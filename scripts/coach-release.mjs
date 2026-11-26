import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const league = read('../reports/phase2/league-summary.json')
const expanded = read('../reports/phase2/expanded-portable.json')
const nominee = read('../reports/phase2/nomination.json')
assert.equal(nominee.policy, 'family-value-upgrade', 'Unrecognized paper strategy')
assert.deepEqual(expanded.passing, [], 'A qualifying expanded strategy needs a coach implementation')
assert.equal(typeof league.gates.family.passes, 'boolean')
assert.equal(typeof league.gates.model.passes, 'boolean')
const release = {
  paper: league.gates.family.passes ? 'value-upgrade' : 'keep-3',
  matchModel: league.gates.model.passes,
}
const path = new URL('../web/release.json', import.meta.url)
if (process.argv.includes('--check')) {
  assert.deepEqual(read('../web/release.json'), release, 'Coach choices disagree with the published experiments')
} else {
  writeFileSync(path, JSON.stringify(release, null, 2) + '\n')
}
console.log('Verified coach selections', release)
