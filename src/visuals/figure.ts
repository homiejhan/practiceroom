/**
 * `[figure]` blocks: to-scale geometry diagrams with no axes. Every point is
 * computed exactly, then the whole figure is scaled uniformly, so angles and
 * proportions are true. The line format follows the Worksheet Studio generator
 * in my TutorAssist project:
 *
 *   triangle ABC AB=8 angle A=50 angle B=60
 *   side AB 8 cm
 *   side BC $x$ [ticks: 1]
 *   angle A 50°
 *   right angle DEA
 *
 * Lines are read top to bottom; a point must exist before a later line uses it.
 */

import { constValue, VisualError } from './expr'
import {
  COLORS,
  INK,
  arcPoints,
  arrowHead,
  fitScene,
  formatNumber,
  labelCenter,
  labelHalfSize,
  lineWidth,
  matchParen,
  onOff,
  parseSize,
  splitOptions,
  splitTop,
  type Options,
  type Scene,
  type SceneItem,
} from './scene'

const SIZES = { small: 110, medium: 170, large: 230 }
const GRID_COLOR = '#dde1e6'
const FILL_OPACITY = 0.14

const PNAME = "[A-Z]\\d*'*"
// "5", "4.5", "1/2", "3sqrt(2)", with an optional degree sign.
const NUM = '-?(?:\\d*\\.?\\d*\\s*\\*?\\s*sqrt\\(\\d*\\.?\\d+\\)|\\d*\\.?\\d+(?:\\/\\d*\\.?\\d+)?)°?'
const PNAME_RUN = new RegExp(`(?:${PNAME})+(?![A-Za-z])`, 'y')
const PNAME_FULL = new RegExp(`^${PNAME}$`)
const REF_FILLER = new Set(['to', 'and', 'from', 'through'])
const SETTING_RE = /^(size|title|labels|grid|rotate)\s*:\s*(.*)$/i
const KIND_RE =
  /^(points?|right\s+triangle|triangle|rectangle|square|parallelogram|rhombus|trapezoid|trapezium|regular|polygon|quadrilateral|pentagon|hexagon|circle|arc|sector|segment|line|ray|vector|side|right\s+angle|angle|text)\b\s*(.*)$/i

const number = (token: string): number => constValue(token.replace(/°$/, ''))
const rad = (degrees: number): number => (degrees * Math.PI) / 180
const deg = (radians: number): number => (radians * 180) / Math.PI
const angleOf = (dx: number, dy: number): number => deg(Math.atan2(dy, dx))

type Pt = [number, number]

type Item =
  | { kind: 'poly'; names: string[]; options: Options }
  | { kind: 'segment' | 'line' | 'ray' | 'vector'; p: string; q: string; options: Options }
  | { kind: 'circle'; center: string; r: number; options: Options }
  | { kind: 'arc' | 'sector'; center: string; r: number; a0: number; a1: number; options: Options }
  | { kind: 'text'; at: string; text: string; options: Options }
  | {
      kind: 'side'
      p: string
      q: string
      text: string | null
      measure: boolean
      auto?: boolean
      vec?: boolean
      options: Options
    }
  | {
      kind: 'angle'
      abc: [string, string, string] | null
      vertex: string
      text: string | null
      measure: boolean
      right: boolean
      options: Options
    }

class Figure {
  pts = new Map<string, Pt>()
  /** Auto-named anonymous coordinates; never labelled. */
  internal = new Set<string>()
  hidden = new Set<string>()
  dot = new Set<string>()
  /** Points made with a `point` line; these always get a dot. */
  declared = new Set<string>()
  shown: string[] = []
  nameText = new Map<string, string>()
  nolabel = new Set<string>()
  items: Item[] = []
  polys: string[][] = []
  size = SIZES.medium
  title: string | null = null
  labels = true
  grid: number | null = null
  rotate = 0
  private anonymous = 0

  define(name: string, x: number, y: number): void {
    const old = this.pts.get(name)
    if (old && Math.hypot(old[0] - x, old[1] - y) > 1e-7 * Math.max(1, Math.abs(x), Math.abs(y))) {
      throw new VisualError(
        `point ${name} already exists at (${formatNumber(old[0])}, ${formatNumber(old[1])}): use a new name`,
      )
    }
    this.pts.set(name, [x, y])
  }

  anon(x: number, y: number): string {
    this.anonymous++
    const name = `#${this.anonymous}`
    this.pts.set(name, [x, y])
    this.internal.add(name)
    return name
  }

  get(name: string): Pt {
    const point = this.pts.get(name)
    if (!point) {
      throw new VisualError(
        `point ${name} hasn't been defined yet: give it coordinates, e.g. ${name}(0, 0), or define it on an earlier line`,
      )
    }
    return point
  }

  show(name: string, dot = false): void {
    if (this.internal.has(name) || this.hidden.has(name)) return
    if (!this.shown.includes(name)) this.shown.push(name)
    if (dot) this.dot.add(name)
  }

  pair(inner: string, whole: string): Pt {
    const parts = splitTop(inner, ',')
    if (parts.length !== 2) throw new VisualError(`expected a point like (2, -3), got "${whole}"`)
    return [constValue(parts[0]), constValue(parts[1])]
  }

  /**
   * Read leading point references: "A(0,0) B (3, 4)", "ABC", "(1, 2) to (3, 4)".
   * Names given with coordinates are defined. Stops at the first token that is
   * not a point reference ("AB=6", "radius", "40°", ...), which is returned.
   */
  refs(s: string): { names: string[]; rest: string } {
    const names: string[] = []
    let i = 0
    for (;;) {
      while (i < s.length && (/\s/.test(s[i]) || s[i] === ',')) i++
      if (i >= s.length) break
      if (s[i] === '(') {
        const j = matchParen(s, i)
        // "(2x+10)°" is label text, not a point.
        if (splitTop(s.slice(i + 1, j), ',').length !== 2) break
        const [x, y] = this.pair(s.slice(i + 1, j), s.slice(i, j + 1))
        names.push(this.anon(x, y))
        i = j + 1
        continue
      }
      const word = /^[a-z]+\b/.exec(s.slice(i))
      if (word && REF_FILLER.has(word[0])) {
        // Skip a filler word only if a point reference follows it.
        const next = s.slice(i + word[0].length).trimStart()
        PNAME_RUN.lastIndex = 0
        if (next.startsWith('(') || PNAME_RUN.test(next)) {
          i += word[0].length
          continue
        }
        break
      }
      PNAME_RUN.lastIndex = i
      const run = PNAME_RUN.exec(s)?.[0]
      if (!run) break
      const after = s.slice(i + run.length).trimStart()
      // "AB=6" is a measurement, not a reference.
      if (after.startsWith('=') && names.length) break
      if (after.startsWith('(')) {
        const k = s.indexOf('(', i + run.length)
        const j = matchParen(s, k)
        const isCoordinates = splitTop(s.slice(k + 1, j), ',').length === 2
        if (isCoordinates) {
          if (!PNAME_FULL.test(run)) {
            throw new VisualError(`"${run}(...)": give coordinates to one point at a time`)
          }
          this.define(run, ...this.pair(s.slice(k + 1, j), s.slice(k, j + 1)))
          names.push(run)
          i = j + 1
          continue
        }
      }
      names.push(...(run.match(new RegExp(PNAME, 'g')) ?? []))
      i += run.length
    }
    return { names, rest: s.slice(i).trim() }
  }
}

