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
DEFAULTS = {"starts": 20, "moves": 600, "api": 1200}
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


def threshold(value):
    require(str(value).isascii() and str(value).isdecimal() and 1 <= int(value) <= 2_000_000_000,
            "Thresholds must be integers between 1 and 2000000000")
    return int(value)


def runtime_limits(config):
    env = config["Environment"]["Variables"]
    return {key: threshold(env.get("SKYJO_RATE_" + key.upper(), default)) for key, default in DEFAULTS.items()}


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
    require(runtime_limits(config) == record.get("limits", DEFAULTS), "Unexpected fallback threshold drift")
    if d.has("origin_rate_policy") or mode != "off":
        verified_policy(d)
    if mode != "off":
        guard_zip(package)
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
        digest = hashlib.sha256(package.read_bytes()).hexdigest()
        require(digest == base64.b64decode(config["CodeSha256"]).hex() == d.state["zip_sha256"],
                "Build the exact deployed guard package before enabling it")
        guard_zip(package)
        verified_policy(d)
        trusted_viewer(d)
        return digest

    def prove_counter(self, mode, limits):
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
            if mode == "enforce" and previous >= limits["api"]:
                continue
            require(json.loads(d.probe("/api/engines", viewer)["body"])["engines"], "IP verification probe failed")
            after = aws("dynamodb", "get-item", query).get("Item", {})
            if after.get("window", {}).get("N") == str(epoch) and int(after["api"]["N"]) > previous:
                return
            time.sleep(1)
        raise RuntimeError("The verified package did not record a durable rate counter for the synthetic read")

    def update(self, config, mode, limits):
        current = dict(config["Environment"]["Variables"])
        if MODE in current or mode != "off":
            current[MODE] = mode
        for name, value in limits.items():
            key = "SKYJO_RATE_" + name.upper()
            if key in current or value != DEFAULTS[name]:
                current[key] = str(value)
        if current == config["Environment"]["Variables"]:
            return config
        self.d.mutate("lambda", "update-function-configuration", {"FunctionName": self.d.name,
                      "RevisionId": config["RevisionId"], "Environment": {"Variables": current}})
        result = self.d.wait_function()
        require(result["CodeSha256"] == config["CodeSha256"] and result["Environment"]["Variables"] == current,
                "Runtime configuration readback mismatch")
        return result

    def set_mode(self, mode, package, overrides=None):
        d = self.d
        cfg = d.wait_function()
        # Off is deliberately available when an interrupted deployment or bad configuration needs rollback.
        source = cfg["Environment"]["Variables"].get(MODE, "off") if mode == "off" else active_mode(cfg)
        if not d.has("origin_rate_mode"):
            require(source == "off" or mode == "off", "Existing active Lambda rate mode requires reconciliation")
            d.remember("origin_rate_mode", d.lambda_arn + "#" + MODE, "AWS::Lambda::Environment", "function")
            self.rows["origin_rate_mode"]["details"] = {"mode": "off"}
        row = self.rows["origin_rate_mode"]
        details = row["details"]
        saved = details.get("limits", DEFAULTS)
        pending = details.get("pending") or {}
        baseline = pending.get("limits", saved) if pending.get("to") == mode else saved
        overrides = overrides or {}
        require(set(overrides) <= DEFAULTS.keys() and (mode != "off" or not overrides), "Unexpected limit flags")
        target = {**baseline, **{k: threshold(v) for k,v in overrides.items()}}
        require(set(target) == DEFAULTS.keys() and all(threshold(v) == v for v in target.values()),
                "Invalid saved threshold configuration")
        if mode != "off":
            live = runtime_limits(cfg)
            if pending:
                require(mode == pending["to"] and target == pending.get("limits", saved)
                        and (source, live) in [(pending["from"], pending.get("from_limits", saved)), (mode, target)],
                        "Resume the saved threshold transition or turn the guard off")
            else:
                require(source == details["mode"] and live == saved, "Live rate mode or thresholds differ from inventory")
            digest = self.verify_guard(cfg, package)
            if mode == "enforce":
                require(source in ("count", "enforce") and details.get("count_verified_zip") == digest
                        and details.get("count_verified_limits", DEFAULTS) == target and target == live,
                        "Verify count mode on this exact package and thresholds before enforcing")
        if not pending or mode == "off":
            details["pending"] = {"from": source, "from_limits": saved, "to": mode, "limits": target,
                                  "run": d.run, "source": d.commit}
            d.save()
            Recovery(d).backup()
        changed = self.update(cfg, mode, target)
        require(active_mode(changed) == mode and runtime_limits(changed) == target, "Mode or thresholds readback mismatch")
        if mode != "off":
            self.prove_counter(mode, target)
            if mode == "count":
                details.update(count_verified_zip=digest, count_verified_limits=target)
        if changed is not cfg:
            d.mutate("lambda", "tag-resource", {"Resource": d.lambda_arn, "Tags": d.latest})
        details.pop("pending")
        details.update(mode=mode, limits=target)
        row.update(last_run=d.run, last_commit=d.commit, last_time=timestamp())
        d.save()
        Recovery(d).backup()
        return {"mode": mode, "limits": target, "trusted_viewer_verified": mode != "off",
                "durable_counter_verified": mode != "off"}

    def status(self):
        config = self.d.wait_function()
        mode = active_mode(config)
        if self.d.has("origin_rate_policy"):
            verified_policy(self.d)
        if mode != "off":
            trusted_viewer(self.d)
        saved = self.rows.get("origin_rate_mode", {}).get("details", {})
        return {"mode": mode, "limits": runtime_limits(config), "recorded_mode": saved.get("mode", "off"),
                "recorded_limits": saved.get("limits", DEFAULTS), "pending": bool(saved.get("pending")),
                "rate_key_policy": self.d.has("origin_rate_policy")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("prepare", "count", "enforce", "off", "status"))
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--package", type=Path, default=ROOT / "online-dist/skyjo-online.zip")
    for name in DEFAULTS:
        parser.add_argument("--" + name, type=int)
    args = parser.parse_args()
    limits = {name: threshold(getattr(args, name)) for name in DEFAULTS if getattr(args, name) is not None}
    require(not limits or args.stage in ("count", "enforce"), "Limit flags apply to count and enforce")
    require(re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args.run_id), "Invalid run ID")
    adapter = RateMode(Deployment(args))
    if args.stage == "prepare":
        output = adapter.prepare()
    elif args.stage == "status":
        output = adapter.status()
    else:
        output = adapter.set_mode(args.stage, args.package, limits)
    print(json.dumps(output))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, OSError, KeyError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
