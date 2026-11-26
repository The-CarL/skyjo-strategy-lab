#!/usr/bin/env python3
"""Manage the Skyjo HTTPS hostname with the selected factory AWS role and private release inventory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import urlsplit

from online import Deployment, Recovery, aws, require

HOST = "skyjo.carloperottino.com"
ZONE = "carloperottino.com"
CLOUDFRONT_ZONE = "Z2FDTNDATAQYW2"
CACHE_POLICY = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"  # AWS Managed-CachingDisabled
ORIGIN_POLICY = "b689b0a8-53d0-40ab-baf2-68738e2966ac"  # AWS Managed-AllViewerExceptHostHeader
METHODS = ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"]


def token(text):
    return hashlib.sha256(text.encode()).hexdigest()[:32]


def clean_dns(record):
    record = dict(record)
    record["Name"] = record["Name"].lower().rstrip(".") + "."
    if "AliasTarget" in record:
        target = dict(record["AliasTarget"])
        target["DNSName"] = target["DNSName"].lower().rstrip(".") + "."
        record["AliasTarget"] = target
    return record


class Domain:
    def __init__(self, deploy):
        self.d = deploy
        self.resources = deploy.state["resources"]
        require({"function", "url", "table"} <= self.resources.keys(), "Restore the app's verified inventory first")
        self.zone = os.environ["FACTORY_AWS_DNS_ZONE_ID"].removeprefix("/hostedzone/")
        require(os.environ["FACTORY_AWS_DNS_ZONE_NAME"].rstrip(".") == ZONE, "Unexpected selected zone")
        z = aws("route53", "get-hosted-zone", {"Id": self.zone})["HostedZone"]
        require(z["Id"].split("/")[-1] == self.zone and z["Name"].rstrip(".") == ZONE and
                z["Config"]["PrivateZone"] is False, "Unexpected zone identity or visibility")

    def records_at(self, name):
        response = aws("route53", "list-resource-record-sets", {"HostedZoneId": self.zone})
        require(not response.get("IsTruncated"), "Incomplete record readback")
        return [clean_dns(r) for r in response["ResourceRecordSets"] if r["Name"].rstrip(".").lower() == name.rstrip(".")]

    def note(self, key, identifier, kind, parent, **details):
        self.d.remember(key, identifier, kind, parent)
        self.resources[key]["details"] = details
        self.d.save()

    def dns(self, key, records, parent):
        name = records[0]["Name"].rstrip(".")
        require(name == HOST or re.fullmatch(r"_[0-9a-f]{32}\." + re.escape(HOST), name),
                "DNS name outside the Skyjo hostname and its validation label")
        expected = sorted((clean_dns(r) for r in records), key=lambda r: r["Type"])
        before = sorted(self.records_at(name), key=lambda r: r["Type"])
        existing = self.resources.get(key)
        if existing:
            previous = existing["details"]
            require(previous["zone"] == self.zone and previous["records"] == expected,
                    "Saved DNS target differs from the proposed operation")
        elif before:
            # A validation CNAME may be shared by several certificates; preserve its existing ownership.
            require(before == expected and key == "domain_validation", "DNS name is already in use")
            self.resources[key] = {"id": name, "type": "AWS::Route53::RecordSet", "parent": parent,
                                   "ownership": "external", "details": {"zone": self.zone, "records": expected}}
            self.d.save()
            return
        else:
            response = self.d.mutate("route53", "change-resource-record-sets", {"HostedZoneId": self.zone,
                "ChangeBatch": {"Comment": "Skyjo " + self.d.run, "Changes": [
                    {"Action": "CREATE", "ResourceRecordSet": r} for r in expected]}})
            self.note(key, name, "AWS::Route53::RecordSet" if len(records) == 1 else "AWS::Route53::RecordSetGroup",
                      parent, zone=self.zone, records=expected, before=before, change=response["ChangeInfo"]["Id"])
        details = self.resources[key]["details"]
        if change := details.get("change"):
            for _ in range(45):
                status = aws("route53", "get-change", {"Id": change})["ChangeInfo"]
                require(status["Id"].split("/")[-1] == change.split("/")[-1], "DNS change ID mismatch")
                if status["Status"] == "INSYNC":
                    break
                time.sleep(4)
            require(status["Status"] == "INSYNC", "DNS change still pending; resume the same stage")
            details["status"] = "INSYNC"
        require(sorted(self.records_at(name), key=lambda r: r["Type"]) == expected, "DNS record readback mismatch")
        self.d.save()

    def certificate(self):
        if "certificate" not in self.resources:
            require(not self.records_at(HOST), "Canonical hostname already exists")
            certs = aws("acm", "list-certificates", {})["CertificateSummaryList"]
            require(not any(HOST == c["DomainName"] for c in certs), "Reconcile an existing certificate first")
            result = self.d.mutate("acm", "request-certificate", {"DomainName": HOST, "ValidationMethod": "DNS",
                "KeyAlgorithm": "RSA_2048", "IdempotencyToken": token(self.d.scope + HOST),
                "Tags": self.d.tag_pairs()})
            self.note("certificate", result["CertificateArn"], "AWS::CertificateManager::Certificate", None, host=HOST)
        arn = self.resources["certificate"]["id"]
        self.d.verify("certificate", aws("acm", "list-tags-for-certificate", {"CertificateArn": arn})["Tags"])
        for _ in range(30):
            cert = aws("acm", "describe-certificate", {"CertificateArn": arn})["Certificate"]
            require(cert["DomainName"] == HOST and set(cert["SubjectAlternativeNames"]) == {HOST}
                    and cert["Type"] == "AMAZON_ISSUED", "Certificate scope mismatch")
            option = next(o for o in cert["DomainValidationOptions"] if o["DomainName"] == HOST)
            if "ResourceRecord" in option:
                break
            time.sleep(3)
        rr = option.get("ResourceRecord", {})
        require(rr.get("Type") == "CNAME" and rr["Value"].lower().rstrip(".").endswith(".acm-validations.aws"),
                "ACM has not supplied the expected DNS validation target yet")
        self.dns("domain_validation", [{"Name": rr["Name"], "Type": "CNAME", "TTL": 300,
                                        "ResourceRecords": [{"Value": rr["Value"]}]}], "certificate")
        Recovery(self.d).backup()
        print(json.dumps({"certificate": cert["Status"], "dns_validation": "verified"}))

    def config(self):
        arn = self.resources["certificate"]["id"]
        cert = aws("acm", "describe-certificate", {"CertificateArn": arn})["Certificate"]
        require(cert["DomainName"] == HOST and cert["Status"] == "ISSUED",
                "Certificate is not issued yet; resume after ACM validation")
        fn_url = aws("lambda", "get-function-url-config", {"FunctionName": self.d.name})["FunctionUrl"]
        require(fn_url == self.resources["url"]["id"], "Unexpected Lambda origin URL")
        origin = urlsplit(fn_url).hostname
        require(origin and re.fullmatch(r"[a-z0-9]+\.lambda-url\.us-east-1\.on\.aws", origin), "Unexpected origin host")
        origin_id = "skyjo-function"
        return {
            "CallerReference": self.d.scope + "-skyjo-https-v1", "Aliases": {"Quantity": 1, "Items": [HOST]},
            "Origins": {"Quantity": 1, "Items": [{"Id": origin_id, "DomainName": origin, "CustomOriginConfig": {
                "HTTPPort": 80, "HTTPSPort": 443, "OriginProtocolPolicy": "https-only",
                "OriginSslProtocols": {"Quantity": 1, "Items": ["TLSv1.2"]}}}]},
            "DefaultCacheBehavior": {"TargetOriginId": origin_id, "ViewerProtocolPolicy": "redirect-to-https",
                "AllowedMethods": {"Quantity": len(METHODS), "Items": METHODS,
                                   "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]}},
                "CachePolicyId": CACHE_POLICY, "OriginRequestPolicyId": ORIGIN_POLICY, "Compress": True},
            "CustomErrorResponses": {"Quantity": 11, "Items": [
                {"ErrorCode": n, "ErrorCachingMinTTL": 0} for n in (400, 403, 404, 405, 414, 416, 500, 501, 502, 503, 504)]},
            "Comment": "Skyjo Strategy Lab family table", "Enabled": True, "PriceClass": "PriceClass_100",
            "HttpVersion": "http2", "IsIPV6Enabled": True, "ViewerCertificate": {
                "ACMCertificateArn": arn, "SSLSupportMethod": "sni-only", "MinimumProtocolVersion": "TLSv1.2_2021"},
        }

    def distribution(self):
        config = self.config()
        if "distribution" not in self.resources:
            listings = aws("cloudfront", "list-distributions", {})["DistributionList"].get("Items", [])
            require(not any(HOST in row.get("Aliases", {}).get("Items", []) for row in listings),
                    "CloudFront hostname already exists; reconcile ownership")
            require(not self.records_at(HOST), "DNS hostname already in use")
            response = self.d.mutate("cloudfront", "create-distribution-with-tags", {
                "DistributionConfigWithTags": {"DistributionConfig": config, "Tags": {"Items": self.d.tag_pairs()}}})
            dist = response["Distribution"]
            self.note("distribution", dist["Id"], "AWS::CloudFront::Distribution", "function",
                      arn=dist["ARN"], edge_host=dist["DomainName"], certificate=self.resources["certificate"]["id"])
        dist = self.distribution_readback(config)
        Recovery(self.d).backup()
        print(json.dumps({"distribution": dist["Status"]}))

    def distribution_readback(self, config):
        row = self.resources["distribution"]
        dist = aws("cloudfront", "get-distribution", {"Id": row["id"]})["Distribution"]
        require(dist["ARN"] == row["details"]["arn"] and dist["DomainName"] == row["details"]["edge_host"],
                "Unexpected CloudFront identity")
        self.d.verify("distribution", aws("cloudfront", "list-tags-for-resource",
                                         {"Resource": dist["ARN"]})["Tags"]["Items"])
        actual = dist["DistributionConfig"]
        before, after = config["DefaultCacheBehavior"], actual["DefaultCacheBehavior"]
        require(actual["Enabled"] and actual["IsIPV6Enabled"] and actual["Aliases"] == config["Aliases"]
                and actual["CacheBehaviors"]["Quantity"] == 0 and actual["Origins"]["Quantity"] == 1
                and actual["PriceClass"] == config["PriceClass"], "Unexpected distribution scope")
        origin = actual["Origins"]["Items"][0]
        require(origin["DomainName"] == config["Origins"]["Items"][0]["DomainName"] and
                origin["CustomOriginConfig"]["OriginProtocolPolicy"] == "https-only" and
                origin["CustomOriginConfig"]["OriginSslProtocols"]["Items"] == ["TLSv1.2"], "Origin TLS mismatch")
        require(all(before[k] == after[k] for k in ("TargetOriginId", "ViewerProtocolPolicy", "CachePolicyId",
                "OriginRequestPolicyId")) and set(after["AllowedMethods"]["Items"]) == set(METHODS),
                "Unexpected proxy behavior")
        require({r["ErrorCode"]: r["ErrorCachingMinTTL"] for r in actual["CustomErrorResponses"]["Items"]} ==
                {r["ErrorCode"]: 0 for r in config["CustomErrorResponses"]["Items"]}, "Error cache policy mismatch")
        require(all(actual["ViewerCertificate"].get(k) == v for k,v in config["ViewerCertificate"].items()),
                "Viewer certificate mismatch")
        cache = aws("cloudfront", "get-cache-policy", {"Id": CACHE_POLICY})["CachePolicy"]["CachePolicyConfig"]
        op = aws("cloudfront", "get-origin-request-policy", {"Id": ORIGIN_POLICY})["OriginRequestPolicy"]["OriginRequestPolicyConfig"]
        require(all(cache[k] == 0 for k in ("MinTTL", "DefaultTTL", "MaxTTL")) and
                op["HeadersConfig"]["HeaderBehavior"] == "allExcept" and
                {h.lower() for h in op["HeadersConfig"]["Headers"]["Items"]} == {"host"} and
                op["QueryStringsConfig"]["QueryStringBehavior"] == "all", "Managed policy settings mismatch")
        return dist

    def publish(self):
        dist = self.distribution_readback(self.config())
        require(dist["Status"] == "Deployed", "Distribution is propagating; resume this stage once deployed")
        self.dns("canonical_dns", [{"Name": HOST, "Type": record_type, "AliasTarget": {
            "HostedZoneId": CLOUDFRONT_ZONE, "DNSName": dist["DomainName"], "EvaluateTargetHealth": False}}
            for record_type in ("A", "AAAA")], "distribution")
        Recovery(self.d).backup()
        print(json.dumps({"hostname": HOST, "tls": "verified", "dns": "INSYNC"}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("certificate", "distribution", "publish"))
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    require(re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args.run_id), "Invalid run ID")
    api = Domain(Deployment(args))
    getattr(api, args.stage)()


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
