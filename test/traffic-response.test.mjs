import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

// CloudFront loads a global handler, so exercise the same source that gets published.
const source = readFileSync(new URL('../infra/traffic-response.js', import.meta.url), 'utf8')
const handler = runInNewContext(source + '\nhandler')
const header = 'x-amzn-waf-skyjo-rate'

test('the viewer function forwards an ordinary API request intact', () => {
  const request = { method: 'POST', uri: '/api/games', headers: { 'x-skyjo-profile': { value: 'example' } } }
  assert.equal(handler({ request }), request)
  request.headers[header] = { value: '0' }
  assert.equal(handler({ request }), request)
})

test('an edge rate marker returns an uncached 429 even when multiple rate rules match', () => {
  for (const marker of [{ value: '1' }, { value: '0', multiValue: [{ value: '0' }, { value: '1' }] }]) {
    const request = { method: 'POST', uri: '/api/games', headers: { [header]: marker } }
    const response = handler({ request })
    assert.equal(response.statusCode, 429)
    assert.equal(response.headers['cache-control'].value, 'no-store')
    assert.equal(response.headers['retry-after'].value, '300')
    assert.equal(response.headers['content-type'].value, 'application/json')
    assert.equal(JSON.parse(response.body.data).error.code, 'rate_limited')
  }
})
