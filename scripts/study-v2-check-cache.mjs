import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {gunzipSync} from 'node:zlib'
import {pathToFileURL} from 'node:url'
import {cachePath, jobsFor, resolveArm, sourceFingerprint} from './study-v2-core.mjs'

export function validateCell(expectedJob, cached, expectedFingerprint, expectedName) {
  assert.equal(cached.version, 1, 'unrecognized cache schema')
  assert.deepEqual(cached.job, expectedJob, 'job definition differs')
  assert.equal(cached.fingerprint, expectedFingerprint, 'source or model fingerprint differs')
  assert.equal(cached.policy, expectedName, 'resolved policy identity differs')
  assert.equal(cached.blocks.length, expectedJob.n, 'missing seed blocks')
  assert.ok(Number.isSafeInteger(cached.decisions) && cached.decisions >= expectedJob.n * expectedJob.seats, 'invalid decision count')
  for (const row of cached.blocks) {
    assert.ok(Array.isArray(row) && row.length === 2, 'wrong block dimensions')
    assert.ok(Number.isFinite(row[0]) && row[0]>=0 && row[0]<=1 && Number.isFinite(row[1]), 'invalid outcome')
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const tasks=jobsFor()
  for(const job of tasks) {
    const path=cachePath(job)
    try {
      const cached=JSON.parse(gunzipSync(readFileSync(path)))
      validateCell(job,cached,sourceFingerprint(job),resolveArm(job.arm).name)
    } catch(error) {
      throw Error('Invalid frozen league evidence at '+path+'. Re-run node scripts/study-v2.mjs before publishing.',{cause:error})
    }
  }
  console.log(tasks.length,'cached cells match the current protocol, code and weights')
}
