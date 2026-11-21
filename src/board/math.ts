/**
 * Math typesetting for the board.
 *
 * Typing uses MathLive's <math-field>, which behaves the way Desmos does:
 * "/" starts a fraction, "^" an exponent, "sqrt" becomes a radical, "pi" a π,
 * "<=" a ≤, and so on. Committed entries are stored as LaTeX and drawn with
 * KaTeX, the same renderer the chat and question cards use.
 */

import katex from 'katex'
import { MathfieldElement } from 'mathlive'

let configured = false

/** One-time MathLive setup: self-hosted fonts, no keypress sounds. */
export function configureMathLive(): void {
  if (configured) return
  configured = true
  MathfieldElement.fontsDirectory = '/mathlive-fonts'
  MathfieldElement.soundsDirectory = null
}

/** MathLive emits a few macros KaTeX does not know; map them to plain LaTeX. */
const KATEX_MACROS: Record<string, string> = {
  '\\differentialD': '\\mathrm{d}',
  '\\exponentialE': '\\mathrm{e}',
  '\\imaginaryI': '\\mathrm{i}',
  '\\placeholder': '\\square',
  '\\mleft': '\\left',
  '\\mright': '\\right',
}

const cache = new Map<string, string>()

export function renderLatex(latex: string): string {
  const hit = cache.get(latex)
  if (hit !== undefined) return hit
  let html: string
  try {
    html = katex.renderToString(latex, {
      throwOnError: false,
      strict: false,
      displayMode: false,
      macros: { ...KATEX_MACROS },
    })
  } catch {
    html = ''
  }
  if (cache.size > 500) cache.clear()
  cache.set(latex, html)
  return html
}

export { MathfieldElement }
