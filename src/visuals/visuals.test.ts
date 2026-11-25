import { describe, expect, it } from 'vitest'
import { VISUAL_FORMAT_BRIEF, VISUAL_FORMAT_RULES } from '../server/ai'
import { compileExpr, constValue } from './expr'
import { buildFigure } from './figure'
import { buildGraph } from './graph'
import { buildVisual, checkVisuals, normalizeTables, splitVisuals } from './index'
import type { Scene, SceneItem } from './scene'
import { sceneToTikz } from './tikz'

const graph = (...lines: string[]): Scene => buildGraph(lines)
const figure = (...lines: string[]): Scene => buildFigure(lines)
const labels = (scene: Scene): string[] =>
  scene.items.flatMap((item) => (item.kind === 'label' ? [item.text] : []))
const strokes = (scene: Scene, color: string) =>
  scene.items.filter(
    (item): item is Extract<SceneItem, { kind: 'path' }> => item.kind === 'path' && item.stroke === color,
  )
const NAVY = '#19468c'

describe('compileExpr', () => {
  const at = (source: string, x: number) => compileExpr(source)(x)

  it('reads implicit multiplication, powers and precedence', () => {
    expect(at('2x - 3', 4)).toBe(5)
    expect(at('-x^2 + 4', 3)).toBe(-5)
    expect(at('(x+1)(x-2)', 3)).toBe(4)
    expect(at('3(x + 1)', 2)).toBe(9)
    expect(at('-1/2 x + 1', 4)).toBe(-1)
    expect(at('2^-1 x', 4)).toBe(2)
  })

  it('reads absolute value bars, functions and constants', () => {
    expect(at('|x - 2|', -1)).toBe(3)
    expect(at('2|x| - 1', -3)).toBe(5)
    expect(at('sqrt(x)', 9)).toBe(3)
    expect(at('sin x', 0)).toBe(0)
    expect(at('cos(pi x)', 1)).toBeCloseTo(-1)
    expect(at('log(x)', 100)).toBeCloseTo(2)
    expect(at('e^x', 1)).toBeCloseTo(Math.E)
    expect(at('cbrt(x)', -8)).toBeCloseTo(-2)
  })

  it('reads the LaTeX forms Claude tends to write', () => {
    expect(at('\\frac{1}{2}x + 3', 4)).toBe(5)
    expect(at('\\sqrt{x + 1}', 8)).toBe(3)
    expect(at('\\sqrt[3]{x}', 27)).toBeCloseTo(3)
    expect(at('2 \\cdot x', 5)).toBe(10)
    expect(at('$x^{2}$', 3)).toBe(9)
  })

  it('gives null where the expression has no real value', () => {
    expect(at('sqrt(x)', -1)).toBeNull()
    expect(at('1/(x - 1)', 1)).toBeNull()
    expect(at('ln(x)', 0)).toBeNull()
    expect(at('x^(1/2)', -4)).toBeNull()
  })

  it('refuses anything that is not math in x', () => {
    expect(() => compileExpr('2y + 1')).toThrow(/unknown name/)
    expect(() => compileExpr('alert(1)')).toThrow()
    expect(() => compileExpr('x +')).toThrow()
    expect(() => compileExpr('')).toThrow()
    expect(() => constValue('x + 1')).toThrow(/must be a number/)
  })

  it('evaluates constants', () => {
    expect(constValue('-1/2')).toBe(-0.5)
    expect(constValue('2pi')).toBeCloseTo(2 * Math.PI)
    expect(constValue('3sqrt(2)')).toBeCloseTo(3 * Math.SQRT2)
  })
})

