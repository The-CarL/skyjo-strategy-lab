#!/usr/bin/env python3
"""Skyjo's CloudFront Free subscription, count-first WAF and aggregate traffic metrics."""
import argparse
import base64
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re

from online import Deployment, Recovery, aws, require

HOST = "skyjo.carloperottino.com"
WINDOW = 300
DEFAULT_LIMITS = {"Starts": 20, "Moves": 600, "Api": 1200}
MARKER = "skyjo-rate"
CF_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
CF_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6"


def byte_match(part, value, constraint="EXACTLY"):
    return {"ByteMatchStatement": {
        "FieldToMatch": {part: {}}, "PositionalConstraint": constraint,
        "SearchString": base64.b64encode(value.encode()).decode(),
        "TextTransformations": [{"Priority": 0, "Type": "NONE"}]}}


def group(operator, *conditions):
    return {operator + "Statement": {"Statements": list(conditions)}}


def scope(name):
    path = lambda text, constraint="EXACTLY": byte_match("UriPath", text, constraint)
    if name == "Api":
        return group("Or", path("/api"), path("/api/", "STARTS_WITH"))
    post = byte_match("Method", "POST")
    if name == "Starts":
        return group("And", post, group("Or", path("/api/games"), path("/api/games/")))
    suffixes = ("/moves", "/moves/", "/abandon", "/abandon/")
    return group("And", post, path("/api/games/", "STARTS_WITH"),
                 group("Or", *(path(suffix, "ENDS_WITH") for suffix in suffixes)))


def visibility(name):
    return {"CloudWatchMetricsEnabled": True, "SampledRequestsEnabled": False, "MetricName": name}


def rules(limits, mode="count"):
    require(mode in ("count", "arm", "native-block"), "Unknown rate mode")
    require(set(limits) == set(DEFAULT_LIMITS) and all(10 <= n <= 2_000_000_000 for n in limits.values()),
            "AWS rate limits must be positive integers in the supported range")
    result = []
    for name in DEFAULT_LIMITS:
        route = scope(name)
        if name != "Api":
            total = "Skyjo" + name + "Total"
            result.append({"Name": total, "Priority": len(result), "Statement": route,
                           "Action": {"Count": {}}, "VisibilityConfig": visibility(total)})
        name_rate = "Skyjo" + name + "PerIP"
        action = {"Count": {}}
        if mode == "arm":
            action = {"Count": {"CustomRequestHandling": {"InsertHeaders": [{"Name": MARKER, "Value": "1"}]}}}
        elif mode == "native-block":
            action = {"Block": {}}
        result.append({"Name": name_rate, "Priority": len(result), "Statement": {"RateBasedStatement": {
            "AggregateKeyType": "IP", "Limit": limits[name], "EvaluationWindowSec": WINDOW,
            "ScopeDownStatement": route}}, "Action": action, "VisibilityConfig": visibility(name_rate)})
    return result


def subscriptions():
    found = []
    payload = {}
    while True:
        page = aws("pricing-plan-manager", "list-subscriptions", payload)
        found.extend(page["subscriptionSummaries"])
        if not page.get("nextToken"):
            return found
        payload = {"nextToken": page["nextToken"]}


