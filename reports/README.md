# Strategy results

The retained experiment suite contains **57,128 complete games**, including the cutoff selection run and the head-to-head battery. The final four-player experiment contributes 19,200 games. A win shared by two players counts as half a win each.

## A rule for the table

Take an available vertical clear. Otherwise take a 3 or lower to replace your highest visible 4 or higher, or put it in a hidden slot if you have no such card. Pass on a higher discard and draw. After a blind draw, apply the same rule; if you pass, flip a hidden card.

On the final deals, the paired improvement over the original keep-5 rule was **21.0 pp (95% interval 19.03 to 22.89 pp)**. Adding only the clear exception to the original rule yielded 6.4 pp (95% interval 5.07 to 7.66 pp). The family rule minus the neural policy was 2.2 pp (95% interval -0.03 to 4.40 pp). The card counter minus the otherwise equivalent table evaluator was -1.0 pp (95% interval -2.48 to 0.39 pp).

## Frozen four-player comparison

Each row plays against the same three opponents: a keep-3 player that clears and protects pairs, a keep-4 player that clears, and a keep-6 player. Every agent plays every seat for each of 600 untouched shuffle seeds. Different rows can all exceed 25% because each faces its own copy of that table.

| Focal policy | Game win share | Approx. 95% interval | Mean final points |
|---|---:|---:|---:|
| threshold-5 | 14.1% | 12.7–15.5% | 79.7 |
| threshold-5+clear | 20.5% | 18.9–22.0% | 70.6 |
| threshold-3+clear | 35.1% | 33.3–36.8% | 54.6 |
| board | 34.1% | 32.4–35.9% | 58.5 |
| table | 36.9% | 35.2–38.7% | 54.5 |
| counter | 35.9% | 34.1–37.7% | 55.5 |
| tree | 27.8% | 26.2–29.4% | 58.0 |
| mlp | 32.9% | 31.2–34.6% | 55.5 |

Intervals use independent shuffle seeds as clusters. The four seat rotations for each seed stay together. Paired differences reuse those same clusters. Intervals describe simulated deals under the specified lineups. Human opponents can behave differently.

## Head-to-head games

Each cell gives the row player's percentage of wins against the column player across 60 deals, with both seat orders per deal. These 28 matchups include the two recorded model-loop regression seeds. Use the frozen four-player experiment for an independent test of the final learned policies.


| Row vs column | threshold-5 | threshold-3+clear | board | table | counter | tree | mlp | rollout-4 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| threshold-5 | — | 8.3 | 22.5 | 15.0 | 16.7 | 8.3 | 8.3 | 67.1 |
| threshold-3+clear | 91.7 | — | 58.3 | 41.7 | 46.2 | 36.7 | 31.7 | 85.0 |
| board | 77.5 | 41.7 | — | 36.7 | 42.5 | 34.2 | 30.8 | 85.8 |
| table | 85.0 | 58.3 | 63.3 | — | 54.2 | 50.0 | 52.5 | 90.0 |
| counter | 83.3 | 53.8 | 57.5 | 45.8 | — | 48.8 | 53.3 | 87.5 |
| tree | 91.7 | 63.3 | 65.8 | 50.0 | 51.2 | — | 39.2 | 96.7 |
| mlp | 91.7 | 68.3 | 69.2 | 47.5 | 46.7 | 60.8 | — | 95.8 |
| rollout-4 | 32.9 | 15.0 | 14.2 | 10.0 | 12.5 | 3.3 | 4.2 | — |

## Other tables and follow-up questions

| Experiment | Games | Purpose |
|---|---:|---|
| [selection](selection.json) | 5,760 | Choose a family cutoff using its own seeds |
| [cutoffs](cutoffs.json) | 2,400 | Compare keep-4, 5, 6, and 7 |
| [four-player](four-player.json) | 5,760 | Four seats against the original hand-written pool |
| [two-player](two-player.json) | 1,800 | Two seats with rotating opponents |
| [six-player](six-player.json) | 3,600 | Six seats with a different opponent mix |
| [learned-opponents](learned-opponents.json) | 2,160 | Mixed table including learned policies |
| [lookahead](lookahead.json) | 288 | Four-sample search pilot |
| [confirmation](confirmation.json) | 12,800 | New family-rule deals also inspected while developing the model safeguards |
| [final](final.json) | 19,200 | Fresh deals with all models and safeguards frozen |
| [duels](duels.json) | 3,360 | All pairs in both seat orders |

The rollout pilot is small and its continuation policy plays only to the end of the current round. The full-game tournaments expose errors in that approximation. Larger search budgets, other opponent populations, opening layouts, and human game logs are natural follow-up experiments. Reserve new seeds before optimizing again.

## Training

Both models rank up to four legal candidate actions using 18 board-only features. The teacher samples eight hidden worlds consistent with a card counter's observations, compares the candidates to round end, and scores each by its margin against the leading rival, with a match-end bonus. Each target is centered within the decision. The student receives only its own visible board and the available card. A progress rule admits visible exchanges that lower the value or complete a column. It prevents the learned policies from spending a duel trading the same cards.

The 360 source games supplied 8,640 decisions. Whole games were split 80/20 before fitting. The decision tree has depth at most six. The neural net has two ReLU hidden layers of 24 and 12 units. Its 150-epoch training budget expired before the optimizer signaled convergence. The final evaluation measures the exported weights and the deployed action rule together. Per-model teacher agreement, prediction errors, and cross-language parity fixtures appear in [training.json](training.json).
