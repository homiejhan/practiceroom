/**
 * `[graph]` blocks: a coordinate plane with functions, inequalities, points
 * and simple shapes. The line format follows the Worksheet Studio generator
 * in my TutorAssist project, so a block written for one works in the other:
 *
 *   x: -5 to 5
 *   y: -5 to 5
 *   y = 2x - 3 [label: $f$]
 *   y = x + 3 for -3 <= x < 0
 *   y >= -x + 2
 *   point A (1, -1)
 */

import { compileExpr, constValue, VisualError } from './expr'
import {
  COLOR_CYCLE,
  COLORS,
  INK,
  anchorOffset,
  arrowHead,
  clipPolygon,
  clipPolyline,
  clipSegment,
  formatNumber,
  labelCenter,
  labelHalfSize,
  lineWidth,
  matchParen,
  onOff,
  parseSize,
  simplify,
  splitOptions,
  splitTop,
  type Box,
  type Options,
  type Scene,
  type SceneItem,
} from './scene'

// Plot widths in pixels. Two small graphs fit side by side on a question card.
const SIZES = { small: 118, medium: 200, large: 250 }
const GRID_COLOR = '#dde1e6'
const AXIS_COLOR = '#2b2f36'
const SHADE_OPACITY = 0.16

type Relation = '=' | '<' | '>' | '<=' | '>='

const REL = '(<=|>=|=<|=>|≤|≥|\\\\leq?|\\\\geq?|<|>|=)'
const SETTING_RE = /^(x|y|xstep|ystep|step|grid|numbers|xlabel|ylabel|size|title)\s*:\s*(.*)$/i
const CURVE_RE = new RegExp(`^(y|[A-Za-z]\\s*\\(\\s*x\\s*\\))\\s*${REL}\\s*(.+)$`)
const VLINE_RE = new RegExp(`^x\\s*${REL}\\s*(.+)$`)
const SHAPE_RE = /^(open\s+point|points?|segment|vector|line|polygon|circle|text)\b\s*(.*)$/i
const FILLER = new Set(['to', 'and', 'from', 'through', 'center', 'centre', 'at', 'with', 'vertices'])

function relation(op: string): Relation {
  if (op === '=<' || op === '≤' || op === '\\le' || op === '\\leq') return '<='
  if (op === '=>' || op === '≥' || op === '\\ge' || op === '\\geq') return '>='
  return op as Relation
}

interface Domain {
  lo: number | null
  loClosed: boolean
  hi: number | null
  hiClosed: boolean
}

interface Coord {
  name: string | null
  x: number
  y: number
}

type ShapeKind =
  | 'point'
  | 'open point'
  | 'points'
  | 'segment'
  | 'vector'
  | 'line'
  | 'polygon'
  | 'circle'
  | 'text'

type GraphItem =
  | {
      kind: 'curve'
      rel: Relation
      f: (x: number) => number | null
      domain: Domain | null
      options: Options
    }
  | { kind: 'vline'; rel: Relation; c: number; options: Options }
  | { kind: ShapeKind; coords: Coord[]; radius: number; text: string; options: Options }

