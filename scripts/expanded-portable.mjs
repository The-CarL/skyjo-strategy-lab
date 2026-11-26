// Independent, pre-specified portable coach gate. Run from the repository root.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { expandedScores } from '../src/expanded.ts'
import { candidates, same } from '../src/policies.ts'
import { block, ci, get } from './expanded-matches.mjs'
import { save } from './common.mjs'

const protocolBytes = readFileSync(
  'reports/phase2/expanded-portable-protocol.json',
)
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const protocol = JSON.parse(protocolBytes)
const modelBytes = readFileSync('models/expanded.json')
const m = JSON.parse(modelBytes)
const family = 'family-value-upgrade'
const modelName = { family: 'threshold-3+clear', 'family-nominee': family }
const names = [
  ...protocol.baselineNames,
  ...protocol.primaryPolicies,
  'expanded-table',
  'short-board',
  'short-table',
]
const bots = names.map((name) => {
  if (!name.startsWith('short-')) return get(modelName[name] ?? name)
  const mode = name.slice(6)
  return {
    name,
    choose(v) {
      const allowed = candidates(v)
      const scored = expandedScores(v, m, mode).filter((row) =>
        allowed.some((c) => same(c.a, row.action)),
      )
      // Match the full scorer's own legal-order tie break exactly.
      return scored.reduce((a, b) => (b.score > a.score ? b : a)).action
    },
  }
})
const started = performance.now()
const panels = []
for (const label of ['primary', 'confirmation']) {
  const panel = protocol[label]
  const wins = []
  for (let i = 0; i < panel.blocks; i++) {
    const matchup = i % panel.lineups.length
    wins.push(
      bots.map((bot) =>
        block(
          bot,
          panel.seed + i,
          panel.seats,
          panel.lineups[matchup],
          Math.floor(i / panel.lineups.length),
        ),
      ),
    )
  }
  const results = Object.fromEntries(
    names.map((name, i) => [name, ci(wins.map((w) => w[i]))]),
  )
  function compare(a, b) {
    const i = names.indexOf(a),
      j = names.indexOf(b)
    const stats = ci(wins.map((w) => w[i] - w[j]))
    return { a, b, ...stats, pass: stats.mean >= 0.02 && stats.ci95[0] > 0 }
  }
  const gates = Object.fromEntries(
    protocol.primaryPolicies.map((name) => {
      const baselines =
        name === 'expanded-board'
          ? protocol.baselineNames
          : [...protocol.baselineNames, 'expanded-board']
      const comparisons = baselines.map((b) => compare(name, b))
      return [name, { pass: comparisons.every((c) => c.pass), comparisons }]
    }),
  )
  const shortlist = [
    compare('expanded-board', 'short-board'),
    compare('expanded-table', 'short-table'),
  ]
  panels.push({
    label,
    ...panel,
    names,
    results,
    gates,
    shortlist,
    wins,
    games: panel.seats * panel.blocks * bots.length,
  })
  console.log(label, JSON.stringify(gates), JSON.stringify(shortlist))
}
save('reports/phase2/expanded-portable.json', {
  protocolSha256: digest(protocolBytes),
  weightsSha256: digest(modelBytes),
  familyNominee: family,
  panels,
  passing: protocol.primaryPolicies.filter((name) =>
    panels.every((p) => p.gates[name].pass),
  ),
  seconds: (performance.now() - started) / 1000,
  totalGames: panels.reduce((n, p) => n + p.games, 0),
})
