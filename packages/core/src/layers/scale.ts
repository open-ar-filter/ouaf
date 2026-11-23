/**
 * `scale` of the anchored layers (spec §6.2): a size multiplier, a number or `[x, y, z]`, bindable and settable by a
 * script. Shared by `text`, `sticker` (and so `canvas`) and `model`, which apply it on top of their own size, in the
 * layer's axes: anchor · T(offset) · R(rotation) · S(size × scale).
 */
import { compileBinding, compileNumberBinding } from '../bindings/index.ts'
import type { LayerContext } from '../engine/layer-type.ts'

/** A compiled `scale`; `write` gives the three factors, false when one is ≤ 0 (the instance is then not shown). */
export interface ScaleBinding {
  write(face: number, out: Float64Array, index: number): boolean
}

/** Compiles the `scale` value of a layer (`1` when absent); `path` locates it in error messages. */
export function compileScale(value: unknown, path: string, ctx: LayerContext): ScaleBinding {
  const env = ctx.bindings
  // Number bindings (`{ bind }` without `map`, number params) go through `write`, which never allocates. Not in a
  // scripted filter: a script may set a vector on a property declared as a number, so the value is read whole.
  const isNumber =
    !env.overrides &&
    (typeof value === 'number' ||
      (typeof value === 'object' && value !== null && !Array.isArray(value) &&
        (('bind' in value && !('map' in value)) || ('param' in value && env.params.type(String((value as { param: unknown }).param)) === 'number'))))
  if (isNumber) {
    const n = compileNumberBinding(value, { fallback: 1, path, name: 'scale' }, env)
    return {
      write(face, out, index) {
        n.write(face, out, index)
        const s = out[index]!
        out[index + 1] = s
        out[index + 2] = s
        return s > 0
      },
    }
  }
  const b = compileBinding(value, { type: ['number', 'vec3'], fallback: 1, path, name: 'scale' }, env)
  return {
    write(face, out, index) {
      const v = b.evaluate(face)
      if (typeof v === 'number') {
        out[index] = v
        out[index + 1] = v
        out[index + 2] = v
      } else {
        out[index] = v[0]
        out[index + 1] = v[1]
        out[index + 2] = v[2]
      }
      return out[index]! > 0 && out[index + 1]! > 0 && out[index + 2]! > 0
    },
  }
}
