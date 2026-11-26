import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  deal,
  move,
  observe,
  play,
  random,
  resumeMatch,
} from '../src/engine.ts'
import { builtIn } from '../src/policies.ts'

const faceUp = (value) => ({ value, up: true })
const hidden = (value) => ({ value, up: false })
const hand = (...cards) => [...cards, ...Array(12 - cards.length).fill(null)]
const never = { name: 'finished-seat', choose: assert.fail }

test('legacy full-game actions, seat RNG and outcomes reproduce the released engine', () => {
  const roster = ['random', 'threshold-5', 'threshold-3+clear', 'table'].map(
    builtIn,
  )
  const log = createHash('sha256')
  const result = play(
    roster,
    987,
    (view, action, round) =>
      log.update(JSON.stringify([round, view.turn, action])),
    (openings) => log.update(JSON.stringify(openings)),
  )
  assert.deepEqual(result, {
    totals: [144, 90, 52, 53],
    rounds: 2,
    moves: 160,
    winners: [2],
  })
  assert.equal(
    log.digest('hex'),
    'b995a432f8224ef12a69c76ea12ee0d71707e5f3a0fbdbaccbb0b1af64007c0a',
  )
})

test('a settled candidate scores the supplied round once and preserves shared wins', () => {
  const s = deal([92, 96, 97], random(3))
  s.hands = [hand(faceUp(8)), hand(faceUp(4)), hand(faceUp(3))]
  s.closer = 2
  s.turn = 2
  s.finished = true
  const settlements = []
  const result = resumeMatch(s, [never, never, never], 4, (scores, totals) => {
    settlements.push([[...scores], [...totals]])
    scores.fill(0)
    totals.fill(-1000)
  })
  assert.deepEqual(settlements, [
    [
      [8, 4, 3],
      [100, 100, 100],
    ],
  ])
  assert.deepEqual(result, {
    totals: [100, 100, 100],
    rounds: 1,
    moves: 0,
    winners: [0, 1, 2],
  })
})

test('resuming with a private draw on a final turn preserves action phase, visibility and doubling', () => {
  const s = deal([90, 95, 95], random(8))
  s.hands = [
    hand(faceUp(5), faceUp(3), faceUp(2)),
    hand(faceUp(0), faceUp(1), hidden(2)),
    hand(faceUp(3), faceUp(4), hidden(1)),
  ]
  s.closer = 0
  s.turn = 1
  s.held = 12
  const calls = []
  const p1 = {
    name: 'drawn',
    choose(v) {
      calls.push(v.turn)
      assert.equal(v.held, 12)
      assert.equal(v.boards[1][2], null)
      assert.equal(v.counts, undefined)
      return { kind: 'flip', slot: 2 }
    },
  }
  const p2 = {
    name: 'last',
    count: true,
    choose(v) {
      calls.push(v.turn)
      assert.equal(v.held, null)
      assert.equal(v.discard, 12)
      assert.equal(v.boards[1][2], 2)
      assert.ok(Array.isArray(v.counts))
      return { kind: 'take', slot: 2 }
    },
  }
  const result = resumeMatch(s, [never, p1, p2], 77)
  assert.deepEqual(calls, [1, 2])
  assert.deepEqual(result, {
    totals: [110, 98, 114],
    moves: 2,
    rounds: 1,
    winners: [1],
  })
})

test('resume continues the current partial round and deals complete later rounds', () => {
  const seed = 777
  const roster = ['threshold-5', 'threshold-3+clear', 'threshold-4'].map(
    builtIn,
  )
  const expected = play(roster, seed)
  assert.ok(expected.rounds > 1)
  // Stop inside the first round of this exact deal. These deterministic policies
  // consume no private random numbers and the short first round never recycles stock.
  const deckRng = random(seed ^ Math.imul(1, 0x9e3779b1))
  const s = deal([0, 0, 0], deckRng)
  for (let i = 0; i < 9; i++)
    move(s, roster[s.turn].choose(observe(s)), deckRng)
  const observed = []
  const result = resumeMatch(s, roster, seed, (points, totals) =>
    observed.push({ points, totals }),
  )
  assert.equal(observed.length, 1)
  assert.deepEqual(observed[0].points, observed[0].totals)
  assert.deepEqual(result, { ...expected, moves: expected.moves - 9 })
})

test('invalid continuation rosters and cumulative totals reject before policy execution', () => {
  const s = deal([0, 0], random(1))
  assert.throws(() => resumeMatch(s, [never, never, never], 1), /seats/)
  s.totals[0] = 100
  assert.throws(() => resumeMatch(s, [never, never], 1), /cumulative scores/)
})
