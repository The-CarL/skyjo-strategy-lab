import test from 'node:test'
import assert from 'node:assert/strict'
import { play } from '../src/engine.ts'
import { familyPolicy } from '../src/family.ts'
import { threshold } from '../src/policies.ts'

function decision(id, board, card, drawn = false) {
  return familyPolicy(id).choose({
    boards: [board],
    turn: 0,
    held: drawn ? card : null,
    discard: card,
  })
}

test('the 3/3 control reproduces the original strategy over complete games', () => {
  const original = threshold(3, true),
    candidate = familyPolicy('family-3-3')
  let decisions = 0
  const checker = {
    name: 'equivalence',
    choose(v, rng) {
      const a = candidate.choose(v, rng)
      assert.deepEqual(a, original.choose(v, rng))
      decisions++
      return a
    },
  }
  for (const seed of [357, 358, 359, 360])
    play([checker, threshold(4, true)], seed)
  assert.ok(decisions > 100)
})

test('visible and hidden cutoffs change independent choices', () => {
  assert.deepEqual(decision('family-5-3', [8, null, null], 5), {
    kind: 'take',
    slot: 0,
  })
  assert.deepEqual(decision('family-5-3', [2, null, null], 5), { kind: 'draw' })
  assert.deepEqual(decision('family-3-5', [8, null, null], 5), {
    kind: 'take',
    slot: 1,
  })
})

test('value-based clears can be declined without disabling the mandatory rule', () => {
  assert.deepEqual(
    decision('family-value-clear', [-2, -2, null, 12, null, null], -2),
    { kind: 'take', slot: 3 },
  )
  assert.deepEqual(
    decision('family-value-clear', [-2, -2, 12, 0, 0, null], -2),
    { kind: 'take', slot: 2 },
  )
  assert.deepEqual(
    decision('family-value-clear', [7, 7, 12, 9, null, null], 7),
    { kind: 'take', slot: 2 },
  )
})

test('pair preservation yields to a five-point improvement', () => {
  assert.deepEqual(
    decision('family-pair-break', [7, 7, null, 6, null, null], 3),
    { kind: 'take', slot: 3 },
  )
  assert.deepEqual(
    decision('family-pair-break', [7, 7, null, 6, null, null], 2),
    { kind: 'take', slot: 0 },
  )
})

test('a drawn upgrade differs from accepting the same known discard', () => {
  assert.deepEqual(decision('family-drawn-upgrade', [11, null, null], 7), {
    kind: 'draw',
  })
  assert.deepEqual(
    decision('family-drawn-upgrade', [11, null, null], 7, true),
    { kind: 'swap', slot: 0 },
  )
  assert.deepEqual(
    decision('family-build-pair', [2, null, null, 3, null, null], 3),
    { kind: 'take', slot: 4 },
  )
  assert.deepEqual(decision('family-hidden-first', [5, null, null], 3), {
    kind: 'take',
    slot: 1,
  })
})

test('the frozen rule takes the larger saving when an optional clear is on offer', () => {
  const id = 'family-value-upgrade'
  assert.deepEqual(decision(id, [1, 1, null, 12, null, null], 1), {
    kind: 'take',
    slot: 3,
  })
  // Clearing saves 7 and the separate swap saves 7. The clear wins the tie.
  assert.deepEqual(decision(id, [1, 1, null, 8, null, null], 1), {
    kind: 'take',
    slot: 2,
  })
  assert.deepEqual(decision(id, [2, 2, null, 2, 2, 12], 2), {
    kind: 'take',
    slot: 5,
  })
  assert.deepEqual(decision(id, [12, null, null], 7, true), {
    kind: 'swap',
    slot: 0,
  })
  assert.deepEqual(decision(id, [12, null, null], 7), { kind: 'draw' })
})
