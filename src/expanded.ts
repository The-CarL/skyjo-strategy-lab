import { GONE, frequencies, legal } from './engine.ts'
import type { Action, Board, Policy, View } from './engine.ts'

/** Coefficients of a linear action scorer. The board coefficients are frozen
 * before the context coefficients are fitted. Both fits optimize match wins. */
export const boardTerms = [
  'drawHurdle',
  'blindDrawFloor',
  'flipValue',
  'hiddenBonus',
  'pairPotential',
  'lateRevealBonus',
] as const
export const tableTerms = [
  'closeRisk',
  'urgentReveal',
  'lateLeadTempo',
] as const

export interface ExpandedBundle {
  version: 1
  board: number[]
  table: number[]
}
export type ExpandedMode = 'board' | 'urgency' | 'table'
export const startingBoard = [4.3, 1.5, 1.15, 0.9, 0.35, 0]
export const startingTable = [0.5, 0, 0]
const average = 760 / 150

function statistics(b: Board) {
  let points = 0,
    hidden = 0,
    largest = -2
  for (const value of b) {
    if (value === GONE) continue
    if (value === null) {
      hidden++
      points += average
    } else {
      points += value
      largest = Math.max(largest, value)
    }
  }
  return { points, hidden, largest }
}

/** 'urgency' deliberately uses only a binary public signal: anyone else has
 * at most one hidden card. 'board' never accesses another player's board. */
function context(v: View, mode: ExpandedMode) {
  let urgent = false,
    closestRound = Infinity,
    closestHidden = 0,
    closestMatch = Infinity
  if (mode !== 'board') {
    for (let i = 0; i < v.boards.length; i++) {
      if (i === v.turn) continue
      if (mode === 'urgency') {
        urgent ||= v.boards[i].filter((value) => value === null).length <= 1
        continue
      }
      const rival = statistics(v.boards[i])
      urgent ||= rival.hidden <= 1
      if (rival.points < closestRound) {
        closestRound = rival.points
        closestHidden = rival.hidden
      }
      closestMatch = Math.min(closestMatch, v.totals[i] + rival.points)
    }
  }
  return { urgent, closestRound, closestHidden, closestMatch }
}

function pairPotential(
  value: number,
  left: number | null,
  right: number | null,
) {
  // A positive pair is potentially valuable; an unavoidable completed column
  // also loses any favorable negative points it held.
  return left === value || right === value ? Math.max(0, value) : 0
}

/** Every legal move, including deliberate uphill exchanges and negative triples,
 * receives a score. Equal scores use engine order. Positive draw/reveal floors
 * require a visible-only move to improve the board's points/pair potential. */
export function expandedScores(v: View, m: ExpandedBundle, mode: ExpandedMode) {
  const [hurdle, drawFloor, flip, hide, pair, lateReveal] = m.board
  const [closeRisk, near, tempo] = m.table
  const b = v.boards[v.turn]
  const own = statistics(b)
  const others = context(v, mode)
  const x = v.held ?? v.discard
  const nearEnd = mode === 'table' && Math.max(...v.totals) >= 70
  return legal(v).map((action) => {
    if (action.kind === 'draw') {
      return { action, score: Math.max(0.1, drawFloor, own.largest - hurdle) }
    }
    const slot = action.slot,
      start = slot - (slot % 3)
    const left = b[start + ((slot + 1) % 3)],
      right = b[start + ((slot + 2) % 3)]
    const old = b[slot]
    const hidden = old === null
    let score: number, gain: number
    if (action.kind === 'flip') {
      // The expectation uses the fixed deck prior; no discard history is read.
      const matchingMates = left !== null && right === left
      gain = matchingMates ? (frequencies[left + 2] / 150) * 3 * left : 0
      score = flip + gain
    } else {
      const clear = left === x && right === x
      gain = (old ?? average) - x + (clear ? 3 * x : 0)
      // If the other two positions already match, their pair disappears upon
      // clearing. Otherwise adding/removing the target may create/break a pair.
      const deltaPair = clear
        ? -Math.max(0, x)
        : pairPotential(x, left, right) -
          (old === null ? 0 : pairPotential(old, left, right))
      score = gain + pair * deltaPair + (hidden ? hide : 0)
    }
    if (hidden) {
      score += lateReveal * Math.max(0, 4 - own.hidden)
      if (others.urgent) score += near
      if (mode === 'table' && v.closer === null && own.hidden === 1) {
        const after = own.points - gain
        // Approximate probability of a rival undercutting a positive round score.
        // Rivals still get a final turn. More hidden cards widen the transition.
        const margin = after - others.closestRound + 3
        const risk =
          0.5 +
          (0.5 * margin) /
            (Math.abs(margin) + 1 + 2 * Math.sqrt(others.closestHidden))
        score -= closeRisk * risk * Math.max(0, after)
        if (nearEnd) {
          const lead = others.closestMatch - (v.totals[v.turn] + after)
          score += tempo * Math.tanh(lead / 15)
        }
      }
      // At least one hidden flip is always affordable after a blind draw.
      if (action.kind === 'flip') score = Math.max(0.05, score)
    }
    return { action, score }
  })
}

export function expandedPolicy(m: ExpandedBundle, mode: ExpandedMode): Policy {
  if (
    m.version !== 1 ||
    m.board.length !== boardTerms.length ||
    m.table.length !== tableTerms.length ||
    ![...m.board, ...m.table].every(Number.isFinite)
  )
    throw Error('Invalid expanded policy coefficients')
  return {
    name: 'expanded-' + mode,
    choose(v): Action {
      const choices = expandedScores(v, m, mode)
      return choices.reduce((best, row) =>
        row.score > best.score ? row : best,
      ).action
    },
  }
}
