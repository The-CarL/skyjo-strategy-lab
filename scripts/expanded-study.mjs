// Fit interpretable scoring policies directly to complete-match win credit.
// Fixed design: development and test deals/opponents use separate ranges.
// Usage: node scripts/expanded-study.mjs [--stage all|fit|test]
import { readFileSync } from 'node:fs'
import { random } from '../src/engine.ts'
import {
  boardTerms,
  expandedPolicy,
  startingBoard,
  startingTable,
  tableTerms,
} from '../src/expanded.ts'
import { options, save } from './common.mjs'

import { block, ci, get, mean } from './expanded-matches.mjs'

const args = options({ stage: 'all' })
if (!['all', 'fit', 'test'].includes(args.stage))
  throw Error('stage must be all, fit, or test')
const modelPath = 'models/expanded.json'
const reports = 'reports/phase2/expanded'
const base = { version: 1, board: startingBoard, table: startingTable }
const trainingPools = [
  ['threshold-3+clear+pairs', 'threshold-4+clear', 'threshold-6'],
  ['threshold-2+clear', 'threshold-5+clear+pairs', 'threshold-5'],
]
const primary = {
  seats: 4,
  seed: 5500000,
  seeds: 1200,
  pool: trainingPools[0],
  label: 'primary',
}
const tests = [
  primary,
  {
    seats: 4,
    seed: 5510000,
    seeds: 600,
    pool: ['mlp', 'board', 'threshold-2+clear+pairs'],
    label: 'held-four',
  },
  {
    seats: 2,
    seed: 5520000,
    seeds: 400,
    pool: ['mlp', 'board', 'threshold-2+clear+pairs'],
    label: 'held-two',
  },
  {
    seats: 6,
    seed: 5530000,
    seeds: 300,
    pool: [
      'mlp',
      'board',
      'threshold-2+clear+pairs',
      'tree',
      'threshold-7+clear+pairs',
    ],
    label: 'held-six',
  },
]
function fitScore(m, mode, start, seeds) {
  const p = expandedPolicy(m, mode)
  let sum = 0
  for (let i = 0; i < seeds; i++)
    sum += block(
      p,
      start + i,
      4,
      trainingPools[i % trainingPools.length],
      Math.floor(i / trainingPools.length),
    )
  return sum / seeds
}
// Cross-entropy search over six board weights, followed by three context weights.
// The same training deals and seat rotations score all candidates per generation.
const bounds = {
  board: [
    [1, 12],
    [0.15, 6],
    [0.15, 5],
    [-3, 3],
    [0, 1.5],
    [-1.5, 1.5],
  ],
  table: [
    [0, 2],
    [-3, 3],
    [-6, 6],
  ],
}
function fit(mode, initialBundle, start, seed) {
  const rng = random(seed)
  const normal = () =>
    Math.sqrt(-2 * Math.log(Math.max(1e-12, rng()))) *
    Math.cos(2 * Math.PI * rng())
  const range = bounds[mode]
  const initial = initialBundle[mode]
  let center = [...initial],
    deviation = range.map(([a, b]) => (b - a) / 4)
  const finalists = [initial]
  const search = []
  let games = 0
  for (let g = 0; g < 4; g++) {
    const pop = [center, initial]
    for (let i = pop.length; i < 14; i++)
      pop.push(
        center.map((x, j) =>
          Math.min(
            range[j][1],
            Math.max(range[j][0], x + normal() * deviation[j]),
          ),
        ),
      )
    const startSeed = start + g * 1000
    const ranked = pop
      .map((weights) => ({
        weights,
        value: fitScore(
          { ...initialBundle, [mode]: weights },
          mode,
          startSeed,
          48,
        ),
      }))
      .sort((a, b) => b.value - a.value)
    const elite = ranked.slice(0, 4).map((r) => r.weights)
    finalists.push(elite[0])
    center = initial.map((_, j) => mean(elite.map((w) => w[j])))
    deviation = initial.map((_, j) =>
      Math.max(
        (range[j][1] - range[j][0]) * 0.06,
        Math.sqrt(mean(elite.map((w) => (w[j] - center[j]) ** 2))),
      ),
    )
    search.push({ startSeed, seeds: 48, best: ranked[0], center, deviation })
    games += 4 * 48 * pop.length
  }
  finalists.push(center)
  const validationSeed = start + 10000
  const ranked = finalists
    .map((weights) => ({
      weights,
      value: fitScore(
        { ...initialBundle, [mode]: weights },
        mode,
        validationSeed,
        200,
      ),
    }))
    .sort((a, b) => b.value - a.value)
  games += 4 * 200 * ranked.length
  return {
    bundle: { ...initialBundle, [mode]: ranked[0].weights },
    report: {
      start,
      seed,
      games,
      terms: mode === 'board' ? boardTerms : tableTerms,
      bounds: range,
      search,
      validationSeed,
      validationSeeds: 200,
      validation: ranked,
    },
  }
}
if (args.stage !== 'test') {
  const time = performance.now()
  const board = fit('board', base, 5000000, 54321)
  const table = fit('table', board.bundle, 5100000, 98765)
  save(modelPath, table.bundle)
  save(reports + '-training.json', {
    objective: 'terminal split win credit to 100, balanced over four seats',
    trainingPools,
    board: board.report,
    table: table.report,
    totalGames: board.report.games + table.report.games,
    seconds: (performance.now() - time) / 1000,
  })
  console.log('Expanded fit complete:', table.bundle)
}
if (args.stage !== 'fit') {
  const time = performance.now()
  const m = JSON.parse(readFileSync(modelPath, 'utf8'))
  const candidates = [
    ['family', get('threshold-3+clear')],
    ['board', get('board')],
    ['table', get('table')],
    ['raw-board', expandedPolicy(base, 'board')],
    ['expanded-board', expandedPolicy(m, 'board')],
    ['expanded-urgency', expandedPolicy(m, 'urgency')],
    ['expanded-table', expandedPolicy(m, 'table')],
  ]
  const names = candidates.map((c) => c[0])
  const panels = []
  const comparisons = [
    ['expanded-board', 'raw-board'],
    ['expanded-board', 'board'],
    ['expanded-board', 'family'],
    ['expanded-table', 'table'],
    ['expanded-table', 'expanded-board'],
    ['expanded-urgency', 'expanded-board'],
  ]
  for (const c of tests) {
    const wins = []
    for (let i = 0; i < c.seeds; i++)
      wins.push(
        candidates.map(([, p]) => block(p, c.seed + i, c.seats, c.pool, i)),
      )
    const results = Object.fromEntries(
      names.map((k, j) => [k, ci(wins.map((r) => r[j]))]),
    )
    const contrasts = comparisons.map(([a, b]) => {
      const ai = names.indexOf(a),
        bi = names.indexOf(b)
      return { a, b, ...ci(wins.map((r) => r[ai] - r[bi])) }
    })
    panels.push({
      ...c,
      groups: names,
      results,
      contrasts,
      wins,
      games: c.seeds * c.seats * candidates.length,
    })
    console.log(c.label, JSON.stringify(contrasts))
  }
  save(reports + '.json', {
    columns: names,
    panels,
    totalGames: panels.reduce((n, p) => n + p.games, 0),
    seconds: (performance.now() - time) / 1000,
  })
}
