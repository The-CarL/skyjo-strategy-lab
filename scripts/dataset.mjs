import { mkdirSync, openSync, writeSync, closeSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { play, random } from '../src/engine.ts'
import { featureNames, evaluate, threshold, blind } from '../src/policies.ts'
import { options, integer } from './common.mjs'

const args = options({
  games: 180,
  samples: 6,
  states: 24,
  seed: 100000,
  out: 'work/training.jsonl',
})
const games = integer(args.games, 2, 100000, 'games'),
  samples = integer(args.samples, 1, 1000, 'samples')
const limit = integer(args.states, 1, 1000, 'states'),
  start = integer(args.seed, 0, 2 ** 31 - 1, 'seed')
mkdirSync(dirname(args.out), { recursive: true })
const temp = args.out + '.tmp',
  fd = openSync(temp, 'w')
writeSync(
  fd,
  JSON.stringify({ features: featureNames, games, samples, limit, start }) +
    '\n',
)
let states = 0
for (let g = 0; g < games; g++) {
  const seed = start + g,
    picker = random(seed ^ 0x390ae),
    labeler = random(seed ^ 0x8391)
  const n = [4, 4, 2, 3, 6, 8][g % 6]
  const bots = Array.from({ length: n }, (_, i) =>
    (g + i) % 13 === 0
      ? blind
      : threshold(3 + ((i + g) % 6), (g + i) % 3 !== 0, (g + i) % 4 === 1),
  )
  // Reservoir sample across the entire game, including late-game and final-turn decisions.
  const reservoir = []
  let seen = 0
  play(bots, seed, (v) => {
    const i = Math.floor(picker() * ++seen)
    if (reservoir.length < limit) reservoir.push(v)
    else if (i < limit) reservoir[i] = v
  })
  for (const v of reservoir) {
    const cs = evaluate(v, labeler, samples)
    const mean = cs.reduce((s, c) => s + c.value, 0) / cs.length
    writeSync(
      fd,
      JSON.stringify({
        seed,
        x: cs.map((c) => c.f),
        y: cs.map((c) => c.value - mean),
      }) + '\n',
    )
    states++
  }
  if ((g + 1) % 30 === 0)
    process.stderr.write('Labeled ' + (g + 1) + '/' + games + ' games\n')
}
closeSync(fd)
renameSync(temp, args.out)
console.log(JSON.stringify({ games, states, samples, path: args.out }))