describe('splitVisuals', () => {
  it('separates blocks from the text around them, in order', () => {
    const segments = splitVisuals('Graph it.\n[graph]\ny = x\n[/graph]\nThen answer.')
    expect(segments.map((segment) => segment.kind)).toEqual(['text', 'graph', 'text'])
    expect(segments[1]).toMatchObject({ lines: ['y = x'] })
  })

  it('puts blocks separated only by blank lines next to each other', () => {
    const segments = splitVisuals('[graph]\n[/graph]\n\n[figure]\ncircle O radius 2\n[/figure]')
    expect(segments.map((segment) => segment.kind)).toEqual(['graph', 'figure'])
  })

  it('leaves an unclosed block as text and reports it', () => {
    const text = 'Look:\n[graph]\ny = x'
    expect(splitVisuals(text)).toEqual([{ kind: 'text', text }])
    expect(checkVisuals(text)).toEqual(['a [graph] block has no closing [/graph] line'])
  })

  it('accepts tags indented inside a list item', () => {
    const segments = splitVisuals('1. Draw:\n   [figure]\n   square ABCD side 2\n   [/figure]')
    expect(segments.map((segment) => segment.kind)).toEqual(['text', 'figure'])
  })
})

describe('normalizeTables', () => {
  it('adds the rule row and blank lines Markdown needs', () => {
    expect(normalizeTables('Fill in:\n| $x$ | 1 | 2 |\n| $y$ |  |  |\n(a) Done.')).toBe(
      'Fill in:\n\n| $x$ | 1 | 2 |\n| :---: | :---: | :---: |\n| $y$ |  |  |\n\n(a) Done.',
    )
  })

  it('leaves a complete table and ordinary text alone', () => {
    const table = '| a | b |\n|:--|--:|\n| 1 | 2 |'
    expect(normalizeTables(table)).toBe(table)
    expect(normalizeTables('|x - 2| = 5 has two solutions')).toBe('|x - 2| = 5 has two solutions')
  })
})

