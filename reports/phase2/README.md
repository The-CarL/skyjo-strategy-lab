# Which Skyjo strategy made it into the family kit?

**Use “Clear or trade?” at the table.** The new paper rule increased four-player win share by 4.61 percentage points in the primary study and 5.04 in the independent confirmation. The offline coach also offers the whole-match neural network. It uses only your own board and the available card. [Family kit](https://github.com/The-CarL/skyjo-strategy-lab/raw/refs/heads/main/downloads/skyjo-family-kit.zip) · [Printable rules and examples](family-study.md)

| Strategy | Four-player primary | Four-player confirmation |
|---|---:|---:|
| Original clear, then keep 3 | 31.13% | 29.12% |
| Clear or trade? | 35.75% | 34.16% |
| Original round-trained neural network | 31.96% | 31.12% |
| New whole-match decision tree | 37.46% | 36.52% |
| New whole-match neural network | 39.59% | 38.59% |
| Matched round-target neural network | 40.91% | 39.93% |

Each entry is the focal player's share of wins, with fractional credit for ties. All policies faced identical opponent mixes within each column. The confirmation used different opponents and fresh seeds. The paper rule's paired 95% intervals for its gains over the original were +3.84 to +5.38 points and +3.96 to +6.12. For the whole-match network against the original network they were +6.66 to +8.61 and +6.08 to +8.86. The decision tree beat the original neural network on both panels, by 5.50 and 5.40 points. [Full league table and intervals](league.md)

## What the network learned

We sampled 24 decisions from each of 480 generated matches. At each decision we compared up to four playable moves. For each move, the engine played out the same 16 plausible hidden worlds, then dealt further rounds until a player reached 100. Each simulation supplied two labels for the decision-making player: win credit at match end and a score-based reward at the end of the current round. We centered the labels within each decision. The dataset contains 611,104 simulated continuations of these positions. A split by source match assigned 384 matches to training and 96 to validation. [Generation record](../match-generation.json)

An 18-input neural network with 24 and 12 ReLU units used Adam at an initial learning rate of 0.002. The primary fit (seed 11) stopped after 16 epochs. We also fit seeds 29 and 47 on the same data. The regression tree used squared error, depth at most six and a minimum of 30 action rows per leaf. It grew 47 leaves. On the 1,781 validation decisions where the simulated match targets distinguished some actions, the primary network chose a tied-best action 52.78% of the time and the tree did so 53.06% of the time. The deployed policies rank legal shortlisted actions using the board, card and candidate move. Training used simulated public observations and finite samples of concealed cards. [Fit metrics](../match-training.json) · [Training code](../../scripts/train_match.py)

The matched comparison changed only the target while holding the sampled worlds, decisions, features, allowed moves and training seed fixed. The round-target network led the whole-match network by 1.31 points in the primary panel (95% interval +0.31 to +2.32) and 1.33 in confirmation (−0.05 to +2.72). **The whole-match target showed no advantage over the matched round target.** The matched model had the highest observed four-player shares in this league. It was designated a diagnostic before testing. It is available as `matched-round-mlp-11` for further experiments. [League protocol](protocol.json) · [Paired target comparison](league.md)

## How we tested the release

- **Paper rule.** Seven alternatives competed on 11,520 development games. We froze one rule, tested it on 9,600 fresh games against three development opponent families, and entered it into the independent league. A separate 24,000-game audit tested visible and hidden cutoffs and a five-point trade rule. [Family experiments](family-study.md)
- **Main league.** Ten policies played 215,040 complete games. Four-player primary and confirmation cohorts used 3,072 and 1,536 independent shuffle seeds, respectively. Every policy took every seat on each seed. Two- and six-player tests added 384 seeds apiece. Opponents included card counters, learned policies, fast finishers and pair chasers. We required a gain of at least two percentage points and a positive lower paired 95% confidence bound in both four-player panels. The paper rule passed against the original. The prespecified whole-match network passed against the original family rule, original network and the untrained evaluator using the same permitted moves. [Seed-level evidence](league-blocks.json.gz) · [Results by opponent and table size](league.md)
- **Scoring every legal move.** We tuned a board scorer in 31,104 full games and compared own-board scoring, one extra opponent signal, and fuller table context. The research panels used 68,600 games. Another 72,000 portable-coach test games compared against the new family and neural challengers and tested the original shortlist with the same fitted weights. The expanded board scorer beat the whole-match network by 2.31 points in its primary panel and 0.23 in its confirmation (95% interval −1.87 to +2.33). The extra opponent signal also failed its preset bar. These policies remain available in the simulator. [Expanded-action research](expanded.md)

All opponents were simulated. The reported intervals capture deal variation within the specified table populations. A family that plays differently may see a different ranking. The downloadable kit contains both printable cards and a score sheet for trying each rule with the same players. [Family pilot instructions](../../docs/family-pilot.md)

All runs used the existing workspace CPU. Estimated additional AWS spend was **$0**. From the repository root, `npm run phase2:verify` verifies the published league and both coach selections. For training and full simulation commands, see the [reproduction instructions](../../README.md#reproduce-phase-two).
