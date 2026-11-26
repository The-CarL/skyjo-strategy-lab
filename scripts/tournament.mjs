import { play } from '../src/engine.ts'
import { options, integer, policy, save } from './common.mjs'

const args = options({
  seeds: 100,
  seed: 800000,
  players: 4,
  pool: 'threshold-5,threshold-6+clear,threshold-4+pairs',
  agents:
    'threshold-5,threshold-5+clear,threshold-5+clear+pairs,counter,tree,mlp',
  out: 'work/tournament.json',
})
const count = integer(args.seeds, 2, 100000, 'seeds'),
  start = integer(args.seed, 0, 2 ** 31 - 1, 'seed')
const n = integer(args.players, 2, 8, 'players')
const pool = args.pool.split(',').map(policy),
  agents = args.agents.split(',').map(policy)
if (new Set(agents.map((a) => a.name)).size !== agents.length)
  throw Error('Duplicate focal agents')
const blocks = []
for (let b = 0; b < count; b++) {
  const seed = start + b
  const rivals = Array.from(
    { length: n - 1 },
    (_, i) => pool[(b + i) % pool.length],
  )
  const values = agents.map((focal) => {
    let win = 0,
      total = 0,
      rounds = 0
    for (let seat = 0; seat < n; seat++) {
      const lineup = [focal, ...rivals]
      const rotated = Array.from(
        { length: n },
        (_, i) => lineup[(i - seat + n) % n],
      )
      const game = play(rotated, seed)
      win += game.winners.includes(seat) ? 1 / game.winners.length : 0
      total += game.totals[seat]
      rounds += game.rounds
    }
    return { win: win / n, score: total / n, rounds: rounds / n }
  })
  blocks.push({ seed, values })
}
function summary(xs, min = -Infinity, max = Infinity) {
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length
  const se = Math.sqrt(
    xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length * (xs.length - 1)),
  )
  return {
    mean,
    ci95: [Math.max(min, mean - 1.96 * se), Math.min(max, mean + 1.96 * se)],
  }
}
const results = agents.map((a, i) => ({
  name: a.name,
  games: n * count,
  winShare: summary(
    blocks.map((b) => b.values[i].win),
    0,
    1,
  ),
  pairedVsFirst: summary(
    blocks.map((b) => b.values[i].win - b.values[0].win),
    -1,
    1,
  ),
  finalScore: summary(blocks.map((b) => b.values[i].score)),
  rounds: summary(blocks.map((b) => b.values[i].rounds)),
}))
save(args.out, {
  config: {
    start,
    count,
    players: n,
    pool: pool.map((a) => a.name),
    agents: agents.map((a) => a.name),
  },
  totalGames: n * count * agents.length,
  results,
  blocks,
})
console.table(
  results.map((r) => ({
    agent: r.name,
    games: r.games,
    winPct: (100 * r.winShare.mean).toFixed(1),
    deltaPP: (100 * r.pairedVsFirst.mean).toFixed(1),
    averageScore: r.finalScore.mean.toFixed(1),
  })),
)
