"""Release regressions for cache isolation and a restarted Lambda URL cutover."""
from copy import deepcopy
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "infra"))
from domain import CACHE_POLICY, ORIGIN_POLICY, signed_config
from online import Deployment, URL_RULES
from origin import EDGE_RULES, Origin, verify_url_permissions


class OriginTest(unittest.TestCase):
    def test_static_and_api_behaviors(self):
        config = {"Enabled": True, "WebACLId": "keep-acl", "Origins": {"Items": [{"Id": "function"}]},
                  "DefaultCacheBehavior": {"TargetOriginId": "function", "CachePolicyId": CACHE_POLICY,
                    "OriginRequestPolicyId": ORIGIN_POLICY, "ViewerProtocolPolicy": "redirect-to-https", "Compress": True}}
        resources = {"origin_access": {"id": "own-oac"}, "static_cache_policy": {"id": "only-static"}}
        output = signed_config(deepcopy(config), resources)
        self.assertEqual(output["WebACLId"], "keep-acl")
        self.assertEqual(output["Origins"]["Items"][0]["OriginAccessControlId"], "own-oac")
        static = output["DefaultCacheBehavior"]
        self.assertEqual(static["CachePolicyId"], "only-static")
        self.assertNotIn("OriginRequestPolicyId", static)
        self.assertEqual(static["AllowedMethods"]["Items"], ["GET", "HEAD"])
        behaviors = output["CacheBehaviors"]["Items"]
        self.assertEqual([b["PathPattern"] for b in behaviors], ["api", "api/*"])
        for behavior in behaviors:
            self.assertEqual(behavior["CachePolicyId"], CACHE_POLICY)
            self.assertEqual(behavior["OriginRequestPolicyId"], ORIGIN_POLICY)
            self.assertIn("POST", behavior["AllowedMethods"]["Items"])

    def setUp(self):
        self.rows = {"url": {"id": "https://legacy.invalid/"},
            "distribution": {"details": {"arn": "owned-distribution", "signed_origin": True}}}
        self.rows.update({k: {"id": k} for k in (*URL_RULES, *EDGE_RULES)})
        self.d = SimpleNamespace(name="owned-function", state={"resources": self.rows, "zip_sha256": "digest"},
            lambda_arn="owned-function-arn", has=self.rows.__contains__, latest={}, run="test", commit="abc", save=Mock())
        self.domain = Mock()
        self.domain.distribution_readback.return_value = {"Status": "Deployed"}
        self.api = Origin.__new__(Origin)
        self.api.d, self.api.rows, self.api.dist = self.d, self.rows, self.rows["distribution"]
        self.api.fn, self.api.domain, self.api.verify_policy = {"FunctionName": "owned-function"}, self.domain, Mock()
        self.auth = "NONE"
        self.grants = {}
        for sid, (action, key, val) in {**URL_RULES, **EDGE_RULES}.items():
            cond = {"StringEquals": {"lambda:FunctionUrlAuthType": val}} if key == "FunctionUrlAuthType" else {
                    "Bool": {"lambda:InvokedViaFunctionUrl": "true"}}
            principal = "*"
            if sid in EDGE_RULES:
                principal = {"Service": "cloudfront.amazonaws.com"}
                cond["ArnLike"] = {"AWS:SourceArn": "owned-distribution"}
            self.grants[sid] = {"Sid": sid, "Effect": "Allow", "Action": action,
                                "Resource": self.d.lambda_arn, "Condition": cond, "Principal": principal}

    def test_readback_waits_for_the_published_configuration(self):
        target = {"DefaultCacheBehavior": {"CachePolicyId": "static"}, "Origins": {"Items": [{"OriginAccessControlId": "oac"}]}}
        previous = {"DefaultCacheBehavior": {"CachePolicyId": "disabled"}, "Origins": {"Items": [{}]}}
        self.api.dist["id"] = "our-edge"
        def view(config):
            return {"Distribution": {"DistributionConfig": config}}
        with patch("origin.aws", side_effect=[view(previous), view(target)]) as read, patch("origin.time.sleep"):
            self.api.routing_readback(target)
        self.assertEqual(read.call_count, 2)
        self.domain.distribution_readback.assert_called_once_with(target)

    def test_lock_resumes_after_interrupted_permission_removal(self):
        def read(service, operation, _payload):
            self.assertEqual(operation, "get-function-url-config")
            return {"AuthType": self.auth, "FunctionUrl": self.rows["url"]["id"]}

        def write(service, operation, payload):
            if operation == "update-function-url-config":
                self.auth = payload["AuthType"]
            elif operation == "remove-permission":
                del self.grants[payload["StatementId"]]
                if payload["StatementId"] == next(iter(URL_RULES)):
                    raise OSError("response interrupted")
            else:
                self.assertEqual(operation, "tag-resource")

        self.d.mutate = Mock(side_effect=write)
        with patch("origin.aws", side_effect=read), patch("origin.rules", side_effect=lambda d: (self.grants, "rev")), \
             patch("origin.Recovery"), patch("origin.invalidate_static"), patch("builtins.print"):
            with self.assertRaises(OSError):
                self.api.lock()
            self.assertEqual(self.auth, "AWS_IAM")
            self.api.lock()
            self.assertEqual(set(self.grants), set(EDGE_RULES))
            self.assertTrue(self.rows["url"]["details"]["private"])
            verify_url_permissions(self.d, self.auth)

    def test_release_rejects_old_public_grants_and_preserves_closed_origin(self):
        self.auth = "AWS_IAM"
        with patch("origin.rules", return_value=(self.grants, "rev")):
            with self.assertRaises(RuntimeError):
                verify_url_permissions(self.d, self.auth)
            for sid in URL_RULES:
                self.grants.pop(sid)
            verify_url_permissions(self.d, self.auth)
            self.rows["url"]["details"] = {"private": True}
            with self.assertRaises(RuntimeError):
                verify_url_permissions(self.d, "NONE")
            self.d.mutate = Mock(side_effect=AssertionError("No AWS write needed for an existing closed URL"))
            with patch("online.aws", side_effect=[{"AuthType": self.auth, "FunctionUrl": self.rows["url"]["id"]},
                    {"ReservedConcurrentExecutions": 2}]), patch("origin.invalidate_static"), \
                    patch("online.Recovery"), patch("builtins.print"):
                Deployment.publish(self.d)
            self.d.mutate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
