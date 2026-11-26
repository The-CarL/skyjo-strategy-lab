# Public game traffic controls

Players and the physical coach use [skyjo.carloperottino.com](https://skyjo.carloperottino.com/). Forge links directly to the game. Game creation is the first operation to restrict during an incident. Players already at a table can continue taking turns, recovering a match and reading history while creation is paused.

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

## Pause or resume new games

The owner can run this from an activated Skyjo factory session, using the existing private release inventory. Read the current status first. Change `action` to `pause` or `resume` and rerun the block for a fresh operation record.

```bash
action=status
run_id="new-games-$action-$(date -u +%Y%m%dT%H%M%SZ)"
export FACTORY_AWS_EXECUTABLE="$PWD/infra/pause.py"
export FACTORY_AWS_EXECUTABLE_SHA256="$(sha256sum "$FACTORY_AWS_EXECUTABLE" | cut -d' ' -f1)"
factory-aws --exec --record "$SKYJO_OPS/$run_id.jsonl" \
  --output "$SKYJO_OPS/$run_id.result.json" -- "$FACTORY_AWS_EXECUTABLE" \
  "$action" --run-id "$run_id" --inventory "$SKYJO_OPS/inventory.json"
cat "$SKYJO_OPS/$run_id.result.json"
```

Every new game transaction checks the owner switch. A request that already created a game can still retrieve it if the original response was lost. A paused start returns 503 with a retry delay and keeps the lineup editable. After resuming, a warm server may take up to five seconds to allow a new start.

## Respond to sustained throttling

The [alarm](traffic-alarm.md) counts throttled requests on the game function. Look at the affected minutes alongside starts, moves and DynamoDB throttling. If new games are competing with players taking turns, pause starts, confirm an existing match can still resume, and reopen creation when the surge passes. Keep the concurrency and table limits in place while investigating. Only the owner’s AWS role can operate the switch.