interface Graph {
  x: [number, number]
  y: [number, number]
  step: number | null
  xstep: number | null
  ystep: number | null
  grid: boolean
  numbers: boolean
  xlabel: string | null
  ylabel: string | null
  size: number
  title: string | null
  items: GraphItem[]
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseRange(value: string, what: string): [number, number] {
  const parts = value
    .trim()
    .replace(/^\[|\]$/g, '')
    .split(/\s*(?:\bto\b|\.\.|,)\s*/)
    .filter((part) => part.trim())
  if (parts.length !== 2) {
    throw new VisualError(`${what} range should look like "-5 to 5", got "${value}"`)
  }
  const lo = constValue(parts[0])
  const hi = constValue(parts[1])
  if (!(lo < hi)) throw new VisualError(`${what} range "${value}": the first number must be smaller`)
  return [lo, hi]
}

/** "A(1,2) B (3, 4) to (5,6)" -> the coordinates (with names) and any words left over. */
function scanCoords(s: string): { coords: Coord[]; words: string[] } {
  const coords: Coord[] = []
  const words: string[] = []
  let name: string | null = null
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c) || c === ',') {
      i++
      continue
    }
    if (c === '(') {
      const j = matchParen(s, i)
      const parts = splitTop(s.slice(i + 1, j), ',')
      if (parts.length !== 2) {
        throw new VisualError(`expected a point like (2, -3), got "${s.slice(i, j + 1)}"`)
      }
      coords.push({ name, x: constValue(parts[0]), y: constValue(parts[1]) })
      name = null
      i = j + 1
      continue
    }
    const rest = s.slice(i)
    const word = /^(?:\$[^$]*\$|[A-Za-z][A-Za-z0-9_']*)/.exec(rest)
    if (word) {
      if (name) words.push(name)
      name = FILLER.has(word[0].toLowerCase()) ? null : word[0]
      i += word[0].length
      continue
    }
    const other = /^[^\sA-Za-z(,$]+/.exec(rest)
    if (!other) throw new VisualError(`didn't understand "${rest}"`)
    if (name) {
      words.push(name)
      name = null
    }
    if (!['--', '-', '->'].includes(other[0])) words.push(other[0])
    i += other[0].length
  }
  if (name) words.push(name)
  return { coords, words }
}

const FLIPPED: Record<string, string> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=' }

/** "-2 <= x < 3" or "x >= 0". */
function parseDomain(source: string): Domain {
  const tokens = source.split(new RegExp(REL)).map((token) => token.trim())
  const position = tokens.indexOf('x')
  if ((tokens.length !== 3 && tokens.length !== 5) || position < 0 || position % 2 !== 0) {
    throw new VisualError(`domain "${source}" should look like "-2 <= x < 3" or "x >= 0"`)
  }
  const domain: Domain = { lo: null, loClosed: true, hi: null, hiClosed: true }
  for (const side of [-1, 1]) {
    const k = position + 2 * side
    if (k < 0 || k >= tokens.length) continue
    let op: string = relation(tokens[position + side])
    const value = constValue(tokens[k])
    // Read as "x OP value": flip the operator when the value is on the left.
    if (side === -1) op = FLIPPED[op] ?? op
    if (op === '>' || op === '>=') {
      domain.lo = value
      domain.loClosed = op === '>='
    } else if (op === '<' || op === '<=') {
      domain.hi = value
      domain.hiClosed = op === '<='
    } else {
      throw new VisualError(`domain "${source}" uses "=": use <, <=, > or >=`)
    }
  }
  return domain
}

const NEEDS: Record<ShapeKind, number> = {
  point: 1,
  'open point': 1,
  points: 1,
  segment: 2,
  vector: 2,
  line: 2,
  polygon: 3,
  circle: 1,
  text: 1,
}

function parseLine(graph: Graph, line: string): void {
  const setting = SETTING_RE.exec(line)
  if (setting) {
    const key = setting[1].toLowerCase()
    const value = setting[2].trim()
    if (key === 'x' || key === 'y') graph[key] = parseRange(value, key)
    else if (key === 'step' || key === 'xstep' || key === 'ystep') {
      const step = constValue(value)
      if (step <= 0) throw new VisualError('step must be positive')
      graph[key] = step
    } else if (key === 'grid' || key === 'numbers') graph[key] = onOff(value, key)
    else if (key === 'xlabel' || key === 'ylabel') {
      graph[key] = ['none', 'off', ''].includes(value.toLowerCase()) ? null : value
    } else if (key === 'size') graph.size = parseSize(value, SIZES, 270)
    else graph.title = value || null
    return
  }

  const { body, options } = splitOptions(line)
  const shape = SHAPE_RE.exec(body)
  const curve = CURVE_RE.exec(body)
  const vline = VLINE_RE.exec(body)

  if (shape) {
    const kind = shape[1].toLowerCase().replace(/\s+/g, ' ') as ShapeKind
    let rest = shape[2]
    let radius = 0
    if (kind === 'circle') {
      const found = /\bradius\s*[:=]?\s*(.+)$/i.exec(rest)
      if (!found) throw new VisualError('circle needs a radius: circle (0, 0) radius 3')
      radius = constValue(found[1])
      rest = rest.slice(0, found.index)
    }
    let text = ''
    let coords: Coord[]
    if (kind === 'text') {
      // Only the position is a coordinate; the rest of the line is the text.
      const at = /^\s*[A-Za-z]?\s*(\([^)]*\))\s*:?\s*(.*)$/.exec(rest)
      if (!at) throw new VisualError('text needs a position and words: text (2, 3) Hello')
      coords = scanCoords(at[1]).coords
      text = at[2].trim().replace(/^["']|["']$/g, '')
      if (!text) throw new VisualError('text needs something to write: text (2, 3) Hello')
    } else {
      const scanned = scanCoords(rest)
      coords = scanned.coords
      if (scanned.words.length) {
        throw new VisualError(`didn't understand "${scanned.words.join(' ')}"`)
      }
    }
    const need = NEEDS[kind]
    const exact = kind !== 'points' && kind !== 'polygon'
    if (coords.length < need || (exact && coords.length > need)) {
      throw new VisualError(`"${kind}" takes ${need} point(s), found ${coords.length}`)
    }
    if (kind === 'line' && coords[0].x === coords[1].x && coords[0].y === coords[1].y) {
      throw new VisualError('line needs two different points')
    }
    graph.items.push({ kind, coords, radius, text, options })
    return
  }

  if (curve) {
    const [expression, domain] = curve[3].split(/\s+for\s+/)
    graph.items.push({
      kind: 'curve',
      rel: relation(curve[2]),
      f: compileExpr(expression),
      domain: domain === undefined ? null : parseDomain(domain),
      options,
    })
    return
  }

  if (vline) {
    graph.items.push({ kind: 'vline', rel: relation(vline[1]), c: constValue(vline[2]), options })
    return
  }

  throw new VisualError(
    'expected a setting (x: -5 to 5), an equation (y = 2x + 1), or point / points / segment / vector / line / polygon / circle / text',
  )
}

// ---------------------------------------------------------------------------
// Ticks
// ---------------------------------------------------------------------------

/** v as (num/den)·π with a small denominator, or null. */
function piFraction(v: number, maxDen = 12): [number, number] | null {
  const ratio = v / Math.PI
  for (let den = 1; den <= maxDen; den++) {
    const num = Math.round(ratio * den)
    if (Math.abs(ratio * den - num) < 1e-9 * Math.max(1, Math.abs(ratio * den))) return [num, den]
  }
  return null
}

function autoStep(lo: number, hi: number): number {
  const range = hi - lo
  const wholeNumbers = Number.isInteger(lo) && Number.isInteger(hi)
  if (!wholeNumbers && piFraction(lo) && piFraction(hi)) {
    const steps = [1 / 12, 1 / 6, 1 / 4, 1 / 3, 1 / 2, 1, 2, 4].map((k) => k * Math.PI)
    return steps.find((step) => range / step <= 8.001) ?? 4 * Math.PI
  }
  if (wholeNumbers && range >= 4 && range <= 24) return 1
  const raw = range / 10
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 5, 10]) if (m * magnitude >= raw - 1e-12) return m * magnitude
  return 10 * magnitude
}

