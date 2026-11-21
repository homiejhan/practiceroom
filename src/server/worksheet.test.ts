import { describe, expect, it } from 'vitest'
import { buildRecapEmail, buildWorksheetLatex, markdownToLatex } from './worksheet'

describe('markdownToLatex', () => {
  it('keeps inline and display math and escapes the text around it', () => {
    expect(markdownToLatex('Solve for $x$: $3x + 5 = 20$')).toBe('Solve for $x$: $3x + 5 = 20$\\par')
    expect(markdownToLatex('Evaluate:\n$$\\frac{1}{2} + \\frac{1}{3}$$')).toBe(
      'Evaluate:\\par\n\\[ \\frac{1}{2} + \\frac{1}{3} \\]\\par',
    )
  })

  it('escapes characters that would break a compile', () => {
    expect(markdownToLatex('Save 50% & pay #1_fee {now}')).toBe(
      'Save 50\\% \\& pay \\#1\\_fee \\{now\\}\\par',
    )
    expect(markdownToLatex('It costs \\$5, not $x$ dollars')).toBe('It costs \\$5, not $x$ dollars\\par')
    expect(markdownToLatex('A lone $ sign')).toBe('A lone \\$ sign\\par')
  })

  it('turns numbered steps into an enumerate, keeping blank lines between items', () => {
    const latex = markdownToLatex('1. Subtract $7$.\n\n2. Divide by **4**.\n\nDone.')
    expect(latex).toBe(
      ['\\begin{enumerate}', '\\item Subtract $7$.', '', '\\item Divide by \\textbf{4}.', '', '\\end{enumerate}', 'Done.\\par'].join('\n'),
    )
  })

  it('formats bold text that wraps math', () => {
    expect(markdownToLatex('**Answer: $x = 6$**')).toBe('\\textbf{Answer: $x = 6$}\\par')
  })

  it('maps typed symbols and drops characters pdflatex cannot set', () => {
    expect(markdownToLatex('$4 × 6 ≤ 24$ ✓ 🎉')).toBe('$4 \\times  6 \\le  24$ $\\checkmark$ \\par')
  })
})

describe('buildWorksheetLatex', () => {
  const input = {
    roomTitle: 'Algebra with Maya & Sam',
    tutorName: 'Tess',
    date: 'November 21, 2026',
    questions: [
      { title: 'Two-step equations', question: 'Solve for $x$: $4x - 7 = 17$', answer: '$x = 6$', solution: '1. Add $7$.\n2. Divide by $4$.' },
    ],
  }

  it('leaves the answer key out unless asked', () => {
    const latex = buildWorksheetLatex({ ...input, includeAnswers: false })
    expect(latex).toContain('Algebra with Maya \\& Sam')
    expect(latex).toContain('\\textbf{Question 1.}')
    expect(latex).not.toContain('x = 6')
    expect(latex.trim().endsWith('\\end{document}')).toBe(true)
  })

  it('adds answers and solutions on a new page when asked', () => {
    const latex = buildWorksheetLatex({ ...input, includeAnswers: true })
    expect(latex).toContain('\\newpage')
    expect(latex).toContain('\\textbf{Answer:} $x = 6$')
    expect(latex).toContain('\\item Add $7$.')
  })
})

describe('buildRecapEmail', () => {
  it('escapes names in the HTML body and links the worksheet', () => {
    const email = buildRecapEmail({
      roomTitle: 'Fractions <review>',
      tutorName: 'Tess',
      questionTitles: ['Adding fractions'],
      worksheetUrl: 'https://example.app.space/api/files/apps/x/worksheets/a.pdf?scope=app',
      includeAnswers: false,
    })
    expect(email.subject).toBe('Practice recap: Fractions <review>')
    expect(email.html).toContain('Fractions &lt;review&gt;')
    expect(email.html).toContain('scope=app')
    expect(email.text).toContain('1. Adding fractions')
  })
})
