import {
  ANCHOR_DEFAULT_FOLLOW,
  LANDMARK_ANCHOR_NAMES,
  cameraToVideo,
  clipToPixelX,
  clipToPixelY,
  computeAnchorMatrix,
  computeVideoToClip,
  createVideoToClip,
  liveAnchorPosition,
  videoToClipX,
  videoToClipY,
  type FaceFrame,
  type FitMode,
} from '@ouaf/core'

/**
 * Debug overlay for issues #10 and #13: draws every anchor of every face with its name, on a 2D canvas laid over
 * the WebGL canvas, using the renderer's own video → clip mapping (same fit and mirroring).
 * Anchors are drawn where `follow: auto` puts them (`computeAnchorMatrix`): orange = `expression` (live landmarks),
 * cyan = `rigid` (canonical model under the head pose); white = the `head` origin, with the x (red) and y (green)
 * axes of the head frame, one face unit long, from the `eyes` point. Without a valid pose, the live landmarks.
 */
export interface AnchorsOverlay {
  readonly element: HTMLCanvasElement
  draw(faces: Readonly<FaceFrame>, view: { width: number; height: number; fit: FitMode; mirrored: boolean }): void
  dispose(): void
}

export function createAnchorsOverlay(): AnchorsOverlay | undefined {
  const canvas = document.createElement('canvas')
  canvas.className = 'anchors-overlay'
  const ctx = canvas.getContext('2d')
  if (!ctx) return undefined
  const mapping = createVideoToClip()
  const p = { x: 0, y: 0, z: 0 }
  const m = new Float32Array(16)

  return {
    element: canvas,
    draw(faces, view) {
      if (canvas.width !== view.width || canvas.height !== view.height) {
        canvas.width = view.width
        canvas.height = view.height
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      if (faces.count === 0) return
      computeVideoToClip(faces.width, faces.height, canvas.width, canvas.height, view.fit, view.mirrored, mapping)

      const r = Math.max(3, canvas.height / 160)
      ctx.font = `${Math.round(Math.max(10, canvas.height / 55))}px system-ui, sans-serif`
      ctx.textBaseline = 'middle'
      ctx.lineWidth = Math.max(2, r / 2)
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)'
      const toX = (u: number) => clipToPixelX(videoToClipX(mapping, u), canvas.width)
      const toY = (v: number) => clipToPixelY(videoToClipY(mapping, v), canvas.height)
      for (let face = 0; face < faces.count; face++) {
        for (const name of LANDMARK_ANCHOR_NAMES) {
          if (computeAnchorMatrix(faces, face, name, 'auto', false, m)) cameraToVideo(faces, m[12]!, m[13]!, m[14]!, p)
          else liveAnchorPosition(faces, face, name, p)
          const x = toX(p.x)
          const y = toY(p.y)
          ctx.fillStyle = ANCHOR_DEFAULT_FOLLOW[name] === 'expression' ? '#ff9f1a' : '#2ee6ff'
          ctx.beginPath()
          ctx.arc(x, y, r, 0, Math.PI * 2)
          ctx.fill()
          ctx.stroke()
          // Labels go to the outside of the face. Mirrored view: the person's left side is on the screen left.
          const left = name.startsWith('left') === view.mirrored
          ctx.textAlign = left ? 'right' : 'left'
          const tx = left ? x - r * 2 : x + r * 2
          ctx.strokeText(name, tx, y)
          ctx.fillText(name, tx, y)
        }
        if (computeAnchorMatrix(faces, face, 'eyes', 'rigid', false, m)) {
          // Frame axes as seen on screen (§5.1): the unmirrored +x is the person's left, i.e. the screen left once
          // the view is mirrored, so the spec's +x is its opposite there.
          const sx = view.mirrored ? -1 : 1
          cameraToVideo(faces, m[12]!, m[13]!, m[14]!, p)
          const ox = toX(p.x)
          const oy = toY(p.y)
          for (const [c, color, sign] of [[0, '#ff3b30', sx], [1, '#34c759', 1]] as const) {
            cameraToVideo(faces, m[12]! + sign * m[c * 4]!, m[13]! + sign * m[c * 4 + 1]!, m[14]! + sign * m[c * 4 + 2]!, p)
            ctx.strokeStyle = color
            ctx.beginPath()
            ctx.moveTo(ox, oy)
            ctx.lineTo(toX(p.x), toY(p.y))
            ctx.stroke()
          }
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)'
        }
        if (computeAnchorMatrix(faces, face, 'head', 'rigid', false, m)) {
          cameraToVideo(faces, m[12]!, m[13]!, m[14]!, p)
          ctx.fillStyle = '#ffffff'
          ctx.beginPath()
          ctx.arc(toX(p.x), toY(p.y), r, 0, Math.PI * 2)
          ctx.fill()
          ctx.stroke()
        }
      }
    },
    dispose() {
      canvas.remove()
    },
  }
}
