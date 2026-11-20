import {
  ANCHOR_DEFAULT_FOLLOW,
  LANDMARK_ANCHOR_NAMES,
  clipToPixelX,
  clipToPixelY,
  computeVideoToClip,
  createVideoToClip,
  liveAnchorPosition,
  videoToClipX,
  videoToClipY,
  type FaceFrame,
  type FitMode,
} from '@ouaf/core'

/**
 * Debug overlay for issue #10: draws every landmark anchor of every face with its name, on a 2D canvas laid over
 * the WebGL canvas, using the renderer's own video → clip mapping (same fit and mirroring).
 * Anchors are drawn at their live landmark position; orange = `follow: auto` resolves to `expression`,
 * cyan = `rigid` (rigid positions from the head pose come with #13).
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
      for (let face = 0; face < faces.count; face++) {
        for (const name of LANDMARK_ANCHOR_NAMES) {
          liveAnchorPosition(faces, face, name, p)
          const x = clipToPixelX(videoToClipX(mapping, p.x), canvas.width)
          const y = clipToPixelY(videoToClipY(mapping, p.y), canvas.height)
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
      }
    },
    dispose() {
      canvas.remove()
    },
  }
}
