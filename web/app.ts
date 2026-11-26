import { GONE, threeMatch } from '../src/engine.ts'
import type { Action, Board, View } from '../src/engine.ts'
import { incoming, positional, threshold } from '../src/policies.ts'
import { learned } from '../src/model.ts'
import type { Bundle } from '../src/model.ts'
import models from '../models/policies.json' with { type: 'json' }

const policies = {
  family: threshold(3, true),
  board: positional('board'),
  tree: learned(models as Bundle, 'tree'),
  mlp: learned(models as Bundle, 'mlp'),
}
type Mode = keyof typeof policies
interface State {
  board: Board
  discard: number | null
  held: number | null
  mode: Mode
}
const fresh = (): State => ({
  board: Array(12).fill(null),
  discard: null,
  held: null,
  mode: 'family',
})
const storeKey = 'skyjo-lab-coach-v1'
const valid = (n: unknown) =>
  typeof n === 'number' && Number.isInteger(n) && n >= -2 && n <= 12
let s = fresh()
try {
  const saved = JSON.parse(localStorage.getItem(storeKey) ?? 'null')
  if (
    saved &&
    Object.hasOwn(policies, saved.mode) &&
    [saved.held, saved.discard].every((x) => x === null || valid(x)) &&
    Array.isArray(saved.board) &&
    saved.board.length === 12 &&
    saved.board.every((x: unknown) => x === null || x === GONE || valid(x))
  )
    s = saved
} catch {
  /* File URLs and private browsing may disable storage. */
}
const history: State[] = []
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T
const button = (id: string) => el<HTMLButtonElement>(id)
const dialog = el<HTMLDialogElement>('picker')
let current: Action | null = null
const spot = (slot: number) =>
  'column ' + (Math.floor(slot / 3) + 1) + ', row ' + ((slot % 3) + 1)
function update(fn: () => void) {
  history.push(structuredClone(s))
  if (history.length > 120) history.shift()
  fn()
  render()
}
function pick(
  title: string,
  done: (x: number | null | 'gone') => void,
  edit = false,
) {
  el('pick-title').textContent = title
  el('numbers').replaceChildren()
  el('special').replaceChildren()
  function choice(
    label: string,
    value: number | null | 'gone',
    target: string,
  ) {
    const b = document.createElement('button')
    b.textContent = label
    b.onclick = () => {
      dialog.close()
      done(value)
    }
    el(target).append(b)
  }
  for (let i = -2; i <= 12; i++) choice(String(i), i, 'numbers')
  if (edit) {
    choice('Face down', null, 'special')
    choice('Column gone', 'gone', 'special')
  }
  dialog.showModal()
}
function clearBoard() {
  for (let i = 0; i < 12; i += 3)
    if (threeMatch(s.board[i], s.board[i + 1], s.board[i + 2]))
      s.board.splice(i, 3, GONE, GONE, GONE)
}
function setSlot(slot: number) {
  pick(
    'Edit ' + spot(slot),
    (x) =>
      update(() => {
        const start = slot - (slot % 3)
        if (x === 'gone') s.board.splice(start, 3, GONE, GONE, GONE)
        else {
          if (s.board[slot] === GONE) s.board.splice(start, 3, null, null, null)
          s.board[slot] = x
          clearBoard()
        }
      }),
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
  pick('What did you draw?', (x) => {
    if (typeof x === 'number')
      update(() => {
        s.held = x
      })
  })
}
function apply() {
  if (!current) return
  const a = current
  if (a.kind === 'draw') return draw()
  const finish = (value: number) =>
    update(() => {
      s.board[a.slot] = value
      s.held = null
      s.discard = null
      clearBoard()
    })
  if (a.kind === 'flip')
    return pick('Card revealed in ' + spot(a.slot), (x) => {
      if (typeof x === 'number') finish(x)
    })
  finish(incoming(getView()))
}
function render() {
  const v = getView(),
    b = s.board,
    hidden = b.filter((x) => x === null).length
  const revealed = b.filter((x) => x !== null && x !== GONE)
  const ready = hidden <= 10
  current =
    ready && hidden > 0 && (s.discard !== null || s.held !== null)
      ? policies[s.mode].choose(v, Math.random)
      : null
  const grid = el('grid')
  grid.replaceChildren()
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 4; col++) {
      const i = col * 3 + row,
        x = b[i],
        cell = document.createElement('button')
      const text = x === null ? '?' : x === GONE ? '—' : String(x)
      cell.className =
        'slot ' +
        (x === null
          ? 'hidden'
          : x === GONE
            ? 'gone'
            : x < 0
              ? 'neg'
              : x >= 7
                ? 'high'
                : '') +
        (current && current.kind !== 'draw' && current.slot === i
          ? ' suggest'
          : '')
      cell.textContent = text
      cell.setAttribute(
        'aria-label',
        spot(i) +
          ', ' +
          (x === null ? 'face down' : x === GONE ? 'removed' : x),
      )
      cell.onclick = () => setSlot(i)
      grid.append(cell)
    }
  el('known').textContent = hidden + ' hidden'
  el('points').textContent =
    'Visible points · ' + revealed.reduce<number>((a, x) => a + x!, 0)
  el<HTMLSelectElement>('policy').value = s.mode
  el('discard-value').textContent = String(s.discard ?? '+')
  el('drawn-value').textContent = String(s.held ?? '+')
  button('drawn').disabled = !ready || !hidden
  button('discard').disabled = !hidden
  button('undo').disabled = !history.length
  const a = current,
    x = incoming(v)
  let title = '',
    reason = '',
    label = ''
  if (!hidden) {
    title = 'Round finished'
    reason = 'Give each other player their final turn, then score the table.'
  } else if (!ready) {
    title = 'Set your opening cards'
    reason = 'Tap each face-up card on your board and enter its value.'
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
    label = 'Enter drawn card'
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
    label = kind === 'flip' ? 'Enter revealed card' : 'Apply move'
  }
  el('advice').textContent = title
  el('reason').textContent = reason
  const act = button('apply')
  act.hidden = !a
  act.textContent = label
  try {
    localStorage.setItem(storeKey, JSON.stringify(s))
  } catch {
    /* usable without persistence */
  }
}
button('discard').onclick = () =>
  pick('Top discard', (x) => {
    if (typeof x === 'number')
      update(() => {
        s.discard = x
        s.held = null
      })
  })
button('drawn').onclick = draw
button('apply').onclick = apply
button('undo').onclick = () => {
  const old = history.pop()
  if (old) {
    s = old
    render()
  }
}
button('reset').onclick = () =>
  update(() => {
    const mode = s.mode
    s = { ...fresh(), mode }
  })
el<HTMLSelectElement>('policy').onchange = (e) =>
  update(() => {
    s.mode = (e.target as HTMLSelectElement).value as Mode
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
