/**
 * Built-ins page (`/builtins.html`): shows the resources of `@ouaf/builtins` (#65) the way the text and color
 * layers will use them, until those layers exist: the fonts registered with `FontFace`, and the LUTs applied in
 * WebGL 2 to a test clip or the camera.
 */
import { BUILTIN_ASSETS, resolveBuiltin, type BuiltinFont, type BuiltinLut } from '@ouaf/builtins'

const BASE = new URL('builtins/', document.baseURI)
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const fonts = Object.entries(BUILTIN_ASSETS).filter((e): e is [string, BuiltinFont] => e[1].kind === 'font')
const luts = Object.entries(BUILTIN_ASSETS).filter((e): e is [string, BuiltinLut] => e[1].kind === 'lut')
const css = (f: BuiltinFont, size: number) => `${f.weight} ${size}px "${f.family}"`

// --- Fonts -----------------------------------------------------------------------------------------------------

const fontText = $<HTMLInputElement>('font-text')
fontText.value = 'Ouaf! Ça déjà vu, Ærøskøbing, Łódź, Tiếng Việt — 0123456789 €£¥ → “quotes”'
const samples: HTMLElement[] = []

for (const [name, font] of fonts) {
  const row = document.createElement('div')
  row.className = 'font-row'
  const label = document.createElement('div')
  label.className = 'name'
  label.textContent = `builtin:${name}\n(loading…)`
  label.style.whiteSpace = 'pre-line'
  const sample = document.createElement('div')
  sample.className = 'sample'
  sample.style.font = css(font, 28)
  sample.textContent = fontText.value
  samples.push(sample)
  row.append(label, sample)
  $('fonts').append(row)

  const url = resolveBuiltin(`builtin:${name}`, BASE)
  const face = new FontFace(font.family, `url(${url.href})`, { weight: String(font.weight), style: font.style })
  const t0 = performance.now()
  face.load().then(
    (loaded) => {
      document.fonts.add(loaded)
      label.textContent = `builtin:${name}\n${font.family} ${font.weight}, ${Math.round(performance.now() - t0)} ms`
    },
    (err: unknown) => (label.textContent = `builtin:${name}\nfailed: ${String(err)}`),
  )
}
fontText.addEventListener('input', () => samples.forEach((s) => (s.textContent = fontText.value)))

// --- LUTs ------------------------------------------------------------------------------------------------------

/** `.cube` 3D LUT: grid size and RGB triplets, red varying fastest. */
function parseCube(text: string): { size: number; data: Float32Array } {
  let size = 0
  const values: number[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('TITLE') || line.startsWith('DOMAIN_')) continue
    if (line.startsWith('LUT_3D_SIZE')) {
      size = Number(line.split(/\s+/)[1])
      continue
    }
    values.push(...line.split(/\s+/).map(Number))
  }
  if (!size || values.length !== size ** 3 * 3) throw new Error('Invalid .cube file')
  const data = new Float32Array(size ** 3 * 4)
  for (let i = 0; i < size ** 3; i++) {
    data.set([values[i * 3]!, values[i * 3 + 1]!, values[i * 3 + 2]!, 1], i * 4)
  }
  return { size, data }
}

const lutCanvas = $<HTMLCanvasElement>('lut-canvas')
const video = $<HTMLVideoElement>('video')
const gl = lutCanvas.getContext('webgl2')!

const VERT = `#version 300 es
in vec2 pos; out vec2 uv;
void main() { uv = vec2(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5); gl_Position = vec4(pos, 0.0, 1.0); }`
const FRAG = `#version 300 es
precision highp float; precision highp sampler3D;
in vec2 uv; out vec4 color;
uniform sampler2D frame; uniform sampler3D lut; uniform float size; uniform float split; uniform bool enabled;
void main() {
  vec3 c = texture(frame, uv).rgb;
  if (enabled && uv.x >= split) c = texture(lut, c * ((size - 1.0) / size) + 0.5 / size).rgb;
  if (enabled && abs(uv.x - split) < 0.002) c = vec3(1.0);
  color = vec4(c, 1.0);
}`

