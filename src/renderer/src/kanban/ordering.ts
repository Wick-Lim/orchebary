import { generateKeyBetween } from 'fractional-indexing'

/** Minimal shape the ordering helpers need — BoardTask satisfies it. */
export interface PositionedItem {
  id: string
  position: string
}

/** Column order: fractional key first, id as a stable tie-breaker. */
export function byPosition(a: PositionedItem, b: PositionedItem): number {
  if (a.position < b.position) return -1
  if (a.position > b.position) return 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function matchesFilter(title: string, filter: string): boolean {
  const q = filter.trim().toLowerCase()
  return q === '' || title.toLowerCase().includes(q)
}

/**
 * Fractional key for dropping `activeId` into a column.
 *
 * @param targetItems ordered items currently in the TARGET column (may still
 *   contain the active item when reordering within the same column)
 * @param overId item the pointer released over, or null for an empty-area /
 *   column drop (append to end)
 *
 * Same-column drags follow arrayMove semantics: dragging downward lands after
 * the over item, dragging upward lands before it.
 */
export function planDropPosition(
  activeId: string,
  overId: string | null,
  targetItems: PositionedItem[]
): string {
  const without = targetItems.filter((i) => i.id !== activeId)
  let index = without.length
  if (overId && overId !== activeId) {
    const overIdx = without.findIndex((i) => i.id === overId)
    if (overIdx >= 0) {
      const fromIdx = targetItems.findIndex((i) => i.id === activeId)
      const overOrig = targetItems.findIndex((i) => i.id === overId)
      index = fromIdx >= 0 && fromIdx < overOrig ? overIdx + 1 : overIdx
    }
  }
  const before = index > 0 ? without[index - 1].position : null
  const after = index < without.length ? without[index].position : null
  try {
    return generateKeyBetween(before, after)
  } catch {
    // Corrupt/duplicate neighbor keys — fall back to the end of the column.
    return generateKeyBetween(without.length ? without[without.length - 1].position : null, null)
  }
}
