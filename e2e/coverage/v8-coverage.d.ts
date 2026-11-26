/** The part of `@bcoe/v8-coverage` used here (the package ships no types). */
declare module '@bcoe/v8-coverage' {
  export interface ScriptCov {
    scriptId: string
    url: string
    functions: Array<{
      functionName: string
      isBlockCoverage: boolean
      ranges: Array<{ startOffset: number; endOffset: number; count: number }>
    }>
  }

  /** Adds up the counts of several runs of the same script; `undefined` for an empty list. */
  export function mergeScriptCovs(scriptCovs: readonly ScriptCov[]): ScriptCov | undefined
}
