# Public game traffic controls

Players and the physical coach use [skyjo.carloperottino.com](https://skyjo.carloperottino.com/). Forge links directly to the game. Game creation is the first operation to restrict during an incident. Players already at a table can continue taking turns, recovering a match and reading history while creation is paused.

## How the live limits work

The CloudFront Function on `/api` and `/api/*` takes the viewer IP from CloudFront and replaces the private forwarding header on every request. Lambda accepts traffic on its URL only from this distribution. The application uses the forwarded address to select a hashed counter in the existing DynamoDB table. A conditional write counts a request before the game handler runs. The address, recovery key and game ID are never stored in the counter. People sharing one public IP share its allowance. Different addresses can occasionally hash to the same counter.

| Request | Limit per public IP in each five-minute window |
| --- | ---: |
| Start a game | 20 |
| Submit a move or abandon a game | 600 |
| All game API requests combined, including reads | 1,200 |

For calibration, a mobile browser played one four-player match through four rounds on November 26, 2026. In 10 minutes 46 seconds it sent one start, 100 move commands and three reads. Its busiest rolling five minutes contained 49 API requests. The test modeled one person playing three bots on one connection.

The counters reset at clock-aligned five-minute boundaries. Traffic split across two windows can briefly reach twice the stated rate. A limited request receives HTTP 429 and a `Retry-After` delay. A player can retry after that delay without duplicating a move or losing a saved game. The public table and physical coach load from CloudFront’s cache. Once loaded, the physical coach needs no game API calls.

AWS Shield Standard and CloudFront provide network-level DDoS protection. Checks for excessive game requests run inside Lambda, so a rejected API request can still invoke Lambda and consume database capacity. The existing two concurrent Lambda executions and the DynamoDB throughput limits bound how much computing and database work can run at once. A large surge from many distinct addresses can still slow play. The game creation pause below keeps new tables from competing with existing matches during an incident.

The origin limiter adds no monthly service subscription. Normal admitted API requests also write a small counter in the existing table. CloudFront, Lambda, DynamoDB, storage and the sustained-throttling alarm follow their usual prices. For example, 100,000 extra one-unit DynamoDB writes at the US East (N. Virginia) on-demand standard rate cost about $0.06 before allowances. [DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/on-demand/) · [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/)

## Inspect or adjust the limits

Run this in an activated Skyjo factory session with the existing private inventory and the tested Lambda ZIP built from the same release. Set `stage=status` for read-only inspection. `count` admits requests and records would-be denials. `enforce` returns 429 to the over-limit caller. `off` turns off origin rate checks. Every stage needs a fresh private operation record.

```bash
stage=status
run_id="origin-rates-$stage-$(date -u +%Y%m%dT%H%M%SZ)"
export FACTORY_AWS_EXECUTABLE="$PWD/infra/origin_rate.py"
export FACTORY_AWS_EXECUTABLE_SHA256="$(sha256sum "$FACTORY_AWS_EXECUTABLE" | cut -d' ' -f1)"
factory-aws --exec --record "$SKYJO_OPS/$run_id.jsonl" \
  --output "$SKYJO_OPS/$run_id.result.json" -- "$FACTORY_AWS_EXECUTABLE" \
  "$stage" --run-id "$run_id" --inventory "$SKYJO_OPS/inventory.json"
cat "$SKYJO_OPS/$run_id.result.json"
```

To change limits, run `count` with `--starts`, `--moves` and `--api`, then run `enforce` on the verified settings. The operator command takes a revision-checked update, checks for a real counter increment and saves its readback in the private inventory. The existing application log group reports `would_limit`, `limited` and `store_unavailable` without player identifiers. Denial logs are sampled to control log volume. A DynamoDB capacity or availability failure returns 503 with a short retry delay.

For a fresh deployment, install the trusted header with `infra/traffic_viewer.py install`, wait for the distribution to finish deploying and verify it with `infra/traffic_viewer.py verify`. Run `infra/origin_rate.py prepare` to add the counter-only DynamoDB policy. Deploy the matching ZIP through `infra/online.py`, run `count`, check ordinary play, then run `enforce`. To retire the header, turn the guard `off` before invoking `infra/traffic_viewer.py detach`. Use the private wrapper and inventory for each stage.

The [optional AWS WAF deployment notes](traffic-waf.md) cover the edge configuration evaluated for this project.

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

The [alarm](traffic-alarm.md) counts throttled requests on the game function. For the affected minutes, compare Lambda `Invocations` and `Throttles`, DynamoDB `ReadThrottleEvents` and `WriteThrottleEvents`, and `scope=traffic` warnings in the game’s log group. A warning identifies the affected request category. If new games are competing with players taking turns, pause starts, confirm an existing match can still resume, and reopen creation when the surge passes. Keep the concurrency and table limits in place while investigating. Only the owner’s AWS role can operate the switch.
