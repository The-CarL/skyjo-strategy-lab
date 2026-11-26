import { play } from '../src/engine.ts'
import { options, integer, policy, save } from './common.mjs'
const args = options({
  seeds: 60,
  seed: 910000,
  agents:
    'threshold-5,threshold-3+clear,board,table,counter,tree,mlp,rollout-4',
  out: 'reports/duels.json',
})
const n = integer(args.seeds, 2, 100000, 'seeds'),
  start = integer(args.seed, 0, 2 ** 31 - 1, 'seed')
const bots = args.agents.split(',').map(policy)
const duels = []
for (let i = 0; i < bots.length; i++)
  for (let j = i + 1; j < bots.length; j++) {
    const xs = []
    for (let k = 0; k < n; k++) {
      let win = 0
      for (let seat = 0; seat < 2; seat++) {
        const pair = [bots[i], bots[j]]
        const game = play(seat ? pair.reverse() : pair, start + k)
        win += game.winners.includes(seat) ? 1 / game.winners.length : 0
      }
      xs.push(win / 2)
    }
    const mean = xs.reduce((a, b) => a + b, 0) / n
    const radius =
      1.96 *
      Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n * (n - 1)))
    duels.push({
      first: bots[i].name,
      second: bots[j].name,
      games: 2 * n,
      firstWinShare: mean,
      ci95: [Math.max(0, mean - radius), Math.min(1, mean + radius)],
    })
  }
save(args.out, {
  seed: start,
  seeds: n,
  totalGames: duels.length * 2 * n,
  duels,
})
console.log(duels.length, 'seat-balanced matchups')
