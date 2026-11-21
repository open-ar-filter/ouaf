/**
 * Expression events (spec §13): blink, wink, mouthOpen/mouthClose, smile/smileEnd, eyebrowRaise, kiss, nod, shake,
 * and faceEnter/faceLeave, detected per face from expression signals (`signals.ts`), whatever their source.
 *
 * - Each event fires **once** at the start of a gesture: a value must cross the threshold, stay above the release
 *   level (threshold minus a hysteresis) for `minDurationMs`, then fall below the release level before the event can
 *   fire again. Noise around the threshold therefore produces no bursts.
 * - Paired end events (`mouthClose`, `smileEnd`) use the same hysteresis the other way round, with their own
 *   `minDurationMs` (`events.mouthClose.minDurationMs`).
 * - nod / shake: a head movement out and back (≥ the amplitude, both ways) on one axis within a second, the other axis
 *   staying comparatively still; continued nodding or shaking is the same gesture.
 * - faceEnter / faceLeave follow the stable face ids given to `update` (spec §5.4); id matching is the tracker's job.
 * - Optional calibration against the neutral face: a per-face baseline of each signal (its lower envelope), removed
 *   before the thresholds are applied.
 *
 * Nothing is allocated per frame: per-face state is preallocated for `maxFaces`, and events are written into a
 * preallocated buffer that `update` returns (valid until the next call).
 */
import type { TManifest } from '@ouaf/spec'
import { EXPRESSION_SIGNAL_COUNT, SIGNAL, SIGNALS_STRIDE } from './signals.ts'

/** Events produced by the detector, in the order of spec §13. */
export const EXPRESSION_EVENTS = [
  'faceEnter',
  'faceLeave',
  'blink',
  'wink',
  'mouthOpen',
  'mouthClose',
  'smile',
  'smileEnd',
  'eyebrowRaise',
  'kiss',
  'nod',
  'shake',
] as const

export type ExpressionEventName = (typeof EXPRESSION_EVENTS)[number]

/** Manifest `events` section: `{ "<event>": { "threshold"?: 0–1, "minDurationMs"?: ms } }`. */
export type EventTuning = NonNullable<TManifest['events']>

/**
 * Default thresholds, from spec §13 (also in the `@ouaf/spec` registry). For nod / shake the 0–1 value scales the
 * head movement: 1 = `NOD_FULL_SCALE_RAD` each way.
 */
export const DEFAULT_EVENT_THRESHOLDS = {
  blink: 0.5,
  wink: 0.5,
  mouthOpen: 0.35,
  smile: 0.5,
  eyebrowRaise: 0.5,
  kiss: 0.6,
  nod: 0.5,
  shake: 0.5,
} as const satisfies Partial<Record<ExpressionEventName, number>>

/**
 * Default `minDurationMs` (implementation choice, spec Appendix C: to be confirmed by measurements). A blink lasts
 * 100–150 ms, i.e. 2 frames at 15 Hz, so it fires on the first frame; a wink must last longer than the lag between
 * the two eyelids at the start of a blink. For nod / shake it is the minimum duration of the out-and-back movement,
 * which rejects one-frame tracking glitches.
 */
export const DEFAULT_EVENT_MIN_DURATION_MS: Readonly<Record<Exclude<ExpressionEventName, 'faceEnter' | 'faceLeave'>, number>> = {
  blink: 0,
  wink: 100,
  mouthOpen: 50,
  mouthClose: 50,
  smile: 100,
  smileEnd: 100,
  eyebrowRaise: 100,
  kiss: 100,
  nod: 200,
  shake: 200,
}

/** Release level = threshold − `HYSTERESIS` (at most half the threshold). */
export const HYSTERESIS = 0.1
/** A wink needs the open eye at least this much below the closed one (at most the threshold). */
export const WINK_MIN_GAP = 0.4
/**
 * Winks are not detected beyond this head yaw (rad, 30°): in a three-quarter view the far eye looks more closed than
 * the near one (measured on the test clips: 0.5–0.6 against 0.1–0.3 with both eyes open).
 */
