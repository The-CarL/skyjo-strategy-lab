import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { learned } from '../src/model.ts'
import { builtIn } from '../src/policies.ts'

export function options(spec) {
  return parseArgs({
    options: Object.fromEntries(
      Object.entries(spec).map(([name, value]) => [
        name,
        { type: 'string', default: String(value) },
      ]),
    ),
  }).values
}
export function integer(value, min, max, label) {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw Error('Invalid ' + label + ' (' + min + '–' + max + ')')
  return n
}
export function policy(name) {
  const suffix = /^(.*)\+open-(pair|random)$/.exec(name)
  if (suffix)
    return {
      ...policy(suffix[1]),
      name,
      opening(rng) {
        if (suffix[2] === 'pair') return [0, 1]
        const a = Math.floor(rng() * 12),
          b = Math.floor(rng() * 11)
        return [a, b >= a ? b + 1 : b]
      },
    }
  if (name === 'tree' || name === 'mlp')
    return learned(
      JSON.parse(
        readFileSync(new URL('../models/policies.json', import.meta.url)),
      ),
      name,
    )
  return builtIn(name)
}
export function save(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path + '.tmp', JSON.stringify(data, null, 2) + '\n')
  renameSync(path + '.tmp', path)
}
