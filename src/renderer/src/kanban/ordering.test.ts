import { describe, expect, it } from 'vitest'
import { byPosition, matchesFilter, planDropPosition, type PositionedItem } from './ordering'

function items(...positions: string[]): PositionedItem[] {
  return positions.map((position, i) => ({ id: `t${i}`, position }))
}

describe('byPosition', () => {
  it('sorts by fractional key with id tie-break', () => {
    const list: PositionedItem[] = [
      { id: 'b', position: 'a2' },
      { id: 'z', position: 'a1' },
      { id: 'a', position: 'a2' }
    ]
    expect([...list].sort(byPosition).map((i) => i.id)).toEqual(['z', 'a', 'b'])
  })
})

describe('matchesFilter', () => {
  it('is a case-insensitive substring match, empty filter matches all', () => {
    expect(matchesFilter('Fix login bug', '')).toBe(true)
    expect(matchesFilter('Fix login bug', '  ')).toBe(true)
    expect(matchesFilter('Fix login bug', 'LOGIN')).toBe(true)
    expect(matchesFilter('Fix login bug', 'logout')).toBe(false)
  })
})

describe('planDropPosition', () => {
  it('appends to an empty column', () => {
    expect(planDropPosition('x', null, [])).toBe('a0')
  })

  it('appends to the end on a column drop', () => {
    const target = items('a0', 'a1')
    const key = planDropPosition('x', null, target)
    expect(key > 'a1').toBe(true)
  })

  it('cross-column drop lands before the over item', () => {
    const target = items('a0', 'a1')
    const key = planDropPosition('x', 't1', target)
    expect(key > 'a0' && key < 'a1').toBe(true)
  })

  it('same-column drag downward lands after the over item', () => {
    const target = items('a0', 'a1', 'a2')
    const key = planDropPosition('t0', 't2', target)
    expect(key > 'a2').toBe(true)
  })

  it('same-column drag upward lands before the over item', () => {
    const target = items('a0', 'a1', 'a2')
    const key = planDropPosition('t2', 't0', target)
    expect(key < 'a0').toBe(true)
  })

  it('same-column adjacent swap produces a key between the right neighbors', () => {
    const target = items('a0', 'a1', 'a2')
    const key = planDropPosition('t0', 't1', target)
    expect(key > 'a1' && key < 'a2').toBe(true)
  })

  it('falls back to end-of-column when neighbor keys are corrupt', () => {
    const target: PositionedItem[] = [
      { id: 't0', position: 'a0' },
      { id: 't1', position: 'a0' }
    ]
    const key = planDropPosition('x', 't1', target)
    expect(key > 'a0').toBe(true)
  })
})