export const WINK_MAX_YAW = Math.PI / 6
/** Head movement (rad, each way) for a nod / shake threshold of 1: 20°, so the default 0.5 is 10°. */
export const NOD_FULL_SCALE_RAD = (20 * Math.PI) / 180
/** The out-and-back movement of a nod / shake must fit in this window (ms). */
export const NOD_WINDOW_MS = 1000
/** The other axis must move less than this fraction of the gesture amplitude. */
export const NOD_DOMINANCE = 0.6
/** After a nod / shake, the next one needs this much time (ms) without the pattern. */
export const NOD_REARM_MS = 400
/** A gap longer than this (ms) between two results of the same face restarts the nod / shake analysis. */
export const MAX_FRAME_GAP_MS = 300

/** Calibration: the neutral baseline never exceeds this value. */
export const BASELINE_MAX = 0.4
/** Calibration: the baseline rises only towards values less than this above it (not during gestures). */
const BASELINE_RISE_BAND = 0.2
const BASELINE_RISE_TAU_MS = 4000
const BASELINE_FALL_TAU_MS = 300

/** Samples kept for nod / shake (covers `NOD_WINDOW_MS` up to 64 Hz). */
const HEAD_SAMPLES = 64

export type EventSide = 'left' | 'right'

/** One detected event. Instances are reused: copy what you keep. */
export interface ExpressionEvent {
  name: ExpressionEventName
  /** Stable id of the face (spec §5.4). */
  faceId: number
  /** `wink` only: the person's side of the closed eye. */
  side: EventSide | null
  /** Time of the frame that triggered the event (same clock as `update`, ms). */
  timeMs: number
}

/** Events of one `update`: `items[0 … count)`. */
export interface ExpressionEventBuffer {
  count: number
  readonly items: readonly ExpressionEvent[]
}

export interface ExpressionEventDetectorOptions {
  /** Faces tracked at most (the tracker's `maxFaces`). */
  maxFaces: number
  /** Tuning from the manifest's `events` section. */
  events?: EventTuning
  /** Calibrate against each person's neutral face (default false). */
  calibrate?: boolean
}

// Implementation note: the per-frame path reads every double it needs (frame time, signal values, thresholds) from
// typed arrays instead of passing it as a call argument. V8 boxes a double argument into a heap number whenever it
// does not inline the callee, which would allocate on every frame.

/** Thresholded gestures ("channels"): one hysteresis state machine each, per face. */
const BLINK = 0
const WINK_LEFT = 1
const WINK_RIGHT = 2
const MOUTH = 3
const SMILE = 4
const BROW = 5
const KISS = 6
const CHANNELS = 7
const START_EVENT: readonly ExpressionEventName[] = ['blink', 'wink', 'wink', 'mouthOpen', 'smile', 'eyebrowRaise', 'kiss']
const END_EVENT: readonly (ExpressionEventName | null)[] = [null, null, null, 'mouthClose', 'smileEnd', null, null]
const SIDE: readonly (EventSide | null)[] = [null, 'left', 'right', null, null, null, null]

/** Hysteresis states. */
const IDLE = 0
const PENDING_ON = 1
const ACTIVE = 2
const PENDING_OFF = 3

/** Head axes, also the bits returned by `HeadGestures.step`. */
const NOD = 0
const SHAKE = 1

/** Recent head pose of one face, for nod (pitch) and shake (yaw). */
class HeadGestures {
  /** `[0]`: time of the current frame (ms), shared with the detector. */
  readonly #clock: Float64Array
  /** Per axis: amplitude (rad) at `2 * axis`, minimum duration (ms) at `2 * axis + 1`; shared with the detector. */
  readonly #params: Float64Array
  readonly #t = new Float64Array(HEAD_SAMPLES)
  readonly #pitch = new Float32Array(HEAD_SAMPLES)
  readonly #yaw = new Float32Array(HEAD_SAMPLES)
  /** Next sample to write; `#n` samples are valid, the newest at `#head - 1`. */
  #head = 0
  #n = 0
  /** Per axis: time from which the gesture may fire again. */
  readonly #armedAt = new Float64Array([-Infinity, -Infinity])

  constructor(clock: Float64Array, params: Float64Array) {
    this.#clock = clock
    this.#params = params
  }

  reset(): void {
    this.#n = 0
    this.#head = 0
    this.#armedAt.fill(-Infinity)
  }

