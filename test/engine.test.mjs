import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GONE,
  deckValues,
  frequencies,
  deal,
  observe,
  move,
  random,
  legal,
  score,
  sampleRound,
  play,
} from '../src/engine.ts'
import { builtIn, candidates } from '../src/policies.ts'
const physical = (s) =>
  [
    ...s.stock,
    ...s.waste,
    ...s.hands.flatMap((h) => h.flatMap((c) => (c ? [c.value] : []))),
    ...(s.held === null ? [] : [s.held]),
  ].sort((a, b) => a - b)
const card = (value) => ({ value, up: true })
test('standard deck, opening setup and all supported player counts', () => {
  const deck = deckValues()
  assert.equal(deck.length, 150)
  assert.equal(
    deck.reduce((s, x) => s + x),
    760,
  )
  for (let n = 2; n <= 8; n++) {
    const s = deal(Array(n).fill(0), random(1))
    assert.deepEqual(physical(s), deck)
    assert.equal(s.stock.length, 149 - 12 * n)
    const sums = s.hands.map((h) =>
      h.filter((c) => c.up).reduce((s, c) => s + c.value, 0),
    )
    assert.equal(sums[s.turn], Math.max(...sums))
    assert.ok(s.hands.every((h) => h.filter((c) => c.up).length === 2))
  }
})
test('pre-draw observation, privately drawn card, and count conservation', () => {
  const s = deal([0, 0], random(3))
  const before = observe(s, true),
    top = s.stock.at(-1)
  assert.equal(before.held, null)
  const other = structuredClone(s)
  ;[other.stock[0], other.hands[0][1].value] = [
    other.hands[0][1].value,
    other.stock[0],
  ]
  assert.deepEqual(observe(other, true), before)
  move(s, { kind: 'draw' }, random(4))
  const after = observe(s, true)
  assert.equal(after.held, top)
  assert.equal(before.counts[top + 2] - after.counts[top + 2], 1)
  assert.ok(!('counts' in observe(s)))
  const sampled = sampleRound(after, random(7))
  assert.deepEqual(observe(sampled, true), after)
  assert.deepEqual(physical(sampled), deckValues())
})
test('invalid actions reject before mutating the game', () => {
  const s = deal([0, 0], random(8)),
    rng = random(1),
    virgin = structuredClone(s)
  for (const a of [
    { kind: 'swap', slot: 0 },
    { kind: 'take', slot: 90 },
    { kind: 'flip', slot: 1 },
    { kind: 'pass', slot: 0 },
  ]) {
    assert.throws(() => move(s, a, rng))
    assert.deepEqual(s, virgin)
  }
  move(s, { kind: 'draw' }, rng)
  const drawn = structuredClone(s)
  for (const a of [
    { kind: 'draw' },
    { kind: 'take', slot: 0 },
    { kind: 'flip', slot: 0 },
  ]) {
    assert.throws(() => move(s, a, rng))
    assert.deepEqual(s, drawn)
  }
})
test('completed column follows replaced card onto discard and clears even negatives', () => {
  for (const value of [-2, 0, 9]) {
    const s = deal([0, 0], random(1))
    s.turn = 0
    s.hands[0].splice(0, 3, card(value), card(value), card(8))
    s.waste.push(value)
    move(s, { kind: 'take', slot: 2 }, random(2))
    assert.deepEqual(s.waste.slice(-4), [8, value, value, value])
    assert.deepEqual(observe(s).boards[0].slice(0, 3), [GONE, GONE, GONE])
  }
})
test('all other seats get a final turn; final reveal clears a hidden match', () => {
  const s = deal([0, 0, 0], random(10))
  s.turn = 1
  s.held = 2
  s.hands[1] = Array.from({ length: 12 }, (_, i) => ({
    value: i % 3,
    up: i !== 0,
  }))
  s.hands[0].splice(0, 3, card(7), card(7), { value: 7, up: false })
  move(s, { kind: 'flip', slot: 0 }, random(2))
  assert.equal(s.closer, 1)
  assert.equal(s.turn, 2)
  move(s, { kind: 'take', slot: 4 }, random(2))
  assert.equal(s.turn, 0)
  assert.equal(s.finished, false)
  move(s, { kind: 'take', slot: 4 }, random(2))
  assert.equal(s.finished, true)
  assert.deepEqual(s.hands[0].slice(0, 3), [null, null, null])
  assert.throws(() => move(s, { kind: 'draw' }, random(0)))
})
test('doubling applies to tied or beaten positive finisher, never zero or negative', () => {
  for (const [mine, other, expected] of [
    [8, 8, 16],
    [8, 6, 16],
    [6, 8, 6],
    [0, -2, 0],
    [-1, -2, -1],
  ]) {
    const s = deal([0, 0], random(1))
    s.finished = true
    s.closer = 0
    s.hands = [[card(mine)], [card(other)]]
    assert.deepEqual(score(s), [expected, other])
  }
})
test('exhaustion preserves the top discard and recycles the remainder', () => {
  const s = deal([0, 0], random(1))
  s.waste.push(...s.stock.splice(0), 6)
  s.stock = []
  const before = physical(s)
  move(s, { kind: 'draw' }, random(2))
  assert.deepEqual(s.waste, [6])
  assert.deepEqual(physical(s), before)
})
test('completed games are deterministic; every legal transition conserves every card', () => {
  const roster = ['threshold-5', 'threshold-3+clear', 'table', 'counter'].map(
    builtIn,
  )
  assert.deepEqual(play(roster, 455), play(roster, 455))
  assert.ok(Math.max(...play(roster, 455).totals) >= 100)
  const rng = random(10),
    s = deal(Array(8).fill(0), rng)
  while (!s.finished) {
    const v = observe(s, true),
      a = roster[s.turn % 4].choose(v, rng)
    assert.ok(legal(v).some((x) => JSON.stringify(x) === JSON.stringify(a)))
    move(s, a, rng)
    assert.deepEqual(physical(s), deckValues())
  }
})
test('threshold priority, mandatory negative clear, and guarding model no-op loops', () => {
  const v = {
    boards: [[8, 8, 11, 4, 3, null, null, null, null, null, null, null]],
    turn: 0,
    held: null,
    discard: 8,
    closer: null,
    totals: [0],
  }
  assert.deepEqual(builtIn('threshold-5').choose(v), { kind: 'draw' })
  assert.deepEqual(builtIn('threshold-3+clear').choose(v), {
    kind: 'take',
    slot: 2,
  })
  assert.ok(
    candidates(v).every(
      (c) => c.a.kind !== 'take' || v.boards[0][c.a.slot] !== 8,
    ),
  )
  v.discard = 3
  assert.deepEqual(builtIn('threshold-3+clear').choose(v), {
    kind: 'take',
    slot: 2,
  })
  v.discard = 4
  assert.deepEqual(builtIn('threshold-3+clear').choose(v), { kind: 'draw' })
  assert.equal(
    frequencies.reduce((a, b) => a + b),
    150,
  )
})
test('opening geometry is configurable and the previous closer starts later rounds', () => {
  const s = deal([5, 12], random(90), 1, [
    [0, 1],
    [5, 8],
  ])
  assert.equal(s.turn, 1)
  assert.deepEqual(
    s.hands.map((hand) => hand.flatMap((c, i) => (c.up ? [i] : []))),
    [
      [0, 1],
      [5, 8],
    ],
  )
  assert.throws(() =>
    deal([0, 0], random(90), null, [
      [0, 0],
      [0, 3],
    ]),
  )
})
