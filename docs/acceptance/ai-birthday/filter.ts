import { defineFilter } from '@ouaf/spec'

// Birthday filter: a striped party hat with a pom-pom on every face, a "Happy birthday, <name>!" greeting above it
// (the name is a parameter), and confetti raining over the whole screen when someone opens their mouth wide.

const CONFETTI_MS = 2600 // how long a burst lasts
const FADE_MS = 600 // fade-out at the end of a burst
const PIECES = 230
const W = 1024 // canvas size: 2:1, wide enough for a landscape screen; on a portrait screen only the middle shows
const H = 512
const COLORS = ['#ff3d8b', '#ffd400', '#2ec4ff', '#7cff4f', '#b56bff', '#ff8a1f', '#ffffff']

type Piece = { x: number; y: number; v: number; sway: number; phase: number; spin: number; w: number; h: number; c: number }

// The hat, in face units on the forehead anchor: the centre of its base, its size and its backward tilt (degrees).
const HAT_BASE = [0, 0, -0.9]
const HAT_HEIGHT = 2.1
const HAT_RADIUS = 0.8
const HAT_TILT = 8

const round = (n: number) => Math.round(n * 1000) / 1000

// Point of the cone's axis at height h above the centre of its base.
function hatPart(h: number): [number, number, number] {
  const a = (HAT_TILT * Math.PI) / 180
  return [round(HAT_BASE[0] ?? 0), round((HAT_BASE[1] ?? 0) + h * Math.cos(a)), round((HAT_BASE[2] ?? 0) - h * Math.sin(a))]
}

// Scale of a torus of band `thickness` (relative) whose tube runs on the cone's surface at height h.
function ringScale(h: number, thickness: number): number {
  const r = HAT_RADIUS * (1 - h / HAT_HEIGHT) + 0.02
  return round((2 * r) / (1 - thickness))
}

const TEXT_SIZE = 0.38
const TEXT_WIDTH = 3.6 // maxWidth of the greeting, face units

// The greeting for a name, and its font size: smaller for a long name, so that "<name>!" fits on one line under
// "Happy birthday," (the text is anchored at its vertical middle: a third line would cover the pom-pom).
function greeting(name: unknown): { text: string; size: number } {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n) return { text: 'Happy birthday!', size: TEXT_SIZE }
  // About 0.55 em per character in the rounded bold font.
  const size = Math.min(TEXT_SIZE, (TEXT_WIDTH * 0.95) / (0.55 * (n.length + 1)))
  return { text: `Happy birthday, ${n}!`, size: Math.round(size * 1000) / 1000 }
}