  /** Adds the pose at `signals[o + SIGNAL.pitch / yaw]` (not NaN); returns a bit set: `1 << NOD`, `1 << SHAKE`. */
  step(signals: Float32Array, o: number): number {
    const t = this.#clock[0]!
    if (this.#n > 0) {
      const last = this.#t[(this.#head + HEAD_SAMPLES - 1) % HEAD_SAMPLES]!
      if (t === last) return 0
      if (t < last) this.reset() // time went backwards (seek, loop)
      else if (t - last > MAX_FRAME_GAP_MS) this.#n = 0
    }
    this.#t[this.#head] = t
    this.#pitch[this.#head] = signals[o + SIGNAL.pitch]!
    this.#yaw[this.#head] = signals[o + SIGNAL.yaw]!
    this.#head = (this.#head + 1) % HEAD_SAMPLES
    if (this.#n < HEAD_SAMPLES) this.#n++
    // Drop the samples older than the window.
    while (this.#n > 1 && t - this.#t[(this.#head + HEAD_SAMPLES - this.#n) % HEAD_SAMPLES]! > NOD_WINDOW_MS) this.#n--

    let fired = 0
    for (let axis = NOD; axis <= SHAKE; axis++) {
      if (!this.#outAndBack(axis)) continue
      if (t >= this.#armedAt[axis]!) fired |= 1 << axis
      this.#armedAt[axis] = t + NOD_REARM_MS // continued nodding or shaking is the same gesture
    }
    return fired
  }

  /**
   * True when the window holds a movement on `axis` away by at least the amplitude and back by at least the amplitude
   * (back at the newest sample), the out-and-back lasting at least the minimum duration, while the other axis moved
   * less than `NOD_DOMINANCE` × the smaller leg.
   */
  #outAndBack(axis: number): boolean {
    const n = this.#n
    if (n < 3) return false
    const a = axis === NOD ? this.#pitch : this.#yaw
    const b = axis === NOD ? this.#yaw : this.#pitch
    const amp = this.#params[2 * axis]!
    const minMs = this.#params[2 * axis + 1]!
    const ts = this.#t
    const first = this.#head + HEAD_SAMPLES - n // sample k is at (first + k) % HEAD_SAMPLES
    const cur = a[(first + n - 1) % HEAD_SAMPLES]!
    // Extremes of the window, newest sample excluded.
    let iMax = 0
    let iMin = 0
    let vMax = a[first % HEAD_SAMPLES]!
    let vMin = vMax
    for (let k = 1; k < n - 1; k++) {
      const v = a[(first + k) % HEAD_SAMPLES]!
      if (v > vMax) {
        vMax = v
        iMax = k
      }
      if (v < vMin) {
        vMin = v
        iMin = k
      }
    }
    for (let s = 1; s >= -1; s -= 2) {
      // s = +1: out to a peak and back down; s = -1: down to a valley and back up.
      const j = s > 0 ? iMax : iMin
      const ext = s > 0 ? vMax : vMin
      if (s * (ext - cur) < amp) continue
      // Start: the latest sample before the extreme at least `amp` away from it.
      let i = j - 1
      while (i >= 0 && s * (ext - a[(first + i) % HEAD_SAMPLES]!) < amp) i--
      if (i < 0) continue
      // End: the first sample after the extreme at least `amp` away from it (the newest one qualifies).
      let k = j + 1
      while (s * (ext - a[(first + k) % HEAD_SAMPLES]!) < amp) k++
      // The duration ends there, not now: a one-frame glitch stays too short however long it stays in the window.
      if (ts[(first + k) % HEAD_SAMPLES]! - ts[(first + i) % HEAD_SAMPLES]! < minMs) continue
      const out = s * (ext - a[(first + i) % HEAD_SAMPLES]!)
      const back = s * (ext - a[(first + k) % HEAD_SAMPLES]!)
      let bMin = Infinity
      let bMax = -Infinity
      for (let m = i; m <= k; m++) {
        const v = b[(first + m) % HEAD_SAMPLES]!
        if (v < bMin) bMin = v
        if (v > bMax) bMax = v
      }
      if (bMax - bMin <= NOD_DOMINANCE * Math.min(out, back)) return true
    }
    return false
  }
}

/** Resolved threshold of `name`: the manifest value, else the default. */
function thresholdOf(events: EventTuning | undefined, name: keyof typeof DEFAULT_EVENT_THRESHOLDS): number {
  const v = events?.[name]?.threshold
  return typeof v === 'number' && v >= 0 && v <= 1 ? v : DEFAULT_EVENT_THRESHOLDS[name]
}

/** Resolved `minDurationMs` of `name`: the manifest value, else the default. */
function minDurationOf(events: EventTuning | undefined, name: keyof typeof DEFAULT_EVENT_MIN_DURATION_MS): number {
  const v = events?.[name]?.minDurationMs
  return typeof v === 'number' && v >= 0 ? v : DEFAULT_EVENT_MIN_DURATION_MS[name]
}

/** Detects the expression events of every tracked face. */
export class ExpressionEventDetector {
  readonly maxFaces: number
  /** Calibrate against each person's neutral face (can be switched at any time). */
  calibrate: boolean
  /** `[0]`: time of the frame being processed (ms). */
  readonly #clock = new Float64Array(1)
  // Per channel: release and trigger levels, minimum durations (ms) to start and to end.
  readonly #on = new Float64Array(CHANNELS)
  readonly #off = new Float64Array(CHANNELS)
  readonly #minOn = new Float64Array(CHANNELS)
  readonly #minOff = new Float64Array(CHANNELS)
  /** `[0]`: minimum gap between the eyes for a wink. */
  readonly #winkGap = new Float64Array(1)
  /** Nod / shake parameters, see `HeadGestures`. */
  readonly #headParams = new Float64Array(4)
  // Per face slot.
  readonly #used: Uint8Array
  readonly #seen: Uint8Array
  readonly #ids: Float64Array
  readonly #lastT: Float64Array
  readonly #calibrated: Uint8Array
  readonly #baseline: Float32Array
  readonly #heads: HeadGestures[] = []
  // Per face slot and channel.
  readonly #state: Uint8Array
  readonly #since: Float64Array
  /** Slot of each input face this frame (-1: none). */
  readonly #slotOf: Int32Array
  /** Signals of the face being processed (calibrated if enabled), and the channel inputs derived from them. */
  readonly #values = new Float32Array(EXPRESSION_SIGNAL_COUNT)
  readonly #input = new Float32Array(CHANNELS)
  readonly #out: { count: number; items: ExpressionEvent[] }

  constructor(options: ExpressionEventDetectorOptions) {
    const { maxFaces } = options
    if (!Number.isInteger(maxFaces) || maxFaces < 1) throw new RangeError(`maxFaces must be a positive integer, got ${maxFaces}`)
    this.maxFaces = maxFaces
    this.calibrate = options.calibrate ?? false
    this.configure(options.events)
    this.#used = new Uint8Array(maxFaces)
    this.#seen = new Uint8Array(maxFaces)
    this.#ids = new Float64Array(maxFaces)
    this.#lastT = new Float64Array(maxFaces)
    this.#calibrated = new Uint8Array(maxFaces)
    this.#baseline = new Float32Array(maxFaces * EXPRESSION_SIGNAL_COUNT)
    this.#state = new Uint8Array(maxFaces * CHANNELS)
    this.#since = new Float64Array(maxFaces * CHANNELS)
    this.#slotOf = new Int32Array(maxFaces)
    for (let i = 0; i < maxFaces; i++) this.#heads.push(new HeadGestures(this.#clock, this.#headParams))
    // Per frame and per face: enter or leave, plus at most one event per channel, nod and shake.
    const capacity = maxFaces * (2 + CHANNELS + 2)
    const items: ExpressionEvent[] = []
    for (let i = 0; i < capacity; i++) items.push({ name: 'faceEnter', faceId: 0, side: null, timeMs: 0 })
    this.#out = { count: 0, items }
  }

  /** Applies the manifest's `events` tuning (also callable later, e.g. when another filter is loaded). */
  configure(events?: EventTuning): void {
    const wink = thresholdOf(events, 'wink')
    this.#channel(BLINK, thresholdOf(events, 'blink'), minDurationOf(events, 'blink'), 0)
    this.#channel(WINK_LEFT, wink, minDurationOf(events, 'wink'), 0)
    this.#channel(WINK_RIGHT, wink, minDurationOf(events, 'wink'), 0)
    this.#channel(MOUTH, thresholdOf(events, 'mouthOpen'), minDurationOf(events, 'mouthOpen'), minDurationOf(events, 'mouthClose'))
    this.#channel(SMILE, thresholdOf(events, 'smile'), minDurationOf(events, 'smile'), minDurationOf(events, 'smileEnd'))
    this.#channel(BROW, thresholdOf(events, 'eyebrowRaise'), minDurationOf(events, 'eyebrowRaise'), 0)
    this.#channel(KISS, thresholdOf(events, 'kiss'), minDurationOf(events, 'kiss'), 0)
    this.#winkGap[0] = Math.min(WINK_MIN_GAP, wink)
    // A zero amplitude would match any jitter: keep a floor of 1°.
    const p = this.#headParams
    p[2 * NOD] = Math.max(Math.PI / 180, thresholdOf(events, 'nod') * NOD_FULL_SCALE_RAD)
    p[2 * NOD + 1] = minDurationOf(events, 'nod')
    p[2 * SHAKE] = Math.max(Math.PI / 180, thresholdOf(events, 'shake') * NOD_FULL_SCALE_RAD)
    p[2 * SHAKE + 1] = minDurationOf(events, 'shake')
  }

  #channel(k: number, threshold: number, minOnMs: number, minOffMs: number): void {
    this.#on[k] = threshold
    this.#off[k] = threshold - Math.min(HYSTERESIS, threshold / 2)
    this.#minOn[k] = minOnMs
    this.#minOff[k] = minOffMs
  }

  /** Forgets every face without emitting events (e.g. when the source changes). */
  reset(): void {
    this.#used.fill(0)
    this.#out.count = 0
  }

  /**
   * Processes one tracking result.
   *
   * @param timeMs media time of the frame (ms); going backwards (seek, loop) restarts the gestures.
   * @param count number of faces this frame.
   * @param ids stable id of each face, `ids[i]` for face `i` (spec §5.4). An id absent from one call to the next
   *   fires `faceLeave`; the grace delay belongs to whoever assigns the ids. Faces beyond `maxFaces` are ignored.
   * @param signals `SIGNALS_STRIDE` floats per face, face `i` at `i * SIGNALS_STRIDE` (`readExpressionSignals`).
   * @returns the events of this frame, in a buffer reused by the next call.
   */
  update(timeMs: number, count: number, ids: ArrayLike<number>, signals: Float32Array): Readonly<ExpressionEventBuffer> {
    this.#clock[0] = timeMs
    this.#out.count = 0
    const used = this.#used
    const seen = this.#seen
    const slotOf = this.#slotOf
    const n = Math.min(count, this.maxFaces)
    seen.fill(0)
    for (let i = 0; i < n; i++) {
      slotOf[i] = -1
      for (let k = 0; k < this.maxFaces; k++) {
        if (used[k] && !seen[k] && this.#ids[k] === ids[i]) {
          seen[k] = 1
          slotOf[i] = k
          break
        }
      }
    }
    for (let k = 0; k < this.maxFaces; k++) {
      if (used[k] && !seen[k]) {
        used[k] = 0
        this.#emit('faceLeave', k, null)
      }
    }
    for (let i = 0; i < n; i++) {
      let slot = slotOf[i]!
      if (slot < 0) {
        slot = used.indexOf(0)
        if (slot < 0) continue
        used[slot] = 1
        seen[slot] = 1
        this.#ids[slot] = ids[i]!
        this.#resetSlot(slot)
        this.#emit('faceEnter', slot, null)
      }
      this.#face(slot, signals, i * SIGNALS_STRIDE)
    }
    return this.#out
  }

  #resetSlot(slot: number): void {
    this.#lastT[slot] = this.#clock[0]!
    this.#calibrated[slot] = 0
    this.#state.fill(IDLE, slot * CHANNELS, (slot + 1) * CHANNELS)
    this.#heads[slot]!.reset()
  }

  #face(slot: number, signals: Float32Array, o: number): void {
    const t = this.#clock[0]!
    if (t < this.#lastT[slot]!) this.#resetSlot(slot) // time went backwards (seek, loop): keep the face
    const v = this.#values
    for (let k = 0; k < EXPRESSION_SIGNAL_COUNT; k++) v[k] = signals[o + k]!
    if (this.calibrate) this.#calibrateValues(slot)
    this.#lastT[slot] = t

    const input = this.#input
    const eyeL = v[SIGNAL.eyeClosedLeft]!
    const eyeR = v[SIGNAL.eyeClosedRight]!
    // `frontal` is false when the yaw is NaN; NaN eyes propagate to the eye channels, which then skip the frame.
    const frontal = Math.abs(signals[o + SIGNAL.yaw]!) <= WINK_MAX_YAW
    const gap = this.#winkGap[0]!
    input[BLINK] = Math.min(eyeL, eyeR)
    input[WINK_LEFT] = eyeL !== eyeL || eyeR !== eyeR ? NaN : frontal && eyeL - eyeR >= gap ? eyeL : 0
    input[WINK_RIGHT] = eyeL !== eyeL || eyeR !== eyeR ? NaN : frontal && eyeR - eyeL >= gap ? eyeR : 0
    input[MOUTH] = v[SIGNAL.jawOpen]!
    input[SMILE] = v[SIGNAL.smile]!
    input[BROW] = v[SIGNAL.browRaise]!
    input[KISS] = v[SIGNAL.pucker]!
    for (let k = 0; k < CHANNELS; k++) this.#step(slot, k)

    const pitch = signals[o + SIGNAL.pitch]!
    const yaw = signals[o + SIGNAL.yaw]!
    if (pitch === pitch && yaw === yaw) {
      const head = this.#heads[slot]!.step(signals, o)
      if (head & (1 << NOD)) this.#emit('nod', slot, null)
      if (head & (1 << SHAKE)) this.#emit('shake', slot, null)
    }
  }

  /** Steps the hysteresis of channel `k` of `slot` with `#input[k]`; emits the start / end event. */
  #step(slot: number, k: number): void {
    const v = this.#input[k]!
    if (v !== v) return // no data: keep the state
    const t = this.#clock[0]!
    const i = slot * CHANNELS + k
    const state = this.#state
    const since = this.#since
    switch (state[i]) {
      case IDLE:
        if (v < this.#on[k]!) return
        state[i] = PENDING_ON
        since[i] = t
        break
      case PENDING_ON:
        if (v < this.#off[k]!) {
          state[i] = IDLE
          return
        }
        break
      case ACTIVE:
        if (v >= this.#off[k]!) return
        state[i] = PENDING_OFF
        since[i] = t
        break
      default: // PENDING_OFF
        if (v >= this.#on[k]!) {
          state[i] = ACTIVE
          return
        }
    }
    if (state[i] === PENDING_ON) {
      if (t - since[i]! < this.#minOn[k]!) return
      state[i] = ACTIVE
      this.#emit(START_EVENT[k]!, slot, SIDE[k]!)
    } else {
      if (t - since[i]! < this.#minOff[k]!) return
      state[i] = IDLE
      const end = END_EVENT[k]
      if (end) this.#emit(end, slot, null)
    }
  }

  /** Removes the per-face neutral baseline from `#values` and rescales them to 0–1. */
  #calibrateValues(slot: number): void {
    const v = this.#values
    const b = this.#baseline
    const o = slot * EXPRESSION_SIGNAL_COUNT
    const first = !this.#calibrated[slot]
    this.#calibrated[slot] = 1
    const dt = this.#clock[0]! - this.#lastT[slot]!
    const fall = 1 - Math.exp(-dt / BASELINE_FALL_TAU_MS)
    const rise = 1 - Math.exp(-dt / BASELINE_RISE_TAU_MS)
    for (let k = 0; k < EXPRESSION_SIGNAL_COUNT; k++) {
      const r = v[k]!
      if (r !== r) continue
      let base = b[o + k]!
      if (first) base = r
      else if (r < base) base += (r - base) * fall
      else if (r - base < BASELINE_RISE_BAND) base += (r - base) * rise
      base = Math.min(Math.max(base, 0), BASELINE_MAX)
      b[o + k] = base
      v[k] = Math.min(1, Math.max(0, (r - base) / (1 - base)))
    }
  }

  #emit(name: ExpressionEventName, slot: number, side: EventSide | null): void {
    const out = this.#out
    const e = out.items[out.count]
    if (!e) return
    e.name = name
    e.faceId = this.#ids[slot]!
    e.side = side
    e.timeMs = this.#clock[0]!
    out.count++
  }
}
