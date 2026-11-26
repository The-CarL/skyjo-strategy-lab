import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createApi } from '../server/api.mjs'
import { createDynamoStore, createMemoryStore } from '../server/store.mjs'

const newKey = () => randomBytes(32).toString('base64url')
const engines = ['threshold-3+clear']
function fixture({ store = createMemoryStore(), ...overrides } = {}) {
  let t = Date.parse('2026-01-01T00:00:00Z'),
    seed = 0
  const handler = createApi({
    store,
    clock: () => new Date(++t).toISOString(),
    seed: () => ++seed,
    ...overrides,
  })
  const owner = newKey()
  async function request(method, path, body, token = owner, options = {}) {
    const u = new URL(path, 'https://example.invalid')
    const ev = {
      version: '2.0',
      rawPath: u.pathname,
      rawQueryString: u.search.slice(1),
      headers: {
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      requestContext: { http: { method } },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...options,
    }
    const result = await handler(ev)
    return {
      status: result.statusCode,
      headers: result.headers,
      json: JSON.parse(result.body),
    }
  }
  const create = (rid = randomUUID(), opponents = engines, token = owner) =>
    request('POST', '/api/games', { opponents, requestId: rid }, token)
  const move = (game, action, rid = randomUUID(), token = owner) =>
    request(
      'POST',
      '/api/games/' + game.id + '/moves',
      { expectedRevision: game.revision, requestId: rid, action },
      token,
    )
  const abandon = (game, rid = randomUUID(), token = owner) =>
    request(
      'POST',
      '/api/games/' + game.id + '/abandon',
      { expectedRevision: game.revision, requestId: rid },
      token,
    )
  return { request, create, move, abandon, store, owner }
}
const opening = { kind: 'open', slots: [0, 3] }
function nextAction(game) {
  if (game.phase === 'opening') return opening
  if (game.phase === 'roundOver') return { kind: 'nextRound' }
  if (game.phase === 'source') return { kind: 'draw' }
  if (game.phase === 'held')
    return { kind: 'flip', slot: game.players[0].board.indexOf(null) }
  throw Error('Unexpected phase ' + game.phase)
}
async function finish(api, start) {
  let game = start
  let last
  for (let i = 0; i < 1000; i++) {
    if (game.phase === 'gameOver') return { game, last }
    const action = nextAction(game),
      rid = randomUUID()
    last = { previous: game, action, rid }
    const r = await api.move(game, action, rid)
    assert.equal(r.status, 200, JSON.stringify(r.json))
    game = r.json.game
  }
  throw Error('Match did not finish under the public API')
}
test('private profiles, validation and hidden-information boundary', async () => {
  const api = fixture()
  const catalog = await api.request('GET', '/api/engines', undefined, null)
  assert.equal(catalog.status, 200)
  assert.ok(catalog.json.engines.some((e) => e.id === engines[0]))
  for (const key of [null, 'weak', 'A'.repeat(42) + 'B'])
    assert.equal(
      (await api.request('GET', '/api/games/current', undefined, key)).status,
      401,
    )
  assert.deepEqual((await api.request('GET', '/api/games/current')).json, {
    game: null,
  })
  assert.equal((await api.create(randomUUID(), [])).status, 400)
  assert.equal((await api.create(randomUUID(), ['nope'])).status, 400)
  assert.equal((await api.create('invalid')).status, 400)
  assert.equal(
    (
      await api.request('POST', '/api/games', undefined, api.owner, {
        body: '{',
      })
    ).status,
    400,
  )
  assert.equal(
    (
      await api.request('POST', '/api/games', undefined, api.owner, {
        body: 'x'.repeat(8193),
      })
    ).status,
    413,
  )
  const r = await api.create()
  assert.equal(r.status, 201)
  const { game } = r.json
  assert.equal(game.revision, 0)
  assert.equal(game.phase, 'opening')
  assert.ok(game.players[0].board.every((x) => x === null))
  for (const field of [
    'seed',
    'stock',
    'botStreams',
    'deckStream',
    'hand',
    'createSignature',
    'receipt',
    'signature',
    'pk',
  ]) {
    assert.ok(!JSON.stringify(game).includes('"' + field + '":'))
  }
  assert.equal(
    (await api.request('GET', '/api/games/' + game.id, undefined, newKey()))
      .status,
    404,
  )
  assert.equal(
    (await api.move(game, opening, randomUUID(), newKey())).status,
    404,
  )
  const wrong = await api.move(game, { kind: 'draw' })
  assert.equal(wrong.status, 422)
  assert.equal(
    (await api.request('GET', '/api/games/' + game.id)).json.game.revision,
    0,
  )
  assert.equal(
    (await api.request('DELETE', '/api/games/' + game.id)).status,
    405,
  )
})
test('creation retries preserve game identity without displacing the most recently started game', async () => {
  const api = fixture(),
    rid = randomUUID()
  const [first, second] = await Promise.all([api.create(rid), api.create(rid)])
  assert.deepEqual([first.status, second.status].sort(), [200, 201])
  assert.equal(first.json.game.id, second.json.game.id)
  assert.equal(
    (await api.create(rid, ['board'])).json.error.code,
    'idempotency_conflict',
  )
  const newer = (await api.create()).json.game
  assert.notEqual(newer.id, first.json.game.id)
  const replay = await api.create(rid)
  assert.equal(replay.json.game.id, first.json.game.id)
  await api.move(first.json.game, opening)
  assert.equal(
    (await api.request('GET', '/api/games/' + first.json.game.id)).json.game
      .revision,
    1,
  )
  assert.equal(
    (await api.request('GET', '/api/games/current')).json.game.id,
    newer.id,
  )
  const foreign = await api.create(rid, engines, newKey())
  assert.equal(foreign.status, 201)
  assert.notEqual(foreign.json.game.id, first.json.game.id)
})
test('concurrent moves are atomic; delayed retries return the latest snapshot and reject key reuse', async () => {
  const api = fixture(),
    g = (await api.create()).json.game,
    rid = randomUUID()
  const [r1, r2] = await Promise.all([
    api.move(g, opening, rid),
    api.move(g, opening, rid),
  ])
  assert.equal(r1.status, 200)
  assert.equal(r2.status, 200)
  assert.deepEqual(r1.json, r2.json)
  const g1 = r1.json.game
  const [one, two] = await Promise.all([
    api.move(g1, nextAction(g1)),
    api.move(g1, nextAction(g1)),
  ])
  assert.deepEqual([one.status, two.status].sort(), [200, 409])
  const replay = await api.move(g, opening, rid)
  assert.equal(replay.json.game.revision, 2)
  const conflict = await api.move(g, { kind: 'open', slots: [1, 4] }, rid)
  assert.equal(conflict.json.error.code, 'idempotency_conflict')
  const stale = await api.move(g, opening)
  assert.equal(stale.json.error.code, 'revision_conflict')
})
test('a lost acknowledgement after commit recovers without applying the move twice', async () => {
  const memory = createMemoryStore()
  let interrupt = true
  const api = fixture({
    store: {
      ...memory,
      async commit(...args) {
        const ok = await memory.commit(...args)
        if (interrupt) {
          interrupt = false
          throw Error('simulated response lost')
        }
        return ok
      },
    },
  })
  const game = (await api.create()).json.game,
    rid = randomUUID()
  assert.equal((await api.move(game, opening, rid)).status, 503)
  assert.equal((await api.move(game, opening, rid)).json.game.revision, 1)
})
test('abandon drops the private state, stays isolated and tolerates duplicate delivery', async () => {
  const memory = createMemoryStore()
  let profileHash
  const api = fixture({
    store: {
      ...memory,
      async create(owner, game) {
        profileHash = owner
        return memory.create(owner, game)
      },
    },
  })
  const createId = randomUUID()
  const original = (await api.create(createId)).json.game
  const moveId = randomUUID()
  const game = (await api.move(original, opening, moveId)).json.game
  const rid = randomUUID()
  assert.equal((await api.abandon(game, rid, newKey())).status, 404)
  assert.equal((await api.abandon(game, rid, null)).status, 401)
  assert.equal(
    (await api.abandon(original)).json.error.code,
    'revision_conflict',
  )
  assert.equal(
    (await api.abandon(game, moveId)).json.error.code,
    'idempotency_conflict',
  )
  const deliveries = await Promise.all([
    api.abandon(game, rid),
    api.abandon(game, rid),
  ])
  for (const res of deliveries) {
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, { game: null })
  }
  const stored = await memory.getGame(profileHash, game.id)
  assert.deepEqual(Object.keys(stored).sort(), [
    'abandonedAt',
    'createSignature',
    'id',
    'revision',
  ])
  assert.equal(stored.revision, game.revision + 1)
  assert.deepEqual((await api.request('GET', '/api/games/current')).json, {
    game: null,
  })
  assert.deepEqual((await api.request('GET', '/api/history')).json, {
    items: [],
    nextCursor: null,
  })
  assert.equal((await api.abandon(game)).json.error.code, 'game_abandoned')
  for (const res of [
    await api.request('GET', '/api/games/' + game.id),
    await api.create(createId),
    await api.move(original, opening, moveId),
    await api.move(game, nextAction(game)),
  ]) {
    assert.equal(res.status, 410)
    assert.equal(res.json.error.code, 'game_abandoned')
  }
  assert.equal(
    (await api.abandon(original, rid)).json.error.code,
    'idempotency_conflict',
  )
  const newer = (await api.create()).json.game
  assert.deepEqual((await api.abandon(game, rid)).json, { game: null })
  assert.equal(
    (await api.request('GET', '/api/games/current')).json.game.id,
    newer.id,
  )
})

