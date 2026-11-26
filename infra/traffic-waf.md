# Optional CloudFront Free firewall

AWS declined to enroll the Skyjo distribution and its dedicated web ACL in the Free flat-rate plan on November 26, 2026. The application uses the [origin rate limiter](traffic.md). These commands document the edge alternative for an eligible subscription.

The `attach` stage creates a metered web ACL until `enroll` succeeds. For an unsuccessful enrollment, `rollback-unenrolled` detaches and deletes only the newly created, unenrolled ACL. Rerun after distribution propagation and verify the removal. Run `verify` only after a Free subscription is active. The Free plan includes up to five rules and an allowance of 1 million requests and 100 GB per month. [AWS plan terms](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html)

## Inspect the public rate limits

Run `verify` to read the current AWS subscription, rule mode, thresholds and window. The three limits apply to each public viewer IP over a rolling five-minute window. A household sharing Wi-Fi shares those allowances. AWS estimates the rate and periodically reevaluates it. A brief burst can pass before the rate rule takes effect. [AWS WAF rate tracking](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based-caveats.html)

| Request | Initial limit per IP per five minutes |
| --- | ---: |
| Start a game | 20 |
| Submit a move or abandon a game | 600 |
| All game API requests combined, including reads | 1,200 |

The game page and physical coach are cached at the edge. Using the physical coach after the page loads requires no game API calls. CloudFront signs calls to the origin. Private boards and history bypass the shared cache.

```bash
stage=verify
run_id="rates-$stage-$(date -u +%Y%m%dT%H%M%SZ)"
export FACTORY_AWS_EXECUTABLE="$PWD/infra/traffic.py"
export FACTORY_AWS_EXECUTABLE_SHA256="$(sha256sum "$FACTORY_AWS_EXECUTABLE" | cut -d' ' -f1)"
factory-aws --exec --record "$SKYJO_OPS/$run_id.jsonl" \
  --output "$SKYJO_OPS/$run_id.result.json" -- "$FACTORY_AWS_EXECUTABLE" \
  "$stage" --run-id "$run_id" --inventory "$SKYJO_OPS/inventory.json"
cat "$SKYJO_OPS/$run_id.result.json"
```

Use `baseline` to read the last hour of one-minute WAF counters. Add `--minutes 1440` to inspect the last day. The starts and moves totals include all viewers. They cannot identify one family's traffic. Newly created metrics may take up to 15 minutes to appear in the metric list. Check `series_discovered` and `reported_minutes` before interpreting zeroes. The rate rules use viewer IP internally while the team's CloudWatch metrics contain aggregate counts. WAF request sampling is disabled.

`count` measures traffic while allowing it through. In `arm`, WAF marks over-limit requests. A viewer-request CloudFront Function returns HTTP 429 with `Retry-After: 300` before they reach Lambda. Only the two API behaviors use the function. `native-block` uses AWS WAF's standard 403 response. Each mode accepts `--starts`, `--moves` and `--api` to tune the limits. Specify all three when changing thresholds, then run `verify` and check that an ordinary player can start or resume a table. Editing a rate rule can reset its rolling estimate. Returning to `count` is the rollback for enforcement. Use a fresh run ID for each stage and serialize changes to the private inventory.

