import {createHash} from 'node:crypto'
import {readFileSync, existsSync, mkdirSync, writeFileSync, renameSync} from 'node:fs'
import {dirname} from 'node:path'
import {gzipSync,gunzipSync} from 'node:zlib'
import {play} from '../src/engine.ts'
import {learned} from '../src/model.ts'
import {policy as registered} from './common.mjs'
import {leaguePolicy} from './study-v2-policies.mjs'

export const protocol = JSON.parse(readFileSync('reports/phase2/protocol.json'))
export const cacheDirectory = 'work/phase2-study'
export function digest(files) {
  const hash = createHash('sha256')
  for (const f of files) hash.update(f).update('\0').update(readFileSync(f)).update('\0')
  return hash.digest('hex')
}
const runtimeFiles = ['src/engine.ts','src/policies.ts','src/model.ts','src/family.ts','scripts/common.mjs','scripts/study-v2-policies.mjs']
const loadedRuntime = digest(runtimeFiles)
export function resolveArm(name) {
  if (name === 'family-nominee') {
    const {policy} = JSON.parse(readFileSync('reports/phase2/nomination.json'))
    return registered(policy)
  }
  const match = /^match-(mlp|tree)-(11|29|47)$/.exec(name)
  const matched = name === 'matched-round-mlp-11'
  if (match || matched) {
    const file = matched ? 'models/matched-round-s11.json' : 'models/match-s'+match[2]+'.json'
    return {...learned(JSON.parse(readFileSync(file)), matched ? 'mlp' : match[1]),name}
  }
  return leaguePolicy(name) ?? registered(name)
}
export function jobsFor(arms = protocol.arms, cohorts = Object.keys(protocol.cohorts)) {
  const jobs = []
  for (const name of cohorts) {
    const c = protocol.cohorts[name]
    for (const [i,[stratum,pool]] of Object.entries(protocol.pools[c.pools]).entries()) {
      for (const arm of arms) jobs.push({arm,cohort:name,stratum,pool,seats:c.seats,n:c.perStratum,start:c.baseSeed+i*c.stride})
    }
  }
  return jobs
}
export function cachePath(job) {
  return [cacheDirectory,job.cohort,job.stratum,job.arm+'.json.gz'].join('/')
}
export function sourceFingerprint(job) {
  if(digest(runtimeFiles)!==loadedRuntime) throw Error('Policy or game code changed mid-run. Restart the worker to use the new source.')
  const files=['reports/phase2/protocol.json',...runtimeFiles,'scripts/study-v2-core.mjs','models/policies.json']
  if (job.arm === 'family-nominee') files.push('reports/phase2/nomination.json')
  if (job.arm.startsWith('match-')) files.push('models/match-s'+job.arm.split('-')[2]+'.json')
  if (job.arm === 'matched-round-mlp-11') files.push('models/matched-round-s11.json')
  return digest(files)
}
export function measure(job) {
  const path=cachePath(job), fingerprint=sourceFingerprint(job)
  if (existsSync(path)) {
    const previous=JSON.parse(gunzipSync(readFileSync(path)))
    if (previous.fingerprint===fingerprint && previous.blocks.length === job.n) return
  }
  const focal=resolveArm(job.arm), pool=job.pool.map(resolveArm)
  const blocks=[]
  let elapsedMoves=0
  for (let k=0; k<job.n; k++) {
    const rivals=Array.from({length:job.seats-1},(_,i)=>pool[(k+i)%pool.length])
    const base=[focal,...rivals]
    let wins=0, points=0
    for (let seat=0; seat<job.seats; seat++) {
      const lineup=Array.from({length:job.seats},(_,i)=>base[(i-seat+job.seats)%job.seats])
      const game=play(lineup,job.start+k)
      if (game.winners.includes(seat)) wins+=1/game.winners.length
      points+=game.totals[seat]
      elapsedMoves+=game.moves
    }
    blocks.push([wins/job.seats, points/job.seats])
  }
  const data={version:1,job,fingerprint,policy:focal.name,decisions:elapsedMoves,blocks}
  mkdirSync(dirname(path),{recursive:true})
  const tmp=path+'.'+process.pid+'.tmp'
  writeFileSync(tmp,gzipSync(JSON.stringify(data)))
  renameSync(tmp,path)
}
