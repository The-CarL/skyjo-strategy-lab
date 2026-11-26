# Phase-two policy league

This preregistered comparison ran **215,040 complete matches**. Each row of the four-seat study faced the same opponent tables. Primary estimates average 3,072 independent deal clusters. The independent confirmation uses 1,536 additional clusters and a different fixed opponent mix. In each cluster the focal policy plays all four seats. Separate two- and six-seat cohorts each use 384 clusters. Win credit is fractional for tied matches.

The nominated paper policy was **family-value-upgrade**. Its promotion decision is **pass**. The seed-11 full-match neural policy's promotion decision is **pass**. Promotion requires at least a 2 percentage point improvement with a positive paired 95% lower bound in each of both four-seat experiments. The paper policy competes against the original family rule; the primary model must pass against every prespecified comparator.

## Win shares

| Focal policy | Four seats, primary | Four seats, confirmation | Two seats | Six seats |
|---|---:|---:|---:|---:|
| threshold-3+clear | 31.13% | 29.12% | 62.24% | 20.51% |
| guarded-prior | 27.88% | 24.50% | 53.71% | 16.38% |
| mlp | 31.96% | 31.12% | 72.98% | 19.81% |
| board | 27.90% | 24.49% | 53.97% | 16.34% |
| family-value-upgrade | 35.75% | 34.16% | 74.67% | 22.92% |
| match-mlp-11 | 39.59% | 38.59% | 79.88% | 26.27% |
| match-mlp-29 | 39.43% | 37.46% | 77.93% | 26.14% |
| match-mlp-47 | 39.22% | 37.37% | 78.26% | 26.37% |
| match-tree-11 | 37.46% | 36.52% | 77.02% | 24.65% |
| matched-round-mlp-11 | 40.91% | 39.93% | 82.36% | 26.27% |

## Paired differences

Entries are percentage points with two-sided 95% seed-cluster intervals. A gain within a single stratum or a single cohort does not satisfy the promotion criterion.

| Difference | Four seats, primary | Four seats, confirmation | Two seats | Six seats |
|---|---:|---:|---:|---:|
| family-value-upgrade minus threshold-3+clear | +4.61 [+3.84, +5.38] | +5.04 [+3.96, +6.12] | +12.43 [+9.26, +15.61] | +2.41 [+0.76, +4.05] |
| match-mlp-11 minus threshold-3+clear | +8.46 [+7.49, +9.42] | +9.48 [+8.12, +10.83] | +17.64 [+14.04, +21.24] | +5.76 [+3.69, +7.82] |
| match-mlp-11 minus guarded-prior | +11.72 [+10.72, +12.71] | +14.09 [+12.68, +15.50] | +26.17 [+22.45, +29.90] | +9.88 [+7.98, +11.78] |
| match-mlp-11 minus mlp | +7.63 [+6.66, +8.61] | +7.47 [+6.08, +8.86] | +6.90 [+3.50, +10.31] | +6.46 [+4.37, +8.55] |
| match-mlp-11 minus board | +11.69 [+10.70, +12.69] | +14.10 [+12.69, +15.51] | +25.91 [+22.20, +29.62] | +9.92 [+8.02, +11.82] |
| match-mlp-11 minus matched-round-mlp-11 | -1.31 [-2.32, -0.31] | -1.33 [-2.72, +0.05] | -2.47 [-5.73, +0.78] | +0.00 [-2.24, +2.24] |
| match-mlp-29 minus threshold-3+clear | +8.30 [+7.34, +9.26] | +8.35 [+7.01, +9.69] | +15.69 [+12.27, +19.11] | +5.63 [+3.62, +7.64] |
| match-mlp-47 minus threshold-3+clear | +8.09 [+7.11, +9.06] | +8.25 [+6.89, +9.61] | +16.02 [+12.08, +19.95] | +5.87 [+3.73, +8.00] |
| match-tree-11 minus threshold-3+clear | +6.33 [+5.36, +7.30] | +7.41 [+6.07, +8.74] | +14.78 [+10.89, +18.66] | +4.14 [+2.12, +6.16] |
| match-tree-11 minus mlp | +5.50 [+4.53, +6.48] | +5.40 [+4.00, +6.81] | +4.04 [+0.32, +7.76] | +4.84 [+2.86, +6.82] |
| mlp minus guarded-prior | +4.09 [+3.10, +5.07] | +6.62 [+5.23, +8.00] | +19.27 [+15.60, +22.94] | +3.42 [+1.54, +5.30] |

