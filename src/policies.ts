import {
  GONE,
  legal,
  move,
  observe,
  random,
  sampleRound,
  score,
} from './engine.ts'
import type { Action, Board, Policy, Random, Round, View } from './engine.ts'

const hiddenCount = (b: Board) => b.filter((x) => x === null).length
const cardTotal = (b: Board, mean: number) =>
  b.reduce<number>((n, x) => n + (x === null ? mean : x === GONE ? 0 : x), 0)
export const incoming = (v: View) => v.held ?? v.discard
const meanCard = 760 / 150
function neighbors(board: Board, slot: number) {
  const start = slot - (slot % 3)
  return [0, 1, 2]
    .map((i) => start + i)
    .filter((i) => i !== slot)
    .map((i) => board[i])
}
function otherPair(board: Board, slot: number, value: number) {
  const start = slot - (slot % 3)
  return (
    board[start + ((slot + 1) % 3)] === value &&
    board[start + ((slot + 2) % 3)] === value
  )
}
export const same = (a: Action, b: Action) =>
  a.kind === b.kind &&
  (a.kind === 'draw' || (b.kind !== 'draw' && a.slot === b.slot))
/** Small, explicitly ordered family rules. Slot order breaks otherwise equal choices. */
export function threshold(limit = 5, clear = false, protect = false): Policy {
  return {
    name:
      'threshold-' +
      limit +
      (clear ? '+clear' : '') +
      (protect ? '+pairs' : ''),
    choose(v) {
      const b = v.boards[v.turn],
        x = incoming(v),
        kind = v.held === null ? 'take' : 'swap'
      let high = -1,
        hidden = -1
      for (let i = 0; i < b.length; i++) {
        const t = b[i]
        if (t === GONE) continue
        if (clear && t !== x && otherPair(b, i, x)) return { kind, slot: i }
        if (t === null) {
          if (hidden < 0) hidden = i
          continue
        }
        if (protect && neighbors(b, i).includes(t)) continue
        if (t >= limit + 1 && (high < 0 || t > b[high]!)) high = i
      }
      if (x <= limit && high >= 0) return { kind, slot: high }
      if (x <= limit && hidden >= 0) return { kind, slot: hidden }
      if (v.held === null) return { kind: 'draw' }
      if (hidden >= 0) return { kind: 'flip', slot: hidden }
      // A player still taking turns always has a hidden card in a legal round.
      return { kind: 'swap', slot: b.findIndex((t) => t !== GONE) }
    },
  }
}
export const blind: Policy = {
  name: 'random',
  choose(v, rng) {
    if (v.held === null && rng() < 0.5) return { kind: 'draw' }
    const options = legal(v).filter((a) => a.kind !== 'draw')
    return options[Math.floor(rng() * options.length)]
  },
}
export const featureNames = [
  'draw',
  'flip',
  'incoming',
  'target',
  'hiddenTarget',
  'hiddenLeft',
  'ownEstimate',
  'highest',
  'columnMatches',
  'pairBroken',
  'clearValue',
  'gain',
  'revealsLast',
  'mateUnknown',
  'mateSum',
  'pairValue',
  'bestVisibleGain',
  'boardSize',
]
export function features(v: View, a: Action): number[] {
  const b = v.boards[v.turn],
    x = incoming(v)
  const highest = Math.max(
    -2,
    ...b.filter((t): t is number => t !== null && t !== GONE),
  )
  const hidden = hiddenCount(b)
  const t = a.kind === 'draw' ? undefined : b[a.slot]
  const mates = a.kind === 'draw' ? [] : neighbors(b, a.slot)
  const exchange = a.kind === 'take' || a.kind === 'swap'
  const matches = exchange ? mates.filter((m) => m === x).length : 0
  const broken =
    exchange && t !== null && t !== undefined && t !== x && mates.includes(t)
  const cleared = matches === 2 ? 3 * x : 0
  const gain = exchange ? (t ?? meanCard) - x + cleared : 0
  return [
    +(a.kind === 'draw'),
    +(a.kind === 'flip'),
    x,
    t ?? meanCard,
    +(t === null),
    hidden,
    cardTotal(b, meanCard),
    highest,
    matches,
    +broken,
    cleared,
    gain,
    +(t === null && hidden === 1),
    mates.filter((m) => m === null).length,
    mates.reduce<number>((s, m) => s + (m ?? meanCard), 0),
    broken ? t! : 0,
    highest - x,
    b.filter((m) => m !== GONE).length,
  ]
}
export function prior(f: number[]) {
  if (f[0]) return Math.max(1.5, f[7] - 4.3)
  if (f[1]) return 1.15
  return (
    f[11] +
    0.9 * f[4] +
    (f[8] === 1 ? Math.max(0, f[2]) * 0.32 : 0) -
    f[9] * Math.max(0, f[15]) * 0.4
  )
}
export interface Candidate {
  a: Action
  f: number[]
  value: number
}
/** Limit expensive searches to the same observable shortlist at training and inference. */
export function candidates(v: View, width = 4): Candidate[] {
  const unique = new Map<string, Candidate>()
  for (const a of legal(v)) {
    // An identical face-up exchange leaves the public game position unchanged.
    if (a.kind === 'take' && v.boards[v.turn][a.slot] === v.discard) continue
    const f = features(v, a)
    const key = f.join(',')
    if (!unique.has(key)) unique.set(key, { a, f, value: prior(f) })
  }
  const ranked = [...unique.values()].sort((a, b) => b.value - a.value)
  const alt = ranked.find(
    (c) => c.a.kind === (v.held === null ? 'draw' : 'flip'),
  )
  const chosen = ranked.slice(0, width)
  if (alt && !chosen.includes(alt)) chosen[chosen.length - 1] = alt
  return chosen
}
export function positional(name: 'board' | 'table' | 'counter'): Policy {
  return {
    name,
    count: name === 'counter',
    choose(v) {
      const n = v.counts,
        total = n?.reduce((s, k) => s + k, 0) ?? 0
      const mean =
        n && total
          ? n.reduce((s, k, i) => s + (i - 2) * k, 0) / total
          : meanCard
      const own = v.boards[v.turn]
      const others = v.boards.filter((_, i) => i !== v.turn)
      const rival = Math.min(...others.map((b) => cardTotal(b, mean)))
      const ranked = candidates(v)
      for (const c of ranked) {
        const f = c.f
        if (f[0]) c.value += meanCard - mean
        else if (f[4]) {
          if (!f[1]) c.value += mean - meanCard
          if (
            name !== 'board' &&
            f[12] &&
            v.closer === null &&
            cardTotal(own, mean) - c.value >= rival
          )
            c.value -= Math.max(1, cardTotal(own, mean) * 0.4)
        }
        if (f[8] === 1 && total && n)
          c.value += 3 * f[2] * (n[f[2] + 2] / total)
      }
      return ranked.sort((a, b) => b.value - a.value)[0].a
    },
  }
}
const continuation = threshold(5, true, true)
function finish(s: Round, rng: Random, seat: number) {
  let steps = 0
  while (!s.finished) {
    const a = continuation.choose(observe(s), rng)
    move(s, a, rng)
    if (++steps > 2000) throw Error('Rollout exceeded round limit')
  }
  const scores = score(s)
  const totals = s.totals.map((t, i) => t + scores[i])
  const margin = Math.min(...totals.filter((_, i) => i !== seat)) - totals[seat]
  if (Math.max(...totals) >= 100) {
    const winners = totals.filter((x) => x === Math.min(...totals)).length
    return (
      (margin >= 0 ? 40 / winners : -40) +
      Math.max(-40, Math.min(40, margin)) * 0.25
    )
  }
  return margin
}
/** Common random worlds and continuation streams for all alternatives in one decision. */
export function evaluate(v: View, rng: Random, samples: number) {
  const choices = candidates(v)
  const values = choices.map(() => 0)
  for (let i = 0; i < samples; i++) {
    const worldSeed = Math.floor(rng() * 4294967296),
      turnSeed = Math.floor(rng() * 4294967296)
    for (let j = 0; j < choices.length; j++) {
      const s = sampleRound(v, random(worldSeed)),
        stream = random(turnSeed)
      move(s, choices[j].a, stream)
      values[j] += finish(s, stream, v.turn) / samples
    }
  }
  return choices.map((c, i) => ({ ...c, value: values[i] }))
}
export function rollout(samples = 4): Policy {
  return {
    name: 'rollout-' + samples,
    count: true,
    choose(v, rng) {
      return evaluate(v, rng, samples).sort((a, b) => b.value - a.value)[0].a
    },
  }
}
export function builtIn(name: string): Policy {
  if (name === 'random') return blind
  if (name === 'board' || name === 'table' || name === 'counter')
    return positional(name)
  const r = /^rollout-([1-9][0-9]*)$/.exec(name)
  if (r) return rollout(Number(r[1]))
  const m = /^threshold-(\d+)(\+clear)?(\+pairs)?$/.exec(name)
  if (m && Number(m[1]) <= 12) return threshold(+m[1], !!m[2], !!m[3])
  throw Error('Unknown policy: ' + name)
}
