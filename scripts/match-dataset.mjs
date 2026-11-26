import { once } from 'node:events'
import {
  createReadStream,
  createWriteStream,
  mkdtempSync,
  renameSync,
  rmSync,
  mkdirSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { performance } from 'node:perf_hooks'
import {
  isMainThread,
  Worker,
  workerData,
  parentPort,
} from 'node:worker_threads'
import { play, random } from '../src/engine.ts'
import { featureNames } from '../src/policies.ts'
import { matchLabels } from '../src/match-teacher.ts'
import { integer, options, policy, save } from './common.mjs'

// Most continuation seats use fast family rules. Across worlds one in eight
// lineups also includes a frozen positional or learned opponent. The focal
// continuation is sampled on the same terms as its rivals.
const rules = [
  'threshold-2+clear',
  'threshold-3+clear',
  'threshold-3+clear+pairs',
  'threshold-4+clear',
  'threshold-4',
  'threshold-5',
  'threshold-5+clear',
  'threshold-5+clear+pairs',
  'threshold-6',
  'threshold-7+clear',
]
const specialists = ['board', 'table', 'counter', 'mlp']
const trainingSeats = [4, 4, 2, 3, 6, 8]
const choose = (items, rng) => items[Math.floor(rng() * items.length)]
const policyMap = new Map(
  [...rules, ...specialists].map((name) => [name, policy(name)]),
)
function drawLineup(n, rng) {
  const lineup = Array.from({ length: n }, () =>
    policyMap.get(choose(rules, rng)),
  )
  if (rng() < 0.125)
    lineup[Math.floor(rng() * n)] = policyMap.get(choose(specialists, rng))
  return lineup
}

async function writeShard(job) {
  const out = createWriteStream(job.file, { flags: 'wx' })
  let simulatedMatches = 0,
    simulatedMoves = 0,
    simulatedRounds = 0,
    decisions = 0
  for (let seed = job.start; seed < job.end; seed++) {
    const gameIndex = seed - job.firstSeed
    const n = trainingSeats[gameIndex % trainingSeats.length]
    const roster = drawLineup(n, random(seed ^ 0x2239d1))
    const picker = random(seed ^ 0x8d412),
      labeler = random(seed ^ 0x911f7)
    const reservoir = []
    let seen = 0
    play(roster, seed, (v) => {
      const i = Math.floor(picker() * ++seen)
      if (reservoir.length < job.states) reservoir.push(v)
      else if (i < job.states) reservoir[i] = v
    })
    for (const v of reservoir) {
      const label = matchLabels(v, labeler, job.samples, drawLineup)
      const line = {
        seed,
        x: label.x,
        y: label.y,
        yRound: label.yRound,
        credit: label.credit,
      }
      if (!out.write(JSON.stringify(line) + '\n')) await once(out, 'drain')
      decisions++
      simulatedMatches += label.simulatedMatches
      simulatedRounds += label.simulatedRounds
      simulatedMoves += label.simulatedMoves
    }
  }
  out.end()
  await once(out, 'finish')
  return { decisions, simulatedMatches, simulatedRounds, simulatedMoves }
}

async function generate() {
  const args = options({
    games: 480,
    states: 24,
    samples: 16,
    seed: 6000000,
    workers: 2,
    out: 'work/match-training.jsonl',
    stats: 'reports/match-generation.json',
  })
  const games = integer(args.games, 2, 100000, 'games'),
    states = integer(args.states, 1, 1000, 'states')
  const samples = integer(args.samples, 1, 1000, 'samples'),
    first = integer(args.seed, 0, 2 ** 31 - 1 - games, 'seed')
  const workers = Math.min(games, integer(args.workers, 1, 64, 'workers'))
  mkdirSync(dirname(args.out), { recursive: true })
  const temp = mkdtempSync(join(dirname(args.out), '.match-shards-'))
  const pool = []
  const started = performance.now()
  const header = {
    schema: 'paired-match-round-v1',
    features: featureNames,
    games,
    samples,
    limit: states,
    start: first,
    trainingSeats,
    rules,
    specialists,
    specialistLineupProbability: 0.125,
    opening: 'spread',
    continuation: 'one sampled policy per seat per world held through game end',
  }
  try {
    const files = Array.from({ length: workers }, (_, i) =>
      join(temp, 'shard-' + i),
    )
    const totals = await Promise.all(
      files.map(
        (file, i) =>
          new Promise((resolve, reject) => {
            const job = {
              file,
              firstSeed: first,
              start: first + Math.floor((games * i) / workers),
              end: first + Math.floor((games * (i + 1)) / workers),
              states,
              samples,
            }
            const worker = new Worker(new URL(import.meta.url), {
              workerData: job,
            })
            pool.push(worker)
            let stats
            worker.on('message', (s) => {
              stats = s
            })
            worker.on('error', reject)
            worker.on('exit', (code) =>
              code === 0 && stats
                ? resolve(stats)
                : reject(Error('Label worker failed: ' + code)),
            )
          }),
      ),
    )
    const finished = join(temp, 'dataset')
    async function* lines() {
      yield JSON.stringify(header) + '\n'
      for (const file of files)
        for await (const chunk of createReadStream(file)) yield chunk
    }
    await pipeline(lines(), createWriteStream(finished, { flags: 'wx' }))
    renameSync(finished, args.out)
    const metrics = Object.fromEntries(
      Object.keys(totals[0]).map((k) => [
        k,
        totals.reduce((s, r) => s + r[k], 0),
      ]),
    )
    const stats = {
      header,
      workers,
      ...metrics,
      wallSeconds: (performance.now() - started) / 1000,
    }
    save(args.stats, stats)
    console.log(JSON.stringify(stats))
  } finally {
    await Promise.all(pool.map((w) => w.terminate()))
    rmSync(temp, { force: true, recursive: true })
  }
}

if (isMainThread) await generate()
else parentPort.postMessage(await writeShard(workerData))
