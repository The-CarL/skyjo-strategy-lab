# Sustained game throttling

The Skyjo alarm watches the existing function’s `AWS/Lambda` Throttles count. It enters ALARM when at least three requests were throttled per minute in three of the last five one-minute periods. Missing minutes count as zero. A single busy minute leaves the alarm OK. CloudWatch sends one SNS notification when the alarm transitions into ALARM. The alarm records transitions to OK in CloudWatch. It does not change concurrency, stop games, or act as a billing limit.

Use the activated Skyjo deployment session and the private inventory from the [hosting guide](README.md). Supply one authorized recipient in a mode-0600 file outside the repository. The example uses `$SKYJO_OPS/alert-recipient`. Keep the address out of command arguments, terminal history, and Git. Run inventory-writing stages serially with other Skyjo deployment work.

```bash
stage=apply
run_id="alarm-$stage-$(date -u +%Y%m%dT%H%M%SZ)"
export FACTORY_AWS_EXECUTABLE="$PWD/infra/traffic_alarm.py"
export FACTORY_AWS_EXECUTABLE_SHA256="$(sha256sum "$FACTORY_AWS_EXECUTABLE" | cut -d' ' -f1)"
factory-aws --exec --record "$SKYJO_OPS/$run_id.jsonl" \
  --output "$SKYJO_OPS/$run_id.result.json" -- "$FACTORY_AWS_EXECUTABLE" \
  "$stage" --run-id "$run_id" --inventory "$SKYJO_OPS/inventory.json" \
  --recipient-file "$SKYJO_OPS/alert-recipient"
```

Use `stage=status` and a fresh run ID for read-only checks. The output reports the alarm state and whether the single subscription is pending or confirmed. The first apply asks AWS to email a confirmation link. The recipient must open that link to receive alarm mail. Repeat runs check the existing request. If a confirmation expires or an AWS call times out, inspect the project topic and private intent receipt before requesting a new message. CloudWatch may initially show INSUFFICIENT_DATA while it evaluates the metric.

The topic policy permits the CloudWatch service to publish only from the exact same-account Skyjo alarm and requires TLS. Notifications carry infrastructure counts. Customer-managed encryption is omitted because CloudWatch publishing to a KMS-encrypted SNS topic requires a compatible customer-managed key with additional fees. One standard-resolution alarm metric in us-east-1 is approximately $0.10 per month before allowances, plus applicable SNS requests and email deliveries. [CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/) · [SNS pricing](https://aws.amazon.com/sns/pricing/) · [SNS key management](https://docs.aws.amazon.com/sns/latest/dg/sns-key-management.html)
