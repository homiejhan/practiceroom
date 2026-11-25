/**
 * Turn a room's questions into a LaTeX worksheet.
 *
 * Questions and solutions are stored as Markdown with `$...$` math (that is
 * what the board and chat render). A printed worksheet needs real LaTeX, so
 * this converts the small Markdown subset Claude is told to write — paragraphs,
 * numbered and bulleted lists, bold, italics, inline and display math, pipe
 * tables — and escapes everything else, so stray characters cannot break the
 * compile. `[graph]` and `[figure]` blocks are drawn with TikZ from the same
 * scene the browser draws as SVG.
 */

import { buildVisual, isRuleRow, isTableRow, splitVisuals, tableCells } from '../visuals/index.js'
import { sceneToTikz } from '../visuals/tikz.js'

export interface WorksheetQuestion {
  title: string
  question: string
  answer: string
  solution: string
}

export interface WorksheetInput {
  roomTitle: string
  tutorName: string
  /** Already formatted for display, e.g. "November 21, 2026". */
  date: string
  questions: WorksheetQuestion[]
  includeAnswers: boolean
}

/** Symbols Claude sometimes types directly, as LaTeX math commands. */
const MATH_SYMBOLS: Record<string, string> = {
  '×': '\\times ',
  '÷': '\\div ',
  '−': '-',
  '–': '-',
  '±': '\\pm ',
  '≤': '\\le ',
  '≥': '\\ge ',
  '≠': '\\ne ',
  '≈': '\\approx ',
  '∞': '\\infty ',
  'π': '\\pi ',
  'θ': '\\theta ',
  '°': '^{\\circ}',
  '√': '\\surd ',
  '→': '\\to ',
  '⇒': '\\Rightarrow ',
  '·': '\\cdot ',
  '✓': '\\checkmark ',
  '✔': '\\checkmark ',
}

/** Typographic characters that have a plain-text LaTeX spelling. */
const TEXT_SYMBOLS: Record<string, string> = {
  '‘': '`',
  '’': "'",
  '“': '``',
  '”': "''",
  '–': '--',
  '—': '---',
  '…': '\\ldots{}',
  ' ': '~',
}

const TEXT_ESCAPES: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '&': '\\&',
  '%': '\\%',
  '#': '\\#',
  _: '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
  $: '\\$',
  '<': '$<$',
  '>': '$>$',
  '|': '$|$',
}

const isAscii = (ch: string): boolean => ch.charCodeAt(0) < 128

// Private-use characters mark where a math segment was lifted out of a line,
// so the text around it can be escaped without touching the math.
const MARK_OPEN = ''
const MARK_CLOSE = ''

function cleanMath(math: string): string {
  let out = ''
  for (const ch of math) {
    if (isAscii(ch)) out += ch
    else out += MATH_SYMBOLS[ch] ?? ' '
  }
  return out.trim()
}

function escapeText(text: string): string {
  let out = ''
  for (const ch of text) {
    if (TEXT_ESCAPES[ch] !== undefined) out += TEXT_ESCAPES[ch]
    else if (isAscii(ch) || ch === MARK_OPEN || ch === MARK_CLOSE) out += ch
    else if (TEXT_SYMBOLS[ch] !== undefined) out += TEXT_SYMBOLS[ch]
    else if (MATH_SYMBOLS[ch] !== undefined) out += `$${MATH_SYMBOLS[ch].trim()}$`
    // Anything else (emoji, other scripts) would stop pdflatex; leave it out.
  }
  return out
}