The seed-11 neural model is the primary fit frozen in advance. Seeds 29 and 47 show sensitivity to model fitting. The matched-round model shares training observations, candidate moves, sampled worlds, simulated continuation policies and fit seed with the full-match model. Its training target uses end-of-round advantage. Their paired comparison tests changing the target in this fixed training design.

## Opponent mix

Each stratum has a quarter of its cohort's weight. The diagnostic differences below compare the family nominee and primary neural model with the published family rule. Exact opponent lists and behavioral definitions appear in the [frozen protocol](protocol.json). The [summary file](league-summary.json) includes each arm's stratum win shares, all paired differences, and mean final scores.

| Cohort | Opponent stratum | Nominee minus original family | Neural minus original family |
|---|---|---:|---:|
| primary | published-house | +3.40 [+1.90, +4.91] | +6.75 [+4.90, +8.61] |
| primary | positional | +6.72 [+4.99, +8.46] | +10.59 [+8.55, +12.63] |
| primary | finish-and-chase | +1.60 [+0.35, +2.84] | +5.45 [+3.61, +7.30] |
| primary | count-and-gap | +6.74 [+5.12, +8.36] | +11.04 [+9.07, +13.00] |
| confirmation | changed-house | +3.49 [+1.36, +5.63] | +7.50 [+4.62, +10.38] |
| confirmation | learned-and-table | +9.18 [+6.72, +11.64] | +16.89 [+14.18, +19.61] |
| confirmation | deny-and-finish | +1.13 [-0.51, +2.77] | +3.03 [+0.67, +5.39] |
| confirmation | patient-and-chase | +6.37 [+4.07, +8.67] | +10.48 [+7.62, +13.35] |
| duel | published-house | +9.38 [+4.28, +14.47] | +15.36 [+8.94, +21.79] |
| duel | positional | +15.36 [+8.32, +22.41] | +20.31 [+12.00, +28.63] |
| duel | finish-and-chase | +5.99 [+0.48, +11.50] | +13.02 [+6.65, +19.39] |
| duel | count-and-gap | +19.01 [+11.58, +26.44] | +21.88 [+14.36, +29.39] |
| six | changed-house | -0.58 [-3.78, +2.62] | +5.64 [+1.47, +9.82] |
| six | learned-and-table | +4.80 [+0.76, +8.85] | +11.83 [+7.49, +16.17] |
| six | deny-and-finish | +0.93 [-1.51, +3.36] | +2.26 [-1.84, +6.36] |
| six | patient-and-chase | +4.48 [+1.20, +7.77] | +3.30 [-0.58, +7.18] |

The five evaluator-only opponent styles test fast reveals, pair chasing, accepting large score reductions, denying a neighbor a visible triple, and cautious finishing. Every opponent is simulated. Intervals quantify variation between shuffled deals in these specific populations. They do not establish the prevalence of any style at a human table. The two sensitivity fits do not give tight estimates of variation across training runs.

Reproduce with Node 24 and Python 3.12 from the repository root:

```sh
node scripts/study-v2.mjs --workers 2
python3 scripts/study_v2_report.py
```

For a fast independent statistical check, run `python3 scripts/study_v2_report.py --from-published`. The [compressed evidence](league-blocks.json.gz) contains paired values for every shuffle block, effective policy names, source fingerprints, decision counts and the full opponent composition. Within each stratum the block index plus its recorded starting seed recovers the exact deal seed.
