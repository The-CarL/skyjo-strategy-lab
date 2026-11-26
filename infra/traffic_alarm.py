#!/usr/bin/env python3
"""Provision or inspect the Skyjo Lambda throttle alarm through factory-aws."""
import argparse
import json
import re
import sys
from pathlib import Path

from online import Deployment, Recovery, REGION, ROOT, aws, require


def topic_policy(topic, alarm, account):
    return {"Version": "2012-10-17", "Statement": [
        {"Sid": "CloudWatchAlarm", "Effect": "Allow", "Principal": {"Service": "cloudwatch.amazonaws.com"},
         "Action": "SNS:Publish", "Resource": topic,
         "Condition": {"StringEquals": {"aws:SourceAccount": account}, "ArnEquals": {"aws:SourceArn": alarm}}},
        {"Sid": "RequireTLS", "Effect": "Deny", "Principal": "*", "Action": "SNS:*", "Resource": topic,
         "Condition": {"Bool": {"aws:SecureTransport": "false"}}},
    ]}


def alarm_config(function, name, topic):
    return {
        "AlarmName": name, "AlarmDescription": "Skyjo online play: at least 3 Lambda throttles in 3 of 5 minutes. Inspect the function before changing concurrency.",
        "ActionsEnabled": True, "AlarmActions": [topic], "OKActions": [], "InsufficientDataActions": [],
        "EvaluationPeriods": 5, "DatapointsToAlarm": 3, "Threshold": 3,
        "ComparisonOperator": "GreaterThanOrEqualToThreshold", "TreatMissingData": "notBreaching",
        "Metrics": [
            {"Id": "m", "MetricStat": {"Metric": {"Namespace": "AWS/Lambda", "MetricName": "Throttles",
             "Dimensions": [{"Name": "FunctionName", "Value": function}]}, "Period": 60, "Stat": "Sum"},
             "ReturnData": False},
            {"Id": "throttles", "Expression": "FILL(m, 0)", "Label": "Throttles per minute", "ReturnData": True},
        ],
    }


