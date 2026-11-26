# Expanded-action models

A CPU-only search fitted six own-board action weights directly to split win credit in complete games to 100. The scorer evaluates every legal move, including visible uphill exchanges that build pairs and alternatives to a negative clear. One untrained control uses the same scoring formula with the initial weights. The deployed board evaluator and family rule supply additional controls.

Four generations evaluated 14 weight vectors apiece. Each generation used 48 matched deals in all four seats. Its four highest-scoring vectors set the next sampling distribution. The best vector per generation, the initial vector, and the final center advanced to another 200 deals for selection. Training mixed two four-player opponent populations at equal weight. The three public-context coefficients were then fitted with the board weights frozen: risk of doubling on closure, near-closure reveal urgency, and pace when a player approaches 100. These training and validation stages used 31,104 full matches combined. No neural-network training data or cloud service was needed for these fits.

The urgency-only variant receives a single extra signal: at least one other player has at most one hidden card. It shares the fitted table model’s urgency coefficient. The full-table model additionally consumes public opponent board estimates and match standings. None of these policies reads hidden cards or the order of the deck.

## Effect of tuning and public information

Values are paired percentage-point differences in win share with nominal 95% intervals. Each independent shuffle seed contributes the mean of its seat rotations. Primary deals use a training-style opponent mix; the other panels use distinct profiles that include existing learned models.

| Panel | Fitted board minus raw board | Fitted board minus existing board | Fitted board minus family | Table minus fitted board | Urgency-only minus fitted board |
|---|---:|---:|---:|---:|---:|
| primary | 8.2 [6.8, 9.6] | 8.7 [7.3, 10.1] | 6.7 [5.2, 8.1] | 0.0 [-0.3, 0.3] | -0.1 [-0.4, 0.3] |
| held-four | 16.9 [14.8, 19.0] | 17.4 [15.3, 19.5] | 10.5 [8.2, 12.8] | 0.1 [-0.3, 0.6] | -0.2 [-0.7, 0.3] |
| held-two | 21.8 [18.0, 25.6] | 21.6 [17.9, 25.4] | 15.1 [11.2, 19.1] | 0.4 [-0.6, 1.3] | -0.6 [-1.4, 0.3] |
| held-six | 8.0 [5.7, 10.4] | 8.6 [6.2, 10.9] | 7.5 [5.0, 9.9] | -0.1 [-0.5, 0.4] | -0.1 [-0.5, 0.4] |

## Independent portable-coach gate

Each four-player deal used all seat rotations. Within both the primary and confirmation panels, two lineups contributed equal numbers of deals. A portable contender had to exceed every registered control by at least two percentage points and have a positive lower interval bound on each panel. The urgency contender also had to clear that bar against the same fitted board without the extra input.

| Panel | Fixed opponent mixtures | Expanded board win share | Family | Family nominee | Board evaluator | Original neural net | Full-match neural net | Urgency minus fitted board (pp) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| primary | 1200 deals | 45.0% | 35.6% | 39.4% | 32.2% | 34.9% | 42.7% | -0.3 [-0.6, 0.1] |
| confirmation | 600 deals | 39.2% | 30.2% | 35.3% | 27.0% | 33.2% | 39.0% | 0.0 [-0.5, 0.5] |

Passing portable variants: none. The machine-readable report includes each required paired contrast and the criterion applied.

## Effect of opening the shortlist

Here each fitted scorer uses identical weights and legal-order tie breaking. Only the pool it ranks changes: all legal actions versus the original hand-picked shortlist of at most four. The comparison measures the inference-time restriction for these fitted weights. Training a model from scratch under the restricted action space would be a different experiment.

| Panel | All-action board minus shortlisted board (pp) | All-action table minus shortlisted table (pp) |
|---|---:|---:|
| primary | 0.3 [-0.1, 0.7] | 0.2 [-0.2, 0.6] |
| confirmation | 0.1 [-0.6, 0.7] | 0.0 [-0.6, 0.7] |

[Training history](expanded-training.json) · [Research panels](expanded.json) · [Frozen portable protocol](expanded-portable-protocol.json) · [Portable contrasts and deal blocks](expanded-portable.json) · [Released weights](../../models/expanded.json)

Reproduce from the repository root:

```sh
node scripts/expanded-study.mjs
node scripts/expanded-portable.mjs
node scripts/expanded-report.mjs
```
