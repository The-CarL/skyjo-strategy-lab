import { createHash, randomBytes } from 'node:crypto'
import {
  engineCatalog,
  createMatch,
  applyCommand,
  publicMatch,
  MatchCommandError,
} from '../src/online-match.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HISTORY_KEY = /^H#\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z#[0-9a-f-]{36}$/
const LIMIT_BYTES = 8192
const PAUSE_RECHECK_SECONDS = 5
const commands = new Set(['open', 'draw', 'take', 'swap', 'flip', 'nextRound'])
const hash = (...parts) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex')

class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message)
    this.status = status
    this.code = code
    this.headers = headers
  }
}
const invalid = (message) => new HttpError(400, 'invalid_request', message)
const missing = () => new HttpError(404, 'game_not_found', 'Game not found.')
const abandoned = () =>
  new HttpError(410, 'game_abandoned', 'This game was abandoned.')
const mismatch = () =>
  new HttpError(
    409,
    'idempotency_conflict',
    'That request ID already identifies a different operation.',
  )
const stale = () =>
  new HttpError(
    409,
    'revision_conflict',
    'The game changed. Reload it and choose your move again.',
  )
const newGamesPaused = () =>
  new HttpError(
    503,
    'new_games_paused',
    'New games are temporarily paused. You can still play an existing game or use the coach.',
    { 'retry-after': String(PAUSE_RECHECK_SECONDS) },
  )
const unavailable = () =>
  new HttpError(
    503,
    'store_unavailable',
    'Game storage is temporarily unavailable. Retry the same request.',
    { 'retry-after': '1' },
  )
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const fields = (v, allowed) =>
  object(v) && Object.keys(v).every((k) => allowed.includes(k))
const integerSlot = (x) => Number.isInteger(x) && x >= 0 && x < 12

function reply(statusCode, payload, extra = {}) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...extra,
    },
    body: JSON.stringify(payload),
  }
}
function header(event, wanted) {
  const headers = event.headers ?? {}
  return (
    headers[wanted] ??
    Object.entries(headers).find(([name]) => name.toLowerCase() === wanted)?.[1]
  )
}
function profile(event) {
  const auth = header(event, 'authorization')
  const raw = header(event, 'x-skyjo-profile')
  const bearer =
    typeof auth === 'string' && /^Bearer /i.test(auth)
      ? auth.slice(7)
      : undefined
  // With a signed origin request, Authorization belongs to AWS. A legacy bearer
  // can still carry the same profile during the transition.
  const token = raw ?? bearer
  if (
    typeof token !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    Buffer.from(token, 'base64url').toString('base64url') !== token ||
    (raw !== undefined && bearer !== undefined && raw !== bearer)
  ) {
    throw new HttpError(
      401,
      'invalid_profile',
      'A valid profile key is required.',
      { 'www-authenticate': 'Bearer' },
    )
  }
  return hash('skyjo:profile:v1', token)
}
function jsonBody(event) {
  const type = header(event, 'content-type')
  if (type && type.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(
      415,
      'unsupported_media_type',
      'Send JSON with Content-Type application/json.',
    )
  }
  if (typeof event.body !== 'string' || !event.body.length)
    throw invalid('A JSON object is required.')
  if (
    event.body.length >
    (event.isBase64Encoded ? Math.ceil(LIMIT_BYTES / 3) * 4 : LIMIT_BYTES)
  ) {
    throw new HttpError(413, 'body_too_large', 'The request body is too large.')
  }
  const raw = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8')
  if (raw.length > LIMIT_BYTES)
    throw new HttpError(413, 'body_too_large', 'The request body is too large.')
  let value
  try {
    value = JSON.parse(raw.toString('utf8'))
  } catch {
    throw invalid('The request body is invalid JSON.')
  }
  if (!object(value)) throw invalid('A JSON object is required.')
  return value
}
function requestId(value) {
  if (typeof value !== 'string' || !UUID.test(value))
    throw invalid('Use a UUID for requestId.')
  return value.toLowerCase()
}
function actionData(action) {
  if (!object(action) || !commands.has(action.kind))
    throw invalid('Unknown game action.')
  const { kind } = action
  if (kind === 'open') {
    if (
      !fields(action, ['kind', 'slots']) ||
      !Array.isArray(action.slots) ||
      action.slots.length !== 2 ||
      !action.slots.every(integerSlot) ||
      action.slots[0] === action.slots[1]
    )
      throw invalid('Choose two different opening cards.')
    return { kind, slots: [...action.slots] }
  }
  if (kind === 'draw' || kind === 'nextRound') {
    if (!fields(action, ['kind']))
      throw invalid('Unexpected fields in this action.')
    return { kind }
  }
  if (!fields(action, ['kind', 'slot']) || !integerSlot(action.slot))
    throw invalid('Choose a valid card slot.')
  return { kind, slot: action.slot }
}
function gameId(owner, rid) {
  const b = Buffer.from(hash('skyjo:create:v1', owner, rid).slice(0, 32), 'hex')
  b[6] = (b[6] & 15) | 0x80
  b[8] = (b[8] & 63) | 0x80
  const s = b.toString('hex')
  return [
    s.slice(0, 8),
    s.slice(8, 12),
    s.slice(12, 16),
    s.slice(16, 20),
    s.slice(20),
  ].join('-')
}
const encodeCursor = (owner, key) =>
  Buffer.from(owner + '|' + key).toString('base64url')
