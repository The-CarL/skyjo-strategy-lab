import test from 'node:test'
import assert from 'node:assert/strict'
import { deal, observe, random } from '../src/engine.ts'
import { guardedCandidates, guardedPrior } from '../src/model.ts'
import { matchLabels, roundUtility, winCredit } from '../src/match-teacher.ts'
import { threshold } from '../src/policies.ts'

test('full-match labels and round controls use the same eligible candidate set and sampled worlds', () => {
  const s = deal([68, 91, 74, 92], random(43))
  const v = observe(s, true)
  let calls = 0
  const sample = (seats, rng) => {
    calls++
    return Array.from({ length: seats }, () =>
      threshold(3 + Math.floor(rng() * 3), true),
    )
  }
  const labels = matchLabels(v, random(10), 5, sample)
  assert.equal(calls, 5)
  const cs = guardedCandidates(v)
  assert.deepEqual(
    labels.x,
    cs.map((c) => c.f),
  )
  assert.deepEqual(
    guardedPrior.choose(v, random(99)),
    [...cs].sort((a, b) => b.value - a.value)[0].a,
  )
  assert.equal(labels.simulatedMatches, 5 * cs.length)
  assert.ok(labels.simulatedRounds >= labels.simulatedMatches)
  const mean = labels.credit.reduce((s, x) => s + x, 0) / cs.length
  for (const [i, x] of labels.credit.entries()) {
    assert.ok(x >= 0 && x <= 1)
    assert.ok(Math.abs(labels.y[i] - (x - mean)) < 1e-12)
  }
  assert.ok(Math.abs(labels.yRound.reduce((a, b) => a + b, 0)) < 1e-10)
  assert.deepEqual(matchLabels(v, random(10), 5, sample), labels)
  assert.deepEqual(observe(s, true), v)
})
test('matched round control preserves score margin, bounded terminal reward and tied win credit', () => {
  assert.equal(roundUtility([35, 33, 70], 0), -2)
  assert.equal(roundUtility([80, 85, 102], 0), 41.25)
  assert.equal(roundUtility([80, 80, 100], 0), 20)
  assert.equal(roundUtility([105, 55], 0), -50)
  assert.equal(winCredit([0, 2], 2), 0.5)
  assert.equal(winCredit([0, 2], 1), 0)
})

test('teacher labels do not depend on the actual hidden assignment behind a counter view', () => {
  const s = deal([67, 55, 90], random(31))
  const v1 = observe(s, true)
  const slot = s.hands[s.turn].findIndex((c) => c && !c.up)
  const index = s.stock.findIndex((x) => x !== s.hands[s.turn][slot].value)
  assert.ok(index >= 0)
  ;[s.stock[index], s.hands[s.turn][slot].value] = [
    s.hands[s.turn][slot].value,
    s.stock[index],
  ]
  const v2 = observe(s, true)
  assert.deepEqual(v1, v2)
  const roster = (n) => Array.from({ length: n }, () => threshold(3, true))
  assert.deepEqual(
    matchLabels(v1, random(12), 3, roster),
    matchLabels(v2, random(12), 3, roster),
  )
})

test('all exported match and round estimators reproduce Python predictions in their reward units', async () => {
  const { readFileSync } = await import('node:fs')
  const { predict } = await import('../src/model.ts')
  const read = (path) =>
    JSON.parse(readFileSync(new URL(path, import.meta.url)))
  const report = read('../reports/match-training.json')
  const cases = [
    ...report.replicaSeeds.map((seed) => [
      'match-s' + seed,
      report.replicas[seed],
    ]),
    ['matched-round-s' + report.primarySeed, report.matchedRoundControl],
  ]
  assert.deepEqual(
    cases.map(([name]) => name),
    ['match-s11', 'match-s29', 'match-s47', 'matched-round-s11'],
  )
  for (const [name, details] of cases) {
    const bundle = read('../models/' + name + '.json')
    assert.ok(details.parity.length >= 8)
    for (const row of details.parity)
      for (const key of ['tree', 'mlp']) {
        assert.ok(
          Math.abs(predict(bundle[key], row.x) - row[key]) < 1e-7,
          name + ' ' + key,
        )
      }
  }
})
