#!/usr/bin/env python3
"""Deploy the Skyjo package through factory-aws --exec. Keep the inventory private."""
import argparse
import base64
from datetime import datetime, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PROJECT = json.loads((ROOT / ".factory/project.json").read_text())
EXPECTED_REPO = "the-carl/skyjo-strategy-lab"
REGION = "us-east-1"
POLICY = "SkyjoRuntime"
CONCURRENCY = 2
ASSETS = {
    "/": "public/index.html", "/app.js": "public/app.js", "/style.css": "public/style.css",
    "/coach": "public/coach/index.html", "/coach/app.js": "public/coach/app.js",
    "/coach/style.css": "public/coach/style.css",
}
CAP = {"MaxReadRequestUnits": 16, "MaxWriteRequestUnits": 32}
URL_RULES = {
    "SkyjoPublicUrl": ("lambda:InvokeFunctionUrl", "FunctionUrlAuthType", "NONE"),
    "SkyjoOnlyViaUrl": ("lambda:InvokeFunction", "InvokedViaFunctionUrl", True),
}


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def run_git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args], text=True).strip()


def aws(service, operation, payload):
    # Use a real mode-0600 file. The factory CLI transport does not forward piped stdin.
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf8", suffix=".json") as request:
        json.dump(payload, request)
        request.flush()
        command = ["aws", service, operation, "--no-cli-pager", "--output", "json",
                   "--cli-connect-timeout", "5", "--cli-read-timeout", "30",
                   "--cli-input-json", "file://" + request.name]
        process = subprocess.run(command, text=True, capture_output=True, timeout=45)
    if process.returncode:
        match = re.search(r"An error occurred \(([^)]+)\)", process.stderr)
        code = match.group(1) if match else "CLIError"
        raise RuntimeError(f"{service}.{operation} {code}")
    return json.loads(process.stdout or "{}")