describe('buildGraph', () => {
  it('plots a line inside the canvas', () => {
    const scene = graph('x: -5 to 5', 'y: -5 to 5', 'y = 2x - 3')
    expect(scene.errors).toEqual([])
    const [line] = strokes(scene, NAVY)
    expect(line.points.length).toBe(4) // a straight line simplifies to its two ends
    for (let i = 0; i < line.points.length; i += 2) {
      expect(line.points[i]).toBeGreaterThanOrEqual(0)
      expect(line.points[i]).toBeLessThanOrEqual(scene.width)
      expect(line.points[i + 1]).toBeGreaterThanOrEqual(0)
      expect(line.points[i + 1]).toBeLessThanOrEqual(scene.height)
    }
  })

  it('draws closed and open endpoint dots for a piecewise function, in one colour', () => {
    const scene = graph('x: -4 to 6', 'y: -2 to 6', 'y = x + 3 for -3 <= x < 0', 'y = -x + 4 for 0 <= x <= 4')
    const dots = scene.items.filter((item) => item.kind === 'dot')
    expect(dots.filter((dot) => dot.kind === 'dot' && dot.open)).toHaveLength(1)
    expect(dots.filter((dot) => dot.kind === 'dot' && !dot.open)).toHaveLength(3)
    expect(new Set(dots.map((dot) => (dot.kind === 'dot' ? dot.color : ''))).size).toBe(1)
    // Open dots are drawn first, so a closed dot at the same spot shows on top.
    const order = dots.map((dot) => (dot.kind === 'dot' && dot.open ? 'open' : 'closed'))
    expect(order).toEqual(['open', 'closed', 'closed', 'closed'])
  })

  it('shades an inequality and dashes a strict boundary', () => {
    const strict = graph('y < -x + 2')
    const fills = strict.items.filter((item) => item.kind === 'path' && item.fill && item.fillOpacity! < 1)
    expect(fills).toHaveLength(1)
    expect(strokes(strict, NAVY)[0].dash).toBe('dashed')
    expect(strokes(graph('y <= -x + 2'), NAVY)[0].dash).toBe('solid')
    expect(graph('y < -x + 2 [noshade]').items.filter((item) => item.kind === 'path' && item.fill && item.fillOpacity! < 1)).toHaveLength(0)
  })

  it('breaks a curve at an asymptote instead of joining across it', () => {
    const scene = graph('x: -6 to 6', 'y: -6 to 6', 'y = 1/(x - 1)')
    const pieces = strokes(scene, NAVY)
    expect(pieces.length).toBe(2)
    // No piece runs the full height of the plot in one step.
    for (const piece of pieces) {
      for (let i = 3; i < piece.points.length; i += 2) {
        expect(Math.abs(piece.points[i] - piece.points[i - 2])).toBeLessThan(scene.height * 0.8)
      }
    }
  })

  it('leaves a gap where a function is undefined', () => {
    const scene = graph('x: -5 to 5', 'y: -1 to 4', 'y = sqrt(x)')
    const [curve] = strokes(scene, NAVY)
    const xs = curve.points.filter((_, i) => i % 2 === 0)
    // Nothing is drawn left of x = 0, the middle of the plot.
    expect(Math.min(...xs)).toBeGreaterThan(scene.width * 0.4)
  })

  it('keeps the outline of closed shapes', () => {
    const scene = graph('polygon A(1, 1) B(4, 1) C(4, 3)', 'circle (-3, -3) radius 2')
    expect(strokes(scene, NAVY)[0].points.length).toBeGreaterThanOrEqual(8)
    expect(strokes(scene, '#c8322b')[0].points.length).toBeGreaterThan(20)
    expect(labels(scene)).toEqual(expect.arrayContaining(['$A$', '$B$', '$C$']))
  })

  it('labels the axes in multiples of pi when the window is', () => {
    const scene = graph('x: -2pi to 2pi', 'y: -2 to 2', 'y = sin(x)')
    expect(labels(scene)).toEqual(expect.arrayContaining(['$\\pi$', '$-2\\pi$']))
  })

  it('draws a blank grid from an empty block', () => {
    const scene = graph()
    expect(scene.errors).toEqual([])
    expect(scene.items.length).toBeGreaterThan(20)
    expect(scene.width).toBeGreaterThan(200)
  })

  it('skips a line it cannot read and draws the rest', () => {
    const scene = graph('y = 2x + 1', 'y = foo(x)', 'banana', 'point (1, 2, 3)')
    expect(scene.errors).toHaveLength(3)
    expect(scene.errors[0]).toContain('y = foo(x)')
    expect(strokes(scene, NAVY)).toHaveLength(1)
  })

  it('keeps labels apart when two curves want the same spot', () => {
    const scene = graph('x: -5 to 5', 'y: -5 to 5', 'y = 2x - 3 [label: $f$]', 'y = -x^2 + 4 [label: $g$]')
    const placed = scene.items.filter(
      (item): item is Extract<SceneItem, { kind: 'label' }> =>
        item.kind === 'label' && (item.text === '$f$' || item.text === '$g$'),
    )
    expect(placed).toHaveLength(2)
    expect(Math.hypot(placed[0].x - placed[1].x, placed[0].y - placed[1].y)).toBeGreaterThan(12)
  })
})

