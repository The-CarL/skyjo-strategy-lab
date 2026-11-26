"""Fallback deployment checks use in-memory provider doubles."""
import base64
from pathlib import Path
import hashlib
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "infra"))
from origin_rate import MODE, MARKERS, RateMode, guard_zip, policy, validate_release


class ConfigTest(unittest.TestCase):
    def setUp(self):
        self.d = Mock(name="deployment")
        self.d.table_arn = "arn:aws:dynamodb:us-east-1:123456789012:table/selected"
        self.d.table, self.d.role_arn = "table", "role"
        self.rows = {"origin_rate_policy": {"id": "SkyjoOriginRate", "parent": "role"},
                     "origin_rate_mode": {"details": {"mode": "count"}}}
        self.d.state = {"resources": self.rows}
        self.d.has.side_effect = self.rows.__contains__
        self.a = RateMode.__new__(RateMode)
        self.a.d, self.a.rows = self.d, self.rows
        self.config = {"Role": "role", "RevisionId": "rev", "CodeSha256": "digest",
                       "Environment": {"Variables": {"SKYJO_TABLE": "table", "OTHER": "preserved", MODE: "count"}}}

    def test_partition_scope(self):
        grant = policy(self.d)["Statement"][0]
        self.assertEqual(set(grant["Action"]), {"dynamodb:PutItem", "dynamodb:UpdateItem"})
        self.assertEqual(grant["Resource"], self.d.table_arn)
        self.assertEqual(grant["Condition"]["ForAllValues:StringLike"]["dynamodb:LeadingKeys"], "R#SKYJO#*")
        self.assertEqual(grant["Condition"]["Null"]["dynamodb:LeadingKeys"], "false")

    def test_config_update_carries_every_other_variable_and_uses_revision(self):
        self.d.wait_function.return_value = {"CodeSha256": "digest", "Environment": {
            "Variables": {"SKYJO_TABLE": "table", "OTHER": "preserved", MODE: "enforce"}}}
        self.a.update(self.config, "enforce")
        request = self.d.mutate.call_args.args[2]
        self.assertEqual(request["RevisionId"], "rev")
        self.assertEqual(request["Environment"]["Variables"], self.d.wait_function.return_value["Environment"]["Variables"])
        self.assertEqual(self.config["Environment"]["Variables"][MODE], "count")

    def test_verified_code_and_viewer_required_before_mode_change(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/"release.zip"
            with ZipFile(path,"w") as archive:
                archive.writestr("index.mjs", b" ".join(MARKERS))
            source = hashlib.sha256(path.read_bytes()).digest()
            self.config["CodeSha256"] = base64.b64encode(source).decode()
            self.d.state["zip_sha256"] = source.hex()
            with patch("origin_rate.verified_policy"), patch("origin_rate.trusted_viewer", side_effect=RuntimeError("viewer")):
                with self.assertRaisesRegex(RuntimeError,"viewer"):
                    self.a.verify_guard(self.config,path)
            self.config["Environment"]["Variables"]["SKYJO_RATE_STARTS"] = "99"
            with self.assertRaisesRegex(RuntimeError, "threshold"):
                self.a.verify_guard(self.config,path)
            with ZipFile(path,"w") as archive:
                archive.writestr("index.mjs", b"no guard")
            with self.assertRaisesRegex(RuntimeError,"lacks"):
                guard_zip(path)

    def test_ordinary_release_rejects_changed_mode_and_unverified_package(self):
        with patch("origin_rate.verified_policy"), patch("origin_rate.guard_zip",side_effect=RuntimeError("missing")):
            with self.assertRaisesRegex(RuntimeError,"missing"):
                validate_release(self.d,self.config,Path("unused"))
        self.config["Environment"]["Variables"][MODE]="off"
        with self.assertRaisesRegex(RuntimeError,"Reconcile"):
            validate_release(self.d,self.config,Path("unused"))

    def test_enforce_requires_previous_count_attestation_before_any_aws_write(self):
        self.a.verify_guard = Mock(return_value="digest")
        self.d.wait_function.return_value = self.config
        with self.assertRaisesRegex(RuntimeError, "count mode"):
            self.a.set_mode("enforce",Path("release.zip"))
        self.d.mutate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