class Deployment:
    def __init__(self, args):
        os.umask(0o077)
        self.run = args.run_id
        self.path = args.inventory.resolve()
        require(not self.path.is_relative_to(ROOT), "Inventory belongs outside the checkout")
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.project = PROJECT["project_id"]
        self.env = PROJECT["environment"]
        self.scope = self.project + "-" + self.env
        require(PROJECT["repository"].lower() == EXPECTED_REPO and self.env == "development",
                "Unexpected project registration")
        require(os.environ.get("FACTORY_PROJECT_ID") == self.project and
                os.environ.get("FACTORY_ENVIRONMENT") == self.env and
                os.environ.get("FACTORY_AWS_REGION") == REGION, "Use the selected factory AWS profile")
        identity = aws("sts", "get-caller-identity", {})
        self.account = os.environ["FACTORY_AWS_ACCOUNT_ID"]
        self.actor = os.environ["FACTORY_AWS_ROLE_NAME"]
        require(identity["Account"] == self.account and f":assumed-role/{self.actor}/" in identity["Arn"],
                "Unexpected AWS execution identity")
        self.boundary = os.environ["FACTORY_AWS_APP_BOUNDARY_ARN"]
        require(re.fullmatch(fr"arn:aws:iam::{self.account}:policy/[A-Za-z0-9_+=,.@/-]+", self.boundary),
                "Use the selected workload boundary")
        self.commit = run_git("rev-parse", "HEAD")
        require(not run_git("status", "--porcelain", "--untracked-files=all"), "Deploy the committed source")
        author = run_git("show", "-s", "--format=%an", self.commit)
        branch = run_git("branch", "--show-current") or self.commit
        self.latest = {"factory:last-run-id": self.run, "factory:last-source-commit": self.commit,
                       "factory:last-source-branch": branch, "factory:last-source-author": author}
        self.tags = {
            "factory:project-id": self.project, "factory:environment": self.env,
            "factory:owner": "the-carl", "factory:managed-by": "engineering-factory",
            "factory:source-repo": EXPECTED_REPO, "factory:source-commit": self.commit,
            "factory:created-by": self.actor, "factory:created-at": timestamp(),
            "factory:creation-run-id": self.run, "factory:provenance-version": "1",
            "factory:expires-at": "none", "factory:s": self.scope,
            "factory:project-name": "Skyjo Strategy Lab", "factory:repo-name": "skyjo-strategy-lab",
            "factory:source-branch": branch, "factory:source-author": author, **self.latest,
        }
        self.name = "factory-" + self.scope + "-r-play"
        self.table = "factory-" + self.scope + "-r-games"
        self.group = "/aws/lambda/" + self.name
        self.lambda_arn = f"arn:aws:lambda:{REGION}:{self.account}:function:{self.name}"
        self.table_arn = f"arn:aws:dynamodb:{REGION}:{self.account}:table/{self.table}"
        self.group_arn = f"arn:aws:logs:{REGION}:{self.account}:log-group:{self.group}"
        self.role_path = "/factory/" + self.scope + "/"
        self.role_arn = f"arn:aws:iam::{self.account}:role{self.role_path}{self.name}"
        self.state = json.loads(self.path.read_text()) if self.path.exists() else {
            "project_id": self.project, "environment": self.env, "region": REGION, "account": self.account,
            "resources": {}, "cleanup_owner": "the-carl", "expiry": "none",
            "approval": "Publish the playable Skyjo web app with saved history; defer custom DNS",
            "estimated_cost": "Family traffic below USD 1 per month; metered, not a spending cap",
        }
        require((self.state["project_id"], self.state["environment"], self.state["account"], self.state["region"])
                == (self.project, self.env, self.account, REGION), "Inventory target mismatch")

    def save(self):
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.state, indent=2) + "\n")
        temporary.replace(self.path)

    def entry(self, **fields):
        with self.path.with_suffix(".events.jsonl").open("a") as out:
            out.write(json.dumps({"actor": self.actor, "run": self.run, "source": self.commit,
                                  "time": timestamp(), **fields}) + "\n")

    def mutate(self, service, op, payload):
        self.entry(state="intent", op=f"{service}.{op}", request_sha256=hashlib.sha256(
            json.dumps(payload, sort_keys=True).encode()).hexdigest())
        try:
            result = aws(service, op, payload)
        except RuntimeError as error:
            self.entry(state="error", op=f"{service}.{op}", error=str(error))
            raise
        self.entry(state="complete", op=f"{service}.{op}")
        return result

    def remember(self, key, identifier, kind, parent=None):
        previous = self.state["resources"].get(key)
        require(not previous or previous["id"] == identifier, "Resource ID mismatch")
        self.state["resources"][key] = {
            "id": identifier, "type": kind, "parent": parent,
            "creation": previous["creation"] if previous else self.tags,
            "last_run": self.run, "last_commit": self.commit, "last_time": timestamp(),
        }
        self.save()

    def has(self, key):
        return key in self.state["resources"]

    def verify(self, key, tags):
        original = self.state["resources"][key]["creation"]
        if isinstance(tags, list):
            tags = {pair["Key"]: pair["Value"] for pair in tags}
        require(all(k in tags for k in self.tags) and
                all(tags[k] == v for k, v in original.items() if k not in self.latest),
                f"{key} ownership or creation tags mismatch")
        return tags

    def tag_pairs(self):
        return [{"Key": k, "Value": v} for k, v in self.tags.items()]

    def role(self):
        trust = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "sts:AssumeRole",
                                                         "Principal": {"Service": "lambda.amazonaws.com"}}]}
        if not self.has("role"):
            role = self.mutate("iam", "create-role", {"RoleName": self.name, "Path": self.role_path,
                "AssumeRolePolicyDocument": json.dumps(trust), "PermissionsBoundary": self.boundary,
                "Tags": self.tag_pairs()})["Role"]
            require(role["Arn"] == self.role_arn, "Role ARN mismatch")
            self.remember("role", self.role_arn, "AWS::IAM::Role")
        role = aws("iam", "get-role", {"RoleName": self.name})["Role"]
        self.verify("role", role["Tags"])
        require(role["PermissionsBoundary"]["PermissionsBoundaryArn"] == self.boundary and
                role["AssumeRolePolicyDocument"] == trust, "Workload trust or boundary mismatch")
        policy = {"Version": "2012-10-17", "Statement": [
            {"Effect": "Allow", "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
             "Resource": self.group_arn + ":*"},
            {"Effect": "Allow", "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"],
             "Resource": self.table_arn},
        ]}
        if not self.has("role_policy"):
            self.mutate("iam", "put-role-policy", {"RoleName": self.name, "PolicyName": POLICY,
                                                   "PolicyDocument": json.dumps(policy)})
            self.remember("role_policy", POLICY, "AWS::IAM::Policy", "role")
        result = aws("iam", "get-role-policy", {"RoleName": self.name, "PolicyName": POLICY})
        require(result["PolicyDocument"] == policy, "Unexpected inline workload permissions")

    def table_and_logs(self):
        if not self.has("table"):
            result = self.mutate("dynamodb", "create-table", {"TableName": self.table,
                "BillingMode": "PAY_PER_REQUEST", "OnDemandThroughput": CAP, "DeletionProtectionEnabled": True,
                "KeySchema": [{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
                "AttributeDefinitions": [{"AttributeName": k, "AttributeType": "S"} for k in ("pk", "sk")],
                "Tags": self.tag_pairs()})["TableDescription"]
            require(result["TableArn"] == self.table_arn, "Table ARN mismatch")
            self.remember("table", self.table_arn, "AWS::DynamoDB::Table")
        for _ in range(60):
            table = aws("dynamodb", "describe-table", {"TableName": self.table})["Table"]
            if table["TableStatus"] == "ACTIVE":
                break
            time.sleep(2)
        require(table["TableStatus"] == "ACTIVE" and table["OnDemandThroughput"] == CAP and
                table["DeletionProtectionEnabled"], "Table or capacity setting unavailable")
        self.verify("table", aws("dynamodb", "list-tags-of-resource", {"ResourceArn": self.table_arn})["Tags"])
        if not self.has("logs"):
            self.mutate("logs", "create-log-group", {"logGroupName": self.group, "tags": self.tags})
            self.remember("logs", self.group_arn, "AWS::Logs::LogGroup")
        self.verify("logs", aws("logs", "list-tags-for-resource", {"resourceArn": self.group_arn})["tags"])
        groups = aws("logs", "describe-log-groups", {"logGroupNamePrefix": self.group})["logGroups"]
        info = next(g for g in groups if g["logGroupName"] == self.group)
        if info.get("retentionInDays") != 7:
            self.mutate("logs", "put-retention-policy", {"logGroupName": self.group, "retentionInDays": 7})
            self.remember("retention", "7 days", "AWS::Logs::Retention", "logs")

    def wait_function(self):
        for _ in range(60):
            data = aws("lambda", "get-function", {"FunctionName": self.name})
            config = data["Configuration"]
            if config["State"] == "Active" and config.get("LastUpdateStatus", "Successful") == "Successful":
                self.verify("function", data["Tags"])
                return config
            require("Failed" not in (config["State"], config.get("LastUpdateStatus")), "Function failed to activate")
            time.sleep(2)
        raise RuntimeError("Function activation timed out")

    def function(self, package):
        with zipfile.ZipFile(package) as archive:
            require(sorted(archive.namelist()) == sorted(["index.mjs", *ASSETS.values()]),
                    "Unexpected online ZIP manifest")
            asset_hashes = {url: hashlib.sha256(archive.read(name)).digest() for url, name in ASSETS.items()}
        content = package.read_bytes()
        digest = base64.b64encode(hashlib.sha256(content).digest()).decode()
        code = base64.b64encode(content).decode()
        settings = {"Runtime": "nodejs22.x", "Role": self.role_arn, "Handler": "index.handler",
                    "MemorySize": 256, "Timeout": 8, "Environment": {"Variables": {"SKYJO_TABLE": self.table}},
                    "LoggingConfig": {"LogFormat": "JSON", "ApplicationLogLevel": "WARN",
                                      "SystemLogLevel": "WARN", "LogGroup": self.group}}
        if not self.has("function"):
            self.mutate("lambda", "create-function", {"FunctionName": self.name, **settings,
                "Code": {"ZipFile": code}, "Architectures": ["arm64"], "Tags": self.tags})
            self.remember("function", self.lambda_arn, "AWS::Lambda::Function", "role")
        config = self.wait_function()
        require(all(config.get(k) == v for k, v in settings.items()) and config["Architectures"] == ["arm64"],
                "Lambda configuration differs from the approved settings")
        if config["CodeSha256"] != digest:
            self.mutate("lambda", "update-function-code", {"FunctionName": self.name, "ZipFile": code,
                                                            "RevisionId": config["RevisionId"]})
            latest = self.wait_function()
            require(latest["CodeSha256"] == digest, "Lambda ZIP digest mismatch")
            self.mutate("lambda", "tag-resource", {"Resource": self.lambda_arn, "Tags": self.latest})
            self.remember("function", self.lambda_arn, "AWS::Lambda::Function", "role")
        if aws("lambda", "get-function-concurrency", {"FunctionName": self.name}).get("ReservedConcurrentExecutions") != CONCURRENCY:
            self.mutate("lambda", "put-function-concurrency", {"FunctionName": self.name,
                                                                "ReservedConcurrentExecutions": CONCURRENCY})
            self.remember("concurrency", str(CONCURRENCY), "AWS::Lambda::ReservedConcurrency", "function")
        self.state["zip_sha256"] = hashlib.sha256(content).hexdigest()
        self.save()
        return asset_hashes

    def probe(self, path):
        # The history read also exercises the bounded Lambda execution role against DynamoDB.
        event = {"version": "2.0", "rawPath": path, "requestContext": {"http": {"method": "GET"}},
                 "headers": {"authorization": "Bearer " + secrets.token_urlsafe(32)}}
        with tempfile.TemporaryDirectory(dir=self.path.parent) as tmp:
            output = Path(tmp) / "result"
            invocation = Path(tmp) / "event.json"
            invocation.write_text(json.dumps(event))
            process = subprocess.run(["aws", "lambda", "invoke", "--function-name", self.name,
                "--payload", "fileb://" + str(invocation), "--no-cli-pager", "--output", "json",
                str(output)], capture_output=True, text=True, timeout=45)
            require(process.returncode == 0, "Private Lambda invocation request failed")
            response = json.loads(process.stdout)
            require("FunctionError" not in response, "Lambda handler failed private invocation")
            actual = json.loads(output.read_text())
            require(actual["statusCode"] == 200, f"Private probe failed on {path}")
            return actual

    def publish(self):
        for sid, (action, key, value) in URL_RULES.items():
            if not self.has(sid):
                self.mutate("lambda", "add-permission", {"FunctionName": self.name, "StatementId": sid,
                                                        "Action": action, "Principal": "*", key: value})
                self.remember(sid, sid, "AWS::Lambda::Permission", "function")
        doc = json.loads(aws("lambda", "get-policy", {"FunctionName": self.name})["Policy"])
        require(len(doc["Statement"]) == 2, "Unexpected additional Lambda resource permissions")
        for s in doc["Statement"]:
            action, key, value = URL_RULES[s["Sid"]]
            actual = {"StringEquals": {"lambda:FunctionUrlAuthType": "NONE"}} if key == "FunctionUrlAuthType" else {
                "Bool": {"lambda:InvokedViaFunctionUrl": "true"}}
            require(s["Action"] == action and s["Principal"] == "*" and s["Effect"] == "Allow" and
                    s["Resource"] == self.lambda_arn and s["Condition"] == actual, "Unexpected Lambda URL grant")
        if not self.has("url"):
            result = self.mutate("lambda", "create-function-url-config", {"FunctionName": self.name, "AuthType": "NONE"})
            self.remember("url", result["FunctionUrl"], "AWS::Lambda::Url", "function")
        result = aws("lambda", "get-function-url-config", {"FunctionName": self.name})
        url = self.state["resources"]["url"]["id"]
        require(result["FunctionUrl"] == url and result["AuthType"] == "NONE" and not result.get("Cors"),
                "Unexpected endpoint configuration")
        require(aws("lambda", "get-function-concurrency", {"FunctionName": self.name})
                .get("ReservedConcurrentExecutions") == CONCURRENCY, "Concurrency readback failed")
        self.state["last_readback"] = {"run": self.run, "source": self.commit, "time": timestamp(),
                                      "private_checks": ["assets", "coach", "engines", "history"], "capacity": CAP,
                                      "concurrency": CONCURRENCY}
        self.save()
        Recovery(self).backup()
        print(json.dumps({"url": url, "source": self.commit, "package_sha256": self.state["zip_sha256"]}))


RECOVERY_KEY = {"pk": {"S": "OPS#FACTORY"}, "sk": {"S": "DEPLOYMENT#v1"}}


class Recovery:
    """One atomic operator record, separate from every browser's P# partition."""

    def __init__(self, deploy):
        self.d = deploy
        self.files = (deploy.path, deploy.path.with_suffix(".events.jsonl"))
        self.names = ("inventory", "events")
        tags = aws("dynamodb", "list-tags-of-resource", {"ResourceArn": deploy.table_arn})["Tags"]
        actual = {t["Key"]: t["Value"] for t in tags}
        require(all(actual.get(k) == deploy.tags[k] for k in
                    ("factory:project-id", "factory:environment", "factory:source-repo", "factory:managed-by", "factory:s")),
                "Recovery table ownership mismatch")

    def read(self):
        return aws("dynamodb", "get-item", {"TableName": self.d.table, "Key": RECOVERY_KEY,
                                            "ConsistentRead": True}).get("Item")

    @staticmethod
    def hash(data):
        return hashlib.sha256(data).hexdigest()

    def contents(self, item):
        require(item and all(item.get(k) == v for k, v in RECOVERY_KEY.items()), "No matching recovery copy")
        blobs = [gzip.decompress(base64.b64decode(item[name]["S"], validate=True)) for name in self.names]
        for name, data in zip(self.names, blobs):
            require(self.hash(data) == item[name + "Sha256"]["S"], "Recovery file digest mismatch")
        require(item["generation"]["S"] == self.generation(blobs), "Recovery generation mismatch")
        self.validate(blobs)
        return blobs

    def generation(self, blobs):
        return self.hash("".join(self.hash(b) for b in blobs).encode())

    def validate(self, blobs):
        data = json.loads(blobs[0])
        require(data["project_id"] == self.d.project and data["environment"] == self.d.env
                and data["region"] == REGION and data["account"] == self.d.account
                and data["resources"]["table"]["id"] == self.d.table_arn, "Foreign deployment inventory")
        require("last_readback" in data, "Recovery copy requires a completed release readback")
        # Archive these two defined deployment records only. The factory operation replies live elsewhere.
        inventory_fields = {"project_id", "environment", "region", "account", "resources", "cleanup_owner",
            "expiry", "approval", "estimated_cost", "zip_sha256", "last_readback"}
        event_fields = {"actor", "run", "source", "time", "state", "op", "error", "request_sha256"}
        require(set(data) <= inventory_fields, "Unexpected deployment inventory fields")
        for line in blobs[1].splitlines():
            entry = json.loads(line)
            require(set(entry) <= event_fields and {"run", "source", "time", "state"} <= entry.keys(),
                    "Unexpected operation journal fields")
        return data

    def backup(self):
        blobs = [p.read_bytes() for p in self.files]
        data = self.validate(blobs)
        prior = self.read()
        if prior:
            old = self.contents(prior)
            require(blobs[1].startswith(old[1]), "The saved journal and local history diverge. Restore and reconcile.")
            require(data["last_readback"]["time"] >= json.loads(old[0])["last_readback"]["time"],
                    "The local inventory predates the saved readback")
        if prior is None or blobs != old:
            item = {**RECOVERY_KEY, "generation": {"S": self.generation(blobs)}}
            for name, blob in zip(self.names, blobs):
                item[name] = {"S": base64.b64encode(gzip.compress(blob, mtime=0)).decode()}
                item[name + "Sha256"] = {"S": self.hash(blob)}
            require(sum(len(v["S"]) for v in item.values()) < 390_000,
                    "Recovery record exceeds the single-item limit. Split the archive before updating it.")
            if prior is None:
                condition = {"ConditionExpression": "attribute_not_exists(pk)"}
            else:
                condition = {"ConditionExpression": "#gen = :prior",
                             "ExpressionAttributeNames": {"#gen": "generation"},
                             "ExpressionAttributeValues": {":prior": prior["generation"]}}
            aws("dynamodb", "put-item", {"TableName": self.d.table, "Item": item, **condition})
        require(self.contents(self.read()) == blobs, "Strong recovery readback differs from the local files")
        return dict(zip(self.names, map(self.hash, blobs)))

    def restore(self):
        blobs = self.contents(self.read())
        for path, blob in zip(self.files, blobs):
            require(not path.exists() or path.read_bytes() == blob,
                    "Existing private files differ. Restore into a fresh directory and reconcile.")
        for path, blob in zip(self.files, blobs):
            if path.exists():
                continue
            # Publish complete bytes atomically without replacing a concurrently created file.
            with tempfile.NamedTemporaryFile(dir=path.parent) as temp:
                temp.write(blob)
                temp.flush()
                os.fsync(temp.fileno())
                os.link(temp.name, path)
        require(all(path.read_bytes() == blob for path, blob in zip(self.files, blobs)), "Restore digest mismatch")
        return dict(zip(self.names, map(self.hash, blobs)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--package", type=Path, default=ROOT / "online-dist/skyjo-online.zip")
    parser.add_argument("--recovery", choices=("backup", "restore"))
    args = parser.parse_args()
    require(re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args.run_id), "Invalid run ID")
    deploy = Deployment(args)
    if args.recovery:
        copies = Recovery(deploy)
        digests = copies.backup() if args.recovery == "backup" else copies.restore()
        print(json.dumps({"verified_sha256": digests}))
        return
    require(args.package.is_file(), "Build the Skyjo online package first")
    try:
        deploy.role()
        deploy.table_and_logs()
        for path, digest in deploy.function(args.package).items():
            actual = deploy.probe(path)
            require(hashlib.sha256(actual["body"].encode()).digest() == digest, f"Served asset differs on {path}")
            if path in ("/", "/coach"):
                directives = actual["headers"].get("content-security-policy", "").split(";")
                require(any(rule.split() == ["script-src", "'self'"] for rule in directives),
                        f"Unexpected script policy on {path}")
        require(json.loads(deploy.probe("/api/engines")["body"])["engines"], "Empty engine catalog")
        require(json.loads(deploy.probe("/api/history")["body"])["items"] == [], "New profile history mismatch")
        deploy.publish()
    except Exception as error:
        deploy.entry(state="stopped", error=str(error))
        raise


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, KeyError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
