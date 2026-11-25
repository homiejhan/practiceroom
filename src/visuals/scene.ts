/**
 * The drawing a visual turns into.
 *
 * A `[graph]` or `[figure]` block is parsed and laid out once into a Scene:
 * a flat list of paths, dots and text labels in pixels, origin top-left. Two
 * small backends then draw it: SVG in the browser (`components/Visual.tsx`)
 * and TikZ in the worksheet PDF (`visuals/tikz.ts`). Everything that needs a
 * decision (clipping, arrowheads, where a label sits) is made here, so the
 * backends stay trivial and the two outputs match.
 */

import { VisualError } from './expr'

export type Dash = 'solid' | 'dashed' | 'dotted'

/** Where a label sits relative to its point: "n" puts it above, "c" centres it. */
export type Anchor = 'c' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export interface PathItem {
  kind: 'path'
  /** Flat [x0, y0, x1, y1, ...] in pixels. */
  points: number[]
  closed?: boolean
  stroke?: string
  width?: number
  dash?: Dash
  fill?: string
  fillOpacity?: number
}

export interface DotItem {
  kind: 'dot'
  x: number
  y: number
  r: number
  color: string
  /** An open dot: white inside, coloured ring. */
  open?: boolean
}

export interface LabelItem {
  kind: 'label'
  x: number
  y: number
  /** Plain text with `$...$` math. */
  text: string
  anchor: Anchor
  color?: string
  bold?: boolean
  /** Axis numbers and other secondary text. */
  small?: boolean
}

export type SceneItem = PathItem | DotItem | LabelItem

export interface Scene {
  kind: 'graph' | 'figure'
  width: number
  height: number
  items: SceneItem[]
  /** Lines of the block that could not be read; the rest is still drawn. */
  errors: string[]
}

// ---------------------------------------------------------------------------
// Colours and line styles
// ---------------------------------------------------------------------------

export const INK = '#16161a'

export const COLORS: Record<string, string> = {
  navy: '#19468c',
  blue: '#2563eb',
  red: '#c8322b',
  green: '#1f8a4c',
  orange: '#d9700e',
  purple: '#7c3aed',
  gold: '#b8892b',
  gray: '#7a7f87',
  grey: '#7a7f87',
  black: INK,
}

/** Curves and shapes without a colour take these in turn. */
export const COLOR_CYCLE = [COLORS.navy, COLORS.red, COLORS.green, COLORS.orange, COLORS.purple]

export interface Options {
  color?: string
  style?: Dash
  weight?: 'thick' | 'thin'
  /** `false` from "noshade", `true` from "fill". */
  shade?: boolean
  label?: string
  ticks?: number
  arcs?: number
  parallel?: number
  flip?: boolean
  hidden?: boolean
  nolabel?: boolean
  lengths?: boolean
  angles?: boolean
  reflex?: boolean
  right?: boolean
  nodots?: boolean
  nocenter?: boolean
}

export function lineWidth(options: Options, base: number): number {
  if (options.weight === 'thick') return base * 1.6
  if (options.weight === 'thin') return base * 0.6
  return base
}

// ---------------------------------------------------------------------------
// Reading a line
// ---------------------------------------------------------------------------

/** Split on a separator, ignoring ones inside (), {}, [] or $...$. */
export function splitTop(s: string, separator = ','): string[] {
  const parts: string[] = []
  let buffer = ''
  let depth = 0
  let inMath = false
  for (const c of s) {
    if (c === '$') inMath = !inMath
    else if (!inMath && '([{'.includes(c)) depth++
    else if (!inMath && ')]}'.includes(c)) depth--
    else if (c === separator && depth === 0 && !inMath) {
      parts.push(buffer)
      buffer = ''
      continue
    }
    buffer += c
  }
  parts.push(buffer)
  return parts
}

/** Index of the ")" that closes the "(" at s[i]. */
export function matchParen(s: string, i: number): number {
  let depth = 0
  for (let j = i; j < s.length; j++) {
    if (s[j] === '(') depth++
    else if (s[j] === ')') {
      depth--
      if (depth === 0) return j
    }
  }
  throw new VisualError(`unbalanced parentheses in "${s}"`)
}