function decodeCursor(owner, token) {
  if (token == null) return null
  if (typeof token !== 'string' || !/^[a-z0-9_-]{1,220}$/i.test(token))
    throw invalid('Invalid history cursor.')
  const bin = Buffer.from(token, 'base64url')
  const [who, key, ...rest] = bin.toString().split('|')
  if (
    who !== owner ||
    !HISTORY_KEY.test(key ?? '') ||
    rest.length ||
    bin.toString('base64url') !== token
  )
    throw invalid('Invalid history cursor.')
  return key
}
function expectMethod(method, allowed) {
  if (!allowed.includes(method))
    throw new HttpError(405, 'method_not_allowed', 'Method not allowed.', {
      allow: allowed.join(', '),
    })
}
function gameView(game) {
  if (game.abandonedAt) throw abandoned()
  return {
    ...publicMatch(game.state),
    id: game.id,
    createdAt: game.createdAt,
    updatedAt: game.updatedAt,
  }
}
function finishedSummary(game, view) {
  return {
    id: game.id,
    createdAt: game.createdAt,
    finishedAt: game.finishedAt,
    players: view.players.map(({ seat, engineId, name, total }) => ({
      seat,
      engineId,
      name,
      total,
      place: 1 + view.players.filter((p) => p.total < total).length,
    })),
    rounds: view.history,
    winners: view.winners,
  }
}

