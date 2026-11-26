import test from 'node:test'
import assert from 'node:assert/strict'
import { play, observe, random } from '../src/engine.ts'
import {
  applyCommand,
  createMatch,
  engineCatalog,
  MatchCommandError,
  publicMatch,
} from '../src/online-match.ts'
import { onlinePolicy } from '../src/online-policies.ts'

const serialized = (s) => JSON.parse(JSON.stringify(s))
const card = (value, up = true) => ({ value, up })
const oneCard = (value, up) => [card(value, up), ...Array(11).fill(null)]

test('the opening snapshot exposes backs, public openings and discard only', () => {
  for (let n = 1; n <= 7; n++) {
    const state = createMatch(Array(n).fill('family-value-upgrade'), 37)
    const p = publicMatch(state)
    assert.deepEqual(publicMatch(serialized(state)), p)
    assert.equal(p.phase, 'opening')
    assert.equal(p.revision, 0)
    assert.equal(p.round, 1)
    assert.equal(p.turn, null)
    assert.equal(p.held, null)
    assert.equal(p.stockCount, 149 - 12 * (n + 1))
    assert.deepEqual(p.players[0].board, Array(12).fill(null))
    assert.ok(
      p.players
        .slice(1)
        .every((player) => player.board.filter((x) => x !== null).length === 2),
    )
    const hiddenSwap = serialized(state)
    ;[hiddenSwap.hand.stock[0], hiddenSwap.hand.hands[0][0].value] = [
      hiddenSwap.hand.hands[0][0].value,
      hiddenSwap.hand.stock[0],
    ]
    hiddenSwap.seed ^= 1234
    assert.deepEqual(publicMatch(hiddenSwap), p)
    assert.equal(p.discard, state.hand.waste.at(-1))
    assert.ok(
      !['hand', 'seed', 'stock', 'deckStream', 'botStreams', 'counts'].some(
        (k) => Object.hasOwn(p, k),
      ),
    )
    p.players[0].board.fill(100)
    assert.deepEqual(publicMatch(state).players[0].board, Array(12).fill(null))
  }
})

test('invalid intake and turn commands are rejected without touching the stored match', () => {
  for (const ids of [[], Array(8).fill('board'), ['bogus'], null])
    assert.throws(() => createMatch(ids, 1), MatchCommandError)
  for (const seed of [-1, 2 ** 32, 1.5, NaN])
    assert.throws(() => createMatch(['board'], seed), MatchCommandError)
  const opening = createMatch(['counter'], 35),
    untouched = serialized(opening)
  for (const cmd of [
    { kind: 'draw' },
    { kind: 'nextRound' },
    { kind: 'open', slots: [1, 1] },
    { kind: 'open', slots: [-1, 4] },
    { kind: 'open', slots: [0, 12] },
    { kind: 'open', slots: new Array(2) },
    null,
  ]) {
    assert.throws(() => applyCommand(opening, cmd), MatchCommandError)
  }
  assert.deepEqual(opening, untouched)
  const state = applyCommand(opening, { kind: 'open', slots: [1, 7] })
  assert.equal(state.revision, 1)
  const v = publicMatch(state)
  assert.equal(v.phase, 'source')
  assert.deepEqual(
    v.players[0].board.flatMap((x, i) => (x !== null ? [i] : [])),
    [1, 7],
  )
  assert.throws(
    () => applyCommand(state, { kind: 'swap', slot: 3 }),
    MatchCommandError,
  )
  assert.throws(
    () => applyCommand(state, { kind: 'take', slot: 0.5 }),
    MatchCommandError,
  )
  assert.throws(
    () => applyCommand(state, { kind: 'nextRound' }),
    MatchCommandError,
  )
  const snap = serialized(state)
  const held = applyCommand(state, { kind: 'draw' })
  assert.deepEqual(state, snap)
  assert.equal(held.revision, 2)
  assert.equal(publicMatch(held).held, snap.hand.stock.at(-1))
  assert.deepEqual(publicMatch(held).recent, [{ seat: 0, kind: 'draw' }])
  for (const cmd of [
    { kind: 'draw' },
    { kind: 'flip', slot: 1 },
    { kind: 'take', slot: 3 },
    { kind: 'bogus', slot: 0 },
  ])
    assert.throws(() => applyCommand(held, cmd), MatchCommandError)
  const post = applyCommand(held, { kind: 'flip', slot: 2 })
  const human = publicMatch(post).recent[0]
  assert.deepEqual(human, {
    kind: 'flip',
    seat: 0,
    slot: 2,
    value: held.hand.hands[0][2].value,
    discarded: held.hand.held,
  })
  assert.equal(publicMatch(post).held, null)
  for (const event of post.recent.filter((e) => e.kind === 'draw'))
    assert.deepEqual(Object.keys(event).sort(), ['kind', 'seat'])
})

