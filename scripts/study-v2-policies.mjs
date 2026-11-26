// Independent league opponents used only in the phase-two evaluation.
import { GONE } from '../src/engine.ts'
import { threshold } from '../src/policies.ts'

const mean = 760 / 150
const keep3 = threshold(3)
const kind = v => v.held === null ? 'take' : 'swap'
const passing = (v, hidden) => v.held === null ? {kind:'draw'} : {kind:'flip',slot:hidden}

function partners(board, i) {
  const start = i - i % 3
  return [board[start + (i+1)%3], board[start + (i+2)%3]]
}
function clearSlot(board, value) {
  return board.findIndex((card,i) => card !== GONE && card !== value && partners(board,i).every(x => x === value))
}
function largest(board, accept) {
  let best = -1
  for (let i = 0; i < board.length; i++) {
    const x = board[i]
    if (x !== null && x !== GONE && accept(x,i) && (best < 0 || x > board[best])) best = i
  }
  return best
}
function estimate(board) {
  return board.reduce((sum,x) => sum + (x === null ? mean : x === GONE ? 0 : x), 0)
}
export function leaguePolicy(name) {
  if (!['study-finisher','study-chaser','study-gap','study-denial','study-patient'].includes(name)) return undefined
  return { name, choose(v) {
    const b = v.boards[v.turn], x = v.held ?? v.discard, hidden = b.indexOf(null)
    const place = slot => ({kind:kind(v), slot})
    const clear = clearSlot(b,x)
    const minimumClear = { 'study-finisher':-2, 'study-chaser':-2, 'study-gap':1, 'study-denial':1, 'study-patient':0 }[name]
    if (clear >= 0 && x >= minimumClear) return place(clear)
    if (name === 'study-finisher') return x <= 7 ? place(hidden) : passing(v,hidden)
    if (name === 'study-chaser') {
      if (x >= 3) {
        const hiddenMate = b.findIndex((y,i)=>y===null && partners(b,i).includes(x))
        if (hiddenMate >= 0) return place(hiddenMate)
        const visibleMate = largest(b,(y,i)=>y>x && partners(b,i).includes(x))
        if (visibleMate >= 0) return place(visibleMate)
      }
      if (x <= 2) {
        const high = largest(b,y=>y>=5)
        return place(high >= 0 ? high : hidden)
      }
      return passing(v,hidden)
    }
    if (name === 'study-patient') {
      const target = keep3.choose(v)
      const last = b.filter(y=>y===null).length === 1 && v.closer === null
      if (last && target.kind !== 'draw' && target.slot===hidden) {
        const rival = Math.min(...v.boards.filter((_,i)=>i!==v.turn).map(estimate))
        const finishEstimate = estimate(b) + (target.kind === 'flip' ? 0 : x-mean)
        const safer = largest(b, y=>y>x)
        if (finishEstimate > 0 && finishEstimate >= rival && safer >= 0) return place(safer)
      }
      return target
    }
    const next = v.boards[(v.turn+1)%v.boards.length]
    const safe = y => name !== 'study-denial' || y <= 0 || clearSlot(next,y) < 0
    const upgrade = largest(b, y=>y-x>=5 && safe(y))
    if (upgrade>=0) return place(upgrade)
    if (x<=2) return place(hidden)
    return passing(v,hidden)
  } }
}
