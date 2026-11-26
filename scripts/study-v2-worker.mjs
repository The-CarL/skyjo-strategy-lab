import {measure} from './study-v2-core.mjs'
process.on('message',job => {
  try {
    measure(job)
    process.send({ok:true})
  } catch (e) {
    process.send({error:e.stack})
  }
})
