import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

const windowMs = 300_000
const defaults = { starts: 20, moves: 600, api: 1200 }
const storageBusy = {
  status: 503,
  code: 'rate_check_unavailable',
  message: 'The game service is temporarily unavailable. Retry the same request.',
  retryAfter: 2,
}

function trustedAddress(headers = {}) {
  const fields = Object.entries(headers).filter(([key]) => key.toLowerCase() === 'x-skyjo-viewer-ip')
  if (fields.length !== 1) return null
  const ip = fields[0][1]
  if (typeof ip !== 'string' || ip.length > 45 || ip.includes('%')) return null
  const family = isIP(ip)
  if (family === 4) return ip
  if (family !== 6) return null
  // URL parsing canonicalizes alternate textual spellings of the same IPv6 address.
  return new URL('http://[' + ip + ']').hostname
}

function category(method, path) {
  if (method === 'POST' && path === '/api/games') return 'starts'
  if (method === 'POST' && /^\/api\/games\/[^/]+\/(moves|abandon)$/.test(path)) return 'moves'
  return 'other'
}

function limitsFrom(env) {
  const limits = {}
  for (const [name, fallback] of Object.entries(defaults)) {
    const input = env['SKYJO_RATE_' + name.toUpperCase()]
    const n = input === undefined ? fallback : Number(input)
    if (!Number.isSafeInteger(n) || n < 1 || n > 2_000_000_000) return null
    limits[name] = n
  }
  return limits
}

/** Called only on API routes behind the OAC origin and the viewer-IP overwrite function. */
export function createRateGuard({ env, consume, now = Date.now, log }) {
  const mode = env.SKYJO_RATE_MODE ?? 'off'
  if (mode === 'off') return undefined
  const limits = limitsFrom(env)
  const configured = (mode === 'count' || mode === 'enforce') && limits !== null
  const observations = new Map()
  const blocked = new Set()
  let blockedEpoch = -1

  function observe(outcome, kind, time) {
    const minute = Math.floor(time / 60_000)
    const event = outcome + ':' + kind
    if (observations.get(event) === minute) return
    observations.set(event, minute)
    log?.({ scope: 'traffic', outcome, kind })
  }
  return async function check(headers, method, path) {
    const time = now()
    const kind = category(method, path)
    const ip = trustedAddress(headers)
    if (!configured || !ip) {
      observe(configured ? 'missing_viewer' : 'invalid_configuration', kind, time)
      return storageBusy
    }
    const epoch = Math.floor(time / windowMs)
    if (blockedEpoch !== epoch) {
      blocked.clear()
      blockedEpoch = epoch
    }
    // One of 2^20 coarse buckets, rehashed each window. Collisions share a budget.
    const bucket = createHash('sha256').update('skyjo-rate-v1:' + epoch + ':' + ip).digest('hex').slice(0, 5)
    const cacheKey = bucket + ':' + kind
    let allowed = false
    if (!blocked.has(cacheKey)) {
      try {
        allowed = await consume({ bucket, window: epoch, kind, limits, countOnly: mode === 'count' })
      } catch {
        observe('store_unavailable', kind, time)
        return storageBusy
      }
    }
    if (allowed) return null
    observe(mode === 'count' ? 'would_limit' : 'limited', kind, time)
    if (mode === 'count') return null
    // Only denials may be cached. A second runtime still enforces the same DynamoDB budget.
    if (blockedEpoch === epoch && blocked.size < 256) blocked.add(cacheKey)
    return {
      status: 429,
      code: 'rate_limited',
      message: 'Too many requests. Try again after the current five-minute window.',
      retryAfter: Math.max(1, Math.ceil(((epoch + 1) * windowMs - time) / 1000)),
    }
  }
}