const FIGURE_FLAGS: Record<string, keyof Options | 'noarc'> = {
  flip: 'flip',
  mirror: 'flip',
  fill: 'shade',
  shade: 'shade',
  shaded: 'shade',
  filled: 'shade',
  hidden: 'hidden',
  hide: 'hidden',
  nolabel: 'nolabel',
  nolabels: 'nolabel',
  unlabeled: 'nolabel',
  lengths: 'lengths',
  angles: 'angles',
  reflex: 'reflex',
  right: 'right',
  nodots: 'nodots',
  nocenter: 'nocenter',
  noarc: 'noarc',
}

/**
 * "y = x^2 [red, dashed, label: $f$]" -> the body and its options. With
 * `figure`, the geometry options are accepted too (ticks: n, arcs: n,
 * parallel: n, flip, fill, hidden, ...).
 */
export function splitOptions(line: string, figure = false): { body: string; options: Options } {
  const match = /^(.*?)\s*\[([^[\]]*)\]\s*$/.exec(line)
  if (!match) return { body: line, options: {} }
  const options: Options = {}
  for (const raw of splitTop(match[2], ',')) {
    const piece = raw.trim()
    if (!piece) continue
    const low = piece.toLowerCase()
    if (figure) {
      const count = /^(ticks?|arcs?|parallel|arrows?)\s*(?:[:=]\s*(\d+))?$/.exec(low)
      if (count) {
        const n = count[2] ? Number(count[2]) : 1
        if (n < 0 || n > 4) throw new VisualError(`${count[1]}: use 0 to 4`)
        if (count[1].startsWith('tick')) options.ticks = n
        else if (count[1].startsWith('arc')) options.arcs = n
        else options.parallel = n
        continue
      }
      const flag = FIGURE_FLAGS[low.replace(/\s+/g, '')]
      if (flag === 'noarc') {
        options.arcs = 0
        continue
      }
      if (flag) {
        ;(options as Record<string, unknown>)[flag] = true
        continue
      }
    }
    const keyed = /^(label|colou?r)\s*[:=]\s*(.*)$/i.exec(piece)
    if (keyed) {
      const value = keyed[2].trim()
      if (keyed[1].toLowerCase() === 'label') options.label = value.replace(/^["']|["']$/g, '')
      else if (COLORS[value.toLowerCase()]) options.color = COLORS[value.toLowerCase()]
      else throw new VisualError(`unknown color "${value}"`)
    } else if (COLORS[low]) options.color = COLORS[low]
    else if (low === 'dashed' || low === 'dotted' || low === 'solid') options.style = low
    else if (low === 'thick' || low === 'thin') options.weight = low
    else if (['noshade', 'no shade', 'unshaded', 'nofill', 'no fill'].includes(low)) {
      options.shade = false
    } else {
      throw new VisualError(`unknown option "${piece}"`)
    }
  }
  return { body: match[1], options }
}

export function onOff(value: string, key: string): boolean {
  const v = value.trim().toLowerCase()
  if (['on', 'yes', 'true', 'show'].includes(v)) return true
  if (['off', 'no', 'false', 'none', 'hide'].includes(v)) return false
  throw new VisualError(`${key}: expected on or off, got "${value}"`)
}

/** "small" / "medium" / "large", or a length such as "3in" or "6cm", in pixels. */
export function parseSize(value: string, named: Record<string, number>, max: number): number {
  const low = value.trim().toLowerCase()
  if (named[low]) return named[low]
  const length = /^([\d.]+)\s*(in|cm|px)?$/.exec(low)
  if (!length) throw new VisualError('size: use small, medium or large')
  const amount = Number(length[1])
  const px = length[2] === 'px' ? amount : length[2] === 'cm' ? (amount / 2.54) * 76 : amount * 76
  return Math.min(max, Math.max(named.small * 0.8, px))
}

// ---------------------------------------------------------------------------
// Numbers and label sizes
// ---------------------------------------------------------------------------

export function formatNumber(value: number, digits = 4): string {
  const text = value.toFixed(digits).replace(/\.?0+$/, '')
  return text === '-0' || text === '' ? '0' : text
}

/** Rough half-width and half-height of a label in pixels (13px text). */
export function labelHalfSize(text: string, small = false): { hw: number; hh: number } {
  const visible = text.replace(/\\[A-Za-z]+|[{}$^_\\]/g, '')
  const perChar = small ? 5.6 : 6.6
  const tall = /\\d?frac/.test(text)
  return {
    hw: (perChar * Math.max(1, visible.length) + 4) / 2,
    hh: tall ? (small ? 11 : 13) : small ? 7 : 8.5,
  }
}

/**
 * The centre for a label that should sit `gap` pixels from a point in a given
 * direction, far enough that its box clears the point.
 */
export function labelCenter(
  x: number,
  y: number,
  dx: number,
  dy: number,
  gap: number,
  text: string,
): { x: number; y: number } {
  const length = Math.hypot(dx, dy) || 1
  const ux = dx / length
  const uy = dy / length
  const { hw, hh } = labelHalfSize(text)
  const reach = gap + Math.abs(ux) * hw + Math.abs(uy) * hh
  return { x: x + ux * reach, y: y + uy * reach }
}

// ---------------------------------------------------------------------------
// Shapes shared by graphs and figures
// ---------------------------------------------------------------------------

/** A filled arrowhead with its tip at (x, y), pointing along (dx, dy). */
export function arrowHead(
  x: number,
  y: number,
  dx: number,
  dy: number,
  color: string,
  size = 7,
): PathItem {
  const length = Math.hypot(dx, dy) || 1
  const ux = dx / length
  const uy = dy / length
  const bx = x - ux * size
  const by = y - uy * size
  const half = size * 0.38
  return {
    kind: 'path',
    points: [x, y, bx - uy * half, by + ux * half, bx + uy * half, by - ux * half],
    closed: true,
    fill: color,
    fillOpacity: 1,
  }
}

/** Points along a circular arc, angles in degrees, counterclockwise in a y-up frame. */
export function arcPoints(
  cx: number,
  cy: number,
  r: number,
  startDeg: number,
  endDeg: number,
  stepDeg = 5,
): number[] {
  const steps = Math.max(2, Math.ceil(Math.abs(endDeg - startDeg) / stepDeg))
  const points: number[] = []
  for (let i = 0; i <= steps; i++) {
    const angle = ((startDeg + ((endDeg - startDeg) * i) / steps) * Math.PI) / 180
    points.push(cx + r * Math.cos(angle), cy + r * Math.sin(angle))
  }
  return points
}

// ---------------------------------------------------------------------------
// Clipping to a rectangle (in whatever units the caller works in)
// ---------------------------------------------------------------------------

export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Liang-Barsky: the part of segment ab inside the box, or null. */
export function clipSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  box: Box,
): [number, number, number, number] | null {
  let t0 = 0
  let t1 = 1
  const dx = bx - ax
  const dy = by - ay
  const edges: Array<[number, number]> = [
    [-dx, ax - box.x0],
    [dx, box.x1 - ax],
    [-dy, ay - box.y0],
    [dy, box.y1 - ay],
  ]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null
      continue
    }
    const r = q / p
    if (p < 0) {
      if (r > t1) return null
      if (r > t0) t0 = r
    } else {
      if (r < t0) return null
      if (r < t1) t1 = r
    }
  }
  return [ax + t0 * dx, ay + t0 * dy, ax + t1 * dx, ay + t1 * dy]
}

