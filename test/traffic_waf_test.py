"""Exercise Skyjo's actual WAF expressions without sending traffic to a live game."""
import base64
from datetime import datetime, timezone
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "infra"))
from traffic import DEFAULT_LIMITS, bucket_counts, rules


def matches(statement, method, path):
    kind, body = next(iter(statement.items()))
    if kind == "RateBasedStatement":
        return matches(body["ScopeDownStatement"], method, path)
    if kind in ("AndStatement", "OrStatement"):
        reducer = all if kind == "AndStatement" else any
        return reducer(matches(item, method, path) for item in body["Statements"])
    assert kind == "ByteMatchStatement"
    value = method if body["FieldToMatch"] == {"Method": {}} else path
    target = base64.b64decode(body["SearchString"]).decode()
    return {"EXACTLY": value == target, "STARTS_WITH": value.startswith(target),
            "ENDS_WITH": value.endswith(target)}[body["PositionalConstraint"]]


class WafTest(unittest.TestCase):
    def test_routes(self):
        configured = rules(DEFAULT_LIMITS)
        self.assertEqual([r["Priority"] for r in configured], list(range(5)))
        for method, path, group in [
            ("POST", "/api/games", "Starts"), ("POST", "/api/games/", "Starts"),
            ("POST", "/api/games/test/moves", "Moves"), ("POST", "/api/games/test/moves/", "Moves"),
            ("POST", "/api/games/test/abandon/", "Moves"), ("GET", "/api/history", "Api"),
            ("GET", "/api", "Api"), ("GET", "/api/engines", "Api"), ("GET", "/coach", ""),
            ("GET", "/apiary", ""), ("POST", "/api/games/test", "Api")]:
            hit = [r["Name"] for r in configured if matches(r["Statement"], method, path)]
            self.assertEqual(hit, ([] if not group else
                [f"Skyjo{group}Total", f"Skyjo{group}PerIP", "SkyjoApiPerIP"] if group != "Api" else ["SkyjoApiPerIP"]))

    def test_utc_buckets_capture_a_household_session_across_local_offsets(self):
        start = datetime(2026, 11, 26, 17, 18, tzinfo=timezone.utc)
        points = [{"Timestamp": f"2026-11-26T12:{minute}:00-05:00", "Sum": 3}
                  for minute in range(18, 24)]
        self.assertEqual(bucket_counts(points, start, 6), {"reported_minutes": 6, "sum": 18,
                         "peak_5min_all_viewers": 15, "upper_bound_unaligned_5min": 18})

    def test_modes(self):
        for mode in ("count", "arm", "native-block"):
            for row in rules(DEFAULT_LIMITS, mode):
                self.assertFalse(row["VisibilityConfig"]["SampledRequestsEnabled"])
                if "Total" in row["Name"] or mode == "count":
                    self.assertEqual(row["Action"], {"Count": {}})
                elif mode == "arm":
                    self.assertIn("CustomRequestHandling", row["Action"]["Count"])
                else:
                    self.assertEqual(row["Action"], {"Block": {}})
                if rate := row["Statement"].get("RateBasedStatement"):
                    self.assertEqual(rate["EvaluationWindowSec"], 300)
                    self.assertEqual(rate["AggregateKeyType"], "IP")

if __name__ == "__main__":
    unittest.main()
