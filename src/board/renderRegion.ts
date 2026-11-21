/**
 * Turn one rectangle of the whiteboard into what the grader needs: a PNG of
 * the ink, plus the typed entries and question cards inside the rectangle.
 *
 * Ink is drawn for real, because handwriting can only be read from pixels.
 * Typed math and question cards are not rasterized: each becomes a labelled
 * placeholder box in the image and its exact LaTeX/text travels as data, which
 * is more reliable than asking a vision model to re-read rendered math.
 */

import {
  HIGHLIGHTER_OPACITY,
  mathProps,
  questionProps,
  rectsOverlap,
  shapeRect,
  strokeProps,
  type Rect,
  type Shape,
} from './types'

export interface RegionCapture {
  image: string
  width: number
  height: number
  strokeCount: number
  questions: Array<{ questionId: string; text: string; x: number; y: number }>
  typed: Array<{ latex: string; x: number; y: number }>
}

const MAX_SIDE = 1400
const MAX_SCALE = 2

function drawTag(ctx: CanvasRenderingContext2D, label: string, box: Rect, color: string): void {
  ctx.save()
  ctx.globalAlpha = 1
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.setLineDash([5, 4])
  ctx.strokeRect(box.x, box.y, Math.max(box.w, 24), Math.max(box.h, 18))
  ctx.setLineDash([])
  ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif'
  const textWidth = ctx.measureText(label).width
  ctx.fillStyle = color
  ctx.fillRect(box.x, box.y, textWidth + 10, 18)
  ctx.fillStyle = '#ffffff'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, box.x + 5, box.y + 9.5)
  ctx.restore()
}

/**
 * @param region  The selected rectangle, in board (world) coordinates.
 * @param shapes  Every shape on the board, in creation order.
 * @param measure Live on-screen size of an HTML shape, in world units. Cards
 *                grow with their text, so the stored size can lag the real one.
 */
export function captureRegion(
  region: Rect,
  shapes: Shape[],
  measure: (shape: Shape) => Rect,
): RegionCapture | null {
  const scale = Math.min(MAX_SCALE, MAX_SIDE / Math.max(region.w, region.h))
  const width = Math.max(64, Math.round(region.w * scale))
  const height = Math.max(64, Math.round(region.h * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  const toImage = (rect: Rect): Rect => ({
    x: (rect.x - region.x) * scale,
    y: (rect.y - region.y) * scale,
    w: rect.w * scale,
    h: rect.h * scale,
  })

  const capture: RegionCapture = {
    image: '',
    width,
    height,
    strokeCount: 0,
    questions: [],
    typed: [],
  }

  for (const shape of shapes) {
    if (shape.type === 'stroke') {
      if (!rectsOverlap(shapeRect(shape), region)) continue
      const { pts, color, size, hl } = strokeProps(shape)
      if (!Array.isArray(pts) || pts.length < 2) continue
      capture.strokeCount += 1
      ctx.save()
      ctx.globalAlpha = hl ? HIGHLIGHTER_OPACITY : 1
      ctx.strokeStyle = color
      ctx.lineWidth = Math.max(1, size * scale)
      ctx.beginPath()
      for (let i = 0; i < pts.length; i += 2) {
        const px = (shape.x + pts[i] - region.x) * scale
        const py = (shape.y + pts[i + 1] - region.y) * scale
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      if (pts.length === 2) ctx.lineTo((shape.x + pts[0] - region.x) * scale + 0.1, (shape.y + pts[1] - region.y) * scale)
      ctx.stroke()
      ctx.restore()
      continue
    }

    const rect = measure(shape)
    if (!rectsOverlap(rect, region)) continue
    const box = toImage(rect)

    if (shape.type === 'math') {
      const { latex } = mathProps(shape)
      if (!latex) continue
      capture.typed.push({ latex, x: Math.round(box.x), y: Math.round(box.y) })
      drawTag(ctx, `T${capture.typed.length}`, box, '#2563eb')
    } else if (shape.type === 'question') {
      const { qid, text } = questionProps(shape)
      capture.questions.push({
        questionId: qid,
        text,
        x: Math.round(box.x),
        y: Math.round(box.y),
      })
      drawTag(ctx, `Q${capture.questions.length}`, box, '#0f766e')
    }
  }

  capture.image = canvas.toDataURL('image/png')
  return capture
}
