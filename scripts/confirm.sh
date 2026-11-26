#!/usr/bin/env bash
set -euo pipefail
# First select the family cutoff. Then freeze threshold-3+clear and evaluate on fresh deals.
node scripts/tournament.mjs --players 4 --agents threshold-5,threshold-0+clear,threshold-1+clear,threshold-2+clear,threshold-3+clear,threshold-4+clear,board,table,counter --seeds 160 --seed 600000 --out reports/selection.json
node scripts/tournament.mjs --players 4 --agents threshold-5,threshold-5+clear,threshold-3+clear,board,table,counter,tree,mlp --seeds 400 --seed 900000 --pool threshold-3+clear+pairs,threshold-4+clear,threshold-6 --out reports/confirmation.json
node scripts/duels.mjs
# Untouched final benchmark after diagnosing the duel regression. Never tune on this run.
node scripts/tournament.mjs --players 4 --agents threshold-5,threshold-5+clear,threshold-3+clear,board,table,counter,tree,mlp --seeds 600 --seed 950000 --pool threshold-3+clear+pairs,threshold-4+clear,threshold-6 --out reports/final.json
