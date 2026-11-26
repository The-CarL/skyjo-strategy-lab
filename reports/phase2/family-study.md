# Family rules

Seven new paper strategies competed against the original clear-then-keep-3 rule on 11,520 development games. Each candidate played 120 shuffle seeds in all four seats against each of three opponent pools. The preset selection criterion gave all three pools equal weight. `family-value-upgrade` earned the highest average win share, 35.96%, and was frozen before the confirmation games.

## Play the selected rule

1. **Find the ordinary move.** If the available card is 3 or lower, replace your highest visible 4 or higher. Otherwise put the low card into a hidden slot if you can. For a card you have already drawn blind, also accept any swap into your highest visible card that saves at least 4 points. Set aside slots that would complete a triple when identifying this ordinary move.
2. **Compare the clear.** Treat a hidden target as worth 5 for this estimate. A clear saves the sum of the three cards currently in that column. An ordinary exchange saves the target value minus the incoming value. Give a plain draw or flip a saving of zero. Take the best clear if it saves at least as much as the ordinary move.
3. **Resolve the turn.** If you have no useful exchange or clear, draw blind when offered the discard. If already holding a blind draw, discard it and flip the first hidden slot. Choose leftmost column then topmost slot when options tie.

Example: you see two 1s and a hidden card in a column, a 12 elsewhere, and a 1 on the discard pile. Clearing saves an estimated 7. Replacing 12 with 1 saves 11. Take the 1 for the 12. All triples that actually form clear automatically under the game rules.

## Holdout on fresh deals

Each row used 400 previously unused shuffle seeds and all four seat rotations, with split credit for tied winners. Intervals use paired seed-level differences. These are new deals against the development opponent families; results from entirely new opponents are a separate test.

| Three opponents | Original clear/keep-3 | Selected family rule | Difference and approximate 95% interval |
|---|---:|---:|---:|
| Keep-3/clear/protect pairs, keep-4/clear, keep-6 | 34.96% | 38.21% | +3.25 pp (+1.39 to +5.11) |
| Board evaluator, original MLP, keep-2/clear | 28.22% | 35.97% | +7.75 pp (+5.46 to +10.04) |
| Table evaluator, counter, keep-3/clear/protect pairs | 24.41% | 29.84% | +5.44 pp (+3.07 to +7.80) |

[Development parameters and candidate ranks](family-development.json) · [Frozen validation](family-confirmation.json)

## What the alternatives change

| ID | Change relative to original clear/keep-3 |
|---|---|
| family-value-clear | Compare a clear's estimated saving with the alternative. This can decline positive, zero or negative clears. |
| family-pair-break | Protect a visible pair unless breaking it saves at least 5 points. |
| family-build-pair | When placing a positive low card into a hidden slot, prefer a column already showing its value. |
| family-drawn-upgrade | After drawing blind, accept a visible improvement of at least 4 points, even for a high incoming card. |
| family-hidden-first | Keep-3 with a visible target floor of 6; prefer a hidden slot when the highest visible value is 4 or 5. |
| family-value-upgrade | Combine conditional clears and the blind-draw upgrade. |
| family-value-position | Add the visible target floor of 6 and hidden placement beside a matching positive card to family-value-upgrade. The blind-draw upgrade can still qualify a target below 6. |

One cutoff audit independently varied the incoming acceptance threshold for visible targets (V) and hidden targets (H). All four policies prioritize a clear and otherwise swap into the highest visible 4+ only if doing so strictly lowers its value. The controls 3/3, 5/3, 3/5 and 5/5 earned 35.13%, 30.79%, 21.48% and 22.68% against the original four-player opponent pool, and 29.69%, 28.84%, 13.67% and 16.85% against the board/MLP/keep-2 pool. This 5/5 control has a different visible target floor from the original keep-5 strategy. A separate rule required a five-point saving to swap into a visible slot, or a value of 3 or lower for a hidden slot. It earned 31.33% versus 34.44% for clear/keep-3 on another 600 paired seeds.

[Cutoff controls and seed intervals](family-cutoffs.json)

## Reproduce

Run from the repository root with Node 24 or later:

```sh
node scripts/family-study.mjs --stage cutoffs
node scripts/family-study.mjs --stage develop
node scripts/family-study.mjs --stage confirm
```

The development stage writes the selected ID. Confirmation reads that selection without re-ranking. Committed summaries preserve seed ranges, lineups, seat count, means, and paired uncertainty. Full block-level replayable tournament records are generated under `work/phase2/family/`. These simulations used local CPU.