test('a lost abandon acknowledgement can be retried after a different match starts', async () => {
  const memory = createMemoryStore()
  let interrupt = true
  const api = fixture({
    store: {
      ...memory,
      async commit(...args) {
        const ok = await memory.commit(...args)
        if (interrupt) {
          interrupt = false
          throw Error('simulated response lost')
        }
        return ok
      },
    },
  })
  const old = (await api.create()).json.game
  const newer = (await api.create()).json.game
  const rid = randomUUID()
  assert.equal((await api.abandon(old, rid)).status, 503)
  assert.deepEqual((await api.abandon(old, rid)).json, { game: null })
  assert.equal(
    (await api.request('GET', '/api/games/current')).json.game.id,
    newer.id,
  )
  assert.equal((await api.move(newer, opening)).status, 200)
})

test('a competing move and abandon share one guarded revision', async () => {
  for (const abandonFirst of [true, false]) {
    const api = fixture()
    const game = (await api.create()).json.game
    const move = () => api.move(game, opening)
    const abandon = () => api.abandon(game)
    const requests = abandonFirst ? [abandon, move] : [move, abandon]
    const [winner, loser] = await Promise.all(requests.map((send) => send()))
    assert.equal(winner.status, 200)
    const current = (await api.request('GET', '/api/games/current')).json.game
    if (abandonFirst) {
      assert.equal(loser.json.error.code, 'game_abandoned')
      assert.equal(current, null)
    } else {
      assert.equal(loser.json.error.code, 'revision_conflict')
      assert.deepEqual(current, winner.json.game)
    }
  }
})

