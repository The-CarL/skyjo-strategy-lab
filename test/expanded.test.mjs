import test from 'node:test'
import assert from 'node:assert/strict'
import { deal, GONE, legal, move, observe, random } from '../src/engine.ts'
import {
  expandedPolicy,
  expandedScores,
  startingBoard,
  startingTable,
} from '../src/expanded.ts'

const m = { version: 1, board: startingBoard, table: startingTable }
const own = [12, 9, 0, null, 3, null, GONE, GONE, GONE, 3, 2, 1]
const v = {
  boards: [own, [0, 2, 3, 1, 4, 5, 6, 7, 8, 9, 10, null]],
  turn: 0,
  discard: 12,
  held: null,
  closer: null,
  totals: [80, 62],
}

test('expanded scoring visits every legal action in both phases including visible uphill swaps', () => {
  for (const held of [null, 12]) {
    const view = { ...v, held }
    assert.deepEqual(
      expandedScores(view, m, 'board').map((r) => r.action),
      legal(view),
    )
  }
  const pairChaser = { ...m, board: [12, 0.15, 1, 0, 1.5, 0] }
  assert.deepEqual(expandedPolicy(pairChaser, 'board').choose(v), {
    kind: 'take',
    slot: 1,
  })
})

test('board and one-bit ablations cannot benefit from inaccessible rival information', () => {
  const altered = {
    ...v,
    totals: [1, 99],
    counts: [1],
    closer: 1,
    boards: [own, v.boards[1].map((x) => (x === null ? null : -2))],
  }
  for (const mode of ['board', 'urgency']) {
    assert.deepEqual(
      expandedScores(v, m, mode),
      expandedScores(altered, m, mode),
    )
  }
  const zero = { ...m, table: [0, 0, 0] }
  for (const mode of ['urgency', 'table'])
    assert.deepEqual(
      expandedScores(v, zero, mode),
      expandedScores(v, zero, 'board'),
    )
})

test('table closing risk uses public rival estimate; urgency-only can respond to a final hidden card', () => {
  const board = [0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, null]
  const view = { ...v, boards: [board, Array(12).fill(-1)], held: 0 }
  const distant = { ...view, boards: [board, Array(12).fill(null)] }
  const weights = { ...m, table: [2, 1, 2] }
  const target = (s) =>
    s.find((r) => r.action.kind === 'swap' && r.action.slot === 11).score
  assert.ok(
    target(expandedScores(view, weights, 'table')) <
      target(expandedScores(distant, weights, 'table')),
  )
  assert.equal(
    target(expandedScores(view, weights, 'urgency')) -
      target(expandedScores(distant, weights, 'urgency')),
    1,
  )
})

test('expanded agents terminate ordinary rounds even when pressure discourages closing', () => {
  const bot = expandedPolicy({ ...m, table: [2, -3, 6] }, 'table')
  for (let seed = 0; seed < 8; seed++) {
    const rng = random(seed),
      s = deal([87, 74], rng)
    let turns = 0
    while (!s.finished && turns++ < 2000) move(s, bot.choose(observe(s)), rng)
    assert.ok(s.finished)
  }
})
