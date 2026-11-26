import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { guardedPrior, learned } from '../src/model.ts'
import { builtIn } from '../src/policies.ts'
import { familyPolicy } from '../src/family.ts'
import { expandedPolicy } from '../src/expanded.ts'

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
function modelBundle(filename) {
  return JSON.parse(readFileSync(new URL('../models/' + filename, import.meta.url)))
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
  if (name === 'guarded-prior') return guardedPrior
  if (name === 'tree' || name === 'mlp')
    return learned(modelBundle('policies.json'), name)
  const match = /^match-(mlp|tree)-(11|29|47)$/.exec(name)
  if (match) return { ...learned(modelBundle('match-s' + match[2] + '.json'), match[1]), name }
  if (name === 'matched-round-mlp-11')
    return { ...learned(modelBundle('matched-round-s11.json'), 'mlp'), name }
  const expanded = /^expanded-(board|urgency|table)$/.exec(name)
  if (expanded) return expandedPolicy(modelBundle('expanded.json'), expanded[1])
  return familyPolicy(name) ?? builtIn(name)
}
export function save(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path + '.tmp', JSON.stringify(data, null, 2) + '\n')
  renameSync(path + '.tmp', path)
}
