/**
 * Constant-time byte comparison, ported from `constant_time_eq` in the retired
 * Rust HTTP server. The loop length is the longer input and every byte
 * position is folded into one accumulator, so neither a length mismatch nor a
 * differing first byte short-circuits.
 */

export const constantTimeEqualBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  const length = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < length; index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

const encoder = new TextEncoder()

export const constantTimeEqualStrings = (left: string, right: string): boolean =>
  constantTimeEqualBytes(encoder.encode(left), encoder.encode(right))
