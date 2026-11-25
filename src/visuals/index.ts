/**
 * Visuals inside question and solution text.
 *
 * Text is Markdown with `$...$` math. A visual is a block on its own lines:
 *
 *   [graph]            [figure]
 *   y = 2x - 3         triangle ABC AB=8 angle A=50 angle B=60
 *   [/graph]           [/figure]
 *
 * (Tables are ordinary Markdown pipe tables and need nothing from here.)
 * `splitVisuals` separates the blocks from the text around them, and
 * `buildVisual` turns a block into a Scene that the browser draws as SVG and
 * the worksheet draws as TikZ. This module has no DOM or React in it, so the
 * worker uses the same code to check what Claude wrote.
 */

import { buildFigure } from './figure'
import { buildGraph } from './graph'
import type { Scene } from './scene'

export type { Scene, SceneItem } from './scene'

export type VisualKind = 'graph' | 'figure'

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: VisualKind; lines: string[]; source: string }

const OPEN = /^\s*\[(graph|figure)\]\s*$/i

/**
 * Split text into runs of Markdown and visual blocks, in order. Blank text
 * between two blocks is dropped, so blocks separated only by blank lines come
 * out next to each other and can sit side by side.
 */
export function splitVisuals(markdown: string): Segment[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const segments: Segment[] = []
  let text: string[] = []
  const flushText = () => {
    if (text.some((line) => line.trim())) segments.push({ kind: 'text', text: text.join('\n') })
    text = []
  }
  for (let i = 0; i < lines.length; i++) {
    const open = OPEN.exec(lines[i])
    if (open) {
      const kind = open[1].toLowerCase() as VisualKind
      const close = new RegExp(`^\\s*\\[/${kind}\\]\\s*$`, 'i')
      const end = lines.findIndex((line, index) => index > i && close.test(line))
      // A block that is never closed stays as text, so nothing after it is swallowed.
      if (end !== -1) {
        flushText()
        const body = lines.slice(i + 1, end)
        segments.push({ kind, lines: body, source: body.join('\n') })
        i = end
        continue
      }
    }
    text.push(lines[i])
  }
  flushText()
  return segments
}

/** The cells of one pipe-table row. A pipe inside `$...$` is part of the math. */
export function tableCells(row: string): string[] {
  const cells: string[] = []
  let cell = ''
  let inMath = false
  const text = row.trim()
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\\' && (text[i + 1] === '|' || text[i + 1] === '$')) {
      cell += text[i + 1] === '|' ? '|' : '\\$'
      i++
    } else if (c === '|' && !inMath) {
      cells.push(cell.trim())
      cell = ''
    } else {
      if (c === '$') inMath = !inMath
      cell += c
    }
  }
  cells.push(cell.trim())
  // Nothing sits before the leading pipe or after the trailing one.
  cells.shift()
  if (cells.length && !cells[cells.length - 1]) cells.pop()
  return cells
}

/** A table's second row when it is only dashes and colons: `|:---:|---:|`. */
export const isRuleRow = (cells: string[]): boolean =>
  cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell))

/**
 * A row of a pipe table: it starts and ends with a pipe and has at least two
 * cells. (Anything looser also matches "|x - 2| = 5" at the start of a line.)
 */
export function isTableRow(line: string | undefined): boolean {
  if (line === undefined) return false
  const text = line.trim()
  return text.startsWith('|') && text.endsWith('|') && tableCells(text).length >= 2
}

/**
 * Make pipe tables safe for a Markdown renderer. Markdown only sees a table
 * when a rule row follows the first row, and it runs a table into the text
 * around it unless a blank line separates them; a table of values is often
 * written with neither. This adds what is missing and changes nothing else.
 */
export function normalizeTables(markdown: string): string {
  if (!markdown.includes('|')) return markdown
  const lines = markdown.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!isTableRow(line)) {
      out.push(line)
      continue
    }
    const first = !isTableRow(lines[i - 1])
    if (first && i > 0 && lines[i - 1].trim()) out.push('')
    out.push(line)
    if (first && !(isTableRow(lines[i + 1]) && isRuleRow(tableCells(lines[i + 1])))) {
      out.push(`|${' :---: |'.repeat(Math.max(1, tableCells(line).length))}`)
    }
    if (!isTableRow(lines[i + 1]) && lines[i + 1]?.trim()) out.push('')
  }
  return out.join('\n')
}

/** Never throws: lines that cannot be read are listed in `scene.errors`. */
export function buildVisual(kind: VisualKind, lines: string[]): Scene {
  return kind === 'graph' ? buildGraph(lines) : buildFigure(lines)
}

/** True when the text has at least one visual block. */
export function hasVisuals(markdown: string): boolean {
  return markdown.includes('[/graph]') || markdown.includes('[/figure]')
}

/**
 * Everything wrong with the visuals in a piece of text, phrased for the
 * author. Empty when all of it can be drawn.
 */
export function checkVisuals(markdown: string): string[] {
  const problems: string[] = []
  for (const segment of splitVisuals(markdown)) {
    if (segment.kind === 'text') {
      for (const line of segment.text.split('\n')) {
        const open = OPEN.exec(line)
        if (open) problems.push(`a [${open[1]}] block has no closing [/${open[1]}] line`)
      }
      continue
    }
    for (const error of buildVisual(segment.kind, segment.lines).errors) {
      problems.push(`[${segment.kind}] ${error}`)
    }
  }
  return problems
}
