import { GONE, threeMatch } from '../src/engine.ts'
import type { Action, Board, Policy, View } from '../src/engine.ts'
import { incoming, positional, threshold } from '../src/policies.ts'
import { learned } from '../src/model.ts'
import type { Bundle } from '../src/model.ts'
import { strategyGuide } from '../src/strategy-guide.ts'
import type { StrategyDetails } from '../src/strategy-guide.ts'
import models from '../models/policies.json' with { type: 'json' }

import { familyPolicy } from '../src/family.ts'
import matchModel from '../models/match-s11.json' with { type: 'json' }

declare const __VALUE_UPGRADE__: boolean
declare const __MATCH_MODEL__: boolean

const modes = new Map<
  string,
  { label: string; policy: Policy; guide: StrategyDetails }
>()
function add(policy: Policy, guideId = policy.name) {
  const guide = strategyGuide[guideId]
  if (!guide?.coachMode || !guide.coachLabel)
    throw Error('Missing coach strategy: ' + guideId)
  modes.set(guide.coachMode, { label: guide.coachLabel, policy, guide })
}
if (__VALUE_UPGRADE__) add(familyPolicy('family-value-upgrade')!)
add(threshold(3, true))
if (__MATCH_MODEL__) add(learned(matchModel as Bundle, 'mlp'), 'match-mlp-11')
add(positional('board'))
add(learned(models as Bundle, 'tree'))
add(learned(models as Bundle, 'mlp'))
interface State {
  board: Board
  discard: number | null
  held: number | null
  mode: string
}
const fresh = (): State => ({
  board: Array(12).fill(null),
  discard: null,
  held: null,
  mode: __VALUE_UPGRADE__ ? 'value' : 'family',
})
const storeKey = 'skyjo-lab-coach-v1'
const valid = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= -2 && n <= 12
const maxUndo = 120
const history: State[] = []
let s = fresh()

function restored(value: unknown): State | null {
  if (!value || typeof value !== 'object') return null
  const { board, discard, held, mode } = value as Partial<State>
  if (
    !Array.isArray(board) ||
    board.length !== 12 ||
    !board.every((x) => x === null || x === GONE || valid(x)) ||
    !(discard === null || valid(discard)) ||
    !(held === null || valid(held))
  )
    return null
  return {
    board: [...board],
    discard,
    held,
    mode: typeof mode === 'string' && modes.has(mode) ? mode : fresh().mode,
  }
}
try {
  const saved = JSON.parse(localStorage.getItem(storeKey) ?? 'null')
  const current = restored(saved)
  if (current) {
    s = current
    if (Array.isArray(saved.undo)) {
      for (const entry of saved.undo.slice(-maxUndo)) {
        const step = restored(entry)
        if (step) history.push(step)
      }
    }
  }
} catch {
  /* The board remains usable when this browser disables file storage. */
}

const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T
const button = (id: string) => el<HTMLButtonElement>(id)
const dialog = el<HTMLDialogElement>('picker')
for (const [id, mode] of modes) {
  el<HTMLSelectElement>('policy').add(new Option(mode.label, id))
  const title = document.createElement('dt')
  title.dataset.mode = id
  title.textContent = mode.label
  const details = document.createElement('dd')
  const decision = document.createElement('p')
  decision.textContent = mode.guide.decision
  const example = document.createElement('p')
  example.textContent = mode.guide.example
  details.append(decision, example)
  el('coach-strategy-list').append(title, details)
}
let current: Action | null = null
const spot = (slot: number) =>
  'column ' + (Math.floor(slot / 3) + 1) + ', row ' + ((slot % 3) + 1)
function update(fn: () => string | void) {
  const before: State = { ...s, board: [...s.board] }
  const message = fn()
  const changed =
    before.discard !== s.discard ||
    before.held !== s.held ||
    before.mode !== s.mode ||
    !before.board.every((x, i) => x === s.board[i])
  if (changed) {
    history.push(before)
    if (history.length > maxUndo) history.shift()
  }
  render()
  el('feedback').textContent = message ?? ''
}

