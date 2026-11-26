import type { Policy, Random, View } from './engine.ts'
import { move, random, resumeMatch, sampleRound } from './engine.ts'
import { guardedCandidates } from './model.ts'

/** Match win credit uses the same tie convention as the tournament runner. */
export function winCredit(winners: number[], seat: number): number {
  return winners.includes(seat) ? 1 / winners.length : 0
}

/** The shipped rollout teacher's current-round reward, read from the same trace. */
export function roundUtility(totals: number[], seat: number): number {
  const rival = Math.min(...totals.filter((_, i) => i !== seat))
  const margin = rival - totals[seat]
  if (Math.max(...totals) < 100) return margin
  const lowest = Math.min(...totals)
  const winners = totals.flatMap((x, i) => (x === lowest ? [i] : []))
  const terminalBonus = winners.includes(seat) ? 40 / winners.length : -40
  return terminalBonus + 0.25 * Math.max(-40, Math.min(40, margin))
}

function centered(values: number[]) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return values.map((value) => value - mean)
}

/**
 * Two labels for each action in the deployment shortlist. Each pair uses the
 * same private world, next deal seeds, continuation players and split win rules.
 * Players receive their own observations via resumeMatch; the state is private
 * to the simulator. Each sample re-deals every concealed slot and the stock.
 */
export function matchLabels(
  v: View,
  rng: Random,
  samples: number,
  drawLineup: (seats: number, rng: Random) => Policy[],
) {
  if (!Number.isSafeInteger(samples) || samples < 1)
    throw Error('Expected at least one sample')
  const choices = guardedCandidates(v)
  const matchValues = choices.map(() => 0)
  const roundValues = choices.map(() => 0)
  let simulatedRounds = 0
  let simulatedMoves = 0
  for (let k = 0; k < samples; k++) {
    const worldSeed = Math.floor(rng() * 2 ** 32)
    const actionSeed = Math.floor(rng() * 2 ** 32)
    const continuationSeed = Math.floor(rng() * 2 ** 32)
    const policies = drawLineup(v.boards.length, rng)
    for (const [j, choice] of choices.entries()) {
      const s = sampleRound(v, random(worldSeed))
      move(s, choice.a, random(actionSeed))
      const result = resumeMatch(s, policies, continuationSeed, (_, totals) => {
        roundValues[j] += roundUtility(totals, v.turn) / samples
      })
      matchValues[j] += winCredit(result.winners, v.turn) / samples
      simulatedRounds += result.rounds
      simulatedMoves += 1 + result.moves
    }
  }
  return {
    x: choices.map((c) => c.f),
    y: centered(matchValues),
    yRound: centered(roundValues),
    credit: matchValues,
    simulatedMatches: choices.length * samples,
    simulatedRounds,
    simulatedMoves,
  }
}
