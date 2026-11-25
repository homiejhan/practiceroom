/**
 * Geometry for finding ink under a pointer: used by the eraser (a sweep
 * between two pointer samples) and by pen-button selection (a single point).
 */

import { shapeRect, strokeProps, type Shape } from './types'

export interface Point {
  x: number
  y: number
}

function pointToSegment(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const lengthSq = abx * abx + aby * aby
  // A zero-length segment is a point.
  const t = lengthSq === 0 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSq
  const clamped = Math.min(1, Math.max(0, t))
  return Math.hypot(p.x - (a.x + clamped * abx), p.y - (a.y + clamped * aby))
}

const side = (a: Point, b: Point, p: Point): number =>
  (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)

/** Shortest distance between segments ab and cd; 0 when they cross. */
export function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  // A proper crossing. Touching and collinear cases fall through to the
  // endpoint distances below, which come out as 0 for them.
  if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) return 0
  return Math.min(
    pointToSegment(a, c, d),
    pointToSegment(b, c, d),
    pointToSegment(c, a, b),
    pointToSegment(d, a, b),
  )
}

/**
 * Whether a sweep from `from` to `to`, `radius` wide on each side, touches the
 * stroke's ink. Pass the same point twice to test a single spot.
 */
export function sweepTouchesStroke(shape: Shape, from: Point, to: Point, radius: number): boolean {
  const { pts, size } = strokeProps(shape)
  if (!Array.isArray(pts) || pts.length < 2) return false
  const reach = radius + (Number(size) || 0) / 2

  // Most ink is nowhere near the pointer: rule it out by its bounding box.
  const box = shapeRect(shape)
  if (
    Math.max(from.x, to.x) < box.x - reach ||
    Math.min(from.x, to.x) > box.x + box.w + reach ||
    Math.max(from.y, to.y) < box.y - reach ||
    Math.min(from.y, to.y) > box.y + box.h + reach
  ) {
    return false
  }

  let previous = { x: pts[0] + shape.x, y: pts[1] + shape.y }
  if (pts.length < 4) return segmentDistance(from, to, previous, previous) <= reach
  for (let i = 2; i + 1 < pts.length; i += 2) {
    const next = { x: pts[i] + shape.x, y: pts[i + 1] + shape.y }
    if (segmentDistance(from, to, previous, next) <= reach) return true
    previous = next
  }
  return false
}
