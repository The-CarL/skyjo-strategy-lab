import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb'

const historyPrefix = 'H#'
const gameKey = (id) => 'G#' + id
const receiptKey = (id, requestId) => 'R#' + id + '#' + requestId
const historyKey = (summary) =>
  historyPrefix + summary.finishedAt + '#' + summary.id
const copy = (x) => (x == null ? null : structuredClone(x))

/** Shared store contract: a write returns false when one of its compare-and-set conditions failed. */
export function createMemoryStore() {
  const accounts = new Map()
  const existing = (owner) => accounts.get(owner)
  function ensure(owner) {
    if (!accounts.has(owner))
      accounts.set(owner, {
        games: new Map(),
        receipts: new Map(),
        history: new Map(),
        current: null,
      })
    return accounts.get(owner)
  }
  return {
    async getGame(owner, id) {
      return copy(existing(owner)?.games.get(id))
    },
    async currentId(owner) {
      return existing(owner)?.current ?? null
    },
    async receipt(owner, id, requestId) {
      return existing(owner)?.receipts.get(receiptKey(id, requestId)) ?? null
    },
    async create(owner, game) {
      const a = ensure(owner)
      if (a.games.has(game.id)) return false
      a.games.set(game.id, copy(game))
      a.current = game.id
      return true
    },
    async commit(owner, game, expected, requestId, signature, summary) {
      const a = existing(owner),
        old = a?.games.get(game.id),
        key = receiptKey(game.id, requestId)
      if (
        !old ||
        old.revision !== expected ||
        old.finishedAt ||
        a.receipts.has(key)
      )
        return false
      a.games.set(game.id, copy(game))
      a.receipts.set(key, signature)
      if (summary) a.history.set(historyKey(summary), copy(summary))
      return true
    },
    async history(owner, limit, after = null) {
      const rows = [...(existing(owner)?.history.entries() ?? [])]
        .filter(([key]) => after === null || key < after)
        .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
      const page = rows.slice(0, limit)
      return {
        items: page.map(([, s]) => copy(s)),
        next: rows.length > limit ? page.at(-1)[0] : null,
      }
    },
  }
}

// A response without cancellation details also needs a consistent readback from the API.
function needsReadback(error) {
  if (error.name === 'ConditionalCheckFailedException') return true
  return (
    error.name === 'TransactionCanceledException' &&
    (!error.CancellationReasons?.length ||
      error.CancellationReasons.some(
        (r) => r.Code === 'ConditionalCheckFailed',
      ))
  )
}
function retryConflict(error) {
  return (
    error.name === 'TransactionConflictException' ||
    (error.name === 'TransactionCanceledException' &&
      error.CancellationReasons?.some((r) =>
        [
          'TransactionConflict',
          'ThrottlingError',
          'ProvisionedThroughputExceeded',
        ].includes(r.Code),
      ))
  )
}

/** Install once per Lambda container. The table uses string keys pk and sk with no indexes. */
export function createDynamoStore({ tableName, client } = {}) {
  if (typeof tableName !== 'string' || !tableName)
    throw Error('Set SKYJO_TABLE')
  const db =
    client ??
    DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 3 }), {
      marshallOptions: { removeUndefinedValues: true },
    })
  const key = (owner, sk) => ({ pk: 'P#' + owner, sk })
  async function get(owner, sk) {
    const result = await db.send(
      new GetCommand({
        TableName: tableName,
        Key: key(owner, sk),
        ConsistentRead: true,
      }),
    )
    return result.Item ?? null
  }
  function put(Item, ConditionExpression, extra = {}) {
    return {
      Put: {
        TableName: tableName,
        Item,
        ...(ConditionExpression ? { ConditionExpression } : {}),
        ...extra,
      },
    }
  }
  const newKey = 'attribute_not_exists(pk)'
  async function transact(items) {
    // Keep the same token and transaction bytes across backend conflict retries.
    const cmd = new TransactWriteCommand({
      TransactItems: items,
      ClientRequestToken: randomUUID(),
    })
    for (let attempt = 0; ; attempt++) {
      try {
        await db.send(cmd)
        return true
      } catch (error) {
        if (needsReadback(error)) return false
        if (!retryConflict(error) || attempt >= 2) throw error
        await sleep(15 * 2 ** attempt + Math.random() * 20)
      }
    }
  }
  const row = (owner, g) => ({
    ...key(owner, gameKey(g.id)),
    revision: g.revision,
    game: g,
    ...(g.finishedAt ? { finishedAt: g.finishedAt } : {}),
  })
  return {
    async getGame(owner, id) {
      return (await get(owner, gameKey(id)))?.game ?? null
    },
    async currentId(owner) {
      return (await get(owner, 'CURRENT'))?.gameId ?? null
    },
    async receipt(owner, id, requestId) {
      return (await get(owner, receiptKey(id, requestId)))?.signature ?? null
    },
    async create(owner, g) {
      return transact([
        put(row(owner, g), newKey),
        put({ ...key(owner, 'CURRENT'), gameId: g.id }),
      ])
    },
    async commit(owner, g, expected, requestId, signature, summary) {
      const items = [
        put(
          row(owner, g),
          '#rev = :expected AND attribute_not_exists(finishedAt)',
          {
            ExpressionAttributeNames: { '#rev': 'revision' },
            ExpressionAttributeValues: { ':expected': expected },
          },
        ),
        put({ ...key(owner, receiptKey(g.id, requestId)), signature }, newKey),
      ]
      if (summary)
        items.push(put({ ...key(owner, historyKey(summary)), summary }, newKey))
      return transact(items)
    },
    async history(owner, limit, after = null) {
      const req = {
        TableName: tableName,
        KeyConditionExpression: 'pk = :owner AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':owner': 'P#' + owner,
          ':prefix': historyPrefix,
        },
        ConsistentRead: true,
        ScanIndexForward: false,
        Limit: limit + 1,
        ...(after ? { ExclusiveStartKey: key(owner, after) } : {}),
      }
      const { Items = [], LastEvaluatedKey } = await db.send(
        new QueryCommand(req),
      )
      const page = Items.slice(0, limit)
      const more = Items.length > limit || Boolean(LastEvaluatedKey)
      return {
        items: page.map((x) => x.summary),
        next: more ? (page.at(-1)?.sk ?? LastEvaluatedKey.sk) : null,
      }
    },
  }
}