describe('buildFigure', () => {
  it('solves a triangle from two angles and a side', () => {
    const scene = figure('triangle ABC AB=8 angle A=50 angle B=60', 'angle C measure', 'side AB measure')
    expect(scene.errors).toEqual([])
    expect(labels(scene)).toEqual(expect.arrayContaining(['70°', '8', '$A$', '$B$', '$C$']))
  })

  it('measures sides exactly, as radicals where they are', () => {
    expect(labels(figure('right triangle ABC legs 3 4', 'side AC measure'))).toContain('5')
    expect(labels(figure('right triangle ABC legs 1 1', 'side AC measure'))).toContain('$\\sqrt{2}$')
    expect(labels(figure('right triangle ABC legs 2 4', 'side AC measure'))).toContain('$2\\sqrt{5}$')
    expect(labels(figure('triangle ABC sides 5 6 7 [angles]'))).toEqual(
      expect.arrayContaining(['57.1°', '78.5°', '44.4°']),
    )
  })

  it('is drawn to scale', () => {
    // A 6 by 3 rectangle is twice as wide as it is tall on screen too.
    const scene = figure('labels: off', 'rectangle ABCD width 6 height 3')
    const [outline] = scene.items.filter((item) => item.kind === 'path')
    if (outline.kind !== 'path') throw new Error('expected a path')
    const xs = outline.points.filter((_, i) => i % 2 === 0)
    const ys = outline.points.filter((_, i) => i % 2 === 1)
    expect((Math.max(...xs) - Math.min(...xs)) / (Math.max(...ys) - Math.min(...ys))).toBeCloseTo(2, 5)
  })

  it('builds constructed points', () => {
    const scene = figure(
      'trapezoid ABCD bottom 10 top 6 height 4',
      'point E foot D A B',
      'segment D E [dashed]',
      'right angle DEA',
      'side DE measure',
      'point M midpoint A B',
      'side AM measure',
    )
    expect(scene.errors).toEqual([])
    expect(labels(scene)).toEqual(expect.arrayContaining(['4', '5', '$E$', '$M$']))
    expect(scene.items.some((item) => item.kind === 'path' && item.dash === 'dashed')).toBe(true)
  })

  it('accepts a label written in parentheses', () => {
    const scene = figure('parallelogram ABCD base 7 side 4 angle 65', 'angle C (2y + 5)°')
    expect(scene.errors).toEqual([])
    expect(labels(scene)).toContain('(2y + 5)°')
  })

  it('keeps everything, labels included, inside the canvas', () => {
    const scene = figure(
      'title: Figure 1',
      'triangle ABC AB=8 angle A=50 angle B=60',
      'side AB a long label for the base',
      'side BC $x$',
      'angle A 50°',
    )
    for (const item of scene.items) {
      if (item.kind === 'path') {
        for (let i = 0; i < item.points.length; i += 2) {
          expect(item.points[i]).toBeGreaterThanOrEqual(0)
          expect(item.points[i]).toBeLessThanOrEqual(scene.width)
          expect(item.points[i + 1]).toBeGreaterThanOrEqual(0)
          expect(item.points[i + 1]).toBeLessThanOrEqual(scene.height)
        }
      } else {
        expect(item.x).toBeGreaterThanOrEqual(0)
        expect(item.x).toBeLessThanOrEqual(scene.width)
        expect(item.y).toBeGreaterThanOrEqual(0)
        expect(item.y).toBeLessThanOrEqual(scene.height)
      }
    }
  })

  it('reports impossible or incomplete geometry instead of drawing it wrong', () => {
    const impossible = figure('triangle ABC AB=1 BC=1 CA=5')
    expect(impossible.items).toEqual([])
    expect(impossible.errors[0]).toMatch(/can't form a triangle/)
    expect(figure('segment A B').errors[0]).toMatch(/hasn't been defined/)
    expect(figure('triangle ABC AB=5').errors[0]).toMatch(/not enough/)
    expect(figure('square ABCD side 2', 'point A (9, 9)').errors[0]).toMatch(/already exists/)
  })
})

describe('sceneToTikz', () => {
  it('writes a picture with its colours, paths and labels', () => {
    const tikz = sceneToTikz(graph('y = 2x - 1 [label: $f$]', 'open point (2, 3)'), (text) => text)
    expect(tikz.startsWith('\\begin{tikzpicture}')).toBe(true)
    expect(tikz).toContain('\\definecolor{prc19468C}{HTML}{19468C}')
    expect(tikz).toContain('draw=prc19468C')
    expect(tikz).toContain('fill=white')
    expect(tikz).toContain('{$f$}')
    expect(tikz.trim().endsWith('\\end{tikzpicture}')).toBe(true)
  })

  it('writes nothing for a visual that could not be drawn', () => {
    expect(sceneToTikz(figure('triangle ABC AB=1 BC=1 CA=5'), (text) => text)).toBe('')
  })
})

/**
 * The prompt is the only documentation Claude gets. Every example it shows
 * must be something the parser reads, or Claude is being taught lines that
 * will not draw.
 */
describe('the visual format taught to Claude', () => {
  it('has example blocks that draw without errors', () => {
    expect(checkVisuals(VISUAL_FORMAT_RULES)).toEqual([])
    const kinds = splitVisuals(VISUAL_FORMAT_RULES).map((segment) => segment.kind)
    expect(kinds).toContain('graph')
    expect(kinds).toContain('figure')
  })

  const quoted = (heading: string): string[] => {
    const line = VISUAL_FORMAT_RULES.split('\n').find((candidate) => candidate.startsWith(heading))
    if (!line) throw new Error(`the prompt has no "${heading}" line`)
    return [...line.matchAll(/"([^"]+)"/g)].map((match) => match[1])
  }
  // Placeholders and fragments, not whole lines.
  const isWholeLine = (example: string) =>
    !example.includes('...') && !example.includes('a to b') && !example.startsWith('for ') && !example.startsWith('-2pi')

  it('lists graph settings and items the parser accepts', () => {
    const examples = [...quoted('Settings:'), ...quoted('Items:')].filter(isWholeLine)
    expect(examples.length).toBeGreaterThan(12)
    for (const example of examples) {
      expect(buildVisual('graph', [example]).errors, example).toEqual([])
    }
    expect(buildVisual('graph', ['x: -2pi to 2pi', 'y = x + 3 for -3 <= x < 1']).errors).toEqual([])
  })

  it('lists figure shapes the parser accepts', () => {
    const examples = quoted('Shapes:')
    expect(examples.length).toBeGreaterThan(10)
    for (const example of examples) {
      const scene = buildVisual('figure', [example])
      expect(scene.errors, example).toEqual([])
      expect(scene.items.length, example).toBeGreaterThan(0)
    }
  })

  it('lists figure points, lines and marks the parser accepts', () => {
    const examples = [...quoted('Points and lines:'), ...quoted('Marks:')]
    expect(examples.length).toBeGreaterThan(12)
    for (const example of examples) {
      // Each example is tried on its own, against a figure that already has A, B, C and O.
      const scene = buildVisual('figure', ['triangle ABC AB=8 angle A=50 angle B=60', 'point O (4, 2)', example])
      expect(scene.errors, example).toEqual([])
    }
  })

  it('lists colours and styles the parser accepts', () => {
    const line = VISUAL_FORMAT_RULES.split('\n').find((candidate) => candidate.startsWith('Options go'))!
    const colors = /Colors: ([^.]+)\./.exec(line)![1].split(', ')
    const styles = /Also: ([^.]+)\./.exec(line)![1].split(', ')
    for (const option of [...colors, ...styles]) {
      expect(buildVisual('figure', [`square ABCD side 2 [${option}]`]).errors, option).toEqual([])
    }
  })

  it('has a short version, for grading and the assistant, that the parser accepts too', () => {
    expect(checkVisuals(VISUAL_FORMAT_BRIEF)).toEqual([])
    expect(splitVisuals(VISUAL_FORMAT_BRIEF).map((segment) => segment.kind)).toEqual(
      expect.arrayContaining(['graph', 'figure']),
    )
    const lineOf = (heading: string) =>
      VISUAL_FORMAT_BRIEF.split('\n').find((candidate) => candidate.startsWith(heading))!
    for (const [, example] of lineOf('Other shapes:').matchAll(/"([^"]+)"/g)) {
      expect(buildVisual('figure', [example]).errors, example).toEqual([])
    }
    for (const [, example] of lineOf('Other marks:').matchAll(/"([^"]+)"/g)) {
      const scene = buildVisual('figure', ['triangle ABC AB=8 angle A=50 angle B=60', example])
      expect(scene.errors, example).toEqual([])
    }
    // The point of it: much shorter than the full guide.
    expect(VISUAL_FORMAT_BRIEF.length).toBeLessThan(VISUAL_FORMAT_RULES.length / 2.5)
  })
})
