/** Stable codes of `ParamError`, usable to pick a message or to test for a case. */
export type ParamErrorCode =
  | 'unknown-param' // no parameter of that name in the manifest
  | 'unknown-preset' // no preset of that name in the manifest
  | 'type' // wrong JavaScript type or shape (e.g. a string for a number, [1] for a vec2, NaN)
  | 'range' // number outside [min, max]
  | 'enum' // select value that is not one of the options (or the host has not supplied them yet)
  | 'too-long' // string or text longer than maxLength
  | 'mime' // asset whose MIME type is not in accept
  | 'too-large' // asset larger than maxSize
  | 'content' // asset whose content fails the untrusted-asset checks when it is loaded (format, dimensions, decoding)
  | 'required' // null for an asset parameter that is not optional
  | 'not-host-options' // setOptions on a parameter that is not a select with options { from: "host" }
  | 'invalid-options' // options supplied by the host that are malformed
  | 'invalid-transition' // transition duration that is not a finite number >= 0

/**
 * Error raised when the host sets an invalid parameter value (spec section 9: an engine MUST reject an invalid value
 * with an explicit error, never silently fix it). Nothing is applied when it is thrown.
 */
export class ParamError extends Error {
  override readonly name = 'ParamError'
  readonly code: ParamErrorCode
  /** Parameter concerned, when there is one. */
  readonly param: string | undefined
  /** Preset concerned, when the value comes from a preset. */
  readonly preset: string | undefined

  constructor(code: ParamErrorCode, message: string, details: { param?: string; preset?: string } = {}) {
    super(message)
    this.code = code
    this.param = details.param
    this.preset = details.preset
  }
}