/** The pieces of a polyline that lie inside the box. */
export function clipPolyline(points: number[], box: Box): number[][] {
  const pieces: number[][] = []
  let current: number[] = []
  const flush = () => {
    if (current.length >= 4) pieces.push(current)
    current = []
  }
  for (let i = 0; i + 3 < points.length; i += 2) {
    const clipped = clipSegment(points[i], points[i + 1], points[i + 2], points[i + 3], box)
    if (!clipped) {
      flush()
      continue
    }
    const [ax, ay, bx, by] = clipped
    const n = current.length
    const joins =
      n >= 2 && Math.abs(current[n - 2] - ax) < 1e-9 && Math.abs(current[n - 1] - ay) < 1e-9
    if (!joins) {
      flush()
      current.push(ax, ay)
    }
    current.push(bx, by)
  }
  flush()
  return pieces
}

/** Sutherland-Hodgman: a polygon clipped to the box (may come back empty). */
export function clipPolygon(points: number[], box: Box): number[] {
  type P = [number, number]
  let ring: P[] = []
  for (let i = 0; i + 1 < points.length; i += 2) ring.push([points[i], points[i + 1]])
  const edges: Array<{ inside: (p: P) => boolean; cross: (a: P, b: P) => P }> = [
    {
      inside: (p) => p[0] >= box.x0,
      cross: (a, b) => [box.x0, a[1] + ((b[1] - a[1]) * (box.x0 - a[0])) / (b[0] - a[0])],
    },
    {
      inside: (p) => p[0] <= box.x1,
      cross: (a, b) => [box.x1, a[1] + ((b[1] - a[1]) * (box.x1 - a[0])) / (b[0] - a[0])],
    },
    {
      inside: (p) => p[1] >= box.y0,
      cross: (a, b) => [a[0] + ((b[0] - a[0]) * (box.y0 - a[1])) / (b[1] - a[1]), box.y0],
    },
    {
      inside: (p) => p[1] <= box.y1,
      cross: (a, b) => [a[0] + ((b[0] - a[0]) * (box.y1 - a[1])) / (b[1] - a[1]), box.y1],
    },
  ]
  for (const edge of edges) {
    const next: P[] = []
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      const aIn = edge.inside(a)
      const bIn = edge.inside(b)
      if (aIn && bIn) next.push(b)
      else if (aIn && !bIn) next.push(edge.cross(a, b))
      else if (!aIn && bIn) next.push(edge.cross(a, b), b)
    }
    ring = next
    if (!ring.length) break
  }
  return ring.flat()
}

