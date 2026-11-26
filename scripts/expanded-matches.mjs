import { play } from '../src/engine.ts'
import { policy } from './common.mjs'

const cache = new Map()
export function get(name) {
  if (!cache.has(name)) cache.set(name, policy(name))
  return cache.get(name)
}
export function block(focal, seed, seats, pool, i) {
  const rivals = Array.from({ length: seats - 1 }, (_, s) =>
    get(pool[(i + s) % pool.length]),
  )
  const lineup = [focal, ...rivals]
  let credit = 0
  for (let seat = 0; seat < seats; seat++) {
    const rotated = Array.from(
      { length: seats },
      (_, s) => lineup[(s - seat + seats) % seats],
    )
    const winners = play(rotated, seed).winners
    if (winners.includes(seat)) credit += 1 / winners.length
  }
  return credit / seats
}
export function mean(xs) {
  return xs.reduce((s, x) => s + x, 0) / xs.length
}
export function ci(xs) {
  const avg = mean(xs)
  const radius =
    1.96 *
    Math.sqrt(
      xs.reduce((s, x) => s + (x - avg) ** 2, 0) /
        (xs.length * (xs.length - 1)),
    )
  return { mean: avg, ci95: [avg - radius, avg + radius] }
}