type Entry = number | null | 'gone'
function pick(
  title: string,
  detail: string,
  done: (x: Entry) => void,
  selected?: Entry,
  edit = false,
) {
  el('pick-title').textContent = title
  el('pick-detail').textContent = detail
  el('numbers').replaceChildren()
  el('special').replaceChildren()
  function choice(label: string, value: Entry, target: string, id?: string) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    if (id) b.id = id
    b.setAttribute('aria-pressed', String(value === selected))
    b.onclick = () => {
      dialog.close()
      done(value)
    }
    el(target).append(b)
  }
  for (let i = -2; i <= 12; i++) choice(String(i), i, 'numbers')
  if (edit) {
    choice('Face down', null, 'special', 'mark-hidden')
    choice('Column gone', 'gone', 'special', 'mark-gone')
  }
  dialog.showModal()
  el('pick-title').focus({ preventScroll: true })
}
function clearBoard(): number[] {
  const cleared: number[] = []
  for (let i = 0; i < 12; i += 3) {
    if (threeMatch(s.board[i], s.board[i + 1], s.board[i + 2])) {
      s.board.splice(i, 3, GONE, GONE, GONE)
      cleared.push(i / 3 + 1)
    }
  }
  return cleared
}
function setSlot(slot: number) {
  const previous = s.board[slot]
  pick(
    'Edit ' + spot(slot),
    previous === GONE
      ? 'This column was removed. Choose a card value or Face down to restore it.'
      : 'Choose the value on your table, keep this card face down, or mark the whole column gone.',
    (x) =>
      update(() => {
        const start = slot - (slot % 3)
        if (x === 'gone') {
          s.board.splice(start, 3, GONE, GONE, GONE)
          return 'Column ' + (start / 3 + 1) + ' marked gone.'
        }
        if (s.board[slot] === GONE) s.board.splice(start, 3, null, null, null)
        s.board[slot] = x
        const cleared = clearBoard()
        if (cleared.length)
          return 'Matching column ' + cleared.join(', ') + ' removed.'
      }),
    previous === GONE ? 'gone' : previous,
    true,
  )
}
function getView(): View {
  return {
    boards: [s.board],
    turn: 0,
    totals: [0],
    discard: s.discard ?? 0,
    held: s.held,
    closer: null,
  }
}
function draw() {
  pick(
    'What did you draw?',
    'Draw from the face-down pile on your table, then tap the number on that card.',
    (x) => {
      if (typeof x === 'number')
        update(() => {
          s.held = x
        })
    },
    s.held ?? undefined,
  )
}