function program(): WebGLProgram {
  const p = gl.createProgram()
  for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]] as const) {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader')
    gl.attachShader(p, s)
  }
  gl.linkProgram(p)
  return p
}
const prog = program()
gl.useProgram(prog)
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
const posLoc = gl.getAttribLocation(prog, 'pos')
gl.enableVertexAttribArray(posLoc)
gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0)

const frameTex = gl.createTexture()
gl.activeTexture(gl.TEXTURE0)
gl.bindTexture(gl.TEXTURE_2D, frameTex)
for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) {
  gl.texParameteri(gl.TEXTURE_2D, k!, v!)
}
const lutTex = gl.createTexture()
gl.activeTexture(gl.TEXTURE1)
gl.bindTexture(gl.TEXTURE_3D, lutTex)
for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, k, gl.CLAMP_TO_EDGE)
gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
gl.uniform1i(gl.getUniformLocation(prog, 'frame'), 0)
gl.uniform1i(gl.getUniformLocation(prog, 'lut'), 1)
const uSize = gl.getUniformLocation(prog, 'size')
const uSplit = gl.getUniformLocation(prog, 'split')
const uEnabled = gl.getUniformLocation(prog, 'enabled')

let split = 0.5
let current: string | null = null
const cubes = new Map<string, Promise<{ size: number; data: Float32Array }>>()
const buttons = new Map<string | null, HTMLButtonElement>()

async function selectLut(name: string | null) {
  current = name
  for (const [n, b] of buttons) b.setAttribute('aria-pressed', String(n === name))
  if (!name) return
  let p = cubes.get(name)
  if (!p) cubes.set(name, (p = fetch(resolveBuiltin(`builtin:${name}`, BASE)).then((r) => r.text()).then(parseCube)))
  const { size, data } = await p
  if (current !== name) return
  gl.activeTexture(gl.TEXTURE1)
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, size, size, size, 0, gl.RGBA, gl.FLOAT, data)
  gl.uniform1f(uSize, size)
}
for (const name of [null, ...luts.map(([n]) => n)]) {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = name ?? 'none'
  b.addEventListener('click', () => void selectLut(name))
  buttons.set(name, b)
  $('luts').append(b)
}

const sourceSelect = $<HTMLSelectElement>('lut-source')
for (const clip of ['pesquet-closeup', 'pesquet-talk', 'pesquet-walk', 'two-faces', 'group-far']) sourceSelect.add(new Option(clip, clip))
const playClip = () => {
  video.srcObject = null
  video.src = `/test-media/${sourceSelect.value}.mp4`
  void video.play()
}
sourceSelect.addEventListener('change', playClip)
$('camera').addEventListener('click', async () => {
  video.src = ''
  video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false })
  await video.play()
})

const moveSplit = (e: PointerEvent) => {
  if (e.buttons === 0 && e.type === 'pointermove') return
  const r = lutCanvas.getBoundingClientRect()
  split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
}
lutCanvas.addEventListener('pointerdown', moveSplit)
lutCanvas.addEventListener('pointermove', moveSplit)

function frame() {
  if (video.readyState >= 2 && video.videoWidth) {
    if (lutCanvas.width !== video.videoWidth || lutCanvas.height !== video.videoHeight) {
      lutCanvas.width = video.videoWidth
      lutCanvas.height = video.videoHeight
    }
    gl.viewport(0, 0, lutCanvas.width, lutCanvas.height)
    gl.activeTexture(gl.TEXTURE0)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
    gl.uniform1f(uSplit, split)
    gl.uniform1i(uEnabled, current && cubes.has(current) ? 1 : 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }
  requestAnimationFrame(frame)
}
playClip()
void selectLut('lut/vintage')
requestAnimationFrame(frame)
