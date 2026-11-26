#!/usr/bin/env python3
"""Migrate the existing Skyjo URL and distribution in independently verifiable stages."""
import argparse
from copy import deepcopy
import json
from pathlib import Path
import re
import sys
import time

from online import Deployment, Recovery, URL_RULES, aws, require, timestamp
from domain import Domain, HOST, signed_config

EDGE_RULES = {
    "SkyjoCloudFrontUrl": ("lambda:InvokeFunctionUrl", "FunctionUrlAuthType", "AWS_IAM"),
    "SkyjoCloudFrontInvoke": ("lambda:InvokeFunction", "InvokedViaFunctionUrl", True),
}


def rules(d):
    try:
        output = aws("lambda", "get-policy", {"FunctionName": d.name})
    except RuntimeError as error:
        if str(error) == "lambda.get-policy ResourceNotFoundException":
            return {}, None
        raise
    return {s["Sid"]: s for s in json.loads(output["Policy"])["Statement"]}, output["RevisionId"]


def validate_rule(d, sid, statement):
    edge = sid in EDGE_RULES
    action, key, value = (EDGE_RULES if edge else URL_RULES)[sid]
    op, condition = ("StringEquals", {"lambda:FunctionUrlAuthType": value}) if key == "FunctionUrlAuthType" else (
        "Bool", {"lambda:InvokedViaFunctionUrl": "true"})
    conditions = {op: condition}
    principal = "*"
    if edge:
        dist = d.state["resources"]["distribution"]
        conditions["ArnLike"] = {"AWS:SourceArn": dist["details"]["arn"]}
        principal = {"Service": "cloudfront.amazonaws.com"}
    require(statement == {"Sid": sid, "Action": action, "Effect": "Allow", "Resource": d.lambda_arn,
                          "Principal": principal, "Condition": conditions}, "Unexpected Lambda invocation grant " + sid)


def verify_url_permissions(d, auth, transition=False):
    statements, _ = rules(d)
    require(set(statements) <= set(URL_RULES) | set(EDGE_RULES), "Unexpected Lambda resource grant")
    for sid, statement in statements.items():
        validate_rule(d, sid, statement)
    permission_ids = {k for k in EDGE_RULES if d.has(k)}
    require(permission_ids <= statements.keys(), "Missing recorded CloudFront grant")
    if transition:
        return statements
    if auth == "NONE":
        require(all(d.has(sid) for sid in URL_RULES) and set(statements) == set(URL_RULES) | permission_ids
                and not d.state["resources"]["url"].get("details", {}).get("private"),
                "Unexpected public URL permissions")
    else:
        require(auth == "AWS_IAM" and set(statements) == permission_ids, "Unexpected signed URL permissions")
        if d.state["resources"].get("distribution", {}).get("details", {}).get("signed_origin"):
            require(permission_ids == set(EDGE_RULES), "Missing scoped distribution authorization")
    return statements


def invalidate_static(d):
    dist = d.state["resources"].get("distribution", {})
    details = dist.get("details", {})
    if not details.get("signed_origin") or details.get("invalidated_zip") == d.state["zip_sha256"]:
        return
    batch = {"Paths": {"Quantity": 1, "Items": ["/*"]},
             "CallerReference": d.run + "-" + d.state["zip_sha256"]}
    inv = d.mutate("cloudfront", "create-invalidation", {"DistributionId": dist["id"], "InvalidationBatch": batch})
    item = inv["Invalidation"]
    for _ in range(90):
        if item["Status"] == "Completed":
            break
        time.sleep(4)
        item = aws("cloudfront", "get-invalidation", {"DistributionId": dist["id"], "Id": item["Id"]})["Invalidation"]
    require(item["Status"] == "Completed", "Invalidation is still propagating")
    details.update(invalidated_zip=d.state["zip_sha256"], last_invalidation=item["Id"])
    d.save()


