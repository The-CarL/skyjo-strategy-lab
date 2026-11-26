import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'

const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0

// The DocumentClient unmarshals successful results. DynamoDB exceptions retain
// their wire-format AttributeValues, including the item at the failed condition.
function failedWindow(error) {
  if (error.name !== 'ConditionalCheckFailedException') throw error
  if (error.Item === undefined) return -1
  const epoch = error.Item.window?.N
  if (typeof epoch !== 'string' || !/^\d+$/.test(epoch) || !nonnegative(Number(epoch)))
    throw new Error('Invalid stored rate window', { cause: error })
  return Number(epoch)
}

function withinLimits(row, kind, limits) {
  const counters = kind === 'other' ? ['api'] : ['api', kind]
  if (!counters.every((name) => nonnegative(row?.[name]) && row[name] > 0))
    throw new Error('Missing rate counter in DynamoDB response')
  return counters.every((name) => row[name] <= limits[name])
}

/** The boolean is the would-allow decision in both count and enforce modes. */
export function createRateStore(client, tableName) {
  if (typeof tableName !== 'string' || !tableName) throw new Error('Set SKYJO_TABLE')
  return {
    async consume({ bucket, window, kind, limits }) {
      if (typeof bucket !== 'string' || !/^[a-f0-9]{5}$/.test(bucket) || !nonnegative(window))
        throw new Error('Invalid rate bucket or window')
      if (
        !['starts', 'moves', 'other'].includes(kind) ||
        !['starts', 'moves', 'api'].every((name) => nonnegative(limits?.[name]))
      )
        throw new Error('Invalid rate category or limits')

      const key = { pk: 'R#SKYJO#' + bucket, sk: 'RATE' }
      const names = { '#window': 'window', '#api': 'api' }
      if (kind !== 'other') names['#kind'] = kind
      const increment = new UpdateCommand({
        TableName: tableName,
        Key: key,
        ConditionExpression: '#window = :window',
        UpdateExpression: 'ADD #api :one' + (kind === 'other' ? '' : ', #kind :one'),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: { ':window': window, ':one': 1 },
        ReturnValues: 'UPDATED_NEW',
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      })
      const first = {
        ...key,
        window,
        api: 1,
        starts: Number(kind === 'starts'),
        moves: Number(kind === 'moves'),
      }
      let reset = false
      // Normally one atomic increment. On rollover, one caller installs the
      // first count. Callers that lose that race increment the installed row.
      for (let attempt = 0; attempt < 3; attempt++) {
        const command = reset
          ? new PutCommand({
              TableName: tableName,
              Item: first,
              ConditionExpression: 'attribute_not_exists(pk) OR #window < :window',
              ExpressionAttributeNames: { '#window': 'window' },
              ExpressionAttributeValues: { ':window': window },
              ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
            })
          : increment
        try {
          const result = await client.send(command)
          return withinLimits(reset ? first : result.Attributes, kind, limits)
        } catch (error) {
          const previous = failedWindow(error)
          if (previous > window) return false
          if ((reset && previous < window) || (!reset && previous === window)) throw error
          reset = previous < window
        }
      }
      throw new Error('Rate window did not stabilize')
    },
  }
}
