# Public game traffic controls

Players and the physical coach use [skyjo.carloperottino.com](https://skyjo.carloperottino.com/). Forge links directly to the game. Game creation is the first operation to restrict during an incident. Players already at a table can continue taking turns, recovering a match and reading history while creation is paused.

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