class Traffic:
    def __init__(self, d):
        self.d = d
        self.resources = d.state["resources"]
        row = self.resources["distribution"]
        self.dist = row["id"]
        self.arn = row["details"]["arn"]
        self.name = "factory-" + d.scope + "-r-rate"
        self.query = {"Scope": "CLOUDFRONT", "Name": self.name}
        require(self.arn == f"arn:aws:cloudfront::{d.account}:distribution/{self.dist}", "Distribution ARN mismatch")
        info = aws("cloudfront", "get-distribution", {"Id": self.dist})["Distribution"]
        require(info["ARN"] == self.arn and info["DistributionConfig"]["Aliases"].get("Items") == [HOST],
                "Wrong CloudFront distribution")
        d.verify("distribution", aws("cloudfront", "list-tags-for-resource", {"Resource": self.arn})["Tags"]["Items"])

    def remember(self, key, arn, kind):
        self.d.remember(key, arn, kind, "distribution")
        self.d.save()

    def acl(self):
        arn = self.resources["traffic_acl"]["id"]
        get = {**self.query, "Id": arn.split("/")[-1]}
        result = aws("wafv2", "get-web-acl", get)
        require(result["WebACL"]["ARN"] == arn and result["WebACL"]["Name"] == self.name, "ACL scope mismatch")
        self.d.verify("traffic_acl", aws("wafv2", "list-tags-for-resource",
                      {"ResourceARN": arn})["TagInfoForResource"]["TagList"])
        return result

    def current(self):
        return aws("cloudfront", "get-distribution-config", {"Id": self.dist})

    def member(self):
        return next((item for item in subscriptions() if self.arn in item["resourceArns"]), None)

    def require_free(self):
        entry = self.member()
        require(entry and entry["planFamily"] == "CloudFront" and entry["planTier"] == "FREE" and
                entry["status"] == "ACTIVE" and not entry.get("scheduledChange") and
                set(entry["resourceArns"]) == {self.arn, self.resources["traffic_acl"]["id"]},
                "Verify the active FREE subscription for the exact app resources")
        return entry

    def attach(self, limits):
        current = self.current()
        config = current["DistributionConfig"]
        require(config["DefaultCacheBehavior"].get("CachePolicyId") == CF_OPTIMIZED and
                all(b.get("CachePolicyId") == CF_DISABLED for b in config["CacheBehaviors"].get("Items", []))
                and {b["PathPattern"] for b in config["CacheBehaviors"].get("Items", [])} == {"api", "api/*"},
                "Finish the managed-cache migration before attaching the ACL")
        previous = self.resources.get("traffic_acl", {}).get("id")
        require(config.get("WebACLId", "") in ("", previous), "A different web ACL is already attached")
        plans = subscriptions()
        own = next((p for p in plans if self.arn in p["resourceArns"]), None)
        require((not own and sum(p["planTier"] == "FREE" for p in plans) < 3) or
                (own and previous and own["planTier"] == "FREE" and previous in own["resourceArns"]),
                "Free plan quota exhausted or existing subscription differs")
        generated = rules(limits)
        print(json.dumps({"waf_capacity": aws("wafv2", "check-capacity", {
            "Scope": "CLOUDFRONT", "Rules": generated})["Capacity"]}), flush=True)
        if not previous:
            # A duplicate name stops here. Inspect matching ownership and the recorded intent before recovery.
            created = self.d.mutate("wafv2", "create-web-acl", {**self.query, "DefaultAction": {"Allow": {}},
                "Description": "Skyjo API rate observation", "Rules": generated, "VisibilityConfig": visibility("SkyjoRate"),
                "Tags": self.d.tag_pairs()})["Summary"]
            self.remember("traffic_acl", created["ARN"], "AWS::WAFv2::WebACL")
        actual = self.acl()["WebACL"]
        require(actual["Rules"] == generated and actual["DefaultAction"] == {"Allow": {}}, "Unexpected initial ACL")
        if not config.get("WebACLId"):
            config["WebACLId"] = actual["ARN"]
            self.d.mutate("cloudfront", "update-distribution", {"Id": self.dist, "IfMatch": current["ETag"],
                          "DistributionConfig": config})
        require(self.current()["DistributionConfig"]["WebACLId"] == actual["ARN"], "Attach readback failed")
        self.resources["traffic_acl"]["details"] = {"mode": "count", "limits": limits, "window_seconds": WINDOW}
        self.d.save()
        Recovery(self.d).backup()
        print(json.dumps({"acl": "attached", "mode": "count", "limits": limits}), flush=True)

    def enroll(self):
        acl = self.acl()["WebACL"]["ARN"]
        require(self.current()["DistributionConfig"].get("WebACLId") == acl, "Associate exact ACL first")
        found = self.member()
        if not found:
            arg = {"planFamily": "CloudFront", "planTier": "FREE", "resourceArns": [self.arn, acl],
                   "usageLevel": "DEFAULT", "approvalMode": "IMMEDIATE"}
            arg["clientToken"] = hashlib.sha256((self.arn + acl + "-free-v1").encode()).hexdigest()
            found = self.d.mutate("pricing-plan-manager", "create-subscription", arg)["subscription"]
        require(found["planTier"] == "FREE" and set(found["resourceArns"]) == {self.arn, acl}, "Unexpected subscription")
        self.remember("traffic_plan", found["arn"], "AWS::PricingPlanManager::Subscription")
        status = aws("pricing-plan-manager", "get-subscription", {"arn": found["arn"]})["subscription"]
        require(status["planTier"] == "FREE" and set(status["resourceArns"]) == {self.arn, acl}, "Plan scope changed")
        Recovery(self.d).backup()
        print(json.dumps({"plan": status["planTier"], "status": status["status"]}))

    def update_mode(self, limits, mode):
        self.require_free()
        if mode == "arm":
            self.response_function()
        found = self.acl()
        acl = found["WebACL"]
        previous = [rule["Name"] for rule in acl["Rules"]]
        generated = rules(limits, mode)
        require(previous == [rule["Name"] for rule in generated], "ACL contains unexpected rules")
        if acl["Rules"] != generated:
            writable = ("Name", "Id", "DefaultAction", "Description", "VisibilityConfig", "CustomResponseBodies",
                        "CaptchaConfig", "ChallengeConfig", "TokenDomains", "AssociationConfig",
                        "DataProtectionConfig", "OnSourceDDoSProtectionConfig")
            args = {k: acl[k] for k in writable if k in acl}
            self.d.mutate("wafv2", "update-web-acl", {**args, "Scope": "CLOUDFRONT", "LockToken": found["LockToken"],
                          "Rules": generated})
        require(self.acl()["WebACL"]["Rules"] == generated, "Mode readback failed")
        if mode != "arm" and self.d.has("traffic_response"):
            self.set_response_association(self.resources["traffic_response"]["id"], attach=False)
        self.resources["traffic_acl"]["details"] = {"mode": mode, "limits": limits, "window_seconds": WINDOW}
        self.d.save()
        Recovery(self.d).backup()

    def response_function(self):
        name = self.name + "-response"
        code = Path(__file__).with_name("traffic-response.js").read_bytes()
        digest = hashlib.sha256(code).hexdigest()
        params = {"Name": name, "FunctionConfig": {"Runtime": "cloudfront-js-2.0",
                  "Comment": "Skyjo viewer-IP rate response " + digest}, "FunctionCode": base64.b64encode(code).decode()}
        if not self.d.has("traffic_response"):
            result = self.d.mutate("cloudfront", "create-function", params)
            self.remember("traffic_response", result["FunctionSummary"]["FunctionMetadata"]["FunctionARN"],
                          "AWS::CloudFront::Function")
        arn = self.resources["traffic_response"]["id"]
        get = aws("cloudfront", "describe-function", {"Name": name, "Stage": "DEVELOPMENT"})
        require(get["FunctionSummary"]["FunctionMetadata"]["FunctionARN"] == arn, "Unexpected viewer function")
        if self.resources["traffic_response"].get("details", {}).get("code_sha256") != digest:
            if get["FunctionSummary"]["FunctionConfig"] != params["FunctionConfig"]:
                get = self.d.mutate("cloudfront", "update-function", {**params, "IfMatch": get["ETag"]})
            self.d.mutate("cloudfront", "publish-function", {"Name": name, "IfMatch": get["ETag"]})
            self.resources["traffic_response"]["details"] = {"code_sha256": digest}
            self.d.save()
        self.set_response_association(arn, attach=True)

    def set_response_association(self, arn, attach):
        current = self.current()
        config = current["DistributionConfig"]
        api = config["CacheBehaviors"].get("Items", [])
        require({b["PathPattern"] for b in api} == {"api", "api/*"}, "Unexpected API routing")
        changed = False
        for behavior in api:
            refs = behavior.get("FunctionAssociations", {}).get("Items", [])
            viewers = [x for x in refs if x["EventType"] == "viewer-request"]
            require(not viewers or viewers == [{"EventType": "viewer-request", "FunctionARN": arn}],
                    "Conflicting viewer function")
            if bool(viewers) != attach:
                refs = refs + [{"EventType": "viewer-request", "FunctionARN": arn}] if attach else [r for r in refs if r not in viewers]
                behavior["FunctionAssociations"] = {"Quantity": len(refs)}
                if refs:
                    behavior["FunctionAssociations"]["Items"] = refs
                changed = True
        if changed:
            self.d.mutate("cloudfront", "update-distribution", {"Id": self.dist, "IfMatch": current["ETag"],
                          "DistributionConfig": config})
        state = aws("cloudfront", "get-distribution", {"Id": self.dist})["Distribution"]
        require(state["Status"] == "Deployed", "Viewer function is rolling out; re-run the same stage after propagation")

    def status(self):
        plan = self.require_free()
        acl = self.acl()["WebACL"]
        require(self.current()["DistributionConfig"]["WebACLId"] == acl["ARN"], "Web ACL is not associated")
        limits = {name: next(r["Statement"]["RateBasedStatement"]["Limit"] for r in acl["Rules"]
                  if r["Name"] == "Skyjo" + name + "PerIP") for name in DEFAULT_LIMITS}
        mode = next((m for m in ("count", "arm", "native-block") if rules(limits, m) == acl["Rules"]), None)
        require(mode is not None and acl["VisibilityConfig"] == visibility("SkyjoRate"), "Unexpected active traffic rules")
        return {"plan": plan["planTier"], "status": plan["status"], "mode": mode, "rules": len(acl["Rules"]),
                "window_seconds": WINDOW, "limits_per_viewer_ip": limits, "sampled_requests": False}

    def baseline(self, minutes):
        require(1 <= minutes <= 1440, "Baseline window must be 1 to 1440 minutes")
        end = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        begin = end - timedelta(minutes=minutes)
        result = {}
        acl = self.acl()["WebACL"]
        filters = {"Namespace": "AWS/WAFV2", "MetricName": "CountedRequests"}
        descriptors = []
        token = None
        while True:
            page = aws("cloudwatch", "list-metrics", {**filters, "Dimensions": [{"Name": "WebACL"}],
                       **({"NextToken": token} if token else {})})
            for metric in page.get("Metrics", []):
                dims = {d["Name"]: d["Value"] for d in metric["Dimensions"]}
                if dims.get("WebACL") in (self.name, acl["VisibilityConfig"]["MetricName"]) and set(dims) in (
                        {"WebACL", "Rule"}, {"WebACL", "Rule", "Region"}):
                    descriptors.append(metric)
            token = page.get("NextToken")
            if not token:
                break
        for rule in rules(DEFAULT_LIMITS):
            metric = rule["Name"]
            series_matches = [r for r in descriptors if {"Name": "Rule", "Value": metric} in r["Dimensions"]]
            require(len(series_matches) <= 1, "Ambiguous WAF metric dimensions")
            points = []
            if series_matches:
                query = {**series_matches[0], "StartTime": begin.isoformat(), "EndTime": end.isoformat(),
                         "Period": 60, "Statistics": ["Sum"]}
                points = aws("cloudwatch", "get-metric-statistics", query)["Datapoints"]
            counts = {str(p["Timestamp"])[:16]: int(p["Sum"]) for p in points}
            series = [counts.get((begin + timedelta(minutes=i)).isoformat()[:16], 0) for i in range(minutes)]
            result[metric] = {"sum": sum(series), "series_discovered": bool(series_matches), "reported_minutes": len(points),
                              "peak_5min_all_viewers": max(sum(series[max(0, i-4):i+1]) for i in range(minutes))}
        print(json.dumps({"start": begin.isoformat(), "end": end.isoformat(), "metrics": result}))

    def rollback(self):
        # Only the ACL created by this transaction may be removed, and only when it never enrolled.
        require(self.member() is None and not self.d.has("traffic_plan"),
                "An existing or pending subscription requires reconciliation before rollback")
        acl = self.acl()["WebACL"]
        current = self.current()
        attached = current["DistributionConfig"].get("WebACLId", "")
        require(attached in ("", acl["ARN"]), "Unexpected associated ACL")
        if attached:
            current["DistributionConfig"]["WebACLId"] = ""
            self.d.mutate("cloudfront", "update-distribution", {"Id": self.dist, "IfMatch": current["ETag"],
                          "DistributionConfig": current["DistributionConfig"]})
        live = aws("cloudfront", "get-distribution", {"Id": self.dist})["Distribution"]
        require(live["Status"] == "Deployed" and not live["DistributionConfig"].get("WebACLId"),
                "Wait for the ACL detachment before completing rollback")
        self.d.mutate("wafv2", "delete-web-acl", {**self.query, "Id": acl["Id"], "LockToken": self.acl()["LockToken"]})
        del self.resources["traffic_acl"]
        self.d.save()
        Recovery(self.d).backup()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=["attach", "enroll", "verify", "count", "arm", "native-block", "baseline", "rollback-unenrolled"])
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--starts", type=int)
    parser.add_argument("--moves", type=int)
    parser.add_argument("--api", type=int)
    parser.add_argument("--minutes", type=int, default=60)
    args = parser.parse_args()
    require(re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args.run_id), "Invalid run ID")
    op = Traffic(Deployment(args))
    prior = op.resources.get("traffic_acl", {}).get("details", {}).get("limits", DEFAULT_LIMITS)
    limits = {k: getattr(args, k.lower()) if getattr(args, k.lower()) is not None else prior[k] for k in DEFAULT_LIMITS}
    if args.stage == "attach":
        op.attach(limits)
    elif args.stage == "enroll":
        op.enroll()
    elif args.stage == "baseline":
        op.baseline(args.minutes)
    elif args.stage == "verify":
        print(json.dumps(op.status()))
    elif args.stage == "rollback-unenrolled":
        op.rollback()
    else:
        op.update_mode(limits, args.stage)


if __name__ == "__main__":
    main()
