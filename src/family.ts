/** Paper policies for classic Skyjo. All decisions use only the acting player's grid. */
import { GONE } from './engine.ts'
import type { Action, Policy, View } from './engine.ts'

interface FamilyRules {
  visibleLimit?: number
  hiddenLimit?: number
  visibleFloor?: number
  minVisibleSaving?: number
  drawnUpgrade?: boolean
  compareClears?: boolean
  protectPair?: boolean
  buildPair?: boolean
}
const rules: Record<string, FamilyRules> = {
  'family-3-3': {},
  'family-5-3': { visibleLimit: 5 },
  'family-3-5': { hiddenLimit: 5 },
  'family-5-5': { visibleLimit: 5, hiddenLimit: 5 },
  'family-save5-hidden3': { minVisibleSaving: 5 },
  'family-value-clear': { compareClears: true },
  'family-pair-break': { protectPair: true },
  'family-build-pair': { buildPair: true },
  'family-drawn-upgrade': { drawnUpgrade: true },
  'family-hidden-first': { visibleFloor: 6 },
  'family-value-upgrade': { compareClears: true, drawnUpgrade: true },
  'family-value-position': {
    compareClears: true,
    drawnUpgrade: true,
    visibleFloor: 6,
    buildPair: true,
  },
}
export const familyIds = Object.keys(rules)

function choose(view: View, rules: FamilyRules): Action {
  const board = view.boards[view.turn]
  const value = view.held ?? view.discard
  const kind = view.held === null ? 'take' : 'swap'
  let clear = -1
  let clearSaving = -Infinity
  let visible = -1
  let highest = -Infinity
  let hidden = -1
  let hiddenBuildsPair = false
  let firstHidden = -1

  for (let slot = 0; slot < board.length; slot++) {
    const target = board[slot]
    if (target === GONE) continue
    const start = slot - (slot % 3)
    const first = board[start + ((slot + 1) % 3)]
    const second = board[start + ((slot + 2) % 3)]
    if (target === null && firstHidden < 0) firstHidden = slot
    if (target !== value && first === value && second === value) {
      if (!rules.compareClears) return { kind, slot }
      // After a clear the entire original column is gone. Round the blind value to five.
      const saving = 2 * value + (target ?? 5)
      if (saving > clearSaving) {
        clear = slot
        clearSaving = saving
      }
      continue
    }
    if (target === null) {
      const buildsPair = Boolean(
        rules.buildPair && value > 0 && (first === value || second === value),
      )
      if (hidden < 0 || (buildsPair && !hiddenBuildsPair)) {
        hidden = slot
        hiddenBuildsPair = buildsPair
      }
      continue
    }
    const saving = target - value
    const normal =
      rules.minVisibleSaving === undefined
        ? target >= (rules.visibleFloor ?? 4) &&
          value <= (rules.visibleLimit ?? 3) &&
          saving > 0
        : saving >= rules.minVisibleSaving
    const drawnUpgrade = rules.drawnUpgrade && view.held !== null && saving >= 4
    const preserve =
      rules.protectPair && (first === target || second === target) && saving < 5
    if ((normal || drawnUpgrade) && !preserve && target > highest) {
      visible = slot
      highest = target
    }
  }
  const ordinary =
    visible >= 0 ? visible : value <= (rules.hiddenLimit ?? 3) ? hidden : -1
  // A blind draw or a plain flip has a nominal immediate saving of zero.
  const ordinarySaving = ordinary < 0 ? 0 : (board[ordinary] ?? 5) - value
  if (clear >= 0 && clearSaving >= ordinarySaving) return { kind, slot: clear }
  if (ordinary >= 0) return { kind, slot: ordinary }
  if (view.held === null) return { kind: 'draw' }
  if (firstHidden < 0)
    throw Error('A player taking a turn must have a hidden slot')
  return { kind: 'flip', slot: firstHidden }
}

export function familyPolicy(id: string): Policy | undefined {
  if (!Object.hasOwn(rules, id)) return undefined
  return { name: id, choose: (view) => choose(view, rules[id]) }
}