export default defineFilter({
  id: 'ai-birthday',
  name: 'Happy birthday',
  description: 'A party hat on every head, a birthday greeting with your name, and confetti when you open your mouth wide.',
  version: '1.0.0',
  license: 'CC0-1.0',
  tags: ['birthday', 'party', 'hat', 'confetti'],
  requires: { face: true },
  params: {
    name: { type: 'string', default: 'Alex', maxLength: 24, label: { en: 'Name', fr: 'Prénom' } },
  },
  assets: {
    title: 'builtin:font/rounded-bold',
  },
  // A wide-open mouth (blowing out the candles), not speech.
  events: { mouthOpen: { threshold: 0.5, minDurationMs: 120 } },
  layers: [
    // Party hat: a cone sitting on top of the head, tilted back a little, with two stripes, a trim and a pom-pom.
    // Every part shares the anchor and the tilt; the offsets are computed along the cone's tilted axis (hatPart).
    { id: 'hat', type: 'model', src: { shape: 'cone', color: '#ff3d8b', roughness: 0.6 }, anchor: 'forehead',
      offset: hatPart(HAT_HEIGHT / 2), rotation: [-HAT_TILT, 0, 0], scale: [HAT_RADIUS * 2, HAT_HEIGHT, HAT_RADIUS * 2],
      occlusion: 'head' },
    { id: 'stripe1', type: 'model', src: { shape: 'torus', color: '#ffd400', roughness: 0.5, thickness: 0.1 },
      anchor: 'forehead', offset: hatPart(HAT_HEIGHT / 3), rotation: [90 - HAT_TILT, 0, 0], scale: ringScale(HAT_HEIGHT / 3, 0.1),
      occlusion: 'head' },
    { id: 'stripe2', type: 'model', src: { shape: 'torus', color: '#2ec4ff', roughness: 0.5, thickness: 0.1 },
      anchor: 'forehead', offset: hatPart((HAT_HEIGHT * 2) / 3), rotation: [90 - HAT_TILT, 0, 0],
      scale: ringScale((HAT_HEIGHT * 2) / 3, 0.1), occlusion: 'head' },
    { id: 'trim', type: 'model', src: { shape: 'torus', color: '#ffffff', roughness: 0.9, thickness: 0.14 },
      anchor: 'forehead', offset: hatPart(0.04), rotation: [90 - HAT_TILT, 0, 0], scale: ringScale(0.04, 0.14),
      occlusion: 'head' },
    { id: 'pompom', type: 'model', src: { shape: 'sphere', color: '#ffffff', roughness: 1 }, anchor: 'forehead',
      offset: hatPart(HAT_HEIGHT + 0.12), scale: 0.48, occlusion: 'head' },
    // The greeting, above the hat, facing the screen. Its text is set by the script from the `name` parameter.
    { id: 'greeting', type: 'text', text: 'Happy birthday!', anchor: 'forehead', offset: hatPart(HAT_HEIGHT + 0.95), size: TEXT_SIZE,
      orient: 'screen', font: 'title', color: '#ffd400', align: 'center', maxWidth: TEXT_WIDTH,
      outline: { width: 0.14, color: '#c2185b' }, shadow: { color: '#00000099', blur: 0.1, offset: [0, -0.06] } },
    // Confetti over the whole screen, drawn by the script only while a burst runs.
    { id: 'confetti', type: 'canvas', width: W, height: H, fps: 0, anchor: 'screen', size: 1, overlay: true,
      visible: false },
  ],
  // The script only reacts to events and its parameter: it needs no tracking data.
  script: { uses: [] },
  state: {
    bursting: false,
    start: -1, // media time of the first frame of the burst, set by the first draw
    pieces: [] as Piece[],
  },
  setup(f) {
    f.layer('greeting').set(greeting(f.params.name))
  },
  on: {
    paramChange(f, { name, value }) {
      if (name === 'name') f.layer('greeting').set(greeting(value))
    },
    mouthOpen(f) {
      // A new burst, or a fresh one over the running one.
      const pieces: Piece[] = []
      for (let i = 0; i < PIECES; i++) {
        pieces.push({
          x: f.random(), // across the visible width
          y: 0.1 - f.random() * 1.4, // from the top of the screen to above it, so it shows at once and keeps raining
          v: 0.55 + f.random() * 0.4, // fall speed, screen heights per second
          sway: 0.01 + f.random() * 0.03,
          phase: f.random() * Math.PI * 2,
          spin: 3 + f.random() * 9,
          w: 9 + f.random() * 9,
          h: 5 + f.random() * 5,
          c: Math.floor(f.random() * COLORS.length),
        })
      }
      f.state.pieces = pieces
      f.state.start = -1
      if (!f.state.bursting) {
        f.state.bursting = true
        f.layer('confetti').set({ visible: true })
        const ticker = f.every(33, (f) => {
          f.layer('confetti').invalidate()
        })
        const check = f.every(100, (f) => {
          if (f.state.bursting) return
          ticker.cancel()
          check.cancel()
          f.layer('confetti').set({ visible: false })
        })
      }
    },
  },
  draw: {
    confetti(ctx, f, frame) {
      if (!f.state.bursting) return
      if (f.state.start < 0) f.state.start = frame.time
      const t = frame.time - f.state.start
      const ms = t * 1000
      if (ms >= CONFETTI_MS) {
        f.state.bursting = false
        return
      }
      const alpha = ms > CONFETTI_MS - FADE_MS ? (CONFETTI_MS - ms) / FADE_MS : 1
      // Only the middle of the canvas is on screen when the screen is narrower than 2:1.
      const visible = Math.min(W, H * (frame.aspect || 1))
      const left = (W - visible) / 2
      ctx.globalAlpha = alpha
      for (const p of f.state.pieces) {
        const y = (p.y + p.v * t) * H
        if (y < -20 || y > H + 20) continue
        const x = left + (p.x + p.sway * Math.sin(p.phase + t * 4)) * visible
        ctx.save()
        ctx.translate(x, y)
        ctx.rotate(p.phase + t * p.spin * 0.5)
        ctx.scale(1, Math.cos(p.phase + t * p.spin)) // tumbling
        ctx.fillStyle = COLORS[p.c] ?? '#ffffff'
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h)
        ctx.restore()
      }
      ctx.globalAlpha = 1
    },
  },
})
