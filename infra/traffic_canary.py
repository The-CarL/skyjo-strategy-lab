#!/usr/bin/env python3
"""Verify the live WAF-to-viewer 429 on one random GET path, then restore Count."""
import argparse
import base64
from copy import deepcopy
import json
from pathlib import Path
import re
import secrets
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from online import Deployment, Recovery, aws, require
from traffic import HOST, MARKER, Traffic, byte_match, group, rules, visibility


def probe_path(token):
    require(re.fullmatch(r"[a-f0-9]{32}", token), "Invalid private readiness identifier")
    return "/api/traffic-readiness-" + token


def probe_rules(original, path):
    # The five-rule Free plan leaves one temporary slot by suspending only the
    # starts-total metric. Putting this marker on the starts rule would affect players.
    altered = deepcopy(original)
    slot = next(index for index, rule in enumerate(altered) if rule["Name"] == "SkyjoStartsTotal")
    name = "SkyjoReadinessProbe"
    altered[slot] = {
        "Name": name,
        "Priority": original[slot]["Priority"],
        "Statement": group("And", byte_match("Method", "GET"), byte_match("UriPath", path)),
        "Action": {"Count": {"CustomRequestHandling": {"InsertHeaders": [{"Name": MARKER, "Value": "1"}]}}},
        "VisibilityConfig": visibility(name),
    }
    return altered


def replace_rules(op, before, after):
    current = op.acl()
    acl = current["WebACL"]
    if acl["Rules"] == after:
        return
    require(acl["Rules"] == before, "Traffic rules changed outside the readiness check")
    writable = ("Name", "Id", "DefaultAction", "Description", "VisibilityConfig", "CustomResponseBodies",
                "CaptchaConfig", "ChallengeConfig", "TokenDomains", "AssociationConfig", "DataProtectionConfig",
                "OnSourceDDoSProtectionConfig")
    config = {k: acl[k] for k in writable if k in acl}
    op.d.mutate("wafv2", "update-web-acl", {**config, "Scope": "CLOUDFRONT", "LockToken": current["LockToken"],
                                           "Rules": after})
    require(op.acl()["WebACL"]["Rules"] == after, "Readiness ACL readback differs")


def association(op):
    config = op.current()["DistributionConfig"]
    require(config["WebACLId"] == op.resources["traffic_acl"]["id"], "Wrong distribution ACL")
    api = config["CacheBehaviors"].get("Items", [])
    require({b["PathPattern"] for b in api} == {"api", "api/*"}, "Unexpected distribution routing")
    return [ref for behavior in api for ref in behavior.get("FunctionAssociations", {}).get("Items", [])
            if ref["EventType"] == "viewer-request"]


def test_published_function(op, path):
    name = op.response_name
    live = aws("cloudfront", "describe-function", {"Name": name, "Stage": "LIVE"})
    arn = live["FunctionSummary"]["FunctionMetadata"]["FunctionARN"]
    require(arn == op.resources["traffic_response"]["id"] and
            association(op) == [{"EventType": "viewer-request", "FunctionARN": arn}] * 2,
            "Both API behaviors must use the published response function")
    for marked in (False, True):
        headers = {"host": {"value": HOST}}
        if marked:
            headers["x-amzn-waf-" + MARKER] = {"value": "1"}
        event = {
            "version": "1.0", "context": {"distributionDomainName": HOST, "distributionId": op.dist,
            "eventType": "viewer-request", "requestId": "skyjo-readiness"}, "viewer": {"ip": "192.0.2.1"},
            "request": {"method": "GET", "uri": path, "headers": headers, "cookies": {}, "querystring": {}},
        }
        res = aws("cloudfront", "test-function", {"Name": name, "Stage": "LIVE", "IfMatch": live["ETag"],
                  "EventObject": base64.b64encode(json.dumps(event).encode()).decode()})["TestResult"]
        require(not res.get("FunctionErrorMessage"), "Published function failed its synthetic test")
        value = json.loads(res["FunctionOutput"])
        if marked:
            response = value.get("response", value)
            require(response.get("statusCode") == 429 and response["headers"]["retry-after"]["value"] == "300",
                    "Published function did not return the expected synthetic 429")
        else:
            require(value.get("request", value).get("uri") == path, "Published function blocked the control")


def public_get(path):
    # Never supply a rate marker, recovery key or game ID on the real requests.
    req = Request("https://" + HOST + path, headers={"Accept": "application/json"})
    try:
        response = urlopen(req, timeout=10)
    except HTTPError as error:
        response = error
    with response:
        require(response.geturl() == req.full_url, "Unexpected redirect during readiness check")
        body = json.loads(response.read(4096))
        return response.status, response.headers, body.get("error", {}).get("code")


def probe(path):
    control, _, code = public_get(path + "-control")
    require((control, code) == (401, "invalid_profile"), "The unmarked control did not reach the application")
    status, headers, code = public_get(path)
    if (status, code) == (401, "invalid_profile"):
        return {"phase": "marker-not-observed", "http": status}
    require(status == 429 and code == "rate_limited" and headers.get("retry-after") == "300"
            and "no-store" in headers.get("cache-control", ""), "Readiness reply differs from the expected 429")
    return {"phase": "verified", "control": control, "http": status, "retry_after_seconds": 300}


def operate(op, stage):
    details = op.resources["traffic_acl"]["details"]
    note = details.get("readiness")
    op.require_free()
    links = association(op)
    if note is None:
        require(op.status()["mode"] == "count" and not links, "Begin readiness from Count with the viewer function detached")
        if stage == "restore":
            return {"phase": "restored"}
        require(stage == "prepare", "Prepare a readiness check first")
        note = {"token": secrets.token_hex(16), "limits": deepcopy(details["limits"])}
        details["readiness"] = note
        op.d.save()
        Recovery(op.d).backup()
    path = probe_path(note["token"])
    original = rules(note["limits"], "count")
    temporary = probe_rules(original, path)
    require(details["limits"] == note["limits"], "Limits changed during readiness check")
    if stage == "prepare":
        require(op.acl()["WebACL"]["Rules"] in (original, temporary), "Unexpected active traffic rules")
        op.response_function()
        test_published_function(op, path)
        replace_rules(op, original, temporary)
        return {"phase": "ready", "real_ip_rates": "count"}
    if stage == "probe":
        require(op.acl()["WebACL"]["Rules"] == temporary, "The exact temporary rule is not active")
        return probe(path)
    require(stage == "restore", "Unknown readiness stage")
    replace_rules(op, temporary, original)
    if op.d.has("traffic_response"):
        op.set_response_association(op.resources["traffic_response"]["id"], attach=False)
    require(not association(op) and op.status()["mode"] == "count", "Failed to restore the original Count configuration")
    del details["readiness"]
    op.d.save()
    Recovery(op.d).backup()
    return {"phase": "restored", "real_ip_rates": "count"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=["prepare", "probe", "restore"])
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    require(re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args.run_id), "Invalid run ID")
    print(json.dumps(operate(Traffic(Deployment(args)), args.stage)))


if __name__ == "__main__":
    main()