function tickLabel(value: number, piMode: boolean): string {
  if (!piMode) return `$${formatNumber(value)}$`
  const fraction = piFraction(value)
  if (!fraction) return `$${formatNumber(value, 2)}$`
  const [num, den] = fraction
  if (num === 0) return '$0$'
  const sign = num < 0 ? '-' : ''
  const top = Math.abs(num) === 1 ? '\\pi' : `${Math.abs(num)}\\pi`
  return den === 1 ? `$${sign}${top}$` : `$${sign}\\frac{${top}}{${den}}$`
}

function tickValues(lo: number, hi: number, step: number): number[] {
  const values: number[] = []
  const first = Math.ceil(lo / step - 1e-9)
  const last = Math.floor(hi / step + 1e-9)
  // Never draw hundreds of grid lines for a mistyped step.
  const stride = Math.max(1, Math.ceil((last - first + 1) / 60))
  for (let k = first; k <= last; k += stride) values.push(k * step)
  return values
}

// ---------------------------------------------------------------------------
// Curve sampling: gaps where a function is undefined, breaks at jumps
// ---------------------------------------------------------------------------

type Fn = (x: number) => number | null

/** Bisect toward the edge of f's domain; the last point where it is defined. */
function refineEdge(f: Fn, goodX: number, badX: number): [number, number] {
  let good = goodX
  let bad = badX
  let goodY = f(good) ?? 0
  for (let i = 0; i < 40; i++) {
    const mid = (good + bad) / 2
    const value = f(mid)
    if (value === null) bad = mid
    else {
      good = mid
      goodY = value
    }
  }
  return [good, goodY]
}

