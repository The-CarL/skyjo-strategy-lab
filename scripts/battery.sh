#!/usr/bin/env bash
set -euo pipefail
# Seed ranges are disjoint from the training generator and from one another.
node scripts/tournament.mjs --players 4 --seeds 240 --seed 800000 --out reports/four-player.json
node scripts/tournament.mjs --players 2 --seeds 150 --seed 810000 --pool threshold-3+clear,threshold-7+clear+pairs,threshold-6 --out reports/two-player.json
node scripts/tournament.mjs --players 6 --seeds 100 --seed 820000 --pool threshold-3+clear,threshold-7+clear+pairs,threshold-6 --out reports/six-player.json
node scripts/tournament.mjs --players 4 --seeds 90 --seed 830000 --pool tree,mlp,threshold-5+clear+pairs --out reports/learned-opponents.json
node scripts/tournament.mjs --players 4 --seeds 24 --seed 840000 --agents threshold-5,mlp,rollout-4 --out reports/lookahead.json
node scripts/tournament.mjs --players 4 --seeds 120 --seed 850000 --agents threshold-5,threshold-4,threshold-6,threshold-7,threshold-5+clear --out reports/cutoffs.json