/** The value after a keyword: "width 6", "height: 4", "radius=3". */
function keyword(rest: string, ...keys: string[]): number | null {
  for (const key of keys) {
    const found = new RegExp(`(?<![A-Za-z])${key}(?![A-Za-z])\\s*[:=]?\\s*(${NUM})`, 'i').exec(rest)
    if (found) return number(found[1])
  }
  return null
}

// ---------------------------------------------------------------------------
// Shapes from measurements
// ---------------------------------------------------------------------------

/**
 * Solve a triangle from any determining set of sides and angles. Sides are
 * written "PQ=5", angles "angle P=40"; "sides 5 6 7" means PQ, QR, RP. The
 * result has P at the origin and Q on the +x axis.
 */
function solveTriangle(names: string[], rest: string): Pt[] {
  const [P, Q, R] = names
  const angle = new Map<string, number>()
  let remaining = rest
  const angleRe = new RegExp(`(?:\\bangle\\s*|m?∠\\s*|\\\\angle\\s*)(${PNAME})\\s*[:=]\\s*(${NUM})`, 'g')
  for (const match of rest.matchAll(angleRe)) {
    if (!names.includes(match[1])) {
      throw new VisualError(`angle ${match[1]} isn't a vertex of triangle ${P}${Q}${R}`)
    }
    angle.set(match[1], number(match[2]))
    remaining = remaining.replace(match[0], ' ')
  }
  // Sides are keyed by the vertex opposite them.
  const opposite = (a: string, b: string) => names.find((name) => name !== a && name !== b)
  const side = new Map<string, number>()
  const sideRe = new RegExp(`\\b(${PNAME})(${PNAME})\\s*[:=]\\s*(${NUM})`, 'g')
  for (const match of remaining.matchAll(sideRe)) {
    const across = opposite(match[1], match[2])
    if (!names.includes(match[1]) || !names.includes(match[2]) || match[1] === match[2] || !across) {
      throw new VisualError(`${match[1]}${match[2]} isn't a side of triangle ${P}${Q}${R}`)
    }
    side.set(across, number(match[3]))
  }
  const three = new RegExp(`\\bsides?\\s*[:=]?\\s*(${NUM})[\\s,]+(${NUM})[\\s,]+(${NUM})`).exec(remaining)
  if (three) {
    side.set(R, number(three[1]))
    side.set(P, number(three[2]))
    side.set(Q, number(three[3]))
  }
  if ([...side.values()].some((v) => v <= 0) || [...angle.values()].some((v) => v <= 0 || v >= 180)) {
    throw new VisualError('side lengths must be positive and angles between 0 and 180')
  }

  for (let pass = 0; pass < 6; pass++) {
    if (angle.size === 2) {
      const missing = names.find((name) => !angle.has(name))!
      const third = 180 - [...angle.values()].reduce((a, b) => a + b, 0)
      if (third <= 0) throw new VisualError('those angles add up to 180° or more')
      angle.set(missing, third)
    }
    // SAS: an angle with both adjacent sides gives the opposite side.
    for (const v of names) {
      const [o1, o2] = names.filter((name) => name !== v)
      if (angle.has(v) && !side.has(v) && side.has(o1) && side.has(o2)) {
        const a = side.get(o1)!
        const b = side.get(o2)!
        side.set(v, Math.sqrt(a * a + b * b - 2 * a * b * Math.cos(rad(angle.get(v)!))))
      }
    }
    if (side.size === 3) {
      const a = side.get(P)!
      const b = side.get(Q)!
      const c = side.get(R)!
      if (a + b <= c || a + c <= b || b + c <= a) {
        throw new VisualError(
          `sides ${formatNumber(c)}, ${formatNumber(a)}, ${formatNumber(b)} can't form a triangle`,
        )
      }
      for (const v of names) {
        const [o1, o2] = names.filter((name) => name !== v)
        const s1 = side.get(o1)!
        const s2 = side.get(o2)!
        const cosine = (s1 * s1 + s2 * s2 - side.get(v)! ** 2) / (2 * s1 * s2)
        if (!angle.has(v)) angle.set(v, deg(Math.acos(Math.max(-1, Math.min(1, cosine)))))
      }
      break
    }
    // Law of sines, from any angle whose opposite side is known.
    const known = names.find((name) => angle.has(name) && side.has(name))
    if (known) {
      const k = side.get(known)! / Math.sin(rad(angle.get(known)!))
      for (const v of names) {
        if (angle.has(v) && !side.has(v)) side.set(v, k * Math.sin(rad(angle.get(v)!)))
        else if (side.has(v) && !angle.has(v)) {
          const sine = side.get(v)! / k
          if (sine > 1 + 1e-9) throw new VisualError('no triangle has those measurements')
          // SSA: take the acute solution.
          angle.set(v, deg(Math.asin(Math.min(1, sine))))
        }
      }
    }
  }
  if (side.size < 3 || angle.size < 3) {
    throw new VisualError(
      `not enough to pin down triangle ${P}${Q}${R}: give 3 sides (${P}${Q}=5 ${Q}${R}=6 ${R}${P}=7), 2 sides and the angle between them, or 2 angles and a side`,
    )
  }
  const c = side.get(R)!
  const b = side.get(Q)!
  const A = rad(angle.get(P)!)
  return [
    [0, 0],
    [c, 0],
    [b * Math.cos(A), b * Math.sin(A)],
  ]
}

/**
 * Local coordinates for a measured shape: first vertex at the origin, second
 * on the +x axis, the rest above it (counterclockwise).
 */