test('current observes a new game created before the old game is abandoned during a read', async () => {
  const memory = createMemoryStore()
  let onRead
  const api = fixture({
    store: {
      ...memory,
      async getGame(owner, id) {
        if (onRead) {
          const hook = onRead
          onRead = null
          await hook()
        }
        return memory.getGame(owner, id)
      },
    },
  })
  const old = (await api.create()).json.game
  let newer
  onRead = async () => {
    newer = (await api.create()).json.game
    assert.equal((await api.abandon(old)).status, 200)
  }
  const current = await api.request('GET', '/api/games/current')
  assert.deepEqual(current.json.game, newer)
})

test('finished matches are immutable and paged newest-first, with tie ranks and round results preserved', async () => {
  const api = fixture(),
    finished = []
  for (let i = 0; i < 2; i++) {
    const start = (await api.create()).json.game
    const { game, last } = await finish(api, start)
    finished.push(game)
    const replay = await api.move(last.previous, last.action, last.rid)
    assert.equal(replay.status, 200)
    assert.deepEqual(replay.json.game, game)
    const frozen = await api.move(game, { kind: 'nextRound' })
    assert.equal(frozen.status, 409)
    assert.equal(frozen.json.error.code, 'game_finished')
    assert.equal((await api.abandon(game)).json.error.code, 'game_finished')
  }
  const first = await api.request('GET', '/api/history?limit=1')
  assert.equal(first.status, 200)
  assert.equal(first.json.items.length, 1)
  assert.ok(first.json.nextCursor)
  const second = await api.request(
    'GET',
    '/api/history?limit=1&cursor=' + first.json.nextCursor,
  )
  assert.equal(second.status, 200)
  assert.equal(second.json.nextCursor, null)
  const entries = [...first.json.items, ...second.json.items]
  assert.deepEqual(
    entries.map((x) => x.id),
    finished.map((g) => g.id).reverse(),
  )
  for (const [i, item] of entries.entries()) {
    const game = finished[1 - i]
    assert.deepEqual(item.rounds, game.history)
    assert.deepEqual(item.winners, game.winners)
    assert.ok(Date.parse(item.finishedAt) >= Date.parse(item.createdAt))
    for (const p of item.players) {
      assert.equal(
        p.place,
        1 + game.players.filter((x) => x.total < p.total).length,
      )
      assert.equal(p.engineId, game.players[p.seat].engineId)
    }
  }
  assert.deepEqual(
    (await api.request('GET', '/api/history', undefined, newKey())).json,
    { items: [], nextCursor: null },
  )
  assert.equal(
    (
      await api.request(
        'GET',
        '/api/history?cursor=' + first.json.nextCursor,
        undefined,
        newKey(),
      )
    ).status,
    400,
  )
  assert.equal((await api.request('GET', '/api/history?limit=31')).status, 400)
  assert.equal(
    (await api.request('GET', '/api/games/current')).json.game.phase,
    'gameOver',
  )
})
test('Dynamo write contract uses one guarded transaction for final state, receipt and immutable history', async () => {
  const calls = []
  const client = {
    send: async (cmd) => {
      calls.push(cmd.input)
      return {}
    },
  }
  const db = createDynamoStore({ tableName: 'sky-test', client })
  const owner = 'profile-hash',
    id = randomUUID(),
    request = randomUUID()
  const game = {
    id,
    revision: 8,
    finishedAt: '2026-01-01T00:00:00.000Z',
    state: { phase: 'gameOver' },
  }
  const summary = { id, finishedAt: game.finishedAt }
  assert.equal(await db.create(owner, game), true)
  assert.equal(calls[0].TransactItems.length, 2)
  const r = await db.commit(
    owner,
    game,
    7,
    request,
    'verified-signature',
    summary,
  )
  assert.equal(r, true)
  const tx = calls[1]
  assert.equal(tx.TransactItems.length, 3)
  assert.ok(tx.ClientRequestToken)
  const [state, receipt, finish] = tx.TransactItems.map((i) => i.Put)
  assert.equal(state.Item.game.state.phase, 'gameOver')
  assert.equal(state.ExpressionAttributeValues[':expected'], 7)
  assert.ok(
    state.ConditionExpression.includes('attribute_not_exists(finishedAt)'),
  )
  assert.equal(receipt.ConditionExpression, 'attribute_not_exists(pk)')
  assert.equal(finish.ConditionExpression, 'attribute_not_exists(pk)')
  assert.ok(finish.Item.sk.startsWith('H#' + summary.finishedAt))
  assert.ok(
    tx.TransactItems.every(
      (i) => i.Put.Item.pk === 'P#' + owner && i.Put.TableName === 'sky-test',
    ),
  )
  await db.currentId(owner)
  assert.equal(calls.at(-1).ConsistentRead, true)
  await db.history(owner, 10)
  assert.equal(calls.at(-1).Limit, 11)
  assert.equal(calls.at(-1).ScanIndexForward, false)
  assert.equal(calls.at(-1).ConsistentRead, true)
})
test('Dynamo atomically abandons via a terminal game row and receipt without writing history or current', async () => {
  let transaction
  const db = createDynamoStore({
    tableName: 'sky-test',
    client: {
      async send(cmd) {
        transaction = cmd.input
        return {}
      },
    },
  })
  const game = {
    id: randomUUID(),
    revision: 2,
    createSignature: 'create-hash',
    abandonedAt: '2026-01-01T00:00:00.000Z',
  }
  const rid = randomUUID()
  assert.equal(await db.commit('owner', game, 1, rid, 'abandon-hash'), true)
  assert.equal(transaction.TransactItems.length, 2)
  const [state, receipt] = transaction.TransactItems.map((x) => x.Put)
  assert.equal(state.Item.sk, 'G#' + game.id)
  assert.equal(state.Item.abandonedAt, game.abandonedAt)
  assert.deepEqual(state.Item.game, game)
  assert.equal(state.Item.revision, 2)
  assert.equal(state.ExpressionAttributeValues[':expected'], 1)
  assert.match(state.ConditionExpression, /attribute_not_exists\(abandonedAt\)/)
  assert.match(state.ConditionExpression, /attribute_not_exists\(finishedAt\)/)
  assert.equal(receipt.Item.sk, 'R#' + game.id + '#' + rid)
  assert.equal(receipt.Item.signature, 'abandon-hash')
  assert.equal(receipt.ConditionExpression, 'attribute_not_exists(pk)')
})
test('Dynamo cancels conflicting revisions and retries transient transaction conflicts with one token', async () => {
  const makeError = (code) =>
    Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      ...(code === 'undetailed'
        ? {}
        : { CancellationReasons: [{ Code: code }] }),
    })
  const tokens = []
  let code = 'TransactionConflict'
  const db = createDynamoStore({
    tableName: 't',
    client: {
      async send(cmd) {
        tokens.push(cmd.input.ClientRequestToken)
        if (code) {
          const current = code
          code = null
          throw makeError(current)
        }
        return {}
      },
    },
  })
  const game = { id: randomUUID(), revision: 0 }
  assert.equal(await db.create('hash', game), true)
  assert.equal(tokens.length, 2)
  assert.equal(tokens[0], tokens[1])
  code = 'ConditionalCheckFailed'
  assert.equal(await db.create('hash', game), false)
  code = 'undetailed'
  assert.equal(await db.create('hash', game), false)
  assert.throws(() => createDynamoStore({}), /SKYJO_TABLE/)
})