function apply() {
  if (!current) return
  const a = current
  if (a.kind === 'draw') return draw()
  const finish = (value: number) => {
    update(() => {
      s.board[a.slot] = value
      s.held = null
      s.discard = null
      const cleared = clearBoard()
      if (cleared.length)
        return 'Move applied. Column ' + cleared.join(', ') + ' cleared.'
      return (
        (a.kind === 'flip' ? 'Revealed ' : 'Placed ') +
        value +
        ' in ' +
        spot(a.slot) +
        '.'
      )
    })
    if (button('apply').hidden) {
      const next = s.board.some((x) => x === null)
        ? button('discard')
        : button('reset')
      next.focus({ preventScroll: true })
    }
  }
  if (a.kind === 'flip')
    return pick(
      'Card revealed in ' + spot(a.slot),
      'Flip this card on your table, then enter its value.',
      (x) => {
        if (typeof x === 'number') finish(x)
      },
    )
  finish(incoming(getView()))
}
function render() {
  const v = getView(),
    b = s.board,
    hidden = b.filter((x) => x === null).length
  const revealed = b.filter((x) => x !== null && x !== GONE)
  const ready = hidden <= 10
  const mode = modes.get(s.mode)!
  current =
    ready && hidden > 0 && (s.discard !== null || s.held !== null)
      ? mode.policy.choose(v, Math.random)
      : null
  el('grid').querySelectorAll<HTMLButtonElement>('.slot').forEach((cell) => {
    const i = Number(cell.dataset.slot),
      x = b[i]
    const suggested = current && current.kind !== 'draw' && current.slot === i
    const face =
      x === null
        ? 'hidden'
        : x === GONE
          ? 'gone'
          : x < 0
            ? 'neg'
            : x >= 7
              ? 'high'
              : ''
    cell.textContent = x === null ? '?' : x === GONE ? '—' : String(x)
    cell.className = 'slot ' + face + (suggested ? ' suggest' : '')
    cell.setAttribute(
      'aria-label',
      spot(i) +
        ', ' +
        (x === null ? 'face down' : x === GONE ? 'removed' : x) +
        (suggested ? ', recommended slot' : ''),
    )
  })
  el('instructions').textContent = !ready
    ? 'Tap the two cards you turned over in front of you and enter their values.'
    : 'Tap any card to edit your board. Enter the top discard or the card you drew from the face-down pile.'
  el('known').textContent = hidden + ' hidden'
  el('points').textContent =
    'Visible points · ' + revealed.reduce<number>((a, x) => a + x!, 0)
  el<HTMLSelectElement>('policy').value = s.mode
  el('policy-description').textContent = mode.guide.description
  el('discard-value').textContent = String(s.discard ?? '+')
  el('drawn-value').textContent = String(s.held ?? '+')
  const holding = s.held !== null
  el('draw-label').textContent = holding ? 'Card I drew' : 'Draw a card'
  button('drawn').setAttribute(
    'aria-label',
    holding ? 'Edit drawn card ' + s.held : 'Draw a card and enter its value',
  )
  button('discard').setAttribute(
    'aria-label',
    s.discard === null
      ? 'Enter the top discard'
      : 'Edit top discard ' + s.discard,
  )
  button('drawn').setAttribute('aria-pressed', String(holding))
  button('discard').setAttribute(
    'aria-pressed',
    String(!holding && s.discard !== null),
  )
  button('drawn').disabled = !hidden
  button('discard').disabled = !hidden
  button('undo').disabled = !history.length
  const a = current,
    x = incoming(v)
  let title = '',
    reason = '',
    label = ''
  if (!hidden) {
    title = 'Round finished'
    reason =
      'Score the remaining cards after everyone has taken their final turn.'
  } else if (!ready) {
    title = 'Set your opening cards'
    reason =
      s.held !== null
        ? 'Your draw of ' +
          s.held +
          ' is recorded. Tap your two visible board cards for advice.'
        : 'Tap each face-up card on your board and enter its value.'
  } else if (!a) {
    title = 'Enter the top discard'
    reason =
      'Tap the discard pile, or enter your blind draw if you already drew.'
  } else if (a.kind === 'draw') {
    title = 'Draw blind'
    reason =
      s.mode === 'family'
        ? 'The discard misses a column clear and the low-card cutoff.'
        : 'This strategy prefers the options available from a blind draw.'
    label = 'Draw and enter its value'
  } else {
    const target = b[a.slot],
      loc = spot(a.slot),
      kind = a.kind
    const start = a.slot - (a.slot % 3)
    const matches = b
      .slice(start, start + 3)
      .filter((y, i) => i !== a.slot % 3 && y === x).length
    title =
      kind === 'flip'
        ? 'Discard ' + x + ' and flip'
        : (kind === 'take' ? 'Take ' : 'Keep ') + x
    if (kind === 'flip') reason = 'Turn up the hidden card in ' + loc + '.'
    else if (matches === 2)
      reason = 'Place it in ' + loc + ' to clear all three cards.'
    else
      reason =
        'Replace ' +
        (target === null ? 'the hidden card' : String(target)) +
        ' in ' +
        loc +
        '.'
    if (s.mode === 'value' && kind !== 'flip' && matches !== 2) {
      const trade = (target ?? 5) - x
      let bestClear = -Infinity
      for (let col = 0; col < 12; col += 3) {
        const column = b.slice(col, col + 3)
        const others = column.filter((card) => card !== x)
        if (others.length === 1)
          bestClear = Math.max(bestClear, 2 * x + (others[0] ?? 5))
      }
      if (Number.isFinite(bestClear) && trade > bestClear)
        reason +=
          ' Counting a hidden card as 5, this saves ' +
          trade +
          ' points. The best clear saves ' +
          bestClear +
          '.'
      else if (s.held !== null && x > 3 && trade >= 4)
        reason += ' This blind draw cuts ' + trade + ' points.'
    }
    label = kind === 'flip' ? 'Enter revealed card' : 'Apply move'
  }
  el('advice').textContent = title
  el('reason').textContent = reason
  const act = button('apply')
  act.hidden = !a
  act.textContent = label
  try {
    localStorage.setItem(storeKey, JSON.stringify({ ...s, undo: history }))
  } catch {
    /* usable without persistence */
  }
}
// Keep grid buttons mounted across edits so closing the value picker returns focus to the same card.
for (let row = 0; row < 3; row++)
  for (let column = 0; column < 4; column++) {
    const i = column * 3 + row,
      cell = document.createElement('button')
    cell.type = 'button'
    cell.className = 'slot'
    cell.dataset.slot = String(i)
    cell.setAttribute('aria-haspopup', 'dialog')
    cell.onclick = () => setSlot(i)
    el('grid').append(cell)
  }
button('discard').onclick = () =>
  pick(
    'Top discard',
    'Enter the number showing on top of the face-up discard pile.',
    (x) => {
      if (typeof x === 'number')
        update(() => {
          s.discard = x
          s.held = null
        })
    },
    s.discard ?? undefined,
  )
button('drawn').onclick = draw
button('apply').onclick = apply
button('undo').onclick = () => {
  const old = history.pop()
  if (old) {
    s = old
    render()
    el('feedback').textContent = 'Last change undone.'
  }
}
button('reset').onclick = () =>
  update(() => {
    const mode = s.mode
    s = { ...fresh(), mode }
  })
el<HTMLSelectElement>('policy').onchange = (e) =>
  update(() => {
    s.mode = (e.target as HTMLSelectElement).value
  })
button('cancel').onclick = () => dialog.close()
button('print').onclick = () => {
  document.body.classList.add('show-card')
  button('back').focus()
}
button('back').onclick = () => {
  document.body.classList.remove('show-card')
  button('print').focus()
}
button('paper').onclick = () => window.print()
render()
