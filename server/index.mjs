import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createApi } from './api.mjs'
import { createDynamoStore } from './store.mjs'

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
])
const cachedAssets = new Map()
const headers = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
}
function serveAsset(event) {
  const path = event.rawPath === '/index.html' ? '/' : event.rawPath
  const file = files.get(path)
  if (!file) return { statusCode: 404, headers, body: 'Page not found' }
  let result = cachedAssets.get(path)
  if (!result) {
    const body = readFileSync(new URL('./public/' + file[0], import.meta.url), 'utf8')
    const etag = '"' + createHash('sha256').update(body).digest('hex') + '"'
    result = { body, headers: { ...headers, 'content-type': file[1], 'cache-control': 'no-cache', etag } }
    cachedAssets.set(path, result)
  }
  const fresh = event.headers?.['if-none-match'] === result.headers.etag
  return {
    statusCode: fresh ? 304 : 200,
    headers: result.headers,
    body: fresh || event.requestContext.http.method === 'HEAD' ? '' : result.body,
  }
}

export function createHandler(store) {
  return createApi({
    store,
    serveAsset,
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
