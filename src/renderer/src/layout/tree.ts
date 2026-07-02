import { nanoid } from 'nanoid'

// Pure pane-tree operations. No DOM, no store, no IPC — unit-testable.

export type SplitDir = 'row' | 'col'

export interface LeafNode {
  type: 'leaf'
  id: string
  sessionId: string
}

export interface SplitNode {
  type: 'split'
  id: string
  dir: SplitDir
  /** Fraction of the split occupied by `a` (clamped to RATIO_MIN..RATIO_MAX). */
  ratio: number
  a: PaneNode
  b: PaneNode
}

export type PaneNode = LeafNode | SplitNode

export const RATIO_MIN = 0.05
export const RATIO_MAX = 0.95

export function clampRatio(ratio: number): number {
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio))
}

export function makeLeaf(sessionId: string, id: string = nanoid()): LeafNode {
  return { type: 'leaf', id, sessionId }
}

export function leavesOf(root: PaneNode): LeafNode[] {
  if (root.type === 'leaf') return [root]
  return [...leavesOf(root.a), ...leavesOf(root.b)]
}

export function firstLeaf(root: PaneNode): LeafNode {
  return root.type === 'leaf' ? root : firstLeaf(root.a)
}

export function findLeaf(root: PaneNode, paneId: string): LeafNode | null {
  if (root.type === 'leaf') return root.id === paneId ? root : null
  return findLeaf(root.a, paneId) ?? findLeaf(root.b, paneId)
}

/**
 * Replace the target leaf with a split whose `a` is the original leaf and `b`
 * is a fresh leaf bound to `newSessionId`. Returns null when paneId is absent.
 */
export function splitLeaf(
  root: PaneNode,
  paneId: string,
  dir: SplitDir,
  newSessionId: string,
  ids?: { splitId?: string; leafId?: string }
): { root: PaneNode; newLeaf: LeafNode } | null {
  if (root.type === 'leaf') {
    if (root.id !== paneId) return null
    const newLeaf = makeLeaf(newSessionId, ids?.leafId)
    const split: SplitNode = {
      type: 'split',
      id: ids?.splitId ?? nanoid(),
      dir,
      ratio: 0.5,
      a: root,
      b: newLeaf
    }
    return { root: split, newLeaf }
  }
  const inA = splitLeaf(root.a, paneId, dir, newSessionId, ids)
  if (inA) return { root: { ...root, a: inA.root }, newLeaf: inA.newLeaf }
  const inB = splitLeaf(root.b, paneId, dir, newSessionId, ids)
  if (inB) return { root: { ...root, b: inB.root }, newLeaf: inB.newLeaf }
  return null
}

/**
 * Remove a leaf; its parent split collapses into the sibling subtree. Returns
 * `{ root: null }` when the removed leaf was the root (i.e. the tab is empty),
 * or null when paneId is absent.
 */
export function removeLeaf(
  root: PaneNode,
  paneId: string
): { root: PaneNode | null; removed: LeafNode } | null {
  if (root.type === 'leaf') {
    return root.id === paneId ? { root: null, removed: root } : null
  }
  const inA = removeLeaf(root.a, paneId)
  if (inA) {
    return { root: inA.root === null ? root.b : { ...root, a: inA.root }, removed: inA.removed }
  }
  const inB = removeLeaf(root.b, paneId)
  if (inB) {
    return { root: inB.root === null ? root.a : { ...root, b: inB.root }, removed: inB.removed }
  }
  return null
}

/** Drop every leaf bound to `sessionId`, collapsing emptied splits. */
export function withoutSession(root: PaneNode, sessionId: string): PaneNode | null {
  if (root.type === 'leaf') return root.sessionId === sessionId ? null : root
  const a = withoutSession(root.a, sessionId)
  const b = withoutSession(root.b, sessionId)
  if (a && b) return a === root.a && b === root.b ? root : { ...root, a, b }
  return a ?? b
}

export function withRatio(root: PaneNode, splitId: string, ratio: number): PaneNode {
  if (root.type === 'leaf') return root
  if (root.id === splitId) return { ...root, ratio: clampRatio(ratio) }
  const a = withRatio(root.a, splitId, ratio)
  const b = withRatio(root.b, splitId, ratio)
  if (a === root.a && b === root.b) return root
  return { ...root, a, b }
}
