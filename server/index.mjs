import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createApi } from './api.mjs'
import { createDynamoStore } from './store.mjs'

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/coach', ['coach/index.html', 'text/html; charset=utf-8']],
  ['/coach/', ['coach/index.html', 'text/html; charset=utf-8']],
  ['/coach/app.js', ['coach/app.js', 'text/javascript; charset=utf-8']],
  ['/coach/style.css', ['coach/style.css', 'text/css; charset=utf-8']],
])
const headers = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
}
function serveAsset(event, cache, readAsset) {
  const path = event.rawPath === '/index.html' ? '/' : event.rawPath
  const file = files.get(path)
  if (!file) return { statusCode: 404, headers: { ...headers, 'cache-control': 'no-store' }, body: 'Page not found' }
  let result = cache.get(path)
  if (!result) {
    const body = readAsset(file[0])
    const etag = '"' + createHash('sha256').update(body).digest('hex') + '"'
    const sharedTtl = file[0].endsWith('.html') ? 60 : 300
    result = {
      body,
      headers: {
        ...headers,
        'content-type': file[1],
        'cache-control': 'public, max-age=0, s-maxage=' + sharedTtl + ', must-revalidate',
        etag,
      },
    }
    cache.set(path, result)
  }
  const candidates = (event.headers?.['if-none-match'] ?? '').split(',')
  const fresh = candidates.some((tag) => {
    const candidate = tag.trim().replace(/^W\//, '')
    return candidate === '*' || candidate === result.headers.etag
  })
  return {
    statusCode: fresh ? 304 : 200,
    headers: result.headers,
    body: fresh || event.requestContext.http.method === 'HEAD' ? '' : result.body,
  }
}

function readPublicAsset(name) {
  return readFileSync(new URL('./public/' + name, import.meta.url), 'utf8')
}

export function createHandler(store, readAsset = readPublicAsset) {
  const cache = new Map()
  return createApi({
    store,
    serveAsset: (event) => serveAsset(event, cache, readAsset),
    logError: ({ scope, operation, type }) => console.error(JSON.stringify({ scope, operation, type })),
  })
}

let api
export async function handler(event) {
  if (!api) {
    const tableName = process.env.SKYJO_TABLE
    if (!tableName) {
      return { statusCode: 503, headers: { 'cache-control': 'no-store' }, body: 'Game service is unavailable' }
    }
    api = createHandler(createDynamoStore({ tableName }))
  }
  return api(event)
}