function shapeLocal(kind: string, names: string[], rest: string): Pt[] {
  const n = names.length
  if (kind === 'triangle') return solveTriangle(names, rest)
  if (kind === 'right triangle') {
    const legs = new RegExp(`\\blegs?\\s*[:=]?\\s*(${NUM})[\\s,]+(${NUM})`).exec(rest)
    if (!legs) {
      throw new VisualError(
        'right triangle needs its legs, e.g. right triangle ABC legs 3 4 (right angle at B)',
      )
    }
    const a = number(legs[1])
    const b = number(legs[2])
    return [
      [0, 0],
      [a, 0],
      [a, b],
    ]
  }
  if (kind === 'rectangle') {
    const by = new RegExp(`(${NUM})\\s*(?:by|x|×)\\s*(${NUM})`).exec(rest)
    const w = by ? number(by[1]) : keyword(rest, 'width', 'length', 'base')
    const h = by ? number(by[2]) : keyword(rest, 'height')
    if (w === null || h === null) {
      throw new VisualError('rectangle needs a size: rectangle ABCD width 6 height 4 (or 6 by 4)')
    }
    return [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ]
  }
  if (kind === 'square') {
    const s = keyword(rest, 'side', 'length')
    if (s === null) throw new VisualError('square needs a side: square ABCD side 4')
    return [
      [0, 0],
      [s, 0],
      [s, s],
      [0, s],
    ]
  }
  if (kind === 'parallelogram' || kind === 'rhombus') {
    let b = kind === 'rhombus' ? keyword(rest, 'side', 'length', 'base') : keyword(rest, 'base', 'length')
    let s = kind === 'rhombus' ? b : keyword(rest, 'side', 'slant', 'leg')
    const a = keyword(rest, 'angle') ?? 60
    const h = keyword(rest, 'height')
    if (kind === 'parallelogram' && s === null && h !== null) s = h / Math.sin(rad(a))
    if (kind === 'parallelogram' && b === null) b = keyword(rest, 'side')
    if (b === null || s === null) {
      throw new VisualError(
        `${kind} needs its size, e.g. parallelogram ABCD base 6 side 4 angle 60 (or rhombus ABCD side 5 angle 60)`,
      )
    }
    const dx = s * Math.cos(rad(a))
    const dy = s * Math.sin(rad(a))
    return [
      [0, 0],
      [b, 0],
      [b + dx, dy],
      [dx, dy],
    ]
  }
  if (kind === 'trapezoid' || kind === 'trapezium') {
    const b = keyword(rest, 'bottom', 'base')
    const t = keyword(rest, 'top')
    const h = keyword(rest, 'height')
    if (b === null || t === null || h === null) {
      throw new VisualError('trapezoid needs bottom, top and height: trapezoid ABCD bottom 8 top 4 height 3')
    }
    const o = keyword(rest, 'offset', 'shift') ?? (b - t) / 2
    return [
      [0, 0],
      [b, 0],
      [o + t, h],
      [o, h],
    ]
  }
  if (kind === 'regular') {
    if (n < 3) throw new VisualError('a regular polygon needs at least 3 vertex names: regular ABCDEF side 3')
    const r = keyword(rest, 'radius', 'circumradius')
    const s = keyword(rest, 'side', 'length') ?? (r === null ? null : 2 * r * Math.sin(Math.PI / n))
    if (s === null) throw new VisualError('regular polygon needs a side (or radius): regular ABCDEF side 3')
    const points: Pt[] = []
    let x = 0
    let y = 0
    let heading = 0
    for (let i = 0; i < n; i++) {
      points.push([x, y])
      x += s * Math.cos(heading)
      y += s * Math.sin(heading)
      heading += (2 * Math.PI) / n
    }
    return points
  }
  throw new VisualError(`can't build a ${kind} from measurements`)
}

const MEASURED_COUNT: Record<string, number> = {
  triangle: 3,
  'right triangle': 3,
  rectangle: 4,
  square: 4,
  parallelogram: 4,
  rhombus: 4,
  trapezoid: 4,
  trapezium: 4,
}

