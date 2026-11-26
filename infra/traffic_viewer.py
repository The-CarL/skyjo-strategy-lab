#!/usr/bin/env python3
"""Install, verify or detach the Skyjo API's trusted viewer-IP header on its signed origin."""
import argparse
import base64
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

from domain import CACHE_POLICY, ORIGIN_POLICY
from online import Deployment, Recovery, aws, require
from origin import verify_url_permissions
from traffic import HOST, Traffic

RECORD = "origin_rate_viewer"
HEADER = "x-skyjo-viewer-ip"
ASSET = Path(__file__).with_name("origin-viewer.js")


def identity(op):
    name = "factory-" + op.d.scope + "-r-ip"
    require(re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", name), "Invalid project CloudFront Function name")
    return name, "arn:aws:cloudfront::" + op.d.account + ":function/" + name


def verify_origin_and_mode(op, cfg, installing=True):
    require(not cfg.get("WebACLId") and not op.d.has("traffic_acl") and not op.d.has("traffic_plan")
            and op.member() is None, "Finish the WAF / pricing plan rollback before the origin fallback")
    url = aws("lambda", "get-function-url-config", {"FunctionName": op.d.name})
    require(url["AuthType"] == "AWS_IAM" and url["FunctionUrl"] == op.resources["url"]["id"],
            "The game function URL needs AWS_IAM before trusting viewer addresses")
    verify_url_permissions(op.d, "AWS_IAM")
    origins = cfg["Origins"].get("Items", [])
    require(len(origins) == 1 and origins[0]["OriginAccessControlId"] == op.resources["origin_access"]["id"] and
            url["FunctionUrl"] == "https://" + origins[0]["DomainName"] + "/" and
            origins[0]["CustomOriginConfig"]["OriginProtocolPolicy"] == "https-only",
            "Unexpected fallback origin")
    control = aws("cloudfront", "get-origin-access-control", {"Id": origins[0]["OriginAccessControlId"]})
    oac = control["OriginAccessControl"]["OriginAccessControlConfig"]
    require(oac["OriginAccessControlOriginType"] == "lambda" and oac["SigningBehavior"] == "always" and
            oac["SigningProtocol"] == "sigv4", "The game origin must always be signed")
    api = cfg["CacheBehaviors"].get("Items", [])
    require({b["PathPattern"] for b in api} == {"api", "api/*"} and len(api) == 2, "Unexpected Skyjo API behaviors")
    require(all(b["TargetOriginId"] == origins[0]["Id"] and b["CachePolicyId"] == CACHE_POLICY and
                b["OriginRequestPolicyId"] == ORIGIN_POLICY for b in api),
            "Both API behaviors must forward viewer headers with caching disabled")
    _, arn = identity(op)
    default = cfg["DefaultCacheBehavior"].get("FunctionAssociations", {}).get("Items", [])
    require(all(b["FunctionARN"] != arn for b in default), "Viewer IP is restricted to API behaviors")
    for b in api:
        lambdas = b.get("LambdaFunctionAssociations", {}).get("Items", [])
        require(all(x["EventType"] not in ("viewer-request", "origin-request") for x in lambdas),
                "An existing Lambda@Edge function can change API request identity")
        viewer = [r for r in b.get("FunctionAssociations", {}).get("Items", []) if r["EventType"] == "viewer-request"]
        require(viewer == [{"EventType": "viewer-request", "FunctionARN": arn}] or (installing and not viewer),
                "Unexpected API viewer-request association")


def set_api_links(op, arn, attach):
    # Validate and update the same ETag. A concurrent WAF / routing change
    # must be reviewed again before the fallback touches its associations.
    current = op.current()
    cfg = current["DistributionConfig"]
    verify_origin_and_mode(op, cfg)
    changed = False
    for b in cfg["CacheBehaviors"]["Items"]:
        refs = b.get("FunctionAssociations", {}).get("Items", [])
        own = {"EventType": "viewer-request", "FunctionARN": arn}
        if (own in refs) == attach:
            continue
        refs = refs + [own] if attach else [r for r in refs if r != own]
        b["FunctionAssociations"] = {"Quantity": len(refs), **({"Items": refs} if refs else {})}
        changed = True
    if changed:
        op.d.mutate("cloudfront", "update-distribution", {
            "Id": op.dist, "IfMatch": current["ETag"], "DistributionConfig": cfg,
        })
    live = aws("cloudfront", "get-distribution", {"Id": op.dist})["Distribution"]
    require(live["Status"] == "Deployed", "Viewer function is rolling out; re-run this stage after propagation")


def remote_sha(name, stage):
    # GetFunction streams the actual function bytes to a positional output file.
    with tempfile.TemporaryDirectory() as directory:
        out = Path(directory) / "function.js"
        process = subprocess.run(["aws", "cloudfront", "get-function", "--name", name, "--stage", stage,
                                  "--no-cli-pager", "--output", "json", str(out)],
                                 capture_output=True, timeout=30)
        if process.returncode:
            reason = re.search(rb"An error occurred \(([^)]+)\)", process.stderr)
            raise RuntimeError("CloudFront function byte read failed: " +
                               (reason[1].decode() if reason else "CLIError"))
        return hashlib.sha256(out.read_bytes()).hexdigest()


def synthetic(op, name, etag):
    for ip, path in [("192.0.2.10", "/api"), ("2001:db8::9", "/api/games/current"), ("192.0.2.10", "/coach")]:
        request = {"method": "GET", "uri": path, "cookies": {}, "querystring": {"n": {"value": "1"}},
                   "headers": {"host": {"value": HOST}, "x-keep": {"value": "keep"},
                               HEADER: {"value": "client-value", "multiValue": [{"value": "client-value"}, {"value": "extra"}]}}}
        event = {"version": "1.0", "viewer": {"ip": ip}, "request": request, "context": {
            "eventType": "viewer-request", "distributionId": op.dist, "distributionDomainName": HOST,
            "requestId": "skyjo-synthetic"}}
        result = aws("cloudfront", "test-function", {"Name": name, "Stage": "LIVE", "IfMatch": etag,
                     "EventObject": base64.b64encode(json.dumps(event).encode()).decode()})["TestResult"]
        require(not result.get("FunctionErrorMessage") and not result.get("FunctionExecutionLogs"),
                "Published viewer function failed its test or wrote logs")
        value = json.loads(result["FunctionOutput"])
        forwarded = value.get("request", value)
        expected = deepcopy(request)
        if path == "/coach":
            del expected["headers"][HEADER]
        else:
            expected["headers"][HEADER] = {"value": ip}
        require(all(forwarded.get(k) == v for k, v in expected.items()),
                "Published function did not preserve and sanitize the synthetic request")


def verify_viewer(op):
    name, arn = identity(op)
    expected = hashlib.sha256(ASSET.read_bytes()).hexdigest()
    record = op.resources.get(RECORD, {})
    require(record.get("id") == arn, "Unknown Skyjo viewer function identity")
    dist = aws("cloudfront", "get-distribution", {"Id": op.dist})["Distribution"]
    require(dist["ARN"] == op.arn and dist["Status"] == "Deployed", "Wait for CloudFront propagation and verify again")
    verify_origin_and_mode(op, dist["DistributionConfig"], installing=False)
    get = aws("cloudfront", "describe-function", {"Name": name, "Stage": "LIVE"})
    info = get["FunctionSummary"]
    require(info["FunctionMetadata"]["FunctionARN"] == arn and info["FunctionConfig"]["Runtime"] == "cloudfront-js-2.0"
            and remote_sha(name, "LIVE") == expected, "Published viewer function bytes or identity differ")
    synthetic(op, name, get["ETag"])
    return {"verified": True, "api_behaviors": 2, "code_sha256": expected}


def install(op):
    name, arn = identity(op)
    verify_origin_and_mode(op, op.current()["DistributionConfig"])
    code = ASSET.read_bytes()
    digest = hashlib.sha256(code).hexdigest()
    spec = {"Name": name, "FunctionConfig": {"Runtime": "cloudfront-js-2.0",
            "Comment": "Skyjo API trusted viewer IP " + digest}, "FunctionCode": base64.b64encode(code).decode()}
    if not op.d.has(RECORD):
        created = op.d.mutate("cloudfront", "create-function", spec)["FunctionSummary"]
        require(created["FunctionMetadata"]["FunctionARN"] == arn, "Unexpected created function ARN")
        op.remember(RECORD, arn, "AWS::CloudFront::Function")
    record = op.resources[RECORD]
    require(record["id"] == arn, "Viewer function differs from private inventory")
    details = record.setdefault("details", {})
    if details.get("published_sha256") != digest:
        dev = aws("cloudfront", "describe-function", {"Name": name, "Stage": "DEVELOPMENT"})
        require(dev["FunctionSummary"]["FunctionMetadata"]["FunctionARN"] == arn, "Unexpected development function")
        if dev["FunctionSummary"]["FunctionConfig"] != spec["FunctionConfig"] or remote_sha(name, "DEVELOPMENT") != digest:
            dev = op.d.mutate("cloudfront", "update-function", {**spec, "IfMatch": dev["ETag"]})
        op.d.mutate("cloudfront", "publish-function", {"Name": name, "IfMatch": dev["ETag"]})
        require(remote_sha(name, "LIVE") == digest, "Published function differs from source")
        details.update(published_sha256=digest, deployed=False)
        op.d.save()
    set_api_links(op, arn, attach=True)
    result = verify_viewer(op)
    details.update(code_sha256=result["code_sha256"], deployed=True)
    op.d.save()
    Recovery(op.d).backup()
    return result


def detach(op):
    # A detached, idle CloudFront Function has no fixed charge. Other resources remain under their owner's control.
    _, arn = identity(op)
    require(op.resources.get(RECORD, {}).get("id") == arn, "Unknown Skyjo viewer function")
    cfg = aws("lambda", "get-function-configuration", {"FunctionName": op.d.name})
    require(cfg.get("Environment", {}).get("Variables", {}).get("SKYJO_RATE_MODE", "off") == "off",
            "Turn off origin rate enforcement before detaching its trusted viewer header")
    verify_origin_and_mode(op, op.current()["DistributionConfig"])
    set_api_links(op, arn, attach=False)
    config = op.current()["DistributionConfig"]
    require(all(ref["FunctionARN"] != arn for b in config["CacheBehaviors"]["Items"]
                for ref in b.get("FunctionAssociations", {}).get("Items", [])), "Viewer function remains associated")
    op.resources[RECORD].setdefault("details", {})["deployed"] = False
    op.d.save()
    Recovery(op.d).backup()
    return {"deployed": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("install", "verify", "detach"))
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    require(re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args.run_id), "Invalid run identifier")
    op = Traffic(Deployment(args))
    print(json.dumps({"install": install, "verify": verify_viewer, "detach": detach}[args.stage](op)))


if __name__ == "__main__":
    main()
