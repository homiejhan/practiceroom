/**
 * Whiteboard vocabulary: tools, ink colors, and the kinds of shape the board
 * stores in the room's CanvasRoom (ink strokes, typed math, question cards
 * and pictures).
 */

import type { CanvasShapeClient } from 'deepspace'

export type Tool = 'pan' | 'select' | 'type' | 'pen' | 'highlighter' | 'eraser' | 'region'

export interface Swatch {
  name: string
  value: string
}

export const PEN_COLORS: Swatch[] = [
  { name: 'Black', value: '#16161a' },
  { name: 'Grey', value: '#7a7f87' },
  { name: 'Red', value: '#dc2626' },
  { name: 'Orange', value: '#ea580c' },
  { name: 'Yellow', value: '#eab308' },
  { name: 'Green', value: '#16a34a' },
  { name: 'Blue', value: '#2563eb' },
  { name: 'Purple', value: '#7c3aed' },
  { name: 'White', value: '#ffffff' },
]

export const HIGHLIGHTER_COLORS: Swatch[] = [
  { name: 'Neon pink', value: '#ff3ea5' },
  { name: 'Neon orange', value: '#ff7a00' },
  { name: 'Bright yellow', value: '#ffe600' },
  { name: 'Neon green', value: '#39ff14' },
  { name: 'Cyan', value: '#00e5ff' },
  { name: 'Neon purple', value: '#b026ff' },
]

/**
 * How wide each inking tool can be set, and where it starts. Pen and
 * highlighter widths are in board units (they zoom with the ink); the eraser
 * is a diameter in screen pixels, so it feels the same size at any zoom.
 */
export const WIDTHS = {
  pen: { min: 1, max: 16, step: 0.5, initial: 4 },
  highlighter: { min: 8, max: 40, step: 1, initial: 22 },
  eraser: { min: 10, max: 80, step: 2, initial: 20 },
} as const

export type WidthTool = keyof typeof WIDTHS
export type ToolWidths = Record<WidthTool, number>

/** Widths a person chose before, checked against the limits; the defaults otherwise. */
export function readWidths(saved: unknown): ToolWidths {
  const from = saved && typeof saved === 'object' ? (saved as Record<string, unknown>) : {}
  const pick = (tool: WidthTool): number => {
    const { min, max, initial } = WIDTHS[tool]
    const value = from[tool]
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : initial
  }
  return { pen: pick('pen'), highlighter: pick('highlighter'), eraser: pick('eraser') }
}

export const HIGHLIGHTER_OPACITY = 0.38

export const QUESTION_CARD_WIDTH = 380
export const MATH_FONT_SIZE = 24

export type Shape = CanvasShapeClient

export interface StrokeProps {
  /** Flat [x0, y0, x1, y1, ...] relative to the shape's x/y. */
  pts: number[]
  color: string
  size: number
  hl: boolean
}

export interface MathProps {
  latex: string
}

export interface QuestionProps {
  /** Record id of the private answer key in `question_keys`. */
  qid: string
  title: string
  text: string
  n: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface View {
  x: number
  y: number
  zoom: number
}

export interface ImageProps {
  /** Path of the uploaded file on this app's own origin. */
  src: string
}

/**
 * A picture's address, only if it is one of this app's own stored files.
 *
 * Shape props are written by anyone in the room, so `src` is not trusted: a
 * crafted shape could otherwise make every participant's browser fetch an
 * outside URL. Only a same-origin `/api/files/...` path is ever put in an <img>.
 */
export function boardImageSrc(shape: Shape): string | null {
  const src = (shape.props as { src?: unknown }).src
  if (typeof src !== 'string' || src.length > 600) return null
  if (!/^\/api\/files\/[A-Za-z0-9_\-./%:@]+(\?[A-Za-z0-9_\-=&.%]*)?$/.test(src)) return null
  if (src.includes('//') || src.includes('..')) return null
  return src
}

export const strokeProps = (shape: Shape): StrokeProps => shape.props as unknown as StrokeProps
export const mathProps = (shape: Shape): MathProps => shape.props as unknown as MathProps
export const questionProps = (shape: Shape): QuestionProps =>
  shape.props as unknown as QuestionProps

export const shapeRect = (shape: Shape): Rect => ({
  x: shape.x,
  y: shape.y,
  w: shape.width,
  h: shape.height,
})

export const rectsOverlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

export const rectContains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h

/**
 * The view after a two-finger pinch. The fingers started `startDistance`
 * apart around `startMid` (screen pixels, relative to the board) and are now
 * `distance` apart around `mid`. The board point that was under the first
 * midpoint stays under the fingers, so spreading zooms and sliding pans.
 */
export function pinchView(
  start: View,
  startMid: { x: number; y: number },
  startDistance: number,
  mid: { x: number; y: number },
  distance: number,
  minZoom: number,
  maxZoom: number,
): View {
  const zoom = Math.min(maxZoom, Math.max(minZoom, (start.zoom * distance) / Math.max(1, startDistance)))
  const anchorX = startMid.x / start.zoom + start.x
  const anchorY = startMid.y / start.zoom + start.y
  return { zoom, x: anchorX - mid.x / zoom, y: anchorY - mid.y / zoom }
}

/** Normalize a rectangle dragged in any direction. */
export function rectFromPoints(ax: number, ay: number, bx: number, by: number): Rect {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) }
}

/** SVG path data for a stroke's points, smoothed through segment midpoints. */
export function strokePath(pts: number[], ox = 0, oy = 0): string {
  const n = pts.length / 2
  if (n === 0) return ''
  const x = (i: number) => pts[i * 2] + ox
  const y = (i: number) => pts[i * 2 + 1] + oy
  if (n === 1) return `M${x(0)},${y(0)} l0.01,0`
  let d = `M${x(0)},${y(0)}`
  for (let i = 1; i < n - 1; i++) {
    const mx = (x(i) + x(i + 1)) / 2
    const my = (y(i) + y(i + 1)) / 2
    d += ` Q${x(i)},${y(i)} ${mx},${my}`
  }
  d += ` L${x(n - 1)},${y(n - 1)}`
  return d
}