function placeMeasured(fig: Figure, kind: string, names: string[], source: string, options: Options): void {
  let rest = source
  const at = new RegExp(`\\bat\\s*(\\([^)]*\\)|${PNAME})`).exec(rest)
  if (at) rest = rest.slice(0, at.index) + rest.slice(at.index + at[0].length)
  const turn = keyword(rest, 'rotate', 'rotated', 'turn', 'turned')
  if (turn !== null) rest = rest.replace(new RegExp(`\\b(?:rotate|rotated|turn|turned)\\s*[:=]?\\s*${NUM}`), ' ')

  // Building on an existing side: take that side's length from the figure.
  const first = fig.pts.get(names[0])
  const second = fig.pts.get(names[1])
  if (!at && first && second) {
    const have = Math.hypot(second[0] - first[0], second[1] - first[1]).toFixed(10)
    const [n0, n1] = names
    if (kind === 'triangle' && !new RegExp(`\\b(?:${n0}${n1}|${n1}${n0})\\s*[:=]|\\bsides?\\b`).test(rest)) {
      rest += ` ${n0}${n1}=${have}`
    } else if (['square', 'rhombus', 'regular'].includes(kind) && keyword(rest, 'side', 'length', 'radius') === null) {
      rest += ` side ${have}`
    } else if (kind === 'rectangle' && keyword(rest, 'width', 'length', 'base') === null && !/\bby\b/.test(rest)) {
      rest += ` width ${have}`
    } else if (kind === 'parallelogram' && keyword(rest, 'base') === null) {
      rest += ` base ${have}`
    } else if ((kind === 'trapezoid' || kind === 'trapezium') && keyword(rest, 'bottom', 'base') === null) {
      rest += ` bottom ${have}`
    }
  }

  let local = shapeLocal(kind, names, rest)
  if (options.flip) local = local.map(([x, y]) => [x, -y])
  let origin: Pt = [0, 0]
  let theta = 0
  if (at) {
    const token = at[1]
    origin = token.startsWith('(') ? fig.pair(token.slice(1, -1), token) : fig.get(token)
  } else if (first) {
    origin = first
    if (second) {
      theta = Math.atan2(second[1] - first[1], second[0] - first[0])
      const built = Math.hypot(local[1][0] - local[0][0], local[1][1] - local[0][1])
      const have = Math.hypot(second[0] - first[0], second[1] - first[1])
      if (Math.abs(built - have) > 1e-6 * Math.max(1, have)) {
        throw new VisualError(
          `${names[0]}${names[1]} is already ${formatNumber(have, 2)} long, but this ${kind} makes it ${formatNumber(built, 2)}`,
        )
      }
    }
  }
  if (turn !== null) theta += rad(turn)
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  names.forEach((name, i) => {
    const [x, y] = local[i]
    fig.define(name, origin[0] + x * cos - y * sin, origin[1] + x * sin + y * cos)
  })
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parsePoint(fig: Figure, kind: string, rest: string, options: Options): void {
  if (kind === 'points') {
    const { names, rest: left } = fig.refs(rest)
    if (left || !names.length) throw new VisualError('points takes named coordinates: points A(0, 0) B(2, 3)')
    for (const name of names) {
      if (options.hidden) fig.hidden.add(name)
      else {
        fig.show(name, !options.nodots)
        fig.declared.add(name)
      }
    }
    return
  }
  const match = new RegExp(`^(${PNAME})\\s*(.*)$`).exec(rest)
  if (!match) throw new VisualError('point needs a capital-letter name: point A (2, 3)')
  const name = match[1]
  const how = match[2].trim()
  const low = how.toLowerCase()
  const after = (pattern: RegExp) => fig.refs(how.replace(pattern, '')).names.map((n) => fig.get(n))

  if (how.startsWith('(')) fig.refs(`${name}${how}`)
  else if (low.startsWith('midpoint')) {
    const points = after(/^midpoint\s*(of)?/i)
    if (points.length !== 2) throw new VisualError('point M midpoint A B')
    fig.define(name, (points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2)
  } else if (low.startsWith('foot')) {
    const points = after(/^foot\s*(of)?/i)
    if (points.length !== 3) {
      throw new VisualError('point D foot C A B (foot of the perpendicular from C to line AB)')
    }
    const [[px, py], [ax, ay], [bx, by]] = points
    const dx = bx - ax
    const dy = by - ay
    const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    fig.define(name, ax + t * dx, ay + t * dy)
  } else if (low.startsWith('from')) {
    const from = new RegExp(
      `^from\\s*(${PNAME})\\s*(?:distance\\s*)?(${NUM})\\s*(?:at|angle|direction|heading)?\\s*(${NUM})`,
      'i',
    ).exec(how)
    if (!from) throw new VisualError('point P from A 5 at 30 (5 units from A in the 30° direction)')
    const [ax, ay] = fig.get(from[1])
    const distance = number(from[2])
    const direction = rad(number(from[3]))
    fig.define(name, ax + distance * Math.cos(direction), ay + distance * Math.sin(direction))
  } else if (low.startsWith('on')) {
    const on = new RegExp(`^on\\s*(.*?)\\s*(?:at\\s*)?(${NUM})$`, 'i').exec(how)
    const points = on ? fig.refs(on[1]).names.map((n) => fig.get(n)) : []
    if (!on || points.length !== 2) {
      throw new VisualError('point P on A B 0.25 (a quarter of the way from A to B)')
    }
    const t = number(on[2])
    fig.define(name, points[0][0] + t * (points[1][0] - points[0][0]), points[0][1] + t * (points[1][1] - points[0][1]))
  } else if (low.startsWith('intersect')) {
    const points = after(/^intersect(ion)?\s*(of)?/i)
    if (points.length !== 4) throw new VisualError('point X intersect A B C D (where line AB meets line CD)')
    const [[x1, y1], [x2, y2], [x3, y3], [x4, y4]] = points
    const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if (Math.abs(den) < 1e-12) throw new VisualError("those lines are parallel: they don't intersect")
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den
    fig.define(name, x1 + t * (x2 - x1), y1 + t * (y2 - y1))
  } else if (!how) fig.get(name)
  else {
    throw new VisualError(
      'point A (2, 3) | point M midpoint A B | point D foot C A B | point P from A 5 at 30 | point P on A B 0.25 | point X intersect A B C D',
    )
  }

  if (options.hidden) {
    fig.hidden.add(name)
    fig.shown = fig.shown.filter((shown) => shown !== name)
    return
  }
  fig.show(name, !options.nodots)
  if (!options.nodots) fig.declared.add(name)
  if (options.label) fig.nameText.set(name, options.label)
  if (options.nolabel) fig.nolabel.add(name)
}

const unquote = (text: string): string => text.replace(/^["']|["']$/g, '')

function parseLine(fig: Figure, line: string): void {
  const setting = SETTING_RE.exec(line)
  if (setting) {
    const key = setting[1].toLowerCase()
    const value = setting[2].trim()
    if (key === 'size') fig.size = parseSize(value, SIZES, 250)
    else if (key === 'title') fig.title = value || null
    else if (key === 'labels') fig.labels = onOff(value, 'labels')
    else if (key === 'grid') fig.grid = /^[\d.]+$/.test(value) ? Number(value) : onOff(value, 'grid') ? 1 : null
    else fig.rotate = number(value)
    return
  }

  const split = splitOptions(line, true)
  const options = split.options
  let body = split.body
  // "A = (1, 2)" is shorthand for a point.
  const shorthand = new RegExp(`^(${PNAME})\\s*=\\s*(\\(.*\\))\\s*$`).exec(body)
  if (shorthand) body = `point ${shorthand[1]} ${shorthand[2]}`
  const matched = KIND_RE.exec(body)
  if (!matched) {
    throw new VisualError(
      'expected a setting (size: small) or one of: point, triangle, right triangle, rectangle, square, parallelogram, rhombus, trapezoid, regular, polygon, circle, arc, sector, segment, line, ray, vector, side, angle, right angle, text',
    )
  }
  const kind = matched[1].toLowerCase().replace(/\s+/g, ' ')
  let rest = matched[2].trim()

  if (kind === 'point' || kind === 'points') {
    parsePoint(fig, kind, rest, options)
    return
  }

  if (kind === 'text') {
    const text = new RegExp(`^\\s*(\\([^)]*\\)|${PNAME}(?:\\s*\\([^)]*\\))?)\\s*:?\\s*(.*)$`).exec(rest)
    const names = text ? fig.refs(text[1]).names : []
    if (!text || names.length !== 1 || !text[2]) {
      throw new VisualError('text needs a position and something to write: text (2, 3) Region $R$')
    }
    fig.get(names[0])
    fig.items.push({ kind: 'text', at: names[0], text: unquote(text[2]), options })
    return
  }

  if (
    ['triangle', 'right triangle', 'rectangle', 'square', 'parallelogram', 'rhombus', 'trapezoid', 'trapezium', 'regular', 'polygon', 'quadrilateral', 'pentagon', 'hexagon'].includes(kind)
  ) {
    const read = fig.refs(rest)
    const names = [...new Set(read.names)]
    rest = read.rest
    const fromPoints =
      ['polygon', 'quadrilateral', 'pentagon', 'hexagon'].includes(kind) ||
      (kind === 'triangle' && names.every((name) => fig.pts.has(name)) && !/=|\bsides?\b/.test(rest))
    if (fromPoints) {
      const need = { quadrilateral: 4, pentagon: 5, hexagon: 6, triangle: 3 }[kind]
      if ((need && names.length !== need) || names.length < 3) {
        throw new VisualError(`${kind} needs ${need ?? 'at least 3'} vertices, found ${names.length}`)
      }
      for (const name of names) fig.get(name)
      if (rest) throw new VisualError(`didn't understand "${rest}"`)
    } else {
      const need = MEASURED_COUNT[kind]
      if (need && names.length !== need) {
        throw new VisualError(
          `${kind} needs ${need} vertex names (e.g. ${'ABCD'.slice(0, need)}), found ${names.length}`,
        )
      }
      if (names.length < 3) throw new VisualError(`${kind} needs at least 3 vertex names`)
      placeMeasured(fig, kind, names, rest, options)
    }
    fig.polys.push(names)
    fig.items.push({ kind: 'poly', names, options })
    for (const name of names) fig.show(name)
    if (options.lengths) {
      names.forEach((name, i) => {
        fig.items.push({
          kind: 'side',
          p: name,
          q: names[(i + 1) % names.length],
          text: null,
          measure: true,
          auto: true,
          options: {},
        })
      })
    }
    if (options.angles) {
      for (const name of names) {
        fig.items.push({ kind: 'angle', abc: null, vertex: name, text: null, measure: true, right: false, options: {} })
      }
    }
    return
  }

  if (kind === 'circle' || kind === 'arc' || kind === 'sector') {
    const read = fig.refs(rest)
    const names = read.names
    rest = read.rest
    if (!names.length) {
      throw new VisualError(`${kind} needs a center: ${kind} O radius 3 (or ${kind} (0, 0) radius 3)`)
    }
    const center = names[0]
    if (!fig.pts.has(center)) fig.define(center, 0, 0)
    const diameter = keyword(rest, 'diameter', 'd')
    let r = keyword(rest, 'radius', 'r') ?? (diameter === null ? null : diameter / 2)
    const [cx, cy] = fig.get(center)
    if (kind === 'circle') {
      if (r === null && names.length === 2) {
        const [tx, ty] = fig.get(names[1])
        r = Math.hypot(tx - cx, ty - cy)
      }
      if (r === null || r <= 0) {
        throw new VisualError('circle needs a radius: circle O radius 3 (or diameter 6, or circle O through A)')
      }
      fig.items.push({ kind: 'circle', center, r, options })
    } else {
      let a0: number
      let a1: number
      if (names.length === 3) {
        // arc O from A to B
        const [ax, ay] = fig.get(names[1])
        const [bx, by] = fig.get(names[2])
        r = r ?? Math.hypot(ax - cx, ay - cy)
        a0 = angleOf(ax - cx, ay - cy)
        a1 = angleOf(bx - cx, by - cy)
        if (a1 <= a0) a1 += 360
      } else {
        const sweep = new RegExp(`\\bfrom\\s*(${NUM})\\s*(?:to|-)\\s*(${NUM})`).exec(rest)
        if (r === null || !sweep) {
          throw new VisualError(
            `${kind} needs a radius and angles: ${kind} O radius 3 from 0 to 120 (or ${kind} O from A to B)`,
          )
        }
        a0 = number(sweep[1])
        a1 = number(sweep[2])
      }
      if (r <= 0) throw new VisualError(`${kind} needs a positive radius`)
      if (!(Math.abs(a1 - a0) <= 360)) throw new VisualError(`a ${kind} sweeps at most 360 degrees`)
      fig.items.push({ kind, center, r, a0, a1, options })
    }
    if (!options.nocenter) fig.show(center, true)
    return
  }

  if (kind === 'segment' || kind === 'line' || kind === 'ray' || kind === 'vector') {
    const { names, rest: left } = fig.refs(rest)
    if (names.length !== 2 || left) {
      throw new VisualError(
        `${kind} takes two points: ${kind} A B or ${kind} (0, 0) to (3, 4)${left ? ` (didn't understand "${left}")` : ''}`,
      )
    }
    const [a, b] = names.map((name) => fig.get(name))
    if (a[0] === b[0] && a[1] === b[1]) throw new VisualError(`${kind}: the two points are the same`)
    fig.items.push({ kind, p: names[0], q: names[1], options })
    const dots = kind !== 'vector' && !options.nodots
    fig.show(names[0], dots)
    fig.show(names[1], dots)
    if (options.lengths) {
      fig.items.push({ kind: 'side', p: names[0], q: names[1], text: null, measure: true, auto: true, options: {} })
    }
    return
  }

  if (kind === 'side') {
    const read = fig.refs(rest)
    if (read.names.length !== 2) {
      throw new VisualError('side takes two points: side AB 5 or side AB $x$ [ticks: 1]')
    }
    const [a, b] = read.names.map((name) => fig.get(name))
    if (a[0] === b[0] && a[1] === b[1]) throw new VisualError('side: the two points are the same')
    const text = read.rest.replace(/^[=:]\s*/, '').trim()
    const measure = ['measure', 'length', '?=', 'auto'].includes(text.toLowerCase())
    fig.items.push({
      kind: 'side',
      p: read.names[0],
      q: read.names[1],
      text: measure || !text ? null : unquote(text),
      measure,
      options,
    })
    return
  }

  // angle / right angle
  const read = fig.refs(rest)
  let text = read.rest.replace(/^[=:]\s*/, '').trim()
  const right = kind === 'right angle' || text.toLowerCase() === 'right' || !!options.right
  if (text.toLowerCase() === 'right') text = ''
  let abc: [string, string, string] | null = null
  let vertex: string
  if (read.names.length === 3) {
    const points = read.names.map((name) => fig.get(name))
    abc = [read.names[0], read.names[1], read.names[2]]
    vertex = read.names[1]
    for (const end of [points[0], points[2]]) {
      if (end[0] === points[1][0] && end[1] === points[1][1]) {
        throw new VisualError(`angle at ${vertex}: one of its sides has zero length`)
      }
    }
  } else if (read.names.length === 1) {
    vertex = read.names[0]
    fig.get(vertex)
    if (!fig.polys.some((poly) => poly.includes(vertex))) {
      throw new VisualError(
        `angle ${vertex}: ${vertex} isn't a vertex of any shape, so name all three points (angle A${vertex}C)`,
      )
    }
  } else {
    throw new VisualError(
      'angle takes three points with the vertex in the middle (angle ABC 40°), or one vertex of a shape (angle B 40°)',
    )
  }
  const measure = ['measure', 'auto', '?='].includes(text.toLowerCase())
  fig.items.push({ kind: 'angle', abc, vertex, text: measure || !text ? null : unquote(text), measure, right, options })
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** "P1" -> $P_1$, "A'" -> $A'$. */
function nameLabel(name: string): string {
  const parts = /^([A-Z])(\d*)('*)$/.exec(name)
  if (!parts) return name
  return `$${parts[1]}${parts[2] ? `_{${parts[2]}}` : ''}${parts[3]}$`
}

/** A length as a whole number, a simplified radical, or a short decimal. */
function formatLength(value: number): string {
  if (Math.abs(value - Math.round(value)) < 1e-6) return String(Math.round(value))
  const square = value * value
  const whole = Math.round(square)
  if (Math.abs(square - whole) < 1e-6 * Math.max(1, whole) && whole < 10000) {
    let outside = 1
    for (let k = Math.floor(Math.sqrt(whole)); k > 1; k--) {
      if (whole % (k * k) === 0) {
        outside = k
        break
      }
    }
    const inside = whole / (outside * outside)
    return `$${outside === 1 ? '' : outside}\\sqrt{${inside}}$`
  }
  return formatNumber(value, 2)
}

// ---------------------------------------------------------------------------
// Layout. Geometry is worked out in pixels with y pointing up (so angles read
// the way they do in the source), and flipped to screen coordinates at the end.
// ---------------------------------------------------------------------------

function layout(fig: Figure, errors: string[]): Scene {
  const turn = rad(fig.rotate)
  const world = new Map<string, Pt>()
  for (const [name, [x, y]] of fig.pts) {
    world.set(name, [x * Math.cos(turn) - y * Math.sin(turn), x * Math.sin(turn) + y * Math.cos(turn)])
  }
  const W = (name: string): Pt => world.get(name)!

  // ---- bounding box, in figure units ----
  const extent: Pt[] = []
  const lineEnds = new Map<Item, [Pt, Pt]>()
  for (const item of fig.items) {
    if (item.kind === 'poly') extent.push(...item.names.map(W))
    else if (item.kind === 'segment' || item.kind === 'vector' || item.kind === 'side') {
      extent.push(W(item.p), W(item.q))
    } else if (item.kind === 'line' || item.kind === 'ray') {
      const [ax, ay] = W(item.p)
      const [bx, by] = W(item.q)
      const reach = item.kind === 'line' ? 0.22 : 0.35
      const ends: [Pt, Pt] = [
        item.kind === 'line' ? [ax - reach * (bx - ax), ay - reach * (by - ay)] : [ax, ay],
        [bx + reach * (bx - ax), by + reach * (by - ay)],
      ]
      lineEnds.set(item, ends)
      extent.push(...ends)
    } else if (item.kind === 'circle') {
      const [cx, cy] = W(item.center)
      extent.push([cx - item.r, cy - item.r], [cx + item.r, cy + item.r])
    } else if (item.kind === 'arc' || item.kind === 'sector') {
      const [cx, cy] = W(item.center)
      const arc = arcPoints(cx, cy, item.r, item.a0 + fig.rotate, item.a1 + fig.rotate)
      for (let i = 0; i < arc.length; i += 2) extent.push([arc[i], arc[i + 1]])
      if (item.kind === 'sector') extent.push([cx, cy])
    } else if (item.kind === 'text') extent.push(W(item.at))
  }
  extent.push(...fig.shown.map(W))
  if (!extent.length) throw new VisualError('the figure has nothing to draw')
  let minX = Math.min(...extent.map((p) => p[0]))
  let maxX = Math.max(...extent.map((p) => p[0]))
  let minY = Math.min(...extent.map((p) => p[1]))
  let maxY = Math.max(...extent.map((p) => p[1]))
  if (fig.grid) {
    const g = fig.grid
    minX = Math.floor(minX / g - 1e-9) * g
    minY = Math.floor(minY / g - 1e-9) * g
    maxX = Math.ceil(maxX / g + 1e-9) * g
    maxY = Math.ceil(maxY / g + 1e-9) * g
  }
  const spanX = maxX - minX
  const spanY = maxY - minY
  const scale = Math.max(spanX, spanY) < 1e-9 ? 1 : fig.size / Math.max(spanX, spanY)

  /** A point in pixels, y up. */
  const P = (name: string): Pt => [W(name)[0] * scale, W(name)[1] * scale]
  const scaled = ([x, y]: Pt): Pt => [x * scale, y * scale]

  const grid: SceneItem[] = []
  const fills: SceneItem[] = []
  const strokes: SceneItem[] = []
  const marks: SceneItem[] = []
  const dots: SceneItem[] = []
  const labels: SceneItem[] = []

  const style = (options: Options, color: string, base = 1.3) => ({
    stroke: color,
    width: lineWidth(options, base),
    dash: options.style ?? ('solid' as const),
  })
  const label = (x: number, y: number, text: string, color = INK) => {
    labels.push({ kind: 'label', x, y, text, anchor: 'c', color })
  }
  /** A label whose near edge sits `gap` pixels from a point, in a direction given in degrees. */
  const labelToward = (x: number, y: number, degrees: number, gap: number, text: string, color = INK) => {
    // labelCenter measures a box, which is the same in either y direction.
    const center = labelCenter(x, y, Math.cos(rad(degrees)), Math.sin(rad(degrees)), gap, text)
    label(center.x, center.y, text, color)
  }

  // A grid finer than the picture can show is left out (and never loops for long).
  if (fig.grid && Math.max(spanX, spanY) / fig.grid <= 60) {
    const g = fig.grid
    for (let x = minX; x <= maxX + 1e-9; x += g) {
      grid.push({ kind: 'path', points: [x * scale, minY * scale, x * scale, maxY * scale], stroke: GRID_COLOR, width: 0.7 })
    }
    for (let y = minY; y <= maxY + 1e-9; y += g) {
      grid.push({ kind: 'path', points: [minX * scale, y * scale, maxX * scale, y * scale], stroke: GRID_COLOR, width: 0.7 })
    }
  }

  // For placing vertex names: the directions (degrees) already taken at each point.
  const incident = new Map<string, number[]>()
  const taken = (name: string) => {
    let list = incident.get(name)
    if (!list) incident.set(name, (list = []))
    return list
  }
  const straight: Array<[Pt, Pt]> = []
  const sweeps = new Map<string, Array<[number, number, number]>>()
  const edges = new Set<string>()
  const edgeKey = (a: string, b: string) => [a, b].sort().join('|')
  const circles: Array<{ name: string; center: Pt; r: number }> = []

  const addEdge = (a: string, b: string) => {
    const [ax, ay] = P(a)
    const [bx, by] = P(b)
    straight.push([
      [ax, ay],
      [bx, by],
    ])
    taken(a).push(angleOf(bx - ax, by - ay))
    taken(b).push(angleOf(ax - bx, ay - by))
  }

  const polyPoints = fig.polys.flat().map(P)
  const middleOf = polyPoints.length ? polyPoints : extent.map(scaled)
  const figCx = middleOf.reduce((sum, p) => sum + p[0], 0) / middleOf.length
  const figCy = middleOf.reduce((sum, p) => sum + p[1], 0) / middleOf.length

  // Labels asked for on segments and vectors become side annotations.
  const sides: Array<Extract<Item, { kind: 'side' }>> = []

  for (const item of fig.items) {
    const options = item.options
    const color = options.color ?? INK
    if (item.kind === 'poly') {
      const ring = item.names.flatMap(P)
      if (options.shade) fills.push({ kind: 'path', points: ring, closed: true, fill: color, fillOpacity: FILL_OPACITY })
      strokes.push({ kind: 'path', points: ring, closed: true, ...style(options, color) })
      item.names.forEach((name, i) => {
        const next = item.names[(i + 1) % item.names.length]
        addEdge(name, next)
        edges.add(edgeKey(name, next))
      })
      if (options.label) {
        const points = item.names.map(P)
        label(
          points.reduce((sum, p) => sum + p[0], 0) / points.length,
          points.reduce((sum, p) => sum + p[1], 0) / points.length,
          options.label,
          color,
        )
      }
    } else if (item.kind === 'segment' || item.kind === 'line' || item.kind === 'ray' || item.kind === 'vector') {
      const a = P(item.p)
      const b = P(item.q)
      const forward = angleOf(b[0] - a[0], b[1] - a[1])
      if (item.kind === 'segment') {
        strokes.push({ kind: 'path', points: [...a, ...b], ...style(options, color) })
      } else if (item.kind === 'vector') {
        const length = Math.hypot(b[0] - a[0], b[1] - a[1])
        const trim = Math.min(0.5, 5 / length)
        strokes.push({
          kind: 'path',
          points: [...a, b[0] - (b[0] - a[0]) * trim, b[1] - (b[1] - a[1]) * trim],
          ...style(options, color, 1.5),
        })
        strokes.push(arrowHead(b[0], b[1], b[0] - a[0], b[1] - a[1], color, 8))
      } else {
        const [e0, e1] = lineEnds.get(item)!.map(scaled)
        strokes.push({ kind: 'path', points: [...e0, ...e1], ...style(options, color) })
        strokes.push(arrowHead(e1[0], e1[1], e1[0] - e0[0], e1[1] - e0[1], color, 7))
        if (item.kind === 'line') strokes.push(arrowHead(e0[0], e0[1], e0[0] - e1[0], e0[1] - e1[1], color, 7))
        taken(item.q).push(forward)
        if (item.kind === 'line') taken(item.p).push(forward + 180)
      }
      addEdge(item.p, item.q)
      edges.add(edgeKey(item.p, item.q))
      if (options.label) {
        sides.push({
          kind: 'side',
          p: item.p,
          q: item.q,
          text: options.label,
          measure: false,
          auto: true,
          vec: item.kind === 'vector',
          options: { color },
        })
      }
    } else if (item.kind === 'circle') {
      const center = P(item.center)
      const r = item.r * scale
      const ring = arcPoints(center[0], center[1], r, 0, 360, 4).slice(0, -2)
      if (options.shade) fills.push({ kind: 'path', points: ring, closed: true, fill: color, fillOpacity: FILL_OPACITY })
      strokes.push({ kind: 'path', points: ring, closed: true, ...style(options, color) })
      circles.push({ name: item.center, center, r })
      if (options.label) {
        labelToward(center[0] + r * Math.SQRT1_2, center[1] + r * Math.SQRT1_2, 45, 3, options.label, color)
      }
    } else if (item.kind === 'arc' || item.kind === 'sector') {
      const center = P(item.center)
      const r = item.r * scale
      const a0 = item.a0 + fig.rotate
      const a1 = item.a1 + fig.rotate
      const arc = arcPoints(center[0], center[1], r, a0, a1, 4)
      if (item.kind === 'sector') {
        const wedge = [...center, ...arc]
        if (options.shade !== false) {
          fills.push({ kind: 'path', points: wedge, closed: true, fill: color, fillOpacity: FILL_OPACITY })
        }
        strokes.push({ kind: 'path', points: wedge, closed: true, ...style(options, color) })
        taken(item.center).push(a0, a1)
      } else {
        strokes.push({ kind: 'path', points: arc, ...style(options, color) })
      }
      circles.push({ name: item.center, center, r })
      if (options.label) {
        const middle = (a0 + a1) / 2
        labelToward(center[0] + r * Math.cos(rad(middle)), center[1] + r * Math.sin(rad(middle)), middle, 4, options.label, color)
      }
    } else if (item.kind === 'text') {
      const [x, y] = P(item.at)
      label(x, y, item.text, color)
    } else if (item.kind === 'side') {
      sides.push(item)
    }
  }

  // ---- side annotations: ticks, parallel arrows, length and name labels ----
  const explicit = new Set(sides.filter((side) => !side.auto).map((side) => edgeKey(side.p, side.q)))
  for (const side of sides) {
    const key = edgeKey(side.p, side.q)
    // A measured length is not printed over a label the author wrote for that side.
    if (side.auto && side.measure && explicit.has(key)) continue
    const options = side.options
    const color = options.color ?? INK
    const [ax, ay] = P(side.p)
    const [bx, by] = P(side.q)
    const length = Math.hypot(bx - ax, by - ay)
    if (length < 1e-9) continue
    if (!edges.has(key) && !side.auto) {
      strokes.push({ kind: 'path', points: [ax, ay, bx, by], ...style(options, color) })
      edges.add(key)
      addEdge(side.p, side.q)
    }
    const dx = (bx - ax) / length
    const dy = (by - ay) / length
    const mx = (ax + bx) / 2
    const my = (ay + by) / 2
    let nx = -dy
    let ny = dx
    // Outward is away from the polygon that owns this edge, else the figure's middle.
    const owner = fig.polys.find((poly) =>
      poly.some((name, i) => edgeKey(name, poly[(i + 1) % poly.length]) === key),
    )
    if (owner) {
      const i = owner.findIndex((name, index) => edgeKey(name, owner[(index + 1) % owner.length]) === key)
      const [p1x, p1y] = P(owner[i])
      const [p2x, p2y] = P(owner[(i + 1) % owner.length])
      // Twice the signed area: positive when the vertices run counterclockwise.
      const area = owner.reduce((sum, name, index) => {
        const [x1, y1] = P(name)
        const [x2, y2] = P(owner[(index + 1) % owner.length])
        return sum + x1 * y2 - x2 * y1
      }, 0)
      const ex = (p2x - p1x) / length
      const ey = (p2y - p1y) / length
      ;[nx, ny] = area > 0 ? [ey, -ex] : [-ey, ex]
    } else {
      const lean = (mx - figCx) * nx + (my - figCy) * ny
      if (lean < -1e-9 || (Math.abs(lean) <= 1e-9 && ny < 0)) {
        nx = -nx
        ny = -ny
      }
    }
    // A vector's name sits on the left of its arrow.
    if (side.vec && !options.flip) [nx, ny] = [-dy, dx]
    if (options.flip) {
      nx = -nx
      ny = -ny
    }
    const ticks = options.ticks ?? 0
    const parallel = options.parallel ?? 0
    for (let i = 0; i < ticks; i++) {
      const along = (i - (ticks - 1) / 2) * 3.6
      const tx = mx + dx * along
      const ty = my + dy * along
      marks.push({ kind: 'path', points: [tx - nx * 5, ty - ny * 5, tx + nx * 5, ty + ny * 5], stroke: color, width: 1 })
    }
    if (parallel) {
      const shift = ticks ? 7 + 3.6 * ticks : 0
      for (let i = 0; i < parallel; i++) {
        const along = shift + (i - (parallel - 1) / 2) * 4.4 + 2.5
        const tx = mx + dx * along
        const ty = my + dy * along
        const backX = tx - dx * 5
        const backY = ty - dy * 5
        marks.push({
          kind: 'path',
          points: [backX + nx * 3.6, backY + ny * 3.6, tx, ty, backX - nx * 3.6, backY - ny * 3.6],
          stroke: color,
          width: 1,
        })
      }
    }
    const text = side.measure ? formatLength(length / scale) : side.text
    if (text) {
      const gap = 4 + (ticks ? 5 : 0) + (parallel && !ticks ? 3.6 : 0)
      labelToward(mx, my, angleOf(nx, ny), gap, text, color)
    }
  }

  // ---- angle annotations: arcs, right-angle squares, measures ----
  for (const item of fig.items) {
    if (item.kind !== 'angle') continue
    const options = item.options
    const color = options.color ?? INK
    const B = item.vertex
    const [bx, by] = P(B)
    let A: string
    let C: string
    let start: number
    let delta: number
    if (item.abc) {
      ;[A, , C] = item.abc
      const a1 = angleOf(P(A)[0] - bx, P(A)[1] - by)
      const a2 = angleOf(P(C)[0] - bx, P(C)[1] - by)
      start = a1
      delta = (((a2 - a1) % 360) + 360) % 360
      if (delta > 180) {
        start = a2
        delta = 360 - delta
      }
      if (options.reflex) {
        start = (start + delta) % 360
        delta = 360 - delta
      }
    } else {
      // The interior angle of the shape this vertex belongs to.
      const poly = fig.polys.find((candidate) => candidate.includes(B))!
      const i = poly.indexOf(B)
      A = poly[(i - 1 + poly.length) % poly.length]
      C = poly[(i + 1) % poly.length]
      const area = poly.reduce((sum, name, index) => {
        const [x1, y1] = P(name)
        const [x2, y2] = P(poly[(index + 1) % poly.length])
        return sum + x1 * y2 - x2 * y1
      }, 0)
      const previous = angleOf(P(A)[0] - bx, P(A)[1] - by)
      const next = angleOf(P(C)[0] - bx, P(C)[1] - by)
      // Counterclockwise: the interior runs from the next vertex round to the previous one.
      start = area > 0 ? next : previous
      delta = ((((area > 0 ? previous - next : next - previous) % 360) + 360) % 360)
    }
    const short = Math.min(
      Math.hypot(P(A)[0] - bx, P(A)[1] - by),
      Math.hypot(P(C)[0] - bx, P(C)[1] - by),
    )
    if (short < 1e-9) continue
    const arcs = options.arcs ?? (item.right ? 0 : 1)
    const r = Math.min(arcs <= 1 ? 16 : 13, 0.38 * short)
    let outer = r
    if (item.right) {
      const square = Math.min(10, 0.3 * short)
      const e1: Pt = [Math.cos(rad(start)), Math.sin(rad(start))]
      const e2: Pt = [Math.cos(rad(start + delta)), Math.sin(rad(start + delta))]
      marks.push({
        kind: 'path',
        points: [
          bx + e1[0] * square,
          by + e1[1] * square,
          bx + (e1[0] + e2[0]) * square,
          by + (e1[1] + e2[1]) * square,
          bx + e2[0] * square,
          by + e2[1] * square,
        ],
        stroke: color,
        width: 0.9,
      })
      outer = square * 1.42
    }
    for (let j = 0; j < arcs; j++) {
      const radius = r + j * 3.2
      marks.push({ kind: 'path', points: arcPoints(bx, by, radius, start, start + delta, 6), stroke: color, width: 0.9 })
      outer = Math.max(outer, radius)
    }
    const text = item.measure ? `${formatNumber(delta, 1)}°` : item.text
    if (text) {
      const { hw, hh } = labelHalfSize(text)
      const half = rad(Math.min(delta, 180) / 2)
      // Far enough out that the label fits between the two sides.
      const need = (Math.max(hw, hh) + 1) / Math.max(Math.tan(half), 0.05)
      const distance = Math.max(outer + 3, Math.min(need, 56))
      const bisector = start + delta / 2
      labelToward(bx + distance * Math.cos(rad(bisector)), by + distance * Math.sin(rad(bisector)), bisector, 0, text, color)
    }
    if (text || arcs || item.right) {
      let list = sweeps.get(B)
      if (!list) sweeps.set(B, (list = []))
      list.push([start, delta, outer])
      // The vertex name must stay clear of the whole marked angle.
      const steps = Math.max(1, Math.ceil(delta / 30))
      for (let j = 0; j <= steps; j++) taken(B).push(start + (delta * j) / steps)
    }
  }

  // ---- point dots and names ----
  for (const name of fig.shown) {
    if (fig.hidden.has(name)) continue
    const [px, py] = P(name)
    const corner = fig.polys.some((poly) => poly.includes(name))
    const dotted = fig.dot.has(name) && (!corner || fig.declared.has(name))
    if (dotted) dots.push({ kind: 'dot', x: px, y: py, r: 2.4, color: INK })
    if (!fig.labels || fig.nolabel.has(name)) continue
    const directions = [...(incident.get(name) ?? [])]
    // A point on a circle: keep its name outside the circle.
    for (const circle of circles) {
      const distance = Math.hypot(px - circle.center[0], py - circle.center[1])
      if (circle.name !== name && Math.abs(distance - circle.r) < 1e-6 * Math.max(1, circle.r)) {
        directions.push(angleOf(circle.center[0] - px, circle.center[1] - py))
      }
    }
    // A point partway along a drawn line: keep off the line on both sides.
    for (const [[ax, ay], [bx, by]] of straight) {
      const lengthSq = (bx - ax) ** 2 + (by - ay) ** 2
      if (lengthSq < 1e-12) continue
      const t = ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / lengthSq
      const off = Math.abs((px - ax) * (by - ay) - (py - ay) * (bx - ax)) / Math.sqrt(lengthSq)
      if (t > 1e-6 && t < 1 - 1e-6 && off < 1e-6) {
        directions.push(angleOf(bx - ax, by - ay), angleOf(ax - bx, ay - by))
      }
    }
    const sorted = [...new Set(directions.map((d) => Math.round((((d % 360) + 360) % 360) * 1e4) / 1e4))].sort(
      (a, b) => a - b,
    )
    let best: number
    if (!sorted.length) {
      const vx = px - figCx
      const vy = py - figCy
      best = Math.hypot(vx, vy) > 1e-9 ? angleOf(vx, vy) : 45
    } else if (sorted.length === 1) best = sorted[0] + 180
    else {
      // The middle of the widest empty wedge around the point.
      let widest = -1
      best = 0
      sorted.forEach((direction, i) => {
        const gap = (((sorted[(i + 1) % sorted.length] - direction) % 360) + 360) % 360 || 360
        if (gap > widest) {
          widest = gap
          best = direction + gap / 2
        }
      })
    }
    best = ((best % 360) + 360) % 360
    let gap = dotted ? 3.5 : 2.5
    // Boxed in by an angle mark: go past it.
    for (const [start, delta, outer] of sweeps.get(name) ?? []) {
      if ((((best - start) % 360) + 360) % 360 <= delta) gap = Math.max(gap, outer + 2)
    }
    labelToward(px, py, best, gap, fig.nameText.get(name) ?? nameLabel(name))
  }

  // ---- to screen coordinates ----
  const flip = (item: SceneItem): SceneItem =>
    item.kind === 'path'
      ? { ...item, points: item.points.map((v, i) => (i % 2 === 0 ? v : -v)) }
      : { ...item, y: -item.y }
  const scene = fitScene(
    'figure',
    [...grid, ...fills, ...strokes, ...marks, ...dots, ...labels].map(flip),
    errors,
  )
  if (!fig.title) return scene

  // The title goes above everything else, centred.
  const titleHeight = 20
  const width = Math.max(scene.width, labelHalfSize(fig.title).hw * 2 + 12)
  const shiftX = (width - scene.width) / 2
  const moved = scene.items.map((item): SceneItem =>
    item.kind === 'path'
      ? { ...item, points: item.points.map((v, i) => v + (i % 2 === 0 ? shiftX : titleHeight)) }
      : { ...item, x: item.x + shiftX, y: item.y + titleHeight },
  )
  moved.push({ kind: 'label', x: width / 2, y: 3, text: fig.title, anchor: 's', bold: true, color: COLORS.navy })
  return { ...scene, width, height: scene.height + titleHeight, items: moved }
}

export function buildFigure(lines: string[]): Scene {
  const errors: string[] = []
  const fig = new Figure()
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    try {
      parseLine(fig, line)
    } catch (error) {
      if (!(error instanceof VisualError)) throw error
      errors.push(`${line} (${error.message})`)
    }
  }
  try {
    return layout(fig, errors)
  } catch (error) {
    if (!(error instanceof VisualError)) throw error
    return { kind: 'figure', width: 0, height: 0, items: [], errors: [...errors, error.message] }
  }
}
