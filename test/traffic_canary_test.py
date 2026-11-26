"""Test Skyjo's bounded edge-readiness probe, retries and cleanup without contacting AWS."""
import base64
from copy import deepcopy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "infra"))
import traffic_canary as canary
from traffic import DEFAULT_LIMITS, rules

PATH = canary.probe_path("a" * 32)


class FakeTraffic:
    def __init__(self):
        self.resources = {"traffic_acl": {"id": "test-acl", "details": {"limits": dict(DEFAULT_LIMITS)}}}
        self.name = "test-name"
        self.dist = "test-distribution"
        self.current_rules = rules(DEFAULT_LIMITS, "count")
        self.linked = False
        self.d = Mock()
        self.d.mutate.side_effect = self.mutate
        self.d.has.side_effect = self.resources.__contains__

    def mutate(self, service, operation, data):
        assert (service, operation, data["LockToken"]) == ("wafv2", "update-web-acl", "token")
        self.current_rules = deepcopy(data["Rules"])

    def current(self):
        refs = [{"FunctionARN": "test-function", "EventType": "viewer-request"}] if self.linked else []
        behaviors = [{"PathPattern": path, "FunctionAssociations": {"Items": refs}} for path in ("api", "api/*")]
        return {"DistributionConfig": {"WebACLId": "test-acl", "CacheBehaviors": {"Items": behaviors}}}

    def acl(self):
        return {"LockToken": "token", "WebACL": {"Name": self.name, "Id": "id", "Rules": deepcopy(self.current_rules)}}

    def status(self):
        assert self.current_rules == rules(DEFAULT_LIMITS, "count")
        return {"mode": "count"}

    def require_free(self):
        pass

    def response_function(self):
        self.resources["traffic_response"] = {"id": "test-function"}
        self.linked = True

    def set_response_association(self, arn, attach):
        assert arn == "test-function"
        self.linked = attach


class CanaryTest(unittest.TestCase):
    def test_only_the_get_probe_matches_the_temporary_marker(self):
        original = rules(DEFAULT_LIMITS, "count")
        prepared = canary.probe_rules(original, PATH)
        self.assertEqual(prepared[1:], original[1:])
        self.assertEqual(len(prepared), 5)
        self.assertEqual(original[0]["Name"], "SkyjoStartsTotal")
        statement = prepared[0]["Statement"]["AndStatement"]["Statements"]
        self.assertEqual([(list(entry["ByteMatchStatement"]["FieldToMatch"])[0],
                           base64.b64decode(entry["ByteMatchStatement"]["SearchString"]).decode(),
                           entry["ByteMatchStatement"]["PositionalConstraint"]) for entry in statement],
                         [("Method", "GET", "EXACTLY"), ("UriPath", PATH, "EXACTLY")])
        self.assertEqual(prepared[0]["Action"]["Count"]["CustomRequestHandling"]["InsertHeaders"],
                         [{"Name": "skyjo-rate", "Value": "1"}])

    def test_cleanup_restores_rules_after_retries_and_rejects_unexpected_changes(self):
        op = FakeTraffic()
        original = deepcopy(op.current_rules)
        with patch.object(canary, "Recovery"), patch.object(canary, "test_published_function"):
            self.assertEqual(canary.operate(op, "prepare")["phase"], "ready")
            expected = deepcopy(op.current_rules)
            nonce = op.resources["traffic_acl"]["details"]["readiness"]["token"]
            self.assertTrue(op.linked)
            canary.operate(op, "prepare")
            self.assertEqual(op.current_rules, expected)
            self.assertEqual(op.resources["traffic_acl"]["details"]["readiness"]["token"], nonce)
            op.current_rules[4]["Statement"]["RateBasedStatement"]["Limit"] = 321
            with self.assertRaisesRegex(RuntimeError, "changed outside"):
                canary.operate(op, "restore")
            op.current_rules = expected
            self.assertEqual(canary.operate(op, "restore")["phase"], "restored")
            self.assertFalse(op.linked)
            self.assertEqual(op.current_rules, original)
            self.assertNotIn("readiness", op.resources["traffic_acl"]["details"])
            self.assertEqual(canary.operate(op, "restore"), {"phase": "restored"})
            self.assertEqual(op.d.mutate.call_count, 2)

    def test_public_probe_uses_only_unmarked_control_and_exact_get_paths(self):
        good = {"cache-control": "no-store", "retry-after": "300"}
        for observed, phase in [((429, good, "rate_limited"), "verified"),
                                ((401, {}, "invalid_profile"), "marker-not-observed")]:
            with patch.object(canary, "public_get", side_effect=[(401, {}, "invalid_profile"), observed]) as get:
                self.assertEqual(canary.probe(PATH)["phase"], phase)
                self.assertEqual([call.args for call in get.call_args_list], [(PATH + "-control",), (PATH,)])

    def test_synthetic_events_check_both_routes_in_the_published_aws_function(self):
        op = FakeTraffic()
        op.response_function()
        seen = []
        def aws(service, operation, args):
            self.assertEqual((service, args["Stage"]), ("cloudfront", "LIVE"))
            if operation == "describe-function":
                return {"ETag": "etag", "FunctionSummary": {"FunctionMetadata": {"FunctionARN": "test-function"}}}
            self.assertEqual((operation, args["IfMatch"]), ("test-function", "etag"))
            request = json.loads(base64.b64decode(args["EventObject"]))["request"]
            present = "x-amzn-waf-skyjo-rate" in request["headers"]
            seen.append(present)
            result = {"response": {"statusCode": 429, "headers": {"retry-after": {"value": "300"}}}} if present else {"request": request}
            return {"TestResult": {"FunctionOutput": json.dumps(result)}}
        with patch.object(canary, "aws", aws):
            canary.test_published_function(op, PATH)
        self.assertEqual(seen, [False, True])


if __name__ == "__main__":
    unittest.main()