/** True when f jumps between two samples (an asymptote or a step). */
function jumps(f: Fn, x0: number, y0: number, x1: number, y1: number, lo: number, hi: number): boolean {
  const range = hi - lo
  if ((y0 > hi && y1 > hi) || (y0 < lo && y1 < lo)) return false
  if (Math.abs(y1 - y0) < 0.02 * range) return false
  let a = x0
  let fa = y0
  let b = x1
  let fb = y1
  for (let i = 0; i < 40; i++) {
    const mid = (a + b) / 2
    const value = f(mid)
    if (value === null) return true
    if (Math.abs(value - fa) >= Math.abs(fb - value)) {
      b = mid
      fb = value
    } else {
      a = mid
      fa = value
    }
    // The gap shrinks with the interval: continuous, just steep.
    if (Math.abs(fb - fa) < 1e-3 * range) return false
  }
  return true
}

/** Sample f on [lo, hi] into continuous runs of flat [x, y, ...] points. */
function sampleRuns(f: Fn, lo: number, hi: number, ylo: number, yhi: number, n = 240): number[][] {
  const runs: number[][] = []
  let current: number[] = []
  let previousBad: number | null = null
  for (let i = 0; i <= n; i++) {
    const x = lo + ((hi - lo) * i) / n
    const y = f(x)
    if (y === null) {
      if (current.length) {
        current.push(...refineEdge(f, current[current.length - 2], x))
        runs.push(current)
        current = []
      }
      previousBad = x
      continue
    }
    if (!current.length && previousBad !== null) current.push(...refineEdge(f, x, previousBad))
    const m = current.length
    if (m && jumps(f, current[m - 2], current[m - 1], x, y, ylo, yhi)) {
      runs.push(current)
      current = []
    }
    current.push(x, y)
    previousBad = null
  }
  if (current.length) runs.push(current)
  return runs.filter((run) => run.length >= 4)
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function layout(graph: Graph, errors: string[]): Scene {
  const [x0, x1] = graph.x
  const [y0, y1] = graph.y
  const xr = x1 - x0
  const yr = y1 - y0
  const W = graph.size
  const ratio = yr / xr
  // Equal units when the window is roughly square; otherwise a fixed shape.
  const H = ratio >= 0.6 && ratio <= 1.6 ? W * ratio : W * 0.8
  const box: Box = { x0, y0, x1, y1 }

  const xstep = graph.xstep ?? graph.step ?? autoStep(x0, x1)
  const ystep = graph.ystep ?? graph.step ?? autoStep(y0, y1)
  const isPi = (step: number) => !Number.isInteger(step) && piFraction(step) !== null
  const xTicks = tickValues(x0, x1, xstep)
  const yTicks = tickValues(y0, y1, ystep)

  // Which ticks get a number: every k-th one, with k as small as fits
  // without the numbers touching, counted from 0 so the origin stays aligned.
  const thin = (ticks: number[], pxPerUnit: number, need: number): number[] => {
    if (ticks.length < 2) return ticks
    const spacing = Math.abs(ticks[1] - ticks[0])
    const every = [1, 2, 5, 10, 20, 50, 100].find((k) => spacing * pxPerUnit * k >= need) ?? 100
    return ticks.filter((value) => {
      const k = value / (spacing * every)
      return Math.abs(k - Math.round(k)) < 1e-6
    })
  }
  const labelWidth = (value: number, step: number) =>
    labelHalfSize(tickLabel(value, isPi(step)), true).hw * 2
  const widestX = Math.max(0, ...xTicks.map((value) => labelWidth(value, xstep)))
  const xNumbers = graph.numbers ? thin(xTicks, W / xr, widestX + 5) : []
  const yNumbers = graph.numbers ? thin(yTicks, H / yr, 15) : []

  // The origin's "0" would sit on top of the other axis, so it is dropped
  // wherever that axis passes through.
  const xShown = xNumbers.filter((value) => !(Math.abs(value) < 1e-9 && x0 < 0 && x1 > 0))
  const yShown = yNumbers.filter((value) => !(Math.abs(value) < 1e-9 && x0 <= 0 && x1 >= 0))
  const yLabelWidth = Math.max(0, ...yShown.map((value) => labelWidth(value, ystep)))

  const shortLabel = (text: string | null) =>
    !!text && text.replace(/\\[A-Za-z]+|[{}$^_\\]/g, '').length <= 3
  // Numbers sit left of the y-axis and below the x-axis. They need margin
  // only when that axis is at (or near) the edge of the plot.
  const yAxisInset = ((Math.min(x1, Math.max(x0, 0)) - x0) / xr) * W
  const xAxisInset = ((Math.min(y1, Math.max(y0, 0)) - y0) / yr) * H
  let padL = 12
  let padR = 12
  let padT = 12
  let padB = 12
  if (graph.numbers) {
    padL = Math.max(padL, yLabelWidth + 9 - yAxisInset)
    padB = Math.max(padB, 21 - xAxisInset)
  }
  if (graph.xlabel) {
    if (shortLabel(graph.xlabel)) padR = 11 + labelHalfSize(graph.xlabel).hw * 2 + 3
    else padB += 19
  }
  if (graph.ylabel) padT = 27
  const titleHeight = graph.title ? 20 : 0
  padT += titleHeight

  const ox = padL
  const oy = padT
  const X = (x: number) => ox + ((x - x0) / xr) * W
  const Y = (y: number) => oy + ((y1 - y) / yr) * H
  const toPx = (points: number[]) => points.map((v, i) => (i % 2 === 0 ? X(v) : Y(v)))

  const grid: SceneItem[] = []
  const shading: SceneItem[] = []
  const axes: SceneItem[] = []
  const curves: SceneItem[] = []
  const openDots: SceneItem[] = []
  const dots: SceneItem[] = []
  const labels: SceneItem[] = []

  // ---- grid and axes ----
  if (graph.grid) {
    for (const value of xTicks) {
      grid.push({ kind: 'path', points: [X(value), oy, X(value), oy + H], stroke: GRID_COLOR, width: 0.7 })
    }
    for (const value of yTicks) {
      grid.push({ kind: 'path', points: [ox, Y(value), ox + W, Y(value)], stroke: GRID_COLOR, width: 0.7 })
    }
  }
  const axisX = X(Math.min(x1, Math.max(x0, 0)))
  const axisY = Y(Math.min(y1, Math.max(y0, 0)))
  const tip = 7
  axes.push({
    kind: 'path',
    points: [x0 < 0 ? ox - tip + 3 : ox, axisY, ox + W + tip - 3, axisY],
    stroke: AXIS_COLOR,
    width: 1.1,
  })
  axes.push(arrowHead(ox + W + tip, axisY, 1, 0, AXIS_COLOR, 6))
  if (x0 < 0) axes.push(arrowHead(ox - tip, axisY, -1, 0, AXIS_COLOR, 6))
  axes.push({
    kind: 'path',
    points: [axisX, y0 < 0 ? oy + H + tip - 3 : oy + H, axisX, oy - tip + 3],
    stroke: AXIS_COLOR,
    width: 1.1,
  })
  axes.push(arrowHead(axisX, oy - tip, 0, -1, AXIS_COLOR, 6))
  if (y0 < 0) axes.push(arrowHead(axisX, oy + H + tip, 0, 1, AXIS_COLOR, 6))

  if (!graph.grid) {
    for (const value of xTicks) {
      if (Math.abs(value) > 1e-9) {
        axes.push({ kind: 'path', points: [X(value), axisY - 3, X(value), axisY + 3], stroke: AXIS_COLOR, width: 0.9 })
      }
    }
    for (const value of yTicks) {
      if (Math.abs(value) > 1e-9) {
        axes.push({ kind: 'path', points: [axisX - 3, Y(value), axisX + 3, Y(value)], stroke: AXIS_COLOR, width: 0.9 })
      }
    }
  }
  for (const value of xShown) {
    labels.push({
      kind: 'label',
      x: X(value),
      y: axisY + 3,
      text: tickLabel(value, isPi(xstep)),
      anchor: 's',
      small: true,
      color: AXIS_COLOR,
    })
  }
  for (const value of yShown) {
    labels.push({
      kind: 'label',
      x: axisX - 4,
      y: Y(value),
      text: tickLabel(value, isPi(ystep)),
      anchor: 'w',
      small: true,
      color: AXIS_COLOR,
    })
  }
  if (graph.xlabel) {
    if (shortLabel(graph.xlabel)) {
      labels.push({ kind: 'label', x: ox + W + tip + 3, y: axisY, text: graph.xlabel, anchor: 'e' })
    } else {
      labels.push({
        kind: 'label',
        x: ox + W / 2,
        y: oy + H + padB - 19 + 2,
        text: graph.xlabel,
        anchor: 's',
        small: true,
      })
    }
  }
  if (graph.ylabel) {
    if (shortLabel(graph.ylabel)) {
      labels.push({ kind: 'label', x: axisX, y: oy - tip - 2, text: graph.ylabel, anchor: 'n' })
    } else {
      labels.push({ kind: 'label', x: 2, y: oy - tip - 3, text: graph.ylabel, anchor: 'ne', small: true })
    }
  }
  if (graph.title) {
    labels.push({
      kind: 'label',
      x: ox + W / 2,
      y: 2,
      text: graph.title,
      anchor: 's',
      bold: true,
      color: COLORS.navy,
    })
  }

  // ---- helpers for items ----
  const inside = (x: number, y: number) =>
    x >= x0 - 1e-9 && x <= x1 + 1e-9 && y >= y0 - 1e-9 && y <= y1 + 1e-9
  const dash = (options: Options, strict = false) => options.style ?? (strict ? 'dashed' : 'solid')
  const stroke = (points: number[], color: string, options: Options, base = 1.7, strict = false) => {
    for (const piece of clipPolyline(points, box)) {
      curves.push({
        kind: 'path',
        points: simplify(toPx(piece)),
        stroke: color,
        width: lineWidth(options, base),
        dash: dash(options, strict),
      })
    }
  }
  const shade = (points: number[], color: string) => {
    const clipped = clipPolygon(points, box)
    if (clipped.length >= 6) {
      shading.push({ kind: 'path', points: toPx(clipped), closed: true, fill: color, fillOpacity: SHADE_OPACITY })
    }
  }
  const keepInPlot = (center: { x: number; y: number }, text: string) => {
    const { hw, hh } = labelHalfSize(text)
    return {
      x: Math.min(ox + W - hw, Math.max(ox + hw, center.x)),
      y: Math.min(oy + H - hh, Math.max(oy + hh, center.y)),
    }
  }

  // Labels already on the graph (axis numbers included), so a new one can be
  // put where it does not cover another.
  const occupied: Array<[number, number, number, number]> = []
  for (const item of labels) {
    if (item.kind !== 'label') continue
    const { hw, hh } = labelHalfSize(item.text, item.small)
    const [sx, sy] = anchorOffset(item.anchor)
    occupied.push([item.x + (sx - 1) * hw, item.y + (sy - 1) * hh, item.x + (sx + 1) * hw, item.y + (sy + 1) * hh])
  }
  /** Put a centred label at the first candidate spot that is free. */
  const placeLabel = (candidates: Array<{ x: number; y: number }>, text: string, color: string) => {
    const { hw, hh } = labelHalfSize(text)
    const boxes = candidates.map((candidate) => {
      const center = keepInPlot(candidate, text)
      return { center, box: [center.x - hw, center.y - hh, center.x + hw, center.y + hh] as const }
    })
    const free = boxes.find(
      ({ box: b }) => !occupied.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]),
    )
    const chosen = free ?? boxes[0]
    if (!chosen) return
    occupied.push([...chosen.box])
    labels.push({ kind: 'label', x: chosen.center.x, y: chosen.center.y, text, anchor: 'c', color })
  }
  /** A label beside a point: in the given direction if that is free, else turned a quarter at a time. */
  const pointLabel = (x: number, y: number, text: string, dx: number, dy: number, color = INK) => {
    const directions = [
      [dx, dy],
      [-dy, dx],
      [dy, -dx],
      [-dx, -dy],
    ]
    placeLabel(
      directions.map(([ux, uy]) => labelCenter(X(x), Y(y), ux, uy, 5, text)),
      text,
      color,
    )
  }
  const nameOf = (coord: Coord) =>
    coord.name ? (coord.name.startsWith('$') ? coord.name : `$${coord.name}$`) : null
  /** Label a curve somewhere along its visible part, above it where there is room. */
  const curveLabel = (points: number[], text: string, color: string) => {
    const pieces = clipPolyline(points, box).map(toPx)
    const longest = pieces.sort((a, b) => b.length - a.length)[0]
    if (!longest) return
    const n = longest.length / 2
    const candidates: Array<{ x: number; y: number }> = []
    for (const side of [1, -1]) {
      for (const fraction of [0.72, 0.5, 0.86, 0.3, 0.14]) {
        const k = Math.min(n - 2, Math.max(1, Math.floor(n * fraction)))
        const tx = longest[(k + 1) * 2] - longest[(k - 1) * 2]
        const ty = longest[(k + 1) * 2 + 1] - longest[(k - 1) * 2 + 1]
        // The normal that points up the page first, then the other side.
        let nx = -ty
        let ny = tx
        if (ny > 0 || (ny === 0 && nx < 0)) {
          nx = -nx
          ny = -ny
        }
        candidates.push(labelCenter(longest[k * 2], longest[k * 2 + 1], nx * side, ny * side, 4, text))
      }
    }
    placeLabel(candidates, text, color)
  }

  // ---- items ----
  let cycle = 0
  let pieceColor: string | null = null
  const nextColor = () => COLOR_CYCLE[cycle++ % COLOR_CYCLE.length]

  for (const item of graph.items) {
    const options = item.options
    if (item.kind === 'curve') {
      // Consecutive restricted pieces are one piecewise function: one colour.
      const color: string = options.color ?? (item.domain && pieceColor ? pieceColor : nextColor())
      pieceColor = item.domain ? color : null
      const lo = Math.max(x0, item.domain?.lo ?? -Infinity)
      const hi = Math.min(x1, item.domain?.hi ?? Infinity)
      if (!(lo < hi)) continue
      const runs = sampleRuns(item.f, lo, hi, y0, y1)
      const strict = item.rel === '<' || item.rel === '>'

      if (item.rel !== '=' && options.shade !== false) {
        const edge = item.rel === '>' || item.rel === '>=' ? y1 : y0
        for (const run of runs) {
          const clamped = run.map((v, i) => (i % 2 === 0 ? v : Math.min(y1, Math.max(y0, v))))
          shade([run[0], edge, ...clamped, run[run.length - 2], edge], color)
        }
      }
      for (const run of runs) stroke(run, color, options, 1.7, item.rel !== '=' && strict)

      if (item.rel === '=' && item.domain) {
        const ends: Array<[number | null, boolean]> = [
          [item.domain.lo, item.domain.loClosed],
          [item.domain.hi, item.domain.hiClosed],
        ]
        for (const [x, closed] of ends) {
          if (x === null) continue
          const y = item.f(x)
          if (y === null || !inside(x, y)) continue
          const dot: SceneItem = { kind: 'dot', x: X(x), y: Y(y), r: 3, color, open: !closed }
          if (closed) dots.push(dot)
          else openDots.push(dot)
        }
      }
      if (options.label) {
        const longest = [...runs].sort((a, b) => b.length - a.length)[0]
        if (longest) curveLabel(longest, options.label, color)
      }
      continue
    }

    pieceColor = null

    if (item.kind === 'vline') {
      const color = options.color ?? nextColor()
      const c = item.c
      if (c < x0 || c > x1) continue
      if (item.rel !== '=' && options.shade !== false) {
        const less = item.rel === '<' || item.rel === '<='
        shade(less ? [x0, y0, c, y0, c, y1, x0, y1] : [c, y0, x1, y0, x1, y1, c, y1], color)
      }
      stroke([c, y0, c, y1], color, options, 1.7, item.rel === '<' || item.rel === '>')
      if (options.label) {
        const text = options.label
        placeLabel(
          [
            labelCenter(X(c), oy + 12, 1, 0, 4, text),
            labelCenter(X(c), oy + 12, -1, 0, 4, text),
            labelCenter(X(c), oy + H - 12, 1, 0, 4, text),
          ],
          text,
          color,
        )
      }
      continue
    }

    const coords = item.coords
    switch (item.kind) {
      case 'point':
      case 'open point': {
        const [p] = coords
        if (!inside(p.x, p.y)) break
        const color = options.color ?? INK
        const dot: SceneItem = { kind: 'dot', x: X(p.x), y: Y(p.y), r: 3, color, open: item.kind === 'open point' }
        if (dot.open) openDots.push(dot)
        else dots.push(dot)
        const text = options.label ?? nameOf(p)
        if (text) pointLabel(p.x, p.y, text, 1, -1, color)
        break
      }
      case 'points': {
        const color = options.color ?? INK
        for (const p of coords) {
          if (inside(p.x, p.y)) dots.push({ kind: 'dot', x: X(p.x), y: Y(p.y), r: 2.8, color })
        }
        break
      }
      case 'segment':
      case 'vector': {
        const [a, b] = coords
        const color = options.color ?? nextColor()
        const clipped = clipSegment(a.x, a.y, b.x, b.y, box)
        if (!clipped) break
        const [ax, ay, bx, by] = toPx(clipped)
        const isVector = item.kind === 'vector'
        const whole = inside(b.x, b.y)
        const length = Math.hypot(bx - ax, by - ay) || 1
        // Stop the line inside the arrowhead so its square end does not show.
        const trim = isVector && whole ? 5 / length : 0
        curves.push({
          kind: 'path',
          points: [ax, ay, bx - (bx - ax) * trim, by - (by - ay) * trim],
          stroke: color,
          width: lineWidth(options, 1.7),
          dash: dash(options),
        })
        if (isVector && whole) curves.push(arrowHead(bx, by, bx - ax, by - ay, color, 8))
        if (!isVector) {
          for (const p of coords) {
            if (inside(p.x, p.y)) dots.push({ kind: 'dot', x: X(p.x), y: Y(p.y), r: 2.8, color })
          }
        }
        // Names sit beyond each end, in line with the segment.
        const nameA = nameOf(a)
        const nameB = nameOf(b)
        if (nameA && inside(a.x, a.y)) pointLabel(a.x, a.y, nameA, ax - bx, ay - by, color)
        if (nameB && inside(b.x, b.y)) pointLabel(b.x, b.y, nameB, bx - ax, by - ay, color)
        if (options.label) {
          const mx = (ax + bx) / 2
          const my = (ay + by) / 2
          placeLabel(
            [
              labelCenter(mx, my, by - ay, -(bx - ax), 4, options.label),
              labelCenter(mx, my, -(by - ay), bx - ax, 4, options.label),
            ],
            options.label,
            color,
          )
        }
        break
      }
      case 'line': {
        const [a, b] = coords
        const color = options.color ?? nextColor()
        const dx = b.x - a.x
        const dy = b.y - a.y
        const reach = ((xr + yr) * 4) / Math.hypot(dx, dy)
        const far = [a.x - dx * reach, a.y - dy * reach, a.x + dx * reach, a.y + dy * reach]
        stroke(far, color, options)
        if (options.label) curveLabel(far, options.label, color)
        break
      }
      case 'polygon': {
        const color = options.color ?? nextColor()
        const ring = coords.flatMap((p) => [p.x, p.y])
        if (options.shade !== false) shade(ring, color)
        stroke([...ring, ring[0], ring[1]], color, options, 1.5)
        const cx = coords.reduce((sum, p) => sum + p.x, 0) / coords.length
        const cy = coords.reduce((sum, p) => sum + p.y, 0) / coords.length
        for (const p of coords) {
          const name = nameOf(p)
          // Outward from the middle of the shape (screen y runs down).
          if (name && inside(p.x, p.y)) pointLabel(p.x, p.y, name, p.x - cx, -(p.y - cy), color)
        }
        if (options.label) {
          labels.push({ kind: 'label', x: X(cx), y: Y(cy), text: options.label, anchor: 'c', color })
        }
        break
      }
      case 'circle': {
        const [center] = coords
        const color = options.color ?? nextColor()
        const ring: number[] = []
        for (let i = 0; i <= 96; i++) {
          const angle = (i / 96) * Math.PI * 2
          ring.push(center.x + item.radius * Math.cos(angle), center.y + item.radius * Math.sin(angle))
        }
        if (options.shade === true) shade(ring.slice(0, -2), color)
        stroke(ring, color, options)
        if (options.label) {
          const at = Math.SQRT1_2 * item.radius
          pointLabel(center.x + at, center.y + at, options.label, 1, -1, color)
        }
        break
      }
      case 'text': {
        const [p] = coords
        if (!inside(p.x, p.y)) break
        labels.push({ kind: 'label', x: X(p.x), y: Y(p.y), text: item.text, anchor: 'c', color: options.color ?? INK })
        break
      }
    }
  }

  return {
    kind: 'graph',
    width: Math.ceil(padL + W + padR),
    height: Math.ceil(padT + H + padB),
    items: [...grid, ...shading, ...axes, ...curves, ...openDots, ...dots, ...labels],
    errors,
  }
}

export function buildGraph(lines: string[]): Scene {
  const errors: string[] = []
  const graph: Graph = {
    x: [-10, 10],
    y: [-10, 10],
    step: null,
    xstep: null,
    ystep: null,
    grid: true,
    numbers: true,
    xlabel: '$x$',
    ylabel: '$y$',
    size: SIZES.medium,
    title: null,
    items: [],
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    try {
      parseLine(graph, line)
    } catch (error) {
      if (!(error instanceof VisualError)) throw error
      errors.push(`${line} (${error.message})`)
    }
  }
  try {
    return layout(graph, errors)
  } catch (error) {
    if (!(error instanceof VisualError)) throw error
    return { kind: 'graph', width: 0, height: 0, items: [], errors: [...errors, error.message] }
  }
}
