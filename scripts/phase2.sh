#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/family-study.mjs --stage cutoffs
node scripts/family-study.mjs --stage develop
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const read = name => JSON.parse(readFileSync('reports/phase2/' + name, 'utf8'))
assert.equal(read('family-development.json').frozen, read('nomination.json').policy)
JS
node scripts/family-study.mjs --stage confirm
node scripts/match-dataset.mjs
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 python3 scripts/train_match.py
node scripts/expanded-study.mjs
node scripts/expanded-portable.mjs
node scripts/expanded-report.mjs
node scripts/study-v2.mjs --workers 2
python3 scripts/study_v2_report.py
python3 scripts/study_v2_report.py --from-published
node scripts/coach-release.mjs --check
