# Skyjo Strategy Lab

A reproducible Skyjo simulator for benchmarking human heuristics, card-counting agents, and learned strategies, with a live coach for tabletop play.

**[Play Skyjo online](https://skyjo.carloperottino.com/)** against up to seven computer opponents. The server saves each move and records completed matches in your private history.

**[Coach a physical game on your phone](https://skyjo.carloperottino.com/coach).** Tap the two cards you revealed in real life, then enter the top discard or the card you actually drew. The coach recommends a move and highlights the slot. Tap any slot to update your board, apply the move you played, or undo a change. The coach saves this board on your device and needs only your own cards. The strategy selector explains each of the six coach modes. The downloadable family kit includes the same coach and two printable strategy cards. [Download the offline kit](https://github.com/The-CarL/skyjo-strategy-lab/raw/refs/heads/main/downloads/skyjo-family-kit.zip)

**Original benchmark.** The [tournament report](reports/README.md) covers 57,128 complete games and includes the full head-to-head matrix. In the final four-player test, taking an immediate clear and otherwise keeping 3 or lower earned 35.1% of wins. The original keep-5 policy earned 14.1%. The comparison used the same opponents, deals, and seat rotations. These rates apply to that opponent mix.

**Phase two.** The [new experiments](reports/phase2/README.md) compare seven paper rules, a decision tree and neural networks trained on simulated match outcomes, and a scorer that evaluates every legal move. The [league](reports/phase2/league.md) used 2-, 4- and 6-player tables. The [printable family pilot](docs/family-pilot.md) lets you compare two strategies offline at your own table.

## Play a match online

Select 2–8 total players, including yourself, then choose a strategy for each computer opponent. You can mix styles or use the same one in multiple seats. Open **Strategy guide** during setup or from the scoreboard to see what each opponent can observe, how it chooses a move, and a worked example. You play one board, from your two opening reveals through the final scoring round. Drawing from the stock lets you exchange the drawn card or discard it and flip a hidden card. Taking the visible discard requires an exchange. Rounds continue until a player reaches 100 total points. The lowest total wins.

The online game saves your progress and results on the server. Return with the same browser to resume. To throw away an unfinished game, choose **Abandon game** and confirm. You can start a fresh table right away. Only completed games enter Match history. Keep a private copy of your recovery key to access the same matches on another browser. Anyone who has that key can access and play your matches.

**Moving a saved game to the Forge address.** On an already-open tab at the [original AWS address](https://lin3byzlstcyscggn7lkbujkb40iqzec.lambda-url.us-east-1.on.aws/), open **Recovery key** and copy your key. At [skyjo.carloperottino.com](https://skyjo.carloperottino.com/), paste it under **Recovery key to restore**. This opens the same online match and history. Save the current key first if you have already started a different profile on the new site.

If the old address shows an AWS access-denied response, keep its browser data. In desktop Chrome or Edge, visit that exact old HTTPS address in the browser profile you used to play. Open Developer Tools → Application → Local storage, select the old origin, and copy the value of `skyjo-online-profile-v1`. Paste it only into the recovery form on the game site. The physical coach stores its board separately. You can finish it in an old open tab or tap the visible cards into the [phone coach](https://skyjo.carloperottino.com/coach).

For local development, run `npm ci` and `npm run online:dev`, then open `http://127.0.0.1:4175/`. The development server keeps test games in memory for the lifetime of the process. `npm run online:package` produces the server and browser assets together in `online-dist/skyjo-online.zip`.

## Run the lab

Use Node 24 or later. Node runs the TypeScript simulation directly. The only JavaScript development dependencies are the type checker and offline bundler.

```sh
npm ci
npm run check
npm test
npm run build
npm run tournament -- --players 4 --agents threshold-5,threshold-3+clear,board,counter,tree,mlp --seeds 100 --seed 700000 --out work/my-table.json
npm run replay -- --agents threshold-3+clear,table,tree,mlp --seed 42
npm run replay -- --verify work/replay.json
```

The tournament runner plays each focal agent against the named opponent pool. The pool rotates by seed; seats rotate within seed. Use `--pool` to change the opponents. For two-player all-pairs competition use `node scripts/duels.mjs`. JSON output retains the seed blocks for recomputing paired comparisons. Use a fresh seed range for an independent experiment.

| Policy name | Decision and information |
|---|---|
| `random` | Random draw/discard choice and legal targets. |
| `threshold-K` | Keep K or lower. Replace the highest visible card above K, otherwise replace a hidden card. Pass on higher cards. |
| `+clear`, `+pairs` | Optional threshold suffixes. Prioritize an immediate vertical clear, or preserve visible pairs when replacing high cards. |
| `board` | Evaluate immediate points, pair value and exposure using your board. |
| `table` | Add public opponent boards and the risk of doubling when finishing. |
| `counter` | Add the exact unseen-card histogram from the public discard history and visible cards. |
| `rollout-N` | Compare a shortlist of candidates in N compatible hidden worlds and simulate to the end of the round. |
| `tree`, `mlp` | Rank that board-only shortlist with trained regression models and a progress rule for visible exchanges. |
| `family-value-upgrade` | Compare the savings from a clear and a regular exchange. After drawing blind, accept a visible saving of 4 or more. |
| `guarded-prior` | Rank the same shortlist and use the same progress rule as the learned policies, using the fixed heuristic score. |
| `match-mlp-11`, `match-tree-11` | Estimate centered match win credit on that shortlist with a neural network or decision tree. Seeds 29 and 47 are also available. |
| `matched-round-mlp-11` | Matched neural comparison using the round score on the same sampled branches. |
| `expanded-board`, `expanded-urgency`, `expanded-table` | Use fitted action weights to score every legal move, with increasing amounts of public table information. |

Append `+open-pair` or `+open-random` to any CLI policy to change its two opening slots. The published battery uses two cards in different columns throughout.

### Add a strategy

Implement `Policy.choose(view, rng)`, optionally request a public count with `count: true`, and register its name in `builtIn` or the CLI policy loader. `legal(view)` gives all valid actions. Draw selection and post-draw placement are separate decisions. Each policy gets its own random stream, isolated from the dealer. The state representation uses four columns of three slots; slot 0 is the top-left, slot 1 is directly below it. Replays record actual openings and actions, so later policy changes do not affect verification.

### Reproduce the original training and battery

Use Python 3.12. Install the training dependencies in a virtual environment. CPU training and simulations run locally; the project creates no AWS resources.

```sh
python -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-train.txt
npm run dataset -- --games 360 --samples 8 --states 24
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 python scripts/train.py
bash scripts/battery.sh
bash scripts/confirm.sh
python scripts/report.py
npm test
```

The default dataset path is `work/training.jsonl`. Every generated training decision comes from a full game with a recorded seed. Training and validation are split by source game. The exported [model bundle](models/policies.json) runs in TypeScript without Python or a network connection. [Training metrics](reports/training.json) include reference predictions checked by the test suite. The [study report](reports/README.md) describes the teacher, model features, search limits, and evaluation design.

### Reproduce phase two

Use Node 24 and Python 3.12. After `npm ci`, run `npm run phase2:verify` to check the league summary and coach selections from the published shuffle blocks. This takes seconds and uses Python's standard library. To regenerate the training data, fits, and all three experimental studies on CPU, install `requirements-train.txt` in a virtual environment and run `npm run phase2:reproduce`. The [phase-two report](reports/phase2/README.md) links the recorded parameters and individual commands. Running each study from its published weights reproduces its evaluation independently of numerical differences between training libraries.

### Verify and package the offline coach

```sh
npm run build
python -m pip install playwright==1.62.0
python -m playwright install chromium
python test/coach_smoke.py
python scripts/package.py
python scripts/package.py --verify
```

The browser test exercises the download, the shipped advice modes, column clearing, blind draws, undo, refresh, mobile width, and the printable card. `CHROMIUM_PATH` selects an installed browser. If a managed browser limits file navigation, `COACH_LOOPBACK=1` serves only the local HTML document on loopback; the test disables networking during play.

## Rules and conventions

The engine implements classic Skyjo for 2–8 seats with the standard 150-card deck. A finished vertical triple clears immediately and final reveals can clear columns. After each other player's final turn, a finisher who ties or loses the round doubles positive points. A full game ends after a round takes any cumulative score to 100 or more.

The first seat among tied opening totals starts the first round; subsequent rounds start with the previous closer. An exhausted draw pile recycles buried discards while retaining the face-up top card. Tied match winners split win credit. These explicit simulation conventions and the deterministic slot tie-break make the experiments reproducible. The competition runner stops with an error for a pathological custom lineup that exceeds 100,000 decisions, so unfinished games cannot silently enter win statistics. The coach accepts only your own visible table information. It cannot apply the full-table or counting modes from partial input.

Independent project. [Official game overview](https://magilano.com/en/products/skyjo) · [Publisher's rule sheet (French PDF)](https://cdn.1j1ju.com/medias/ee/b8/88-skyjo-regle.pdf).
