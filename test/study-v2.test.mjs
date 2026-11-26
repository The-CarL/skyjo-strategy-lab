import test from 'node:test'
import assert from 'node:assert/strict'
import {jobsFor,protocol} from '../scripts/study-v2-core.mjs'
import {leaguePolicy} from '../scripts/study-v2-policies.mjs'

function view(board,discard,rivals=[12,12,null,null,null,null,null,null,null,null,null,null]) {
  return {boards:[board,rivals],turn:0,held:null,discard,closer:null,totals:[0,0]}
}
test('frozen league assigns each shuffle to one cohort and stratum and includes all seat rotations',()=>{
  const seen=new Set()
  for(const j of jobsFor([protocol.arms[0]])) {
    for(let i=0;i<j.n;i++) {
      assert.ok(!seen.has(j.start+i))
      seen.add(j.start+i)
    }
    assert.ok(j.seats>=2 && j.seats<=8)
  }
  assert.equal(seen.size,3072+1536+384+384)
})
test('independent style examples cover reveal priority, matched pairs, and avoiding a gift to the next player',()=>{
  const v=view([12,3,null,8,2,null,null,null,null,null,null,null],6)
  assert.deepEqual(leaguePolicy('study-finisher').choose(v),{kind:'take',slot:2})
  assert.deepEqual(leaguePolicy('study-gap').choose(v),{kind:'take',slot:0})
  assert.deepEqual(leaguePolicy('study-denial').choose(v),{kind:'draw'})
  const w=view([5,null,null,5,2,null,4,null,null,null,null,null],5)
  assert.deepEqual(leaguePolicy('study-chaser').choose(w),{kind:'take',slot:1})
})
test('patient player can reduce a known high card while delaying a bad close',()=>{
  const v=view([9,9,7,7,8,6,8,6,7,8,9,null],5,Array(12).fill(0))
  v.held=5
  assert.deepEqual(leaguePolicy('study-patient').choose(v),{kind:'swap',slot:0})
})

test('cached matches with stale source or the wrong lineup cannot enter the published statistics', async () => {
  const {validateCell} = await import('../scripts/study-v2-check-cache.mjs')
  const job = {arm:'example',seats:2,n:1,pool:['opponent']}
  const data = {version:1,job,policy:'example',fingerprint:'current',blocks:[[0.5,50]],decisions:20}
  validateCell(job,data,'current','example')
  assert.throws(()=>validateCell(job,data,'changed','example'), /fingerprint/)
  assert.throws(()=>validateCell({...job,pool:['different']},data,'current','example'), /job definition/)
})