test('hosted complete matches reproduce the engine across seats, rounds and JSON resumes', () => {
  const human = onlinePolicy('family-value-upgrade')
  const botIds = [
    'match-mlp-11',
    'counter',
    'expanded-board',
    'match-tree-11',
    'mlp',
    'threshold-3+clear',
    'table',
  ]
  for (const n of [1, 3, 7]) {
    const seed = 2028 + n,
      ids = botIds.slice(0, n)
    const reference = play([human, ...ids.map(onlinePolicy)], seed)
    let state = createMatch(ids, seed),
      previousCloser = null
    for (let i = 0; state.phase !== 'gameOver'; i++) {
      assert.ok(i < 2000)
      const old = serialized(state)
      let command
      if (state.phase === 'opening') command = { kind: 'open', slots: [0, 3] }
      else if (state.phase === 'roundOver') {
        previousCloser = state.hand.closer
        command = { kind: 'nextRound' }
      } else command = human.choose(observe(state.hand), random(97))
      const next = applyCommand(serialized(state), command)
      assert.deepEqual(state, old)
      assert.equal(next.revision, state.revision + 1)
      if (command.kind === 'open' && previousCloser > 0)
        assert.equal(next.recent[1].seat, previousCloser)
      assert.ok(next.recent.length <= 2 * n + 1)
      state = next
    }
    const p = publicMatch(state)
    assert.equal(p.round, reference.rounds)
    assert.deepEqual(
      p.players.map((player) => player.total),
      reference.totals,
    )
    assert.deepEqual(p.winners, reference.winners)
    assert.equal(p.history.length, reference.rounds)
    assert.ok(p.players.every((seat) => seat.board.every((x) => x !== null)))
    assert.ok(
      !['hand', 'deckStream', 'seed', 'stock', 'botStreams'].some((k) =>
        Object.hasOwn(p, k),
      ),
    )
    assert.throws(
      () => applyCommand(state, { kind: 'nextRound' }),
      MatchCommandError,
    )
  }
})

test('final turn clears, doubling and joint winners stay aligned with the public scoreboard', () => {
  const s = createMatch(['board'], 12)
  Object.assign(s.hand, {
    hands: [oneCard(4, false), oneCard(4, true)],
    totals: [96, 92],
    held: 12,
    turn: 0,
    closer: 1,
  })
  s.phase = 'held'
  const ended = applyCommand(s, { kind: 'flip', slot: 0 })
  const p = publicMatch(ended)
  assert.equal(p.phase, 'gameOver')
  assert.equal(p.turn, null)
  assert.deepEqual(p.history, [
    { round: 1, closer: 1, points: [4, 8], totals: [100, 100] },
  ])
  assert.deepEqual(p.winners, [0, 1])
  p.history[0].points[1] = 999
  assert.deepEqual(publicMatch(ended).history[0].points, [4, 8])
  const clearingFixture = serialized(s)
  clearingFixture.hand.totals = [0, 0]
  clearingFixture.hand.hands[0].splice(0, 3, card(7, false), card(7), card(7))
  const closed = applyCommand(clearingFixture, { kind: 'flip', slot: 0 })
  assert.equal(closed.phase, 'roundOver')
  assert.deepEqual(publicMatch(closed).recent[0].cleared, [0])
  assert.deepEqual(publicMatch(closed).history[0].points, [0, 8])
  const opened = applyCommand(closed, { kind: 'nextRound' })
  assert.equal(publicMatch(opened).round, 2)
  assert.deepEqual(
    publicMatch(opened).players.map((p) => p.total),
    [0, 8],
  )
})

test('every selectable policy can act with the exact same public projections as tournament policies', () => {
  const names = new Set(engineCatalog.map((e) => e.id))
  for (const expected of [
    'family-value-upgrade',
    'threshold-3+clear',
    'match-mlp-11',
    'matched-round-mlp-11',
    'match-tree-11',
    'mlp',
    'tree',
    'counter',
    'expanded-board',
    'expanded-table',
  ])
    assert.ok(names.has(expected), expected)
  assert.equal(names.size, engineCatalog.length)
  for (const { id, name, description } of engineCatalog) {
    assert.ok(name && description)
    assert.equal(onlinePolicy(id).name, id)
    const opened = applyCommand(createMatch([id], 113), {
      kind: 'open',
      slots: [0, 3],
    })
    assert.equal(publicMatch(opened).phase, 'source')
  }
})
