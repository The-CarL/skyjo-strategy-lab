"""Check the alarm's publisher scope and confirmation retry safety without contacting AWS."""
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "infra"))
from traffic_alarm import TrafficAlarm, alarm_config, topic_policy


class TrafficAlarmTests(unittest.TestCase):
    def test_single_metric_and_publisher(self):
        account = "123456789012"
        alarm = f"arn:aws:cloudwatch:us-east-1:{account}:alarm:skyjo-throttles"
        topic = f"arn:aws:sns:us-east-1:{account}:skyjo-alerts"
        config = alarm_config("skyjo", "skyjo-throttles", topic)
        self.assertEqual(config["AlarmActions"], [topic])
        self.assertEqual((config["Threshold"], config["DatapointsToAlarm"], config["EvaluationPeriods"]), (3, 3, 5))
        self.assertEqual(config["Metrics"][0]["MetricStat"]["Metric"]["Dimensions"], [{"Name": "FunctionName", "Value": "skyjo"}])
        allow, deny = topic_policy(topic, alarm, account)["Statement"]
        self.assertEqual(allow["Principal"], {"Service": "cloudwatch.amazonaws.com"})
        self.assertEqual(allow["Resource"], topic)
        self.assertEqual(allow["Condition"], {"StringEquals": {"aws:SourceAccount": account}, "ArnEquals": {"aws:SourceArn": alarm}})
        self.assertIn("SNS:Publish", deny["Action"])
        self.assertIn("SNS:Subscribe", deny["Action"])
        self.assertTrue(all("*" not in name for name in deny["Action"]))
        self.assertEqual((deny["Effect"], deny["Condition"]["Bool"]["aws:SecureTransport"]), ("Deny", "false"))

    def test_uncertain_confirmation_is_not_resent(self):
        app = object.__new__(TrafficAlarm)
        app.topic = "example"
        app.d = Mock()
        app.d.state = {"resources": {"traffic_topic": {}}}
        app.delivery = Mock(return_value="absent")
        app.d.mutate.side_effect = RuntimeError("network interrupted")
        with self.assertRaisesRegex(RuntimeError, "network interrupted"):
            app.subscribe_once("owner@example.invalid")
        with self.assertRaisesRegex(RuntimeError, "previously requested"):
            app.subscribe_once("owner@example.invalid")
        app.delivery.return_value = "pending_confirmation"
        self.assertEqual(app.subscribe_once("owner@example.invalid"), "pending_confirmation")
        self.assertEqual(app.d.mutate.call_count, 1)


if __name__ == "__main__":
    unittest.main()
