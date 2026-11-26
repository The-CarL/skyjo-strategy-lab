/** Seat-balanced paper-rule development. Run develop before the independent confirm stage. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { options, save } from './common.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = options({ stage: 'develop' })
const baseline = 'threshold-3+clear'
const developmentCandidates = [
  'family-value-clear',
  'family-pair-break',
  'family-build-pair',
  'family-drawn-upgrade',
  'family-hidden-first',
  'family-value-upgrade',
  'family-value-position',
]
const pools = {
  published: ['threshold-3+clear+pairs', 'threshold-4+clear', 'threshold-6'],
  mixed: ['board', 'mlp', 'threshold-2+clear'],
  observers: ['table', 'counter', 'threshold-3+clear+pairs'],
}
const reports = resolve(root, 'reports/phase2')
const developmentFile = resolve(reports, 'family-development.json')
const mean = (xs) => xs.reduce((sum, x) => sum + x, 0) / xs.length

function tournament(stage, poolName, agents, seed, seeds) {
  const raw = resolve(
    root,
    'work/phase2/family',
    stage + '-' + poolName + '.json',
  )
  execFileSync(
    process.execPath,
    [
      'scripts/tournament.mjs',
      '--seed',
      String(seed),
      '--seeds',
      String(seeds),
      '--players',
      '4',
      '--pool',
      pools[poolName].join(','),
      '--agents',
      agents.join(','),
      '--out',
      raw,
    ],
    { cwd: root },
  )
  const result = JSON.parse(readFileSync(raw))
  console.log(stage, poolName, result.totalGames, 'games')
  return {
    ...result.config,
    games: result.totalGames,
    raw: relative(root, raw),
    rows: result.results.map((r) => ({
      id: r.name,
      win: r.winShare.mean,
      vsBaseline: r.pairedVsFirst,
    })),
  }
}

// Intervals in the tournament output cluster all four seat rotations by shuffle seed.
// Pool seeds are disjoint. The development criterion weights the three opponent pools equally.
if (args.stage === 'develop') {
  const agents = [baseline, ...developmentCandidates]
  const tables = Object.keys(pools).map((pool, i) =>
    tournament('develop', pool, agents, 2600000 + i * 10000, 120),
  )
  const ranks = developmentCandidates
    .map((id) => ({
      id,
      meanWinAcrossPools: mean(
        tables.map((t) => t.rows.find((r) => r.id === id).win),
      ),
    }))
    .sort((a, b) => b.meanWinAcrossPools - a.meanWinAcrossPools)
  save(developmentFile, {
    stage: 'development',
    baseline,
    criterion:
      'Highest equally weighted mean win share among the seven alternatives. Fixed ID order breaks ties.',
    frozen: ranks[0].id,
    ranks,
    tables,
  })
  console.log('Frozen family candidate:', ranks[0].id)
} else if (args.stage === 'confirm') {
  const development = JSON.parse(readFileSync(developmentFile))
  if (!developmentCandidates.includes(development.frozen))
    throw Error('Unrecognized frozen policy')
  const agents = [baseline, development.frozen]
  const tables = Object.keys(pools).map((pool, i) =>
    tournament('confirm', pool, agents, 2700000 + i * 10000, 400),
  )
  save(resolve(reports, 'family-confirmation.json'), {
    stage: 'confirmation',
    baseline,
    frozen: development.frozen,
    tables,
  })
} else if (args.stage === 'cutoffs') {
  // Reproduce the four controls on the exact audit deals; also retain the five-point saving rule.
  const agents = ['family-3-3', 'family-5-3', 'family-3-5', 'family-5-5']
  const tables = ['published', 'mixed'].map((pool, i) =>
    tournament('cutoffs', pool, agents, 1300000 + i * 10000, 600),
  )
  const saving = tournament(
    'gap-five',
    'published',
    [baseline, 'family-save5-hidden3'],
    1100000,
    600,
  )
  save(resolve(reports, 'family-cutoffs.json'), {
    stage: 'cutoff-audit',
    tables,
    saving,
  })
} else {
  throw Error('Expected --stage develop, confirm, or cutoffs')
}
