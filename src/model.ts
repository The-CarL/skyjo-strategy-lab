import type { Policy, View } from './engine.ts'
import { candidates, featureNames } from './policies.ts'
export interface Tree {
  type: 'tree'
  childrenLeft: number[]
  childrenRight: number[]
  feature: number[]
  threshold: number[]
  value: number[]
}
export interface Net {
  type: 'mlp'
  mean: number[]
  scale: number[]
  weights: number[][][]
  biases: number[][]
}
export interface Bundle {
  version: number
  features: string[]
  tree: Tree
  mlp: Net
}
export function predict(model: Tree | Net, x: number[]): number {
  if (model.type === 'tree') {
    let i = 0
    while (model.childrenLeft[i] !== -1)
      i =
        x[model.feature[i]] <= model.threshold[i]
          ? model.childrenLeft[i]
          : model.childrenRight[i]
    return model.value[i]
  }
  let layer = x.map((t, i) => (t - model.mean[i]) / model.scale[i])
  model.weights.forEach((w, k) => {
    const next = [...model.biases[k]]
    for (let i = 0; i < layer.length; i++)
      for (let j = 0; j < next.length; j++) next[j] += layer[i] * w[i][j]
    layer =
      k === model.weights.length - 1 ? next : next.map((y) => Math.max(0, y))
  })
  return layer[0]
}
export function guardedCandidates(v: View) {
  // A learned value estimate can otherwise cycle visible cards forever in a duel.
  // Every exchange either reveals a slot, clears a column, or lowers a visible value.
  return candidates(v).filter((c) => {
    if (c.a.kind === 'draw' || c.a.kind === 'flip') return true
    const target = v.boards[v.turn][c.a.slot]
    return target === null || (v.held ?? v.discard) < target || c.f[8] === 2
  })
}
export const guardedPrior: Policy = {
  name: 'guarded-prior',
  choose(v) {
    return guardedCandidates(v).sort((a, b) => b.value - a.value)[0].a
  },
}

export function learned(bundle: Bundle, key: 'tree' | 'mlp'): Policy {
  if (
    bundle.version !== 1 ||
    bundle.features.join('|') !== featureNames.join('|')
  )
    throw Error('Model schema mismatch')
  return {
    name: key,
    choose(v) {
      const choices = guardedCandidates(v)
      for (const c of choices) c.value = predict(bundle[key], c.f)
      return choices.sort((a, b) => b.value - a.value)[0].a
    },
  }
}
