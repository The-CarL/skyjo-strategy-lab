import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../infra/origin-viewer.js', import.meta.url), 'utf8')
const forward = runInNewContext(source + '\nhandler')
const key = 'x-skyjo-viewer-ip'

for (const [ip, path] of [['192.0.2.27', '/api'], ['2001:db8::15', '/api/games/current']]) {
  test('forwards only the viewer IP while preserving the request for ' + path, () => {
    for (const existing of [null, { value: 'client-value', multiValue: [{ value: 'client-value' }, { value: 'extra' }] }]) {
      const req = {
        method: 'POST', uri: path, querystring: {limit: {value: '10'}},
        headers: { 'x-skyjo-profile': { value: 'example-profile' }, ...(existing ? { [key]: existing } : {}) },
        cookies: { a: {value: 'test'} },
      }
      const expected = structuredClone(req)
      expected.headers[key] = { value: ip }
      const result = forward({ viewer: { ip }, request: req })
      assert.deepEqual(structuredClone(result), expected)
    }
  })
}

test('a static or unrelated path never receives the viewer address', () => {
  for (const uri of ['/', '/coach', '/apiary/test']) {
    const req = { uri, headers: { [key]: { value: 'client supplied' } } }
    assert.deepEqual(structuredClone(forward({viewer: {ip: '192.0.2.1'}, request: req})), { uri, headers: {} })
  }
})