/** A Lambda function-URL v2 handler. Static content never receives an API request or an error payload. */
export function createApi({
  store,
  serveAsset,
  rateGuard,
  clock = () => new Date().toISOString(),
  seed = () => randomBytes(4).readUInt32LE(),
  logError,
} = {}) {
  const knownEngines = new Set(engineCatalog.map((x) => x.id))
  let pausedUntil = 0
  // Read and mutation failures that survive the SDK's retries can be retried with the same request ID.
  async function db(method, ...args) {
    try {
      return await store[method](...args)
    } catch (e) {
      logError?.({
        scope: 'store',
        operation: method,
        type: e?.name ?? 'Error',
      })
      throw unavailable()
    }
  }
  async function newGame(owner, body) {
    if (!fields(body, ['requestId', 'opponents']))
      throw invalid('Unexpected fields in game setup.')
    const rid = requestId(body.requestId),
      opponents = body.opponents
    if (
      !Array.isArray(opponents) ||
      opponents.length < 1 ||
      opponents.length > 7 ||
      !opponents.every((id) => knownEngines.has(id))
    ) {
      throw invalid('Choose between one and seven listed opponent engines.')
    }
    const id = gameId(owner, rid),
      signature = hash('create', opponents)
    const replay = (old) => {
      if (old.createSignature !== signature) throw mismatch()
      return reply(200, { game: gameView(old) })
    }
    const existing = await db('getGame', owner, id)
    if (existing) return replay(existing)
    if (Date.now() < pausedUntil) throw newGamesPaused()
    const now = clock(),
      state = createMatch([...opponents], seed())
    const game = {
      id,
      createdAt: now,
      updatedAt: now,
      revision: state.revision,
      createSignature: signature,
      state,
    }
    if (await db('create', owner, game))
      return reply(201, { game: gameView(game) })
    const winner = await db('getGame', owner, id)
    if (winner) return replay(winner)
    if (await db('newGamesPaused')) {
      // Repeated attempts while paused still check for an accepted request ID.
      // Only refusals are cached. A new transaction always checks the owner switch.
      pausedUntil = Date.now() + PAUSE_RECHECK_SECONDS * 1000
      throw newGamesPaused()
    }
    throw unavailable()
  }
  async function changeGame(owner, id, body, operation) {
    const isAbandon = operation === 'abandon'
    const allowed = ['requestId', 'expectedRevision']
    if (!isAbandon) allowed.push('action')
    if (!fields(body, allowed))
      throw invalid('Unexpected fields in game request.')
    const rid = requestId(body.requestId)
    const expected = body.expectedRevision
    if (!Number.isSafeInteger(expected) || expected < 0)
      throw invalid('expectedRevision must be a nonnegative integer.')
    const action = isAbandon ? null : actionData(body.action)
    const signature = isAbandon
      ? hash('abandon', expected)
      : hash('move', expected, action)
    const before = await db('getGame', owner, id)
    if (!before) throw missing()
    async function replayOrReject() {
      const receipt = await db('receipt', owner, id, rid)
      if (receipt !== null && receipt !== signature) throw mismatch()
      if (isAbandon && receipt === signature) return reply(200, { game: null })
      const latest = await db('getGame', owner, id)
      if (!latest) throw missing()
      if (latest.abandonedAt) throw abandoned()
      if (receipt === signature) return reply(200, { game: gameView(latest) })
      if (latest.revision !== expected) throw stale()
      if (latest.finishedAt)
        throw new HttpError(409, 'game_finished', 'This game is complete.')
      // A competing request may still be committing a transaction with this ID.
      throw unavailable()
    }
    if (before.revision !== expected || before.finishedAt || before.abandonedAt)
      return replayOrReject()
    if (isAbandon) {
      // Retain the create identity and terminal revision so delayed requests cannot resurrect the game.
      const game = {
        id,
        createSignature: before.createSignature,
        revision: expected + 1,
        abandonedAt: clock(),
      }
      if (await db('commit', owner, game, expected, rid, signature))
        return reply(200, { game: null })
      return replayOrReject()
    }
    const state = applyCommand(before.state, action),
      now = clock()
    const game = { ...before, state, revision: state.revision, updatedAt: now }
    const view = gameView(game)
    let summary
    if (view.phase === 'gameOver') {
      game.finishedAt = now
      summary = finishedSummary(game, view)
    }
    if (await db('commit', owner, game, expected, rid, signature, summary))
      return reply(200, { game: view })
    return replayOrReject()
  }
  async function currentGame(owner) {
    let id = await db('currentId', owner)
    while (id) {
      const game = await db('getGame', owner, id)
      if (!game) return null
      if (!game.abandonedAt) return gameView(game)
      // A new game can be created between reading the pointer and reading the abandoned game.
      const latestId = await db('currentId', owner)
      if (latestId === id) return null
      id = latestId
    }
    return null
  }
  return async function handle(event) {
    try {
      const method = event.requestContext?.http?.method ?? event.httpMethod
      const path =
        (event.rawPath ?? event.path ?? '/').replace(/\/$/, '') || '/'
      if (!path.startsWith('/api/') && path !== '/api') {
        expectMethod(method, ['GET', 'HEAD'])
        return serveAsset
          ? await serveAsset(event)
          : reply(404, {
              error: { code: 'not_found', message: 'Page not found.' },
            })
      }
      if (rateGuard) {
        const denied = await rateGuard(event.headers, method, path)
        if (denied) {
          return reply(
            denied.status,
            { error: { code: denied.code, message: denied.message } },
            { 'retry-after': String(denied.retryAfter) },
          )
        }
      }
      if (path === '/api/engines') {
        expectMethod(method, ['GET'])
        return reply(200, { engines: engineCatalog })
      }
      const owner = profile(event)
      if (!store) throw unavailable()
      if (path === '/api/games') {
        expectMethod(method, ['POST'])
        return await newGame(owner, jsonBody(event))
      }
      if (path === '/api/games/current') {
        expectMethod(method, ['GET'])
        return reply(200, { game: await currentGame(owner) })
      }
      if (path === '/api/history') {
        expectMethod(method, ['GET'])
        const q =
          event.queryStringParameters ??
          Object.fromEntries(new URLSearchParams(event.rawQueryString ?? ''))
        const limit = q.limit === undefined ? 10 : Number(q.limit)
        if (!Number.isInteger(limit) || limit < 1 || limit > 30)
          throw invalid('History limit must be between 1 and 30.')
        const page = await db(
          'history',
          owner,
          limit,
          decodeCursor(owner, q.cursor),
        )
        return reply(200, {
          items: page.items,
          nextCursor: page.next ? encodeCursor(owner, page.next) : null,
        })
      }
      const route = /^\/api\/games\/([^/]+)(?:\/(moves|abandon))?$/.exec(path)
      if (route && UUID.test(route[1])) {
        const id = route[1].toLowerCase()
        if (route[2]) {
          expectMethod(method, ['POST'])
          return await changeGame(owner, id, jsonBody(event), route[2])
        }
        expectMethod(method, ['GET'])
        const game = await db('getGame', owner, id)
        if (!game) throw missing()
        return reply(200, { game: gameView(game) })
      }
      throw new HttpError(404, 'not_found', 'Endpoint not found.')
    } catch (e) {
      if (e instanceof MatchCommandError)
        return reply(422, {
          error: { code: 'illegal_move', message: e.message },
        })
      if (e instanceof HttpError)
        return reply(
          e.status,
          { error: { code: e.code, message: e.message } },
          e.headers,
        )
      logError?.({ scope: 'api', type: e?.name ?? 'Error' })
      return reply(500, {
        error: {
          code: 'internal_error',
          message: 'The game request could not be completed.',
        },
      })
    }
  }
}
