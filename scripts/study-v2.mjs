import {fork} from 'node:child_process'
import {parseArgs} from 'node:util'
import {protocol,jobsFor} from './study-v2-core.mjs'
const {values} = parseArgs({options:{
  arms:{type:'string',default:protocol.arms.join(',')},
  cohorts:{type:'string',default:Object.keys(protocol.cohorts).join(',')},
  workers:{type:'string',default:'2'},
}})
const arms=values.arms.split(','), cohorts=values.cohorts.split(',')
if (arms.some(a=>!protocol.arms.includes(a)) || cohorts.some(c=>!protocol.cohorts[c])) throw Error('Unknown arm or cohort')
const concurrency=Number(values.workers)
if (![1,2].includes(concurrency)) throw Error('Use one or two workers')
const jobs=jobsFor(arms,cohorts)
let next=0
const started=Date.now()
async function workerLoop() {
  const child=fork(new URL('./study-v2-worker.mjs',import.meta.url),[],{stdio:['ignore','inherit','inherit','ipc']})
  try {
    while(next<jobs.length) {
      const job=jobs[next++]
      await new Promise((resolve,reject)=>{
        const cleanup=()=>{child.off('message',message);child.off('exit',exit);child.off('error',error)}
        const message=reply=>{cleanup();reply.error?reject(Error(reply.error)):resolve()}
        const exit=code=>{cleanup();reject(Error('Benchmark worker exited with '+code))}
        const error=e=>{cleanup();reject(e)}
        child.once('message',message);child.once('exit',exit);child.once('error',error);child.send(job)
      })
      console.log(job.cohort,job.stratum,job.arm,'ready')
    }
  } finally {
    child.kill()
  }
}
await Promise.all(Array.from({length:concurrency},workerLoop))
console.log(jobs.length,'cells ready in',Math.round((Date.now()-started)/1000),'seconds')
