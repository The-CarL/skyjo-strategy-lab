import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { deal, move, play, random, score } from '../src/engine.ts'
import { options, integer, policy, save } from './common.mjs'
const args = options({
  seed: 42,
  agents: 'threshold-5,threshold-5+clear,tree,mlp',
  out: 'work/replay.json',
  verify: '',
})
if (args.verify) {
  const r = JSON.parse(readFileSync(args.verify))
  if (r.version !== 1) throw Error('Unknown replay version')
  const totals = r.agents.map(() => 0)
  let previous = null,
    i = 0,
    round = 0
  while (Math.max(...totals) < 100) {
    const rng = random(r.seed ^ Math.imul(++round, 0x9e3779b1))
    const s = deal(totals, rng, previous, r.openings?.[round - 1])
    while (!s.finished) {
      const row = r.actions[i++]
      if (!row || row.round !== round || row.seat !== s.turn)
        throw Error('Replay turn mismatch at ' + i)
      move(s, row.action, rng)
    }
    score(s).forEach((x, j) => (totals[j] += x))
    previous = s.closer
  }
  if (i !== r.actions.length || !isDeepStrictEqual(totals, r.result.totals))
    throw Error('Replay result mismatch')
  console.log('Verified', totals, round, 'rounds')
} else {
  const seed = integer(args.seed, 0, 2 ** 31 - 1, 'seed'),
    agents = args.agents.split(',')
  const actions = [],
    openings = []
  const result = play(
    agents.map(policy),
    seed,
    (v, action, round) => actions.push({ round, seat: v.turn, action }),
    (slots) => openings.push(slots),
  )
  save(args.out, { version: 1, seed, agents, openings, actions, result })
  console.log(result)
}
