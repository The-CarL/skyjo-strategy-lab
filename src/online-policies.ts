import type { Policy } from './engine.ts'
import { expandedPolicy } from './expanded.ts'
import type { ExpandedBundle } from './expanded.ts'
import { familyPolicy } from './family.ts'
import { learned } from './model.ts'
import type { Bundle } from './model.ts'
import { positional, threshold } from './policies.ts'
import expanded from '../models/expanded.json' with { type: 'json' }
import match from '../models/match-s11.json' with { type: 'json' }
import matchedRound from '../models/matched-round-s11.json' with { type: 'json' }
import round from '../models/policies.json' with { type: 'json' }

export interface EngineInfo {
  id: string
  name: string
  description: string
}

const catalog: { policy: Policy; name: string; description: string }[] = [
  {
    policy: familyPolicy('family-value-upgrade')!,
    name: 'Clear or trade',
    description:
      'Weighs a column clear against a low-card swap. A blind draw can also replace a visible card to save four points.',
  },
  {
    policy: threshold(3, true),
    name: 'Clear, then keep 3',
    description:
      'Takes an immediate column clear, then looks for a 3 or lower to replace a high or hidden card.',
  },
  {
    policy: positional('board'),
    name: 'Board evaluator',
    description:
      'Ranks moves using its visible points, pairs, and hidden cards.',
  },
  {
    policy: positional('table'),
    name: 'Table evaluator',
    description:
      'Compares visible boards to estimate the scoring risk of ending the round.',
  },
  {
    policy: positional('counter'),
    name: 'Card counter',
    description:
      'Remembers revealed cards to estimate the remaining values and weighs the risk of closing.',
  },
  {
    policy: { ...learned(match as Bundle, 'mlp'), name: 'match-mlp-11' },
    name: 'Match-trained neural network',
    description:
      'Uses its own board to rank moves learned from simulated wins over complete games.',
  },
  {
    policy: { ...learned(match as Bundle, 'tree'), name: 'match-tree-11' },
    name: 'Match-trained decision tree',
    description:
      'Uses a decision tree trained on complete-game outcomes to rank moves from its own board.',
  },
  {
    policy: {
      ...learned(matchedRound as Bundle, 'mlp'),
      name: 'matched-round-mlp-11',
    },
    name: 'Matched-round neural network',
    description:
      'Trained on the same games as the match-trained network, using the score margin after the current round.',
  },
  {
    policy: learned(round as Bundle, 'mlp'),
    name: 'Original round neural network',
    description:
      'Uses its own board to rank moves learned from score margins at the end of simulated rounds.',
  },
  {
    policy: learned(round as Bundle, 'tree'),
    name: 'Round-trained decision tree',
    description:
      'Uses a decision tree trained on simulated round scores to rank its own board moves.',
  },
  {
    policy: expandedPolicy(expanded as ExpandedBundle, 'board'),
    name: 'All-moves board evaluator',
    description:
      'Scores every legal move using board and pair values tuned in simulated matches.',
  },
  {
    policy: expandedPolicy(expanded as ExpandedBundle, 'table'),
    name: 'All-moves table evaluator',
    description:
      'Scores every legal move using board values, opponents’ visible positions, and match standings.',
  },
]

export const engineCatalog: EngineInfo[] = catalog.map(
  ({ policy, name, description }) => ({
    id: policy.name,
    name,
    description,
  }),
)

const policies = new Map(catalog.map(({ policy }) => [policy.name, policy]))

export function onlinePolicy(id: string): Policy {
  const policy = policies.get(id)
  if (!policy) throw Error('Unknown game engine: ' + id)
  return { ...policy }
}
