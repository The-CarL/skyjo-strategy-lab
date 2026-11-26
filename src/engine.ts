/** Classic Skyjo. Slot = column * 3 + row. Removed columns keep stable slot IDs. */
export const GONE = -9
export type Board = (number | null)[]
type Card = { value: number; up: boolean }
export type Action =
  | { kind: 'draw' }
  | { kind: 'take' | 'swap' | 'flip'; slot: number }
export type Random = () => number
export const frequencies = [5, 10, 15, ...Array<number>(12).fill(10)]
export const deckValues = () =>
  frequencies.flatMap((n, i) => Array<number>(n).fill(i - 2))
export function random(seed: number): Random {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), state | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export function shuffle<T>(cards: T[], rng: Random) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[cards[i], cards[j]] = [cards[j], cards[i]]
  }
  return cards
}
export interface Round {
  hands: (Card | null)[][]
  stock: number[]
  waste: number[]
  held: number | null
  turn: number
  closer: number | null
  finished: boolean
  totals: number[]
}
export interface View {
  boards: Board[]
  totals: number[]
  turn: number
  closer: number | null
  discard: number
  held: number | null
  counts?: number[] // Multiset across the stock and still-hidden grid cards.
}
export type Policy = {
  name: string
  count?: boolean
  opening?: (rng: Random) => [number, number]
  choose: (v: View, rng: Random) => Action
}
export function deal(
  totals: number[],
  rng: Random,
  starter: number | null = null,
  openings = totals.map(() => [0, 3]),
): Round {
  if (totals.length < 2 || totals.length > 8)
    throw Error('Classic Skyjo supports 2–8 seats')
  if (
    openings.length !== totals.length ||
    openings.some(
      (pair) =>
        pair.length !== 2 ||
        pair[0] === pair[1] ||
        pair.some((i) => !Number.isInteger(i) || i < 0 || i > 11),
    )
  )
    throw Error('Choose two distinct opening slots per seat')
  const stock = shuffle(deckValues(), rng)
  const hands = totals.map((_, seat) =>
    Array.from({ length: 12 }, (_, slot) => ({
      value: stock.pop()!,
      up: openings[seat].includes(slot),
    })),
  )
  const open = hands.map(
    (h, i) => h[openings[i][0]].value + h[openings[i][1]].value,
  )
  const turn = starter ?? open.indexOf(Math.max(...open))
  return {
    hands,
    stock,
    waste: [stock.pop()!],
    held: null,
    turn,
    closer: null,
    finished: false,
    totals: [...totals],
  }
}
export function observe(s: Round, count = false): View {
  const boards = s.hands.map((hand) =>
    hand.map((card) => (card === null ? GONE : card.up ? card.value : null)),
  )
  const v: View = {
    boards,
    totals: [...s.totals],
    turn: s.turn,
    closer: s.closer,
    discard: s.waste[s.waste.length - 1],
    held: s.held,
  }
  if (count) {
    const counts = [...frequencies]
    for (const board of boards)
      for (const x of board) if (x !== null && x !== GONE) counts[x + 2]--
    for (const x of s.waste) counts[x + 2]--
    if (s.held !== null) counts[s.held + 2]--
    v.counts = counts
  }
  return v
}
export function legal(v: View): Action[] {
  const moves: Action[] = v.held === null ? [{ kind: 'draw' }] : []
  v.boards[v.turn].forEach((card, slot) => {
    if (card === GONE) return
    moves.push({ kind: v.held === null ? 'take' : 'swap', slot })
    if (v.held !== null && card === null) moves.push({ kind: 'flip', slot })
  })
  return moves
}
export function threeMatch(
  a: number | null | undefined,
  b: number | null | undefined,
  c: number | null | undefined,
) {
  return a != null && a !== GONE && a === b && b === c
}
export function clearColumns(s: Round, seat: number) {
  const hand = s.hands[seat]
  for (let i = 0; i < 12; i += 3) {
    const first = hand[i]
    if (
      first?.up &&
      hand[i + 1]?.up &&
      hand[i + 2]?.up &&
      threeMatch(first.value, hand[i + 1]!.value, hand[i + 2]!.value)
    ) {
      s.waste.push(first.value, first.value, first.value)
      hand.splice(i, 3, null, null, null)
    }
  }
}
export function move(s: Round, a: Action, rng: Random) {
  if (s.finished) throw Error('Round is over')
  if (a.kind === 'draw') {
    if (s.held !== null) throw Error('Already holding a card')
    if (!s.stock.length) {
      const top = s.waste.pop()!
      s.stock = shuffle(s.waste, rng)
      s.waste = [top]
    }
    if (!s.stock.length) throw Error('No recyclable stock')
    s.held = s.stock.pop()!
    return
  }
  if (a.kind !== 'take' && a.kind !== 'swap' && a.kind !== 'flip')
    throw Error('Unknown action')
  const hand = s.hands[s.turn]
  const target = hand[a.slot]
  if (!target || !Number.isInteger(a.slot)) throw Error('Invalid target')
  if ((a.kind === 'take') !== (s.held === null))
    throw Error('Wrong action phase')
  if (a.kind === 'flip') {
    if (target.up) throw Error('Can only flip a hidden card')
    s.waste.push(s.held!)
    target.up = true
  } else {
    const incoming = a.kind === 'take' ? s.waste.pop()! : s.held!
    s.waste.push(target.value)
    hand[a.slot] = { value: incoming, up: true }
  }
  s.held = null
  clearColumns(s, s.turn)
  if (s.closer === null && hand.every((c) => c === null || c.up))
    s.closer = s.turn
  s.turn = (s.turn + 1) % s.hands.length
  if (s.turn === s.closer) {
    for (let seat = 0; seat < s.hands.length; seat++) {
      for (const c of s.hands[seat]) if (c) c.up = true
      clearColumns(s, seat)
    }
    s.finished = true
  }
}
export function score(s: Round): number[] {
  if (!s.finished || s.closer === null) throw Error('Round still active')
  const raw = s.hands.map((h) => h.reduce((sum, c) => sum + (c?.value ?? 0), 0))
  const n = s.closer
  if (raw[n] > 0 && raw.some((v, i) => i !== n && v <= raw[n])) raw[n] *= 2
  return raw
}
export type Log = { round: number; seat: number; action: Action }
export function play(
  policies: Policy[],
  seed: number,
  onMove?: (v: View, action: Action, round: number) => void,
  onRound?: (openings: number[][]) => void,
) {
  const totals = policies.map(() => 0)
  const policyRng = policies.map((_, i) =>
    random(seed ^ Math.imul(i + 1, 0x45d9f3b)),
  )
  let starter: number | null = null
  let rounds = 0,
    moves = 0
  while (Math.max(...totals) < 100) {
    const rng = random(seed ^ Math.imul(++rounds, 0x9e3779b1))
    const openings = policies.map(
      (p, i) =>
        p.opening?.(random(seed ^ Math.imul(rounds, 0xc2b2ae35) ^ i)) ?? [0, 3],
    )
    onRound?.(openings.map((pair) => [...pair]))
    const s = deal(totals, rng, starter, openings)
    while (!s.finished) {
      const p = policies[s.turn]
      const v = observe(s, Boolean(onMove || p.count))
      // The recording observer can count; each policy gets only its advertised information.
      const pv = onMove && !p.count ? { ...v, counts: undefined } : v
      const a = p.choose(pv, policyRng[s.turn])
      onMove?.(v, a, rounds)
      move(s, a, rng)
      if (++moves > 100000)
        throw Error(
          'Non-terminating lineup at seed ' +
            seed +
            ' round ' +
            rounds +
            ' [' +
            policies.map((p) => p.name).join(', ') +
            ']',
        )
    }
    score(s).forEach((x, i) => (totals[i] += x))
    starter = s.closer
  }
  const low = Math.min(...totals)
  return {
    totals,
    rounds,
    moves,
    winners: totals.flatMap((x, i) => (x === low ? [i] : [])),
  }
}
/** Draw a fresh hidden world compatible with exactly the counter's observations.
 * Cards buried in the discard have no relevant order when recycled. */
export function sampleRound(v: View, rng: Random): Round {
  if (!v.counts) throw Error('A public count is required')
  const unknown = shuffle(
    v.counts.flatMap((n, i) => Array<number>(n).fill(i - 2)),
    rng,
  )
  const wasteCounts = frequencies.map((n, i) => n - v.counts![i])
  const hands = v.boards.map((b) =>
    b.map((x) => {
      if (x === GONE) return null
      if (x === null) return { value: unknown.pop()!, up: false }
      wasteCounts[x + 2]--
      return { value: x, up: true }
    }),
  )
  if (v.held !== null) wasteCounts[v.held + 2]--
  wasteCounts[v.discard + 2]--
  const waste = wasteCounts.flatMap((n, i) => Array<number>(n).fill(i - 2))
  waste.push(v.discard)
  return {
    hands,
    stock: unknown,
    waste,
    held: v.held,
    turn: v.turn,
    closer: v.closer,
    finished: false,
    totals: [...v.totals],
  }
}
