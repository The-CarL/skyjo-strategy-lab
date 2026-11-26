"""Check the signed-origin boundary before the app trusts a CloudFront viewer header."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "infra"))
import traffic_viewer as viewer


class ViewerTest(unittest.TestCase):
    def setUp(self):
        self.op = Mock()
        self.op.d.scope = "example-development"
        self.op.d.account = "000000000000"
        self.op.d.has.return_value = False
        self.op.member.return_value = None
        self.op.resources = {"origin_access": {"id": "oac"}, "url": {"id": "https://example.lambda-url/"}}
        self.name, self.arn = viewer.identity(self.op)
        origin = {"Id": "origin", "DomainName": "example.lambda-url", "OriginAccessControlId": "oac",
                  "CustomOriginConfig": {"OriginProtocolPolicy": "https-only"}}
        behavior = {"TargetOriginId": "origin", "CachePolicyId": viewer.CACHE_POLICY,
                    "OriginRequestPolicyId": viewer.ORIGIN_POLICY,
                    "FunctionAssociations": {"Items": [{"EventType": "viewer-request", "FunctionARN": self.arn}]}}
        self.cfg = {"Origins": {"Items": [origin]}, "CacheBehaviors": {
            "Items": [dict(deepcopy(behavior), PathPattern=path) for path in ("api", "api/*")]},
            "DefaultCacheBehavior": {}}
        def fake(service, operation, args):
            if operation == "get-function-url-config":
                return {"AuthType": "AWS_IAM", "FunctionUrl": self.op.resources["url"]["id"]}
            if operation == "get-origin-access-control":
                return {"OriginAccessControl": {"OriginAccessControlConfig": {
                    "SigningProtocol": "sigv4", "SigningBehavior": "always", "OriginAccessControlOriginType": "lambda"}}}
            raise AssertionError(operation)
        self.aws = patch.object(viewer, "aws", side_effect=fake).start()
        self.grants = patch.object(viewer, "verify_url_permissions").start()
        self.addCleanup(patch.stopall)

    def test_exact_only_cloudfront_signed_api_routes(self):
        viewer.verify_origin_and_mode(self.op, self.cfg, installing=False)
        self.grants.assert_called_once_with(self.op.d, "AWS_IAM")
        for fn in [
            lambda c: c.update(WebACLId="some-acl"),
            lambda c: c["Origins"]["Items"][0].update(OriginAccessControlId="another"),
            lambda c: c["CacheBehaviors"]["Items"][0].update(OriginRequestPolicyId="drop-headers"),
            lambda c: c["CacheBehaviors"]["Items"][0].update(FunctionAssociations={"Items":[]}),
            lambda c: c["CacheBehaviors"]["Items"][1].update(LambdaFunctionAssociations={
                "Items":[{"EventType":"origin-request","LambdaFunctionARN":"other"}]}),
            lambda c: c["DefaultCacheBehavior"].update(FunctionAssociations={"Items":[{
                "EventType":"viewer-request", "FunctionARN":self.arn}]}),
        ]:
            cfg = deepcopy(self.cfg)
            fn(cfg)
            with self.assertRaises(RuntimeError):
                viewer.verify_origin_and_mode(self.op, cfg, installing=False)

    def test_an_existing_pricing_plan_prevents_fallback(self):
        self.op.member.return_value = {"planTier": "FREE"}
        with self.assertRaisesRegex(RuntimeError, "pricing plan rollback"):
            viewer.verify_origin_and_mode(self.op, self.cfg)

    def test_an_open_url_never_can_supply_trusted_viewer_identities(self):
        self.aws.side_effect = None
        self.aws.return_value = {"AuthType": "NONE", "FunctionUrl": self.op.resources["url"]["id"]}
        with self.assertRaisesRegex(RuntimeError, "AWS_IAM"):
            viewer.verify_origin_and_mode(self.op, self.cfg)
        self.grants.assert_not_called()


if __name__ == "__main__":
    unittest.main()
