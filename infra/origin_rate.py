#!/usr/bin/env python3
"""Optional DynamoDB fallback for installations without an active CloudFront pricing plan."""
import argparse
import base64
import hashlib
import json
import re
import secrets
import sys
import time
from pathlib import Path
from zipfile import ZipFile

from online import Deployment, ROOT, Recovery, aws, require, timestamp

POLICY = "SkyjoOriginRate"
MODE = "SKYJO_RATE_MODE"
LIMITS = {"SKYJO_RATE_STARTS": 20, "SKYJO_RATE_MOVES": 600, "SKYJO_RATE_API": 1200}
MARKERS = (b"SKYJO_RATE_MODE", b"x-skyjo-viewer-ip", b"R#SKYJO#")


def policy(d):
    return {"Version": "2012-10-17", "Statement": [{
        "Effect": "Allow", "Action": ["dynamodb:PutItem", "dynamodb:UpdateItem"], "Resource": d.table_arn,
        "Condition": {"ForAllValues:StringLike": {"dynamodb:LeadingKeys": "R#SKYJO#*"},
                      "Null": {"dynamodb:LeadingKeys": "false"}}}]}


def current_policy(d):
    try:
        return aws("iam", "get-role-policy", {"RoleName": d.name, "PolicyName": POLICY})["PolicyDocument"]
    except RuntimeError as error:
        if str(error) == "iam.get-role-policy NoSuchEntity":
            return None
        raise


def verified_policy(d):
    row = d.state["resources"].get("origin_rate_policy", {})
    require(row.get("id") == POLICY and row.get("parent") == "role"
            and current_policy(d) == policy(d), "Unexpected rate-key inline policy")


def active_mode(config):
    env = config["Environment"]["Variables"]
    value = env.get(MODE, "off")
    require(value in ("off", "count", "enforce"), "Unknown Lambda rate mode")
    return value


def check_limits(config):
    env = config["Environment"]["Variables"]
    require(all(env.get(k, str(v)) == str(v) for k, v in LIMITS.items()), "Unexpected fallback rate threshold overrides")


def guard_zip(package):
    with ZipFile(package) as archive:
        bundle = archive.read("index.mjs")
    require(all(m in bundle for m in MARKERS), "Release bundle lacks the trusted-viewer DynamoDB rate guard")


def trusted_viewer(d):
    from traffic import Traffic
    from traffic_viewer import verify_viewer
    row = d.state["resources"].get("origin_rate_viewer", {})
    require(row.get("details", {}).get("deployed") is True, "Viewer function has not completed deployment")
    result = verify_viewer(Traffic(d))
    require(result["verified"] and result["api_behaviors"] == 2 and
            result["code_sha256"] == row["details"]["code_sha256"], "Live viewer function differs from its deployment")


def validate_release(d, config, package):
    """The normal code deploy changes no environment variables or auxiliary role policies."""
    mode = active_mode(config)
    record = d.state["resources"].get("origin_rate_mode", {}).get("details", {})
    require(not record.get("pending") and mode == record.get("mode", "off"), "Reconcile the recorded rate mode")
    if d.has("origin_rate_policy"):
        verified_policy(d)
    if mode != "off":
        check_limits(config)
        guard_zip(package)
        verified_policy(d)
        trusted_viewer(d)


