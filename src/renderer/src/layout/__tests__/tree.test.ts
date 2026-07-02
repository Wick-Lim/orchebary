import { describe, expect, it } from 'vitest'
import {
  clampRatio,
  findLeaf,
  firstLeaf,
  leavesOf,
  makeLeaf,
  removeLeaf,
  splitLeaf,
  withRatio,
  withoutSession,
  type SplitNode
} from '../tree'

describe('splitLeaf', () => {
  it('replaces a root leaf with a split (original as a, new as b)', () => {
    const root = makeLeaf('s1', 'p1')
    const result = splitLeaf(root, 'p1', 'row', 's2', { splitId: 'sp', leafId: 'p2' })
    expect(result).not.toBeNull()
    const split = result!.root as SplitNode
    expect(split).toMatchObject({
      type: 'split',
      id: 'sp',
      dir: 'row',
      ratio: 0.5,
      a: { type: 'leaf', id: 'p1', sessionId: 's1' },
      b: { type: 'leaf', id: 'p2', sessionId: 's2' }
    })
    expect(result!.newLeaf.id).toBe('p2')
  })

  it('splits a nested leaf without mutating untouched branches', () => {
    const base = splitLeaf(makeLeaf('s1', 'p1'), 'p1', 'row', 's2', {
      splitId: 'sp1',
      leafId: 'p2'
    })!
    const result = splitLeaf(base.root, 'p2', 'col', 's3', { splitId: 'sp2', leafId: 'p3' })!
    const root = result.root as SplitNode
    expect(root.a).toBe((base.root as SplitNode).a) // structural sharing
    expect(root.b).toMatchObject({
      type: 'split',
      dir: 'col',
      a: { id: 'p2' },
      b: { id: 'p3', sessionId: 's3' }
    })
    expect(leavesOf(root).map((l) => l.id)).toEqual(['p1', 'p2', 'p3'])
  })

  it('returns null for an unknown pane id', () => {
    expect(splitLeaf(makeLeaf('s1', 'p1'), 'nope', 'row', 's2')).toBeNull()
  })
})

describe('removeLeaf', () => {
  it('collapses the parent split into the sibling', () => {
    const { root } = splitLeaf(makeLeaf('s1', 'p1'), 'p1', 'row', 's2', { leafId: 'p2' })!
    const result = removeLeaf(root, 'p2')!
    expect(result.root).toMatchObject({ type: 'leaf', id: 'p1' })
    expect(result.removed.sessionId).toBe('s2')
  })

  it('collapses a nested split, keeping the rest of the tree intact', () => {
    const step1 = splitLeaf(makeLeaf('s1', 'p1'), 'p1', 'row', 's2', { leafId: 'p2' })!
    const step2 = splitLeaf(step1.root, 'p2', 'col', 's3', { leafId: 'p3' })!
    const result = removeLeaf(step2.root, 'p2')!
    expect(leavesOf(result.root!).map((l) => l.id)).toEqual(['p1', 'p3'])
    expect((result.root as SplitNode).dir).toBe('row')
  })

  it('returns a null root when the last leaf is removed (tab closes)', () => {
    const result = removeLeaf(makeLeaf('s1', 'p1'), 'p1')!
    expect(result.root).toBeNull()
    expect(result.removed.id).toBe('p1')
  })

  it('returns null for an unknown pane id', () => {
    expect(removeLeaf(makeLeaf('s1', 'p1'), 'nope')).toBeNull()
  })
})

describe('withoutSession', () => {
  it('drops every leaf bound to a session and collapses emptied splits', () => {
    const step1 = splitLeaf(makeLeaf('s1', 'p1'), 'p1', 'row', 's2', { leafId: 'p2' })!
    const step2 = splitLeaf(step1.root, 'p1', 'col', 's2', { leafId: 'p3' })!
    const pruned = withoutSession(step2.root, 's2')
    expect(pruned).toMatchObject({ type: 'leaf', id: 'p1', sessionId: 's1' })
  })

  it('returns null when the whole tree used the session', () => {
    expect(withoutSession(makeLeaf('s1', 'p1'), 's1')).toBeNull()
  })

  it('returns the same reference when nothing matches', () => {
    const { root } = splitLeaf(makeLeaf('s1', 'p1'), 'p1', 'row', 's2')!
    expect(withoutSession(root, 'other')).toBe(root)
  })
})

describe('withRatio', () => {
  it('updates the target split and clamps out-of-range values', () => {
    const { root } = splitLeaf(makeLeaf('s1', 'p1'), 'p1', 'row', 's2', { splitId: 'sp' })!
    expect((withRatio(root, 'sp', 0.3) as SplitNode).ratio).toBe(0.3)
    expect((withRatio(root, 'sp', -1) as SplitNode).ratio).toBe(clampRatio(-1))
    expect((withRatio(root, 'sp', 2) as SplitNode).ratio).toBe(clampRatio(2))
  })

  it('returns the same reference when the split id is absent', () => {
    const { root } = splitLeaf(makeLeaf('s1', 'p1'), 'p1', 'row', 's2')!
    expect(withRatio(root, 'missing', 0.7)).toBe(root)
  })
})

describe('lookup helpers', () => {
  it('firstLeaf/findLeaf walk the tree', () => {
    const step1 = splitLeaf(makeLeaf('s1', 'p1'), 'p1', 'row', 's2', { leafId: 'p2' })!
    expect(firstLeaf(step1.root).id).toBe('p1')
    expect(findLeaf(step1.root, 'p2')?.sessionId).toBe('s2')
    expect(findLeaf(step1.root, 'zzz')).toBeNull()
  })
})
