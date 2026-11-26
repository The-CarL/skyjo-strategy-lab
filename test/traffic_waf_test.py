"""Exercise Skyjo's actual WAF expressions without sending traffic to a live game."""
import base64
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "infra"))
from traffic import DEFAULT_LIMITS, rules


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
