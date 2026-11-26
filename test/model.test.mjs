import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { predict } from '../src/model.ts'
import { policy } from '../scripts/common.mjs'
import { play } from '../src/engine.ts'
const bundle = JSON.parse(
  readFileSync(new URL('../models/policies.json', import.meta.url)),
)
const report = JSON.parse(
  readFileSync(new URL('../reports/training.json', import.meta.url)),
)
test('portable inference reproduces scikit-learn for both exported models', () => {
  for (const row of report.parity)
    for (const name of ['tree', 'mlp'])
      assert.ok(Math.abs(predict(bundle[name], row.x) - row[name]) < 1e-7)
})
test('tree versus neural network terminates on the equal-exchange regression deal', () => {
  for (const seed of [910001, 910010])
    assert.ok(play(['mlp', 'tree'].map(policy), seed).moves < 10000)
})
