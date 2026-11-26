import type { Policy } from './engine.ts'
import { expandedPolicy } from './expanded.ts'
import type { ExpandedBundle } from './expanded.ts'
import { familyPolicy } from './family.ts'
import { learned } from './model.ts'
import type { Bundle } from './model.ts'
import { positional, threshold } from './policies.ts'
import { strategyGuide } from './strategy-guide.ts'
import type { StrategyDetails } from './strategy-guide.ts'
import expanded from '../models/expanded.json' with { type: 'json' }
import match from '../models/match-s11.json' with { type: 'json' }
import matchedRound from '../models/matched-round-s11.json' with { type: 'json' }
import round from '../models/policies.json' with { type: 'json' }

export interface EngineInfo extends StrategyDetails {
  id: string
}

const catalog: Policy[] = [
  familyPolicy('family-value-upgrade')!,
  threshold(3, true),
  positional('board'),
  positional('table'),
  positional('counter'),
  { ...learned(match as Bundle, 'mlp'), name: 'match-mlp-11' },
  { ...learned(match as Bundle, 'tree'), name: 'match-tree-11' },
  { ...learned(matchedRound as Bundle, 'mlp'), name: 'matched-round-mlp-11' },
  learned(round as Bundle, 'mlp'),
  learned(round as Bundle, 'tree'),
  expandedPolicy(expanded as ExpandedBundle, 'board'),
  expandedPolicy(expanded as ExpandedBundle, 'table'),
]

export const engineCatalog: EngineInfo[] = catalog.map(({ name: id }) => {
  const details = strategyGuide[id]
  if (!details) throw Error('Missing strategy guide for ' + id)
  return { id, ...details }
})

const policies = new Map(catalog.map((policy) => [policy.name, policy]))

export function onlinePolicy(id: string): Policy {
  const policy = policies.get(id)
  if (!policy) throw Error('Unknown game engine: ' + id)
  return { ...policy }
}
