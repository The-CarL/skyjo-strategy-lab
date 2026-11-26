import { deal, legal, move, observe, random, score } from './engine.ts'
import type { Action, Board, Random, Round } from './engine.ts'
import { engineCatalog, onlinePolicy } from './online-policies.ts'

export { engineCatalog } from './online-policies.ts'
export type { EngineInfo } from './online-policies.ts'

export type MatchCommand =
  | Action
  | { kind: 'open'; slots: [number, number] }
  | { kind: 'nextRound' }
export type MatchPhase =
  | 'opening'
  | 'source'
  | 'held'
  | 'roundOver'
  | 'gameOver'
export type RoundResult = {
  round: number
  closer: number
  points: number[]
  totals: number[]
}
export type TurnEvent = {
  seat: number
  kind: 'open' | Action['kind']
  slot?: number
  /** Public incoming/revealed card following a placement or flip. */
  value?: number
  discarded?: number
  /** Zero-based column indices removed from this seat's grid during this move. */
  cleared?: number[]
}
export interface PublicMatch {
  phase: MatchPhase
  revision: number
  round: number
  turn: number | null
  closer: number | null
  stockCount: number
  discard: number | null
  held: number | null
  players: {
    seat: number
    engineId: string | null
    name: string
    board: Board
    total: number
  }[]
  history: RoundResult[]
  winners: number[]
  recent: TurnEvent[]
}

interface Cursor {
  seed: number
  draws: number
}
/** Server storage only. The seed, deck, face-down values and RNG cursors are private. */
export interface OnlineMatch {
  version: 1
  seed: number
  revision: number
  engines: string[]
  phase: MatchPhase
  hand: Round
  deckStream: Cursor
  botStreams: Cursor[]
  history: RoundResult[]
  recent: TurnEvent[]
}
export class MatchCommandError extends Error {
  override name = 'MatchCommandError'
}

/** Restore the engine's own seeded stream, without serializing a JavaScript closure. */
function resume(cursor: Cursor): Random {
  const rng = random(cursor.seed)
  for (let i = 0; i < cursor.draws; i++) rng()
  return () => {
    cursor.draws++
    return rng()
  }
}

function pendingDeal(seed: number, engines: string[], history: RoundResult[]) {
  const previous = history.at(-1)
  const round = history.length + 1
  const totals = previous?.totals ?? Array<number>(engines.length + 1).fill(0)
  const deckStream = {
    seed: (seed ^ Math.imul(round, 0x9e3779b1)) >>> 0,
    draws: 0,
  }
  // The game engine can reveal configured slots while dealing. Hide the two
  // human placeholders until the human has committed both opening selections.
  const openings = [
    [0, 3],
    ...engines.map(
      (id, i) =>
        onlinePolicy(id).opening?.(
          random(seed ^ Math.imul(round, 0xc2b2ae35) ^ (i + 1)),
        ) ?? [0, 3],
    ),
  ]
  const hand = deal(
    totals,
    resume(deckStream),
    previous?.closer ?? null,
    openings,
  )
  for (const card of hand.hands[0]) if (card) card.up = false
  return { hand, deckStream }
}

/** Deal to one human and one to seven bots. The caller supplies a private unsigned seed. */
export function createMatch(engineIds: string[], seed: number): OnlineMatch {
  if (!Array.isArray(engineIds) || engineIds.length < 1 || engineIds.length > 7)
    throw new MatchCommandError('Choose between one and seven opponents.')
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new MatchCommandError('Expected an unsigned 32-bit match seed.')
  for (const id of engineIds) {
    if (!engineCatalog.some((engine) => engine.id === id))
      throw new MatchCommandError('Unknown opponent.')
  }
  return {
    version: 1,
    seed,
    engines: [...engineIds],
    revision: 0,
    phase: 'opening',
    ...pendingDeal(seed, engineIds, []),
    history: [],
    recent: [],
    botStreams: engineIds.map((_, i) => ({
      seed: (seed ^ Math.imul(i + 2, 0x45d9f3b)) >>> 0,
      draws: 0,
    })),
  }
}

function opening(state: OnlineMatch, slots: [number, number]) {
  if (
    !Array.isArray(slots) ||
    slots.length !== 2 ||
    slots[0] === slots[1] ||
    ![slots[0], slots[1]].every((n) => Number.isInteger(n) && n >= 0 && n < 12)
  )
    throw new MatchCommandError('Choose two different cards from your board.')
  const hand = state.hand
  for (const slot of slots) hand.hands[0][slot]!.up = true
  const prev = state.history.at(-1)
  if (prev) hand.turn = prev.closer
  else {
    const sums = hand.hands.map((board) =>
      board.reduce((n, c) => n + (c?.up ? c.value : 0), 0),
    )
    hand.turn = sums.indexOf(Math.max(...sums))
  }
  state.recent.push({ seat: 0, kind: 'open' })
}

