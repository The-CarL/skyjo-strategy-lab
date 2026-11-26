# Skyjo Strategy Lab

A reproducible Skyjo simulator for benchmarking human heuristics, card-counting agents, and learned strategies, with a live coach for tabletop play.

**Play at the table.** [Download the family kit](https://github.com/The-CarL/skyjo-strategy-lab/raw/refs/heads/main/downloads/skyjo-family-kit.zip), extract it, and open `skyjo-coach.html` in a browser that runs local HTML. It includes its code, styles, and trained weights. Enter the visible cards and tap the top discard. The coach highlights a move, handles the blind-draw decision, clears columns, and supports undo. The current board is saved on-device when browser storage is available. The [one-page strategy card](downloads/skyjo-strategy-card.pdf) works at any table, including phones whose file preview disables scripts.

**Read the experiment.** The [tournament report](reports/README.md) covers 57,128 complete games and includes the full head-to-head matrix. In the final four-player test, taking an immediate clear and otherwise keeping 3 or lower earned 35.1% of wins. The original keep-5 policy earned 14.1%. The comparison used the same opponents, deals, and seat rotations. These rates apply to that opponent mix.

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

Append `+open-pair` or `+open-random` to any CLI policy to change its two opening slots. The published battery uses two cards in different columns throughout.

### Add a strategy

Implement `Policy.choose(view, rng)`, optionally request a public count with `count: true`, and register its name in `builtIn` or the CLI policy loader. `legal(view)` gives all valid actions. Draw selection and post-draw placement are separate decisions. Each policy gets its own random stream, isolated from the dealer. The state representation uses four columns of three slots; slot 0 is the top-left, slot 1 is directly below it. Replays record actual openings and actions, so later policy changes do not affect verification.

### Reproduce training and the published battery

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

### Verify and package the offline coach

```sh
npm run build
python -m pip install playwright==1.62.0
python -m playwright install chromium
python test/coach_smoke.py
python scripts/package.py
python scripts/package.py --verify
```

The browser test exercises the download, all four advice modes, column clearing, blind draws, undo, refresh, mobile width, and the printable card. `CHROMIUM_PATH` selects an installed browser. If a managed browser limits file navigation, `COACH_LOOPBACK=1` serves only the local HTML document on loopback; the test disables networking during play.

## Rules and conventions

The engine implements classic Skyjo for 2–8 seats with the standard 150-card deck. A finished vertical triple clears immediately and final reveals can clear columns. After each other player's final turn, a finisher who ties or loses the round doubles positive points. A full game ends after a round takes any cumulative score to 100 or more.

The first seat among tied opening totals starts the first round; subsequent rounds start with the previous closer. An exhausted draw pile recycles buried discards while retaining the face-up top card. Tied match winners split win credit. These explicit simulation conventions and the deterministic slot tie-break make the experiments reproducible. The competition runner stops with an error for a pathological custom lineup that exceeds 100,000 decisions, so unfinished games cannot silently enter win statistics. The coach accepts only your own visible table information. It cannot apply the full-table or counting modes from partial input.

Independent project. [Official game overview](https://magilano.com/en/products/skyjo) · [Publisher's rule sheet (French PDF)](https://cdn.1j1ju.com/medias/ee/b8/88-skyjo-regle.pdf).
