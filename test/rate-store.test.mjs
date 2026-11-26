import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { createRateStore } from '../server/rate-store.mjs'

const defaults = { bucket: '000af', window: 3, kind: 'starts', limits: { starts: 2, moves: 4, api: 5 } }
const rateKey = 'R#SKYJO#000af'
function conflict(row) {
  const error = new Error('Condition rejected')
  error.name = 'ConditionalCheckFailedException'
  if (row) error.Item = { window: { N: String(row.window) } }
  throw error
}

function memoryClient() {
  const rows = new Map()
  return {
    rows,
    async send(command) {
      const input = command.input
      assert.equal(input.TableName, 'test')
      assert.equal(input.ReturnValuesOnConditionCheckFailure, 'ALL_OLD')
      const names = input.ExpressionAttributeNames
      assert.equal(names['#window'], 'window')
      const epoch = input.ExpressionAttributeValues[':window']
      if (command instanceof PutCommand) {
        assert.equal(input.ConditionExpression, 'attribute_not_exists(pk) OR #window < :window')
        assert.equal(input.Item.sk, 'RATE')
        const old = rows.get(input.Item.pk)
        if (old && old.window >= epoch) conflict(old)
        rows.set(input.Item.pk, { ...input.Item })
        return {}
      }
      assert.ok(command instanceof UpdateCommand)
      assert.equal(input.Key.sk, 'RATE')
      assert.equal(input.ConditionExpression, '#window = :window')
      const row = rows.get(input.Key.pk)
      if (!row || row.window !== epoch) conflict(row)
      assert.equal(input.ReturnValues, 'UPDATED_NEW')
      assert.equal(input.ExpressionAttributeValues[':one'], 1)
      assert.equal(names['#api'], 'api')
      const kind = names['#kind']
      assert.equal(input.UpdateExpression, kind ? 'ADD #api :one, #kind :one' : 'ADD #api :one')
      const changed = { api: ++row.api }
      if (kind) changed[kind] = ++row[kind]
      return { Attributes: changed }
    },
  }
}

test('every attempt counts toward API quota and only its matching category', async () => {
  const client = memoryClient()
  const { consume } = createRateStore(client, 'test')
  const kinds = ['starts', 'starts', 'starts', 'other', 'moves', 'moves']
  const decisions = []
  for (const kind of kinds) decisions.push(await consume({ ...defaults, kind, countOnly: true }))
  assert.deepEqual(decisions, [true, true, false, true, true, false])
  assert.deepEqual(client.rows.get(rateKey), {
    pk: rateKey, sk: 'RATE', window: 3, api: 6, starts: 3, moves: 2,
  })
  assert.equal(await consume({ ...defaults, bucket: '000a0' }), true)
  assert.equal(await consume({ ...defaults, window: 4, limits: { starts: 0, moves: 1, api: 1 } }), false)
  assert.equal(client.rows.size, 2)
})

test('concurrent cold starts and rollover count each invocation once across clients', async () => {
  const db = memoryClient()
  const clients = Array.from({ length: 5 }, () => createRateStore(db, 'test'))
  for (const window of [0, 1, 1234]) {
    const allowed = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      clients[i % clients.length].consume({ ...defaults, window, kind: 'moves' })))
    assert.equal(allowed.filter(Boolean).length, 4)
    assert.deepEqual(db.rows.get(rateKey), { pk: rateKey, sk: 'RATE', window, starts: 0, moves: 20, api: 20 })
    assert.equal(db.rows.size, 1)
  }
  assert.equal(await clients[0].consume(defaults), false)
  assert.equal(db.rows.get(rateKey).window, 1234)
  assert.equal(db.rows.get(rateKey).api, 20)
})

test('a delayed prior-window reset cannot replace a newly opened window', async () => {
  const db = memoryClient()
  const fresh = createRateStore(db, 'test')
  const delayed = createRateStore({
    async send(command) {
      if (command instanceof PutCommand)
        assert.equal(await fresh.consume({ ...defaults, window: 4, kind: 'other' }), true)
      return db.send(command)
    },
  }, 'test')
  assert.equal(await delayed.consume(defaults), false)
  assert.deepEqual(db.rows.get(rateKey), { pk: rateKey, sk: 'RATE', window: 4, starts: 0, moves: 0, api: 1 })
})

test('invalid bucket, window, kind, or bound cannot create a counter row', async () => {
  const db = memoryClient()
  const { consume } = createRateStore(db, 'test')
  for (const bad of [
    { bucket: 'FFFFF' }, { bucket: '12345x' }, { bucket: 12345 }, { bucket: 'abcde\n' },
    { window: -1 }, { window: 3.2 }, { window: 2 ** 53 }, { kind: 'new' },
    { limits: { starts: -1, moves: 4, api: 5 } }, { limits: { moves: 4, api: 5 } },
  ]) await assert.rejects(consume({ ...defaults, ...bad }), /Invalid rate/)
  assert.equal(db.rows.size, 0)
})

test('ambiguous writes, malformed counter images and throttled IO propagate as errors', async () => {
  for (const name of ['TimeoutError', 'ProvisionedThroughputExceededException']) {
    const error = new Error('simulated IO failure')
    error.name = name
    let calls = 0
    const store = createRateStore({ send() { calls++; throw error } }, 'test')
    await assert.rejects(store.consume(defaults), (actual) => actual === error)
    assert.equal(calls, 1)
  }
  const bad = new Error('unexpected wire shape')
  bad.name = 'ConditionalCheckFailedException'
  for (const Item of [{}, { window: { N: '-1' } }, { window: 3 }]) {
    bad.Item = Item
    const store = createRateStore({ send() { throw bad } }, 'test')
    await assert.rejects(store.consume(defaults), /Invalid stored rate window/)
  }
  const missingCounts = createRateStore({ async send() { return {} } }, 'test')
  await assert.rejects(missingCounts.consume(defaults), /Missing rate counter/)
})

test('the installed DocumentClient exposes raw ALL_OLD failures and native successful counters', async () => {
  const operations = []
  const low = new DynamoDBClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 1,
    requestHandler: {
      async handle(request) {
        const method = request.headers['x-amz-target'].split('.').pop()
        operations.push(method)
        const body = JSON.parse(new TextDecoder().decode(request.body))
        assert.equal(body.ReturnValuesOnConditionCheckFailure, 'ALL_OLD')
        assert.deepEqual(body.ExpressionAttributeValues[':window'], { N: '3' })
        const before = operations.length < 3
        const payload = before
          ? { __type: 'ConditionalCheckFailedException', Item: { window: { N: String(operations.length + 1) } } }
          : { Attributes: { api: { N: '4' }, starts: { N: '2' } } }
        return { response: {
          statusCode: before ? 400 : 200,
          headers: { 'content-type': 'application/x-amz-json-1.0' },
          body: Readable.from([Buffer.from(JSON.stringify(payload))]),
        } }
      },
      destroy() {},
    },
  })
  try {
    const { consume } = createRateStore(DynamoDBDocumentClient.from(low), 'test')
    assert.equal(await consume(defaults), true)
    assert.deepEqual(operations, ['UpdateItem', 'PutItem', 'UpdateItem'])
  } finally {
    low.destroy()
  }
})
