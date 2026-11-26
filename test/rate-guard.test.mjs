import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { createApi } from '../server/api.mjs'
import { createRateGuard } from '../server/rate-guard.mjs'
import { createMemoryStore } from '../server/store.mjs'

const windowMs = 300_000
const sampleIp = '2001:db8::1'
const trusted = { 'x-skyjo-viewer-ip': sampleIp }
const gamePath = '/api/games/00000000-0000-0000-0000-000000000001/moves'

function fixture(mode = 'enforce') {
  const owner = randomBytes(32).toString('base64url')
  const calls = []
  const logs = []
  const counts = new Map()
  let time = windowMs - 1501
  const env = { SKYJO_RATE_MODE: mode, SKYJO_RATE_STARTS: '1', SKYJO_RATE_MOVES: '2', SKYJO_RATE_API: '6' }
  const handler = createApi({
    store: createMemoryStore(),
    serveAsset: () => ({ statusCode: 200 }),
    rateGuard: createRateGuard({
      env,
      now: () => time,
      log: row => logs.push(row),
      async consume(input) {
        const { bucket, window, kind, limits } = input
        calls.push(input)
        const key = bucket + '/' + window
        const n = counts.get(key) ?? { starts: 0, moves: 0, other: 0, api: 0 }
        n.api++
        n[kind]++
        counts.set(key, n)
        return n.api <= limits.api && (kind === 'other' || n[kind] <= limits[kind])
      },
    }),
  })
  const run = (method, rawPath, headers, body) => handler({
    rawPath, requestContext: { http: { method, sourceIp: '198.51.100.55' } },
    headers, body: body && JSON.stringify(body),
  })
  const api = (method, path, body, headers) =>
    run(method, path, { 'x-skyjo-profile': owner, ...trusted, ...headers }, body)
  return { api, run, calls, logs, tick(ms) { time += ms } }
}

test('enforcement shares profile-independent, rotating quotas from canonical viewer addresses', async () => {
  const { api, calls, logs, tick } = fixture()
  const request = { requestId: randomUUID(), opponents: ['board'] }
  const created = await api('POST', '/api/games', request)
  assert.equal(created.statusCode, 201)
  const replay = await api('POST', '/api/games/', request, {
    'x-skyjo-profile': randomBytes(32).toString('base64url'),
    'x-skyjo-viewer-ip': '2001:0DB8:0000:0000:0000:0000:0000:0001',
    'x-forwarded-for': '198.51.100.21',
  })
  assert.equal(replay.statusCode, 429)
  assert.equal(replay.headers['retry-after'], '2')
  const denied = await api('POST', '/api/games', request)
  assert.equal(denied.statusCode, 429)
  assert.equal(calls.length, 2, 'cached denials need no more writes in this warm container')
  assert.equal(calls[0].bucket, calls[1].bucket)
  assert.match(calls[0].bucket, /^[0-9a-f]{5}$/)
  assert.equal(logs.length, 1)
  assert.ok(!JSON.stringify({ calls, logs }).includes(sampleIp))

  // Exceeding the creation quota leaves the turn and read budgets usable.
  assert.equal((await api('GET', '/api/engines')).statusCode, 200)
  assert.equal((await api('POST', gamePath, {})).statusCode, 400)
  assert.deepEqual(calls.map(c => c.kind), ['starts', 'starts', 'other', 'moves'])
  tick(1501)
  const accepted = await api('POST', '/api/games', request)
  assert.equal(accepted.statusCode, 200, 'original idempotent receipt survives the throttle')
  assert.deepEqual(JSON.parse(accepted.body).game, JSON.parse(created.body).game)
  assert.notEqual(calls.at(-1).window, calls[0].window)
  assert.notEqual(calls.at(-1).bucket, calls[0].bucket)
})

test('static coach and assets never consume quota; API cannot use a caller-supplied forwarding chain', async () => {
  const { run, calls, logs } = fixture()
  for (const path of ['/', '/coach', '/coach/style.css'])
    assert.equal((await run('GET', path, {})).statusCode, 200)
  for (const headers of [
    {}, { 'x-forwarded-for': '192.0.2.2' },
    { ...trusted, 'X-Skyjo-Viewer-IP': '192.0.2.2' },
    { 'x-skyjo-viewer-ip': '192.0.2.2:1234' },
    { 'x-skyjo-viewer-ip': '192.0.2.2, 192.0.2.3' },
    { 'x-skyjo-viewer-ip': 'fe80::1%eth0' },
  ]) {
    const res = await run('GET', '/api/engines', headers)
    assert.equal(res.statusCode, 503)
    assert.equal(JSON.parse(res.body).error.code, 'rate_check_unavailable')
  }
  assert.equal(calls.length, 0)
  assert.deepEqual(logs, [{ scope: 'traffic', outcome: 'missing_viewer', kind: 'other' }])
})

test('count mode permits over-budget requests and reports without logging an address or profile', async () => {
  const { run, calls, logs } = fixture('count')
  for (let i = 0; i < 9; i++)
    assert.equal((await run('GET', '/api/engines', trusted)).statusCode, 200)
  assert.equal(calls.length, 9)
  assert.deepEqual(logs, [{ scope: 'traffic', outcome: 'would_limit', kind: 'other' }])
})

test('observed storage failures and unusable configuration return retryable 503, independently of limits', async () => {
  for (const env of [
    { SKYJO_RATE_MODE: 'enforce' },
    { SKYJO_RATE_MODE: 'count' },
    { SKYJO_RATE_MODE: 'unknown' },
    { SKYJO_RATE_MODE: 'enforce', SKYJO_RATE_STARTS: 'zero' },
  ]) {
    const guard = createRateGuard({
      env,
      consume: async () => { throw Object.assign(new Error(), { name: 'ProvisionedThroughputExceededException' }) },
    })
    const deny = await guard(trusted, 'POST', '/api/games')
    assert.equal(deny.status, 503)
    assert.equal(deny.retryAfter, 2)
  }
  assert.equal(createRateGuard({ env: {} }), undefined)
  assert.equal(createRateGuard({ env: { SKYJO_RATE_MODE: 'off' } }), undefined)
})