function playAction(state: OnlineMatch, action: Action, deckRandom: Random) {
  const s = state.hand,
    seat = s.turn
  if (action.kind === 'draw') {
    move(s, action, deckRandom)
    // A blind draw reveals no value to the other seats.
    state.recent.push({ seat, kind: 'draw' })
    return
  }
  const hand = s.hands[seat]
  const columnPresent = [0, 3, 6, 9].map((slot) => hand[slot] !== null)
  const incoming = action.kind === 'take' ? s.waste.at(-1)! : s.held!
  const old = hand[action.slot]!.value
  move(s, action, deckRandom)
  const cleared = columnPresent.flatMap((was, i) =>
    was && hand[i * 3] === null ? [i] : [],
  )
  const event: TurnEvent = {
    seat,
    kind: action.kind,
    slot: action.slot,
    value: action.kind === 'flip' ? old : incoming,
    discarded: action.kind === 'flip' ? incoming : old,
  }
  if (cleared.length) event.cleared = cleared
  state.recent.push(event)
}

function advance(state: OnlineMatch, deckRandom: Random) {
  const s = state.hand
  // Until the human acts again, each other seat can draw and place at most once.
  let decisions = 0
  while (!s.finished && s.turn !== 0) {
    if (++decisions > 2 * state.engines.length)
      throw Error('Bot response exceeded one rotation.')
    const seat = s.turn,
      bot = onlinePolicy(state.engines[seat - 1])
    const action = bot.choose(
      observe(s, !!bot.count),
      resume(state.botStreams[seat - 1]),
    )
    playAction(state, action, deckRandom)
  }
  if (s.finished) {
    const points = score(s),
      totals = s.totals.map((n, i) => n + points[i])
    state.history.push({
      round: state.history.length + 1,
      closer: s.closer!,
      points,
      totals,
    })
    state.phase = Math.max(...totals) >= 100 ? 'gameOver' : 'roundOver'
  } else {
    state.phase = s.held === null ? 'source' : 'held'
  }
}

/** A pure transition. On success the new snapshot advances exactly one revision.
 * Automatic bot decisions are part of this same command and storage transaction. */
export function applyCommand(
  previous: OnlineMatch,
  command: MatchCommand,
): OnlineMatch {
  if (!command || typeof command !== 'object')
    throw new MatchCommandError('Invalid game command.')
  const state = structuredClone(previous)
  state.recent = []
  if (command.kind === 'nextRound') {
    if (state.phase !== 'roundOver')
      throw new MatchCommandError('The next round is unavailable.')
    Object.assign(state, pendingDeal(state.seed, state.engines, state.history))
    state.phase = 'opening'
  } else if (command.kind === 'open') {
    if (state.phase !== 'opening')
      throw new MatchCommandError('The opening selection is already complete.')
    opening(state, command.slots)
    advance(state, resume(state.deckStream))
  } else {
    if (
      (state.phase !== 'source' && state.phase !== 'held') ||
      state.hand.turn !== 0
    )
      throw new MatchCommandError('A turn action is unavailable.')
    const valid = legal(observe(state.hand)).some(
      (a) =>
        a.kind === command.kind &&
        (a.kind === 'draw' ||
          (command.kind !== 'draw' && a.slot === command.slot)),
    )
    if (!valid)
      throw new MatchCommandError(
        'That move is unavailable for the selected card.',
      )
    const deckRandom = resume(state.deckStream)
    playAction(state, command, deckRandom)
    advance(state, deckRandom)
  }
  state.revision++
  return state
}

/** The only match representation for the browser. Every returned collection is detached. */
export function publicMatch(state: OnlineMatch): PublicMatch {
  const s = state.hand
  const view = observe(s)
  const ended = state.phase === 'roundOver' || state.phase === 'gameOver'
  const totals = ended ? state.history.at(-1)!.totals : s.totals
  const low = Math.min(...totals)
  const players = view.boards.map((board, seat) => {
    const engineId = seat === 0 ? null : state.engines[seat - 1]
    const name =
      engineId === null
        ? 'You'
        : engineCatalog.find((p) => p.id === engineId)!.name
    return { seat, engineId, name, board, total: totals[seat] }
  })
  return {
    phase: state.phase,
    revision: state.revision,
    round: ended ? state.history.length : state.history.length + 1,
    turn: ended || state.phase === 'opening' ? null : s.turn,
    closer: s.closer,
    stockCount: s.stock.length,
    discard: view.discard,
    held: state.phase === 'held' && s.turn === 0 ? s.held : null,
    players,
    history: structuredClone(state.history),
    recent: structuredClone(state.recent),
    winners:
      state.phase === 'gameOver'
        ? totals.flatMap((n, i) => (n === low ? [i] : []))
        : [],
  }
}