/** One line of Markdown (no block structure) to LaTeX. */
export function inlineToLatex(line: string): string {
  const math: string[] = []
  const stash = (latex: string): string => {
    math.push(latex)
    return `${MARK_OPEN}${math.length - 1}${MARK_CLOSE}`
  }

  let text = line
    // Markers may only come from stash() below, never from the input.
    .replaceAll(MARK_OPEN, '')
    .replaceAll(MARK_CLOSE, '')
    // An escaped dollar is a literal dollar sign, not a math delimiter.
    .replace(/\\\$/g, () => stash('\\$'))
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, body: string) => stash(`\\[ ${cleanMath(body)} \\]`))
    .replace(/\$([^$\n]+?)\$/g, (_, body: string) => stash(`$${cleanMath(body)}$`))
    .replace(/`([^`\n]+)`/g, (_, code: string) => stash(`\\texttt{${escapeText(code)}}`))

  text = escapeText(text)
    .replace(/\*\*(.+?)\*\*/g, '\\textbf{$1}')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1\\emph{$2}')

  return text.replace(
    new RegExp(`${MARK_OPEN}(\\d+)${MARK_CLOSE}`, 'g'),
    (_, index: string) => math[Number(index)] ?? '',
  )
}

type ListKind = 'enumerate' | 'itemize'

/**
 * Consecutive pipe rows as a ruled table. A second row of dashes makes the
 * first row a bold header and sets each column's alignment; an empty cell is
 * left wide enough to write in.
 */
function tableToLatex(rows: string[]): string {
  const parsed = rows.map(tableCells)
  const hasHeader = parsed.length >= 2 && isRuleRow(parsed[1])
  const align = hasHeader
    ? parsed[1].map((cell) => (cell.startsWith(':') === cell.endsWith(':') ? 'c' : cell.endsWith(':') ? 'r' : 'l'))
    : []
  const body = hasHeader ? [parsed[0], ...parsed.slice(2)] : parsed
  const columns = Math.max(...body.map((row) => row.length))
  const spec = Array.from({ length: columns }, (_, i) => align[i] ?? 'c').join('|')
  const line = (cells: string[], bold: boolean): string =>
    `${Array.from({ length: columns }, (_, i) => {
      const cell = cells[i] ?? ''
      if (!cell) return '\\hspace{0.45in}'
      return bold ? `\\textbf{${inlineToLatex(cell)}}` : inlineToLatex(cell)
    }).join(' & ')} \\\\ \\hline`
  return [
    '\\begin{center}',
    '{\\renewcommand{\\arraystretch}{1.4}',
    `\\begin{tabular}{|${spec}|}`,
    '\\hline',
    ...body.map((row, i) => line(row, hasHeader && i === 0)),
    '\\end{tabular}}',
    '\\end{center}',
  ].join('\n')
}

/** Markdown text with no visual blocks in it, to a LaTeX fragment. */
function textToLatex(markdown: string): string {
  const out: string[] = []
  let list: ListKind | null = null
  const closeList = () => {
    if (list) out.push(`\\end{${list}}`)
    list = null
  }

  // Display math written across several lines is joined first so the
  // line-based pass below sees it as one unit.
  const lines = markdown
    .replace(/\r\n?/g, '\n')
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, body: string) => `$$${body.replace(/\s*\n\s*/g, ' ')}$$`)
    .split('\n')

  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index]
    const line = rawLine.trimEnd()
    if (!line.trim()) {
      // A blank line ends a paragraph but not a list: Markdown lists often
      // have blank lines between items.
      out.push('')
      continue
    }
    if (/^\s*(```|~~~)/.test(line)) continue

    if (isTableRow(line)) {
      let end = index
      while (isTableRow(lines[end + 1])) end++
      closeList()
      out.push(tableToLatex(lines.slice(index, end + 1)))
      index = end
      continue
    }

    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/)
    const bulleted = line.match(/^\s*[-*+]\s+(.*)$/)
    if (numbered || bulleted) {
      const kind: ListKind = numbered ? 'enumerate' : 'itemize'
      if (list !== kind) {
        closeList()
        out.push(`\\begin{${kind}}`)
        list = kind
      }
      // The step's own number is kept, so a list that carries on after a
      // figure or a table does not start again from 1.
      out.push(numbered ? `\\item[${numbered[1]}.] ${inlineToLatex(numbered[2])}` : `\\item ${inlineToLatex(bulleted![1])}`)
      continue
    }

    const heading = line.match(/^\s*#{1,6}\s+(.*)$/)
    if (heading) {
      closeList()
      out.push(`\\textbf{${inlineToLatex(heading[1])}}\\par`)
      continue
    }

    // Indented text under a list item continues that item; anything else
    // starts a new paragraph outside the list.
    if (list && !/^\s{2,}/.test(rawLine)) closeList()
    out.push(`${inlineToLatex(line.trim())}\\par`)
  }
  closeList()
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Markdown (the subset described above) to a LaTeX fragment. */
export function markdownToLatex(markdown: string): string {
  const parts: string[] = []
  // Blocks separated only by blank lines share a row, as they do on screen.
  let row: string[] = []
  const flushRow = () => {
    if (row.length) parts.push(`\\begin{center}\n${row.join('\n\\hspace{0.15in}\n')}\n\\end{center}`)
    row = []
  }
  for (const segment of splitVisuals(markdown)) {
    if (segment.kind === 'text') {
      flushRow()
      parts.push(textToLatex(segment.text))
    } else {
      const picture = sceneToTikz(buildVisual(segment.kind, segment.lines), inlineToLatex)
      if (picture) row.push(picture)
    }
  }
  flushRow()
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function buildWorksheetLatex(input: WorksheetInput): string {
  const parts: string[] = [
    '\\documentclass[11pt]{article}',
    '\\usepackage{amsmath,amssymb}',
    '\\usepackage[margin=1in]{geometry}',
    '\\usepackage{tikz}',
    '\\setlength{\\parindent}{0pt}',
    '\\setlength{\\parskip}{6pt}',
    '\\pagestyle{empty}',
    '\\begin{document}',
    `{\\Large\\bfseries ${escapeText(input.roomTitle)}}\\par`,
    `${escapeText(input.tutorName)} \\hfill ${escapeText(input.date)}\\par`,
    'Name: \\rule{2.6in}{0.4pt}\\par',
    '\\vspace{4pt}\\hrule\\vspace{14pt}',
  ]

  input.questions.forEach((question, index) => {
    parts.push(
      // One unbreakable box per question, so a figure never lands on the page
      // after the text that refers to it.
      '\\noindent\\begin{minipage}{\\linewidth}\\setlength{\\parskip}{6pt}',
      `\\textbf{Question ${index + 1}.}\\par`,
      markdownToLatex(question.question),
      '\\end{minipage}\\par',
      // Room to work the problem by hand.
      '\\vspace{1.7in}',
    )
  })

  if (input.includeAnswers) {
    parts.push('\\newpage', '{\\Large\\bfseries Answers and worked solutions}\\par', '\\vspace{8pt}')
    input.questions.forEach((question, index) => {
      parts.push(
        `\\textbf{Question ${index + 1}.} ${escapeText(question.title)}\\par`,
        `\\textbf{Answer:} ${markdownToLatex(question.answer)}`,
      )
      if (question.solution) parts.push(markdownToLatex(question.solution))
      parts.push('\\vspace{10pt}')
    })
  }

  parts.push('\\end{document}')
  return parts.join('\n')
}

/** Plain-text and HTML bodies for the recap email. Math stays in the PDF. */
export function buildRecapEmail(input: {
  roomTitle: string
  tutorName: string
  questionTitles: string[]
  worksheetUrl: string
  includeAnswers: boolean
}): { subject: string; text: string; html: string } {
  const count = input.questionTitles.length
  const noun = count === 1 ? 'question' : 'questions'
  const contents = input.includeAnswers
    ? 'the questions with space to work, followed by the answers and worked solutions'
    : 'the questions with space to work'
  const intro = `Here is the recap from "${input.roomTitle}" with ${input.tutorName}. We worked on ${count} ${noun}:`
  const outro = `The worksheet has ${contents}:`
  const signoff = `Reply to this email to reach ${input.tutorName}.`

  const text = [
    intro,
    '',
    ...input.questionTitles.map((title, index) => `${index + 1}. ${title}`),
    '',
    outro,
    input.worksheetUrl,
    '',
    signoff,
  ].join('\n')

  const esc = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const html = [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1b1c1f">',
    `<p>${esc(intro)}</p>`,
    `<ol>${input.questionTitles.map((title) => `<li>${esc(title)}</li>`).join('')}</ol>`,
    `<p>${esc(outro)}</p>`,
    `<p><a href="${esc(input.worksheetUrl)}" style="color:#0f6b5c;font-weight:600">Open the worksheet (PDF)</a></p>`,
    `<p style="color:#5d6067">${esc(signoff)}</p>`,
    '</div>',
  ].join('')

  return { subject: `Practice recap: ${input.roomTitle}`, text, html }
}