class Origin:
    def __init__(self, d):
        self.d = d
        self.domain = Domain(d)
        self.rows = d.state["resources"]
        self.dist = self.rows["distribution"]
        self.arn = self.dist["details"]["arn"]
        self.fn = {"FunctionName": d.name}

    def config(self):
        return aws("cloudfront", "get-distribution-config", {"Id": self.dist["id"]})

    def verify_policy(self):
        oac = aws("cloudfront", "get-origin-access-control", {"Id": self.rows["origin_access"]["id"]})
        actual = oac["OriginAccessControl"]["OriginAccessControlConfig"]
        require(actual == self.oac(), "Unexpected origin access control")
        cache = aws("cloudfront", "get-cache-policy", {"Id": self.rows["static_cache_policy"]["id"]})
        require(cache["CachePolicy"]["CachePolicyConfig"] == self.cache(), "Unexpected shared cache policy")

    def oac(self):
        return {"Name": self.d.name, "Description": "Sign Skyjo CloudFront requests to its Lambda URL",
                "SigningProtocol": "sigv4", "SigningBehavior": "always", "OriginAccessControlOriginType": "lambda"}

    def cache(self):
        params = {"EnableAcceptEncodingGzip": True, "EnableAcceptEncodingBrotli": True,
                  "HeadersConfig": {"HeaderBehavior": "none"}, "CookiesConfig": {"CookieBehavior": "none"},
                  "QueryStringsConfig": {"QueryStringBehavior": "none"}}
        return {"Name": self.d.name + "-static", "Comment": "Only Skyjo public assets advertise shared caching",
                "MinTTL": 0, "MaxTTL": 300, "DefaultTTL": 0, "ParametersInCacheKeyAndForwardedToOrigin": params}

    def prepare(self):
        self.domain.distribution_readback(self.domain.config())
        for key, op, config, resource, response_name, list_key, aws_type in [
            ("origin_access", "origin-access-control", self.oac(), "OriginAccessControlConfig", "OriginAccessControl",
             "OriginAccessControlList", "AWS::CloudFront::OriginAccessControl"),
            ("static_cache_policy", "cache-policy", self.cache(), "CachePolicyConfig", "CachePolicy",
             "CachePolicyList", "AWS::CloudFront::CachePolicy"),
        ]:
            if self.d.has(key):
                continue
            payload = {"Type": "custom"} if key == "static_cache_policy" else {}
            collection = aws("cloudfront", "list-" + ("cache-policies" if payload else "origin-access-controls"), payload)
            for row in collection.get(list_key, {}).get("Items", []):
                name = row["CachePolicy"]["CachePolicyConfig"]["Name"] if payload else row["Name"]
                require(name != config["Name"], "Reconcile existing " + op + " ownership before adoption")
            result = self.d.mutate("cloudfront", "create-" + op, {resource: config})[response_name]
            self.d.remember(key, result["Id"], aws_type, "distribution")
        self.verify_policy()
        current = verify_url_permissions(self.d, aws("lambda", "get-function-url-config", self.fn)["AuthType"], True)
        for sid, (action, key, value) in EDGE_RULES.items():
            if sid not in current:
                _, revision = rules(self.d)
                payload = {**self.fn, "StatementId": sid, "Action": action, "Principal": "cloudfront.amazonaws.com",
                           "SourceArn": self.arn, key: value}
                if revision:
                    payload["RevisionId"] = revision
                self.d.mutate("lambda", "add-permission", payload)
            validate_rule(self.d, sid, rules(self.d)[0][sid])
            if not self.d.has(sid):
                self.d.remember(sid, sid, "AWS::Lambda::Permission", "function")
        Recovery(self.d).backup()
        print(json.dumps({"prepared": True, "host": HOST}))

    def edge(self):
        self.verify_policy()
        config = self.domain.config()
        current = self.config()
        if not self.dist["details"].get("signed_origin"):
            obj = current["DistributionConfig"]
            require(obj["Origins"]["Quantity"] == 1, "Unexpected origin count")
            if obj["Origins"]["Items"][0].get("OriginAccessControlId") != self.rows["origin_access"]["id"]:
                self.domain.distribution_readback(config)
                require(not obj.get("CacheBehaviors", {}).get("Items"), "Unexpected existing cache behaviors")
                self.d.mutate("cloudfront", "update-distribution", {
                    "Id": self.dist["id"], "IfMatch": current["ETag"],
                    "DistributionConfig": signed_config(deepcopy(obj), self.rows)})
            self.domain.distribution_readback(signed_config(config, self.rows))
            self.d.mutate("cloudfront", "tag-resource", {"Resource": self.arn, "Tags": {"Items": [
                {"Key": k, "Value": v} for k,v in self.d.latest.items()]}})
            self.dist["details"]["signed_origin"] = True
            self.dist.update(last_run=self.d.run, last_commit=self.d.commit, last_time=timestamp())
            self.d.save()
        result = self.domain.distribution_readback(self.domain.config())
        Recovery(self.d).backup()
        print(json.dumps({"cloudfront": result["Status"], "origin": "sigv4", "public_assets_max_ttl": 300}))

    def lock(self):
        self.verify_policy()
        require(self.dist["details"].get("signed_origin"), "Deploy the signed edge first")
        result = self.domain.distribution_readback(self.domain.config())
        require(result["Status"] == "Deployed", "Wait for the signed edge to deploy globally")
        url = aws("lambda", "get-function-url-config", self.fn)
        require(url["FunctionUrl"] == self.rows["url"]["id"], "Unexpected Lambda URL")
        allowed = verify_url_permissions(self.d, url["AuthType"], True)
        require(set(EDGE_RULES) <= allowed.keys(), "Missing distribution-scoped grants")
        if url["AuthType"] == "NONE":
            self.d.mutate("lambda", "update-function-url-config", {**self.fn, "AuthType": "AWS_IAM"})
        require(aws("lambda", "get-function-url-config", self.fn)["AuthType"] == "AWS_IAM", "URL remains public")
        for sid in URL_RULES:
            current, revision = rules(self.d)
            if sid in current:
                validate_rule(self.d, sid, current[sid])
                self.d.mutate("lambda", "remove-permission", {**self.fn, "StatementId": sid, "RevisionId": revision})
            if self.d.has(sid):
                self.rows[sid].setdefault("retired", {"run": self.d.run, "commit": self.d.commit, "time": timestamp()})
        verify_url_permissions(self.d, "AWS_IAM")
        self.rows["url"].setdefault("details", {})["private"] = True
        self.rows["url"].update(last_run=self.d.run, last_commit=self.d.commit, last_time=timestamp())
        self.d.mutate("lambda", "tag-resource", {"Resource": self.d.lambda_arn, "Tags": self.d.latest})
        self.d.save()
        invalidate_static(self.d)
        Recovery(self.d).backup()
        print(json.dumps({"host": HOST, "origin_auth": "AWS_IAM", "public_permissions": 0}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("prepare", "edge", "lock"))
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    require(re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args.run_id), "Invalid run ID")
    getattr(Origin(Deployment(args)), args.stage)()


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, KeyError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