/** Ramer-Douglas-Peucker: drop points that do not change the shape visibly. */
export function simplify(points: number[], tolerance = 0.25): number[] {
  const n = points.length / 2
  if (n < 3) return points
  const keep = new Array<boolean>(n).fill(false)
  keep[0] = keep[n - 1] = true
  const stack: Array<[number, number]> = [[0, n - 1]]
  while (stack.length) {
    const [i, j] = stack.pop()!
    const ax = points[i * 2]
    const ay = points[i * 2 + 1]
    const dx = points[j * 2] - ax
    const dy = points[j * 2 + 1] - ay
    const norm = Math.hypot(dx, dy)
    let best = -1
    let index = -1
    for (let k = i + 1; k < j; k++) {
      // A closed loop starts and ends at the same place: with no chord to
      // measure from, use the distance to that point.
      const d =
        norm < 1e-9
          ? Math.hypot(points[k * 2] - ax, points[k * 2 + 1] - ay)
          : Math.abs(dy * (points[k * 2] - ax) - dx * (points[k * 2 + 1] - ay)) / norm
      if (d > best) {
        best = d
        index = k
      }
    }
    if (index !== -1 && best > tolerance) {
      keep[index] = true
      stack.push([i, index], [index, j])
    }
  }
  const out: number[] = []
  for (let k = 0; k < n; k++) if (keep[k]) out.push(points[k * 2], points[k * 2 + 1])
  return out
}

/**
 * Shift a scene so everything, labels included, sits inside the canvas with a
 * small margin, and size the canvas to fit.
 */
export function fitScene(kind: Scene['kind'], items: SceneItem[], errors: string[], margin = 6): Scene {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const grow = (x0: number, y0: number, x1: number, y1: number) => {
    minX = Math.min(minX, x0)
    minY = Math.min(minY, y0)
    maxX = Math.max(maxX, x1)
    maxY = Math.max(maxY, y1)
  }
  for (const item of items) {
    if (item.kind === 'path') {
      for (let i = 0; i + 1 < item.points.length; i += 2) {
        grow(item.points[i], item.points[i + 1], item.points[i], item.points[i + 1])
      }
    } else if (item.kind === 'dot') {
      grow(item.x - item.r, item.y - item.r, item.x + item.r, item.y + item.r)
    } else {
      const { hw, hh } = labelHalfSize(item.text, item.small)
      const [ox, oy] = anchorOffset(item.anchor)
      const cx = item.x + ox * hw
      const cy = item.y + oy * hh
      grow(cx - hw, cy - hh, cx + hw, cy + hh)
    }
  }
  if (!Number.isFinite(minX)) return { kind, width: 0, height: 0, items: [], errors }
  const dx = margin - minX
  const dy = margin - minY
  const shifted = items.map((item): SceneItem => {
    if (item.kind === 'path') {
      return { ...item, points: item.points.map((v, i) => v + (i % 2 === 0 ? dx : dy)) }
    }
    return { ...item, x: item.x + dx, y: item.y + dy }
  })
  return {
    kind,
    width: Math.ceil(maxX - minX + margin * 2),
    height: Math.ceil(maxY - minY + margin * 2),
    items: shifted,
    errors,
  }
}

/** Where a label's centre is, relative to its point, in half-sizes. */
export function anchorOffset(anchor: Anchor): [number, number] {
  const x = anchor.includes('e') ? 1 : anchor.includes('w') ? -1 : 0
  const y = anchor.includes('s') ? 1 : anchor.includes('n') ? -1 : 0
  return [x, y]
}
