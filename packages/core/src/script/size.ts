/**
 * Rough size in bytes of structured-cloneable `value` (strings count 2 bytes a character); stops counting once over
 * `limit`. The measure of the 64 KB limits on messages between a script and its host (`f.emit`, `send`, spec §12.4):
 * a bounded walk, cheaper than serializing, and the same for both directions.
 */
export function estimateSize(value: unknown, limit: number): number {
  let total = 0
  const seen = new Set<object>()
  const stack: unknown[] = [value]
  while (stack.length > 0 && total <= limit) {
    const v = stack.pop()
    if (v === null || v === undefined || typeof v === 'boolean') total += 1
    else if (typeof v === 'number' || typeof v === 'bigint') total += 8
    else if (typeof v === 'string') total += 2 * v.length
    else if (typeof v === 'object') {
      if (seen.has(v)) continue
      seen.add(v)
      if (ArrayBuffer.isView(v)) total += v.byteLength
      else if (v instanceof ArrayBuffer) total += v.byteLength
      else if (v instanceof Map) for (const [k, x] of v) stack.push(k, x)
      else if (v instanceof Set) for (const x of v) stack.push(x)
      else
        for (const [k, x] of Object.entries(v)) {
          total += 2 * k.length
          stack.push(x)
        }
    }
  }
  return total
}
