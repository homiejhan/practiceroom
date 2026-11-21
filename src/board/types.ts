/**
 * Whiteboard vocabulary: tools, ink colors, and the three kinds of shape the
 * board stores in the room's CanvasRoom.
 */

import type { CanvasShapeClient } from 'deepspace'

export type Tool = 'pan' | 'select' | 'type' | 'pen' | 'highlighter' | 'region'

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

export const PEN_SIZES = [2.5, 4, 7] as const
export const HIGHLIGHTER_SIZE = 22
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
