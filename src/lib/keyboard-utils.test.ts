import { describe, expect, it } from 'vitest'
import { isImeComposing } from './keyboard-utils'

// Build a minimal stand-in for a React KeyboardEvent. Vitest's jsdom
// environment doesn't fire real composition events, so we synthesize
// the two signals isImeComposing inspects.
function isKeyboardEventDouble(value: unknown): value is React.KeyboardEvent {
  if (typeof value !== 'object' || value === null) return false
  if (!('key' in value) || typeof value.key !== 'string') return false
  if (!('keyCode' in value) || typeof value.keyCode !== 'number') return false
  if (!('nativeEvent' in value)) return false
  const { nativeEvent } = value
  return typeof nativeEvent === 'object' && nativeEvent !== null &&
    'isComposing' in nativeEvent && typeof nativeEvent.isComposing === 'boolean'
}

function ke(opts: {
  isComposing?: boolean
  keyCode?: number
  key?: string
}): React.KeyboardEvent {
  const double = {
    key: opts.key ?? 'Enter',
    keyCode: opts.keyCode ?? 13,
    nativeEvent: { isComposing: opts.isComposing ?? false },
  }
  if (!isKeyboardEventDouble(double)) throw new Error('invalid keyboard event double')
  return double
}

describe('isImeComposing', () => {
  it('is false for a plain Enter press with no IME activity', () => {
    expect(isImeComposing(ke({ key: 'Enter', keyCode: 13 }))).toBe(false)
  })

  it('is true when the W3C `isComposing` flag is set', () => {
    expect(isImeComposing(ke({ isComposing: true, keyCode: 229 }))).toBe(true)
  })

  it('is true when keyCode === 229 even after isComposing has flipped back', () => {
    // The commit-press itself: Chromium reports keyCode 229 but
    // isComposing has already cleared. Without this branch the
    // commit Enter leaks through as a submit.
    expect(isImeComposing(ke({ isComposing: false, keyCode: 229 }))).toBe(true)
  })

  it('is true for non-Enter keys during composition', () => {
    // Defensive: arrow keys, escape, etc. during composition should
    // also be treated as IME-owned by callers that care.
    expect(isImeComposing(ke({ key: 'ArrowDown', isComposing: true, keyCode: 229 }))).toBe(true)
  })

  it('is false for Shift+Enter (no IME)', () => {
    expect(isImeComposing(ke({ key: 'Enter', keyCode: 13 }))).toBe(false)
  })
})