class TrafficAlarm:
    def __init__(self, d):
        self.d = d
        require(d.has("function") and d.state["resources"]["function"]["id"] == d.lambda_arn,
                "Restore the existing Skyjo inventory first")
        d.verify("function", aws("lambda", "list-tags", {"Resource": d.lambda_arn})["Tags"])
        self.name = d.name + "-sustained-throttles"
        self.arn = f"arn:aws:cloudwatch:{REGION}:{d.account}:alarm:{self.name}"
        self.topic_name = d.name + "-alerts"
        self.topic = f"arn:aws:sns:{REGION}:{d.account}:{self.topic_name}"
        self.policy = topic_policy(self.topic, self.arn, d.account)
        self.config = alarm_config(d.name, self.name, self.topic)

    def topic_attributes(self):
        try:
            return aws("sns", "get-topic-attributes", {"TopicArn": self.topic})["Attributes"]
        except RuntimeError as exc:
            if str(exc) == "sns.get-topic-attributes NotFound":
                return None
            raise

    def verify_topic(self):
        self.d.verify("traffic_topic", aws("sns", "list-tags-for-resource", {"ResourceArn": self.topic})["Tags"])
        data = self.topic_attributes()
        require(data and data["TopicArn"] == self.topic and json.loads(data["Policy"]) == self.policy
                and not data.get("KmsMasterKeyId"), "Topic publisher, transport, or encryption configuration differs")

    def install_topic(self):
        attrs = self.topic_attributes()
        if not self.d.has("traffic_topic"):
            require(attrs is None, "Topic name already exists without an ownership receipt")
            result = self.d.mutate("sns", "create-topic", {"Name": self.topic_name, "Tags": self.d.tag_pairs()})
            require(result["TopicArn"] == self.topic, "Unexpected new topic")
            self.d.remember("traffic_topic", self.topic, "AWS::SNS::Topic", "function")
            attrs = self.topic_attributes()
        self.d.verify("traffic_topic", aws("sns", "list-tags-for-resource", {"ResourceArn": self.topic})["Tags"])
        require(attrs and attrs["TopicArn"] == self.topic and not attrs.get("KmsMasterKeyId"), "Topic identity or encryption differs")
        if json.loads(attrs["Policy"]) != self.policy:
            # The factory owns the topic and has its creation receipt before any policy update.
            self.d.mutate("sns", "set-topic-attributes", {"TopicArn": self.topic, "AttributeName": "Policy",
                                                          "AttributeValue": json.dumps(self.policy)})
        self.verify_topic()

    def alarm(self):
        alarms = aws("cloudwatch", "describe-alarms", {"AlarmNames": [self.name]})
        require(not alarms.get("CompositeAlarms"), "A composite alarm already uses this name")
        return next(iter(alarms["MetricAlarms"]), None)

    def verify_alarm(self):
        current = self.alarm()
        require(current and current["AlarmArn"] == self.arn, "Expected alarm unavailable")
        self.d.verify("traffic_alarm", aws("cloudwatch", "list-tags-for-resource", {"ResourceARN": self.arn})["Tags"])
        # Metric queries are a set in the readback. Ignore AWS response ordering.
        for k, value in self.config.items():
            actual = current.get(k)
            if k == "Metrics":
                actual = sorted(actual or [], key=lambda m: m["Id"])
                value = sorted(value, key=lambda m: m["Id"])
            require(actual == value, "Alarm configuration differs: " + k)
        return current["StateValue"]

    def install_alarm(self):
        current = self.alarm()
        if not self.d.has("traffic_alarm"):
            require(current is None, "Alarm name already exists without an ownership receipt")
            self.d.mutate("cloudwatch", "put-metric-alarm", {**self.config, "Tags": self.d.tag_pairs()})
            self.d.remember("traffic_alarm", self.arn, "AWS::CloudWatch::Alarm", "function")
        return self.verify_alarm()

    def delivery(self, address):
        rows = aws("sns", "list-subscriptions-by-topic", {"TopicArn": self.topic})
        require(not rows.get("NextToken"), "Unexpected subscription count")
        rows = rows["Subscriptions"]
        require(len(rows) <= 1 and all(row["Protocol"] == "email" and row["Endpoint"] == address for row in rows),
                "A different subscription already exists on the project topic")
        if not rows:
            return "absent"
        arn = rows[0]["SubscriptionArn"]
        if arn in {"PendingConfirmation", "pending confirmation"}:
            return "pending_confirmation"
        require(arn.startswith(self.topic + ":"), "Unrecognized subscription state")
        attrs = aws("sns", "get-subscription-attributes", {"SubscriptionArn": arn})["Attributes"]
        require(attrs["TopicArn"] == self.topic and attrs["Protocol"] == "email" and attrs["Endpoint"] == address,
                "Confirmed subscription does not match the requested destination")
        return "pending_confirmation" if attrs["PendingConfirmation"].lower() == "true" else "confirmed"

    def subscribe_once(self, address):
        state = self.delivery(address)
        metadata = self.d.state["resources"]["traffic_topic"].setdefault("details", {})
        if state == "absent":
            # Record the intent before SNS sends the confirmation. Never resend on a retry,
            # including after an ambiguous provider response or an expired confirmation.
            require(not metadata.get("confirmation_requested"), "Confirmation previously requested. Reconcile delivery before resending")
            metadata["confirmation_requested"] = True
            self.d.save()
            self.d.mutate("sns", "subscribe", {"TopicArn": self.topic, "Protocol": "email", "Endpoint": address})
            state = self.delivery(address)
            require(state != "absent", "Confirmation not visible yet: use status before any retry")
        return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("apply", "status"))
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--recipient-file", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    require(re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args.run_id), "Invalid run ID")
    path = args.recipient_file.resolve()
    require(path.is_file() and not path.is_relative_to(ROOT) and path.stat().st_mode & 0o077 == 0,
            "Use a private recipient file outside the repository")
    address = path.read_text().strip()
    require(re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", address), "Invalid recipient")
    d = Deployment(args)
    app = TrafficAlarm(d)
    if args.stage == "apply":
        app.install_topic()
        state = app.install_alarm()
        subscription = app.subscribe_once(address)
        Recovery(d).backup()
    else:
        app.verify_topic()
        state = app.verify_alarm()
        subscription = app.delivery(address)
    print(json.dumps({"alarm": state, "alarm_actions": 1, "email": subscription}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        sys.exit(str(error))
