# Skyjo strategy models

## Phase-two models

The whole-match network and CART tree estimate a move’s win credit relative to other candidates in the same position. The matched round-target network uses an end-of-round reward on the same simulations. An independently tuned scorer can also rank every legal action. The [phase-two report](../reports/phase2/README.md) describes training, scores on previously unseen games, and the coach selection criteria. The [fit record](../reports/match-training.json) contains the parameters, effective iterations, validation metrics, and parity fixtures.

## Original models

The two exported estimators predict a candidate's advantage in simulated score-margin units. The goal of deployment is game win share. Predicted scores are useful for ordering moves; they are not calibrated win probabilities.

**Examples.** Reservoir sampling selects up to 24 decisions across each complete game. The training generator varies table size and threshold opponents, then labels up to four distinct candidates per decision using the same eight sampled hidden worlds per candidate. A world contains every publicly known face-up card and a shuffled assignment of the unseen multiset. The independent continuation policy keeps 5 or lower, clears immediately, and protects pairs. Simulations stop at the current round's end. Intermediate targets use margin against the leading rival, including cumulative scores. A capped margin and terminal win bonus apply when the game ends. Subtracting the decision's mean reduces state-to-state score scale.

**Information.** The teacher sees public table information and the discard history. Students have 18 features from their own board, the available card and the candidate action. These include action type, visible target, hidden-card count, estimated own points, available clear, pair changes, expected immediate gain and whether a move closes the round. The shortlist uses an explicit hand-written ordering and retains the draw or flip alternative. Models can only choose shortlisted moves.

**Estimators.** A CART regression tree uses depth six and at least 30 training action rows per leaf. A standardized MLP uses 24 and 12 ReLU units, an identity output, Adam, a 0.002 initial learning rate, and a 150-epoch cap. The serialized weights and tree nodes are portable JSON. The runtime rejects mismatched feature schemas. Training uses 288 whole games; 72 other source games measure teacher agreement and error. Game tournaments evaluate actual win share on separate deal seeds. Training rows are counterfactual simulations, without personal or family game data.

**Guard against cycles.** Two learned agents originally traded unchanged or increasing visible values forever in reproducible two-player deals. A visible exchange now requires strict improvement or a clear. Draws, flips and revealing a hidden target remain available. Two regression tests exercise the original deals. The trained policies' reported strength includes this guard. A family may choose different preferences in the rules engine.

**Limits.** The rollout teacher uses a small sample and a fixed continuation policy. The agents have incomplete information, a limited shortlist and finite opponents. The family coach omits opponent boards and previous-round scores by design. The neural optimizer reached its preset epoch limit. Treat alternative opponent pools, larger rollout budgets and human game logs as new experiments. [Full results](../reports/README.md) · [Training diagnostics](../reports/training.json).