class RateMode:
    def __init__(self, d):
        self.d = d
        self.rows = d.state["resources"]
        require(self.rows.get("role", {}).get("id") == d.role_arn and
                self.rows.get("function", {}).get("id") == d.lambda_arn, "Unverified Skyjo role or function")
        role = aws("iam", "get-role", {"RoleName": d.name})["Role"]
        require(role["Arn"] == d.role_arn and role["PermissionsBoundary"]["PermissionsBoundaryArn"] == d.boundary,
                "Unverified rate-guard role or permissions boundary")
        d.verify("role", role["Tags"])

    def prepare(self):
        d = self.d
        if not d.has("origin_rate_policy"):
            require(current_policy(d) is None, "Existing inline rate policy requires ownership reconciliation")
            d.mutate("iam", "put-role-policy", {"RoleName": d.name, "PolicyName": POLICY,
                     "PolicyDocument": json.dumps(policy(d))})
            d.remember("origin_rate_policy", POLICY, "AWS::IAM::Policy", "role")
        verified_policy(d)
        Recovery(d).backup()
        return {"policy": "verified", "permissions": ["PutItem", "UpdateItem"], "partition": "R#SKYJO#*"}

    def verify_guard(self, config, package):
        d = self.d
        require(config["Role"] == d.role_arn and config["Environment"]["Variables"].get("SKYJO_TABLE") == d.table,
                "Unexpected workload configuration")
        check_limits(config)
        digest = hashlib.sha256(package.read_bytes()).hexdigest()
        require(digest == base64.b64decode(config["CodeSha256"]).hex() == d.state["zip_sha256"],
                "Build the exact deployed guard package before enabling it")
        guard_zip(package)
        verified_policy(d)
        trusted_viewer(d)
        return digest

    def prove_counter(self):
        """One direct catalog read with a synthetic TEST-NET address demonstrates a real durable increment."""
        d = self.d
        for _ in range(3):
            viewer = "198.51.100." + str(secrets.randbelow(254) + 1)
            epoch = int(time.time()) // 300
            bucket = hashlib.sha256(f"skyjo-rate-v1:{epoch}:{viewer}".encode()).hexdigest()[:5]
            query = {"TableName": d.table, "Key": {"pk": {"S": "R#SKYJO#" + bucket}, "sk": {"S": "RATE"}},
                     "ConsistentRead": True}
            before = aws("dynamodb", "get-item", query).get("Item", {})
            previous = int(before["api"]["N"]) if before.get("window", {}).get("N") == str(epoch) else 0
            if previous >= LIMITS["SKYJO_RATE_API"]:
                continue
            require(json.loads(d.probe("/api/engines", viewer)["body"])["engines"], "IP verification probe failed")
            after = aws("dynamodb", "get-item", query).get("Item", {})
            if after.get("window", {}).get("N") == str(epoch) and int(after["api"]["N"]) > previous:
                return
            time.sleep(1)
        raise RuntimeError("The verified package did not record a durable rate counter for the synthetic read")

    def update(self, config, mode):
        current = dict(config["Environment"]["Variables"])
        if active_mode(config) == mode:
            return config
        current[MODE] = mode
        self.d.mutate("lambda", "update-function-configuration", {"FunctionName": self.d.name,
                      "RevisionId": config["RevisionId"], "Environment": {"Variables": current}})
        result = self.d.wait_function()
        require(result["CodeSha256"] == config["CodeSha256"] and result["Environment"]["Variables"] == current,
                "Runtime configuration readback mismatch")
        return result

    def set_mode(self, mode, package):
        d = self.d
        cfg = d.wait_function()
        source = active_mode(cfg)
        if not d.has("origin_rate_mode"):
            require(source == "off", "Existing active Lambda rate mode requires reconciliation")
            d.remember("origin_rate_mode", d.lambda_arn + "#" + MODE, "AWS::Lambda::Environment", "function")
            self.rows["origin_rate_mode"]["details"] = {"mode": "off"}
        row = self.rows["origin_rate_mode"]
        details = row["details"]
        pending = details.get("pending")
        if pending:
            require(mode == pending["to"] or mode == "off", "Resume the saved mode change or turn the guard off")
            require(source in (pending["from"], pending["to"]), "Runtime mode differs from pending transition")
        else:
            require(source == details["mode"], "Runtime mode differs from saved inventory")
        if mode != "off":
            digest = self.verify_guard(cfg, package)
            if mode == "enforce":
                require(source in ("count", "enforce") and details.get("count_verified_zip") == digest,
                        "Verify count mode on this exact package before enforcing")
        details["pending"] = {"from": source, "to": mode, "run": d.run, "source": d.commit}
        d.save()
        Recovery(d).backup()
        self.update(cfg, mode)
        if mode != "off":
            self.prove_counter()
            if mode == "count":
                details["count_verified_zip"] = digest
        if source != mode:
            d.mutate("lambda", "tag-resource", {"Resource": d.lambda_arn, "Tags": d.latest})
        details.pop("pending")
        details["mode"] = mode
        row.update(last_run=d.run, last_commit=d.commit, last_time=timestamp())
        d.save()
        Recovery(d).backup()
        return {"mode": mode, "trusted_viewer_verified": mode != "off", "durable_counter_verified": mode != "off"}

    def status(self):
        mode = active_mode(self.d.wait_function())
        if self.d.has("origin_rate_policy"):
            verified_policy(self.d)
        if mode != "off":
            trusted_viewer(self.d)
        saved = self.rows.get("origin_rate_mode", {}).get("details", {})
        return {"mode": mode, "recorded_mode": saved.get("mode", "off"), "pending": bool(saved.get("pending")),
                "rate_key_policy": self.d.has("origin_rate_policy")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("prepare", "count", "enforce", "off", "status"))
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--package", type=Path, default=ROOT / "online-dist/skyjo-online.zip")
    args = parser.parse_args()
    require(re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args.run_id), "Invalid run ID")
    adapter = RateMode(Deployment(args))
    if args.stage == "prepare":
        output = adapter.prepare()
    elif args.stage == "status":
        output = adapter.status()
    else:
        output = adapter.set_mode(args.stage, args.package)
    print(json.dumps(output))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, OSError, KeyError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
