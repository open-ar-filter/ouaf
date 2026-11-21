/** The `window.__spike83` hook of `/spikes/runtime.html` (spike #83), shared by its browser tests. */

export interface Roi {
  cx: number
  cy: number
  size: number
  rotation: number
}

export interface Analysis {
  detectorRoi: Roi | undefined
  found: boolean
  landmarks: number[]
}

export interface Spike83 {
  runtime: string | null
  threads: number
  frames: number
  runs: number
  mode: 'main' | 'worker'
  warnings: string[]
  worker: { crossOriginIsolated: boolean; options: { threads: number; crop: string; detectorCrop: string }; pthreads: number } | undefined
  bench(runs: number, atSeconds?: number): Promise<{ landmarksMs: number; found: number; runs: number }>
  analyse(atSeconds: number): Promise<Analysis>
}

declare global {
  interface Window {
    __spike83?: Spike83
  }
}
