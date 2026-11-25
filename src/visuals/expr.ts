/**
 * A small math-expression compiler for graphs: "2x - 3", "-x^2 + 4",
 * "|x - 2|", "sin x", "\frac{1}{2}x".
 *
 * The text is tokenised and parsed into a closure; nothing is evaluated as
 * code. A value that does not exist (the square root of a negative, a division
 * by zero) comes back as null so a plot can leave a gap there.
 */

/** A line of a visual that could not be read. The message is shown to the author. */
export class VisualError extends Error {}

const FUNCTIONS: Record<string, (value: number) => number> = {
  arcsin: Math.asin,
  arccos: Math.acos,
  arctan: Math.atan,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  sec: (value) => 1 / Math.cos(value),
  csc: (value) => 1 / Math.sin(value),
  cot: (value) => Math.cos(value) / Math.sin(value),
  ln: Math.log,
  log: Math.log10,
  exp: Math.exp,
  floor: Math.floor,
  ceil: Math.ceil,
}

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E }

// Longest first, so "exp" is read before "e" and "x".
const NAMES = [...Object.keys(FUNCTIONS), ...Object.keys(CONSTANTS), 'x'].sort(
  (a, b) => b.length - a.length,
)

type Token =
  | { t: 'num'; value: number }
  | { t: 'x' }
  | { t: 'func'; name: string }
  | { t: 'op'; op: '+' | '-' | '*' | '/' | '^' }
  | { t: 'lp' }
  | { t: 'rp' }
  | { t: 'bar' }

/** s[i] is "{": the text inside the braces and the index just past the closing one. */
function braceGroup(s: string, i: number): [string, number] {
  let depth = 0
  for (let j = i; j < s.length; j++) {
    if (s[j] === '{') depth++
    else if (s[j] === '}') {
      depth--
      if (depth === 0) return [s.slice(i + 1, j), j + 1]
    }
  }
  throw new VisualError(`unbalanced braces in "${s}"`)
}

/** Rewrite \frac{a}{b} and \sqrt[n]{a} as plain parenthesised math. */
function expandLatex(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    const rest = s.slice(i)
    const frac = /^\\[dt]?frac\s*(?=\{)/.exec(rest)
    if (frac) {
      const [a, afterA] = braceGroup(s, i + frac[0].length)
      let j = afterA
      while (s[j] === ' ') j++
      if (s[j] !== '{') throw new VisualError('\\frac needs two {...} groups')
      const [b, afterB] = braceGroup(s, j)
      out += `((${expandLatex(a)})/(${expandLatex(b)}))`
      i = afterB
      continue
    }
    const root = /^\\sqrt\s*(?:\[([^\]]*)\])?\s*(?=\{)/.exec(rest)
    if (root) {
      const [inner, after] = braceGroup(s, i + root[0].length)
      const a = expandLatex(inner)
      const n = (root[1] ?? '').trim()
      if (!n || n === '2') out += `sqrt(${a})`
      else if (n === '3') out += `cbrt(${a})`
      else out += `((${a})^(1/(${n})))`
      i = after
      continue
    }
    out += s[i]
    i++
  }
  return out
}

function delatex(source: string): string {
  let s = source
    .replace(/\$/g, '')
    .replace(/−/g, '-')
    .replace(/[·×]/g, '*')
    .replace(/÷/g, '/')
    .replace(/π/g, 'pi')
    .replace(/²/g, '^2')
    .replace(/³/g, '^3')
    .replace(/\\(?:left|right|big|Big)(?![A-Za-z])/g, '')
    .replace(/\\[,;:! ]|\\quad(?![A-Za-z])/g, ' ')
    .replace(/\\(?:cdot|times)(?![A-Za-z])/g, '*')
    .replace(/\\div(?![A-Za-z])/g, '/')
  s = expandLatex(s)
  // \pi -> pi, \sin -> sin
  return s.replace(/\\([A-Za-z]+)/g, ' $1 ').replace(/\{/g, '(').replace(/\}/g, ')')
}

function tokenize(source: string): Token[] {
  const s = delatex(source)
  const tokens: Token[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(s.slice(i))
    if (number) {
      tokens.push({ t: 'num', value: Number(number[0]) })
      i += number[0].length
      continue
    }
    if (/[A-Za-z]/.test(c)) {
      const word = /^[A-Za-z]+/.exec(s.slice(i))![0]
      let j = 0
      while (j < word.length) {
        const name = NAMES.find((candidate) => word.startsWith(candidate, j))
        if (!name) {
          throw new VisualError(`unknown name "${word}" in "${source}" (the variable must be x)`)
        }
        if (name === 'x') tokens.push({ t: 'x' })
        else if (name in CONSTANTS) tokens.push({ t: 'num', value: CONSTANTS[name] })
        else tokens.push({ t: 'func', name })
        j += name.length
      }
      i += word.length
      continue
    }
    if (s.startsWith('**', i)) {
      tokens.push({ t: 'op', op: '^' })
      i += 2
      continue
    }
    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '^') tokens.push({ t: 'op', op: c })
    else if (c === '(') tokens.push({ t: 'lp' })
    else if (c === ')') tokens.push({ t: 'rp' })
    else if (c === '|') tokens.push({ t: 'bar' })
    else throw new VisualError(`unexpected character "${c}" in "${source}"`)
    i++
  }
  return tokens
}

/**
 * Make the implicit explicit: "sin x" gets parentheses, |...| becomes abs(...),
 * and "2x" / "3(x+1)" / "(x+1)(x-2)" get a multiplication sign.
 */
function normalize(tokens: Token[], source: string): Token[] {
  const withCalls: Token[] = []
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k]
    withCalls.push(token)
    if (token.t !== 'func') continue
    const next = tokens[k + 1]
    if (next && (next.t === 'num' || next.t === 'x')) {
      withCalls.push({ t: 'lp' }, next, { t: 'rp' })
      k++
    } else if (!next || next.t !== 'lp') {
      throw new VisualError(
        `"${token.name}" needs its argument in parentheses, e.g. ${token.name}(x)`,
      )
    }
  }

  const out: Token[] = []
  let previousEndsValue = false
  let openBars = 0
  for (const token of withCalls) {
    let pieces: Token[] = [token]
    let startsValue = token.t === 'num' || token.t === 'x' || token.t === 'func' || token.t === 'lp'
    let endsValue = token.t === 'num' || token.t === 'x' || token.t === 'rp'
    if (token.t === 'bar') {
      // A bar closes only when one is open and it follows a complete value.
      if (openBars > 0 && previousEndsValue) {
        openBars--
        pieces = [{ t: 'rp' }]
        startsValue = false
        endsValue = true
      } else {
        openBars++
        pieces = [{ t: 'func', name: 'abs' }, { t: 'lp' }]
        startsValue = true
        endsValue = false
      }
    }
    if (previousEndsValue && startsValue) out.push({ t: 'op', op: '*' })
    out.push(...pieces)
    previousEndsValue = endsValue
  }
  if (openBars > 0) throw new VisualError(`unbalanced | bars in "${source}"`)
  return out
}

type Evaluate = (x: number) => number

/** Recursive descent over the normalized tokens. `-x^2` is `-(x^2)`. */
function parse(tokens: Token[], source: string): Evaluate {
  let position = 0
  const fail = () => new VisualError(`can't read the expression "${source}"`)

  const sum = (): Evaluate => {
    let left = product()
    for (;;) {
      const token = tokens[position]
      if (token?.t !== 'op' || (token.op !== '+' && token.op !== '-')) return left
      position++
      const a = left
      const b = product()
      left = token.op === '+' ? (x) => a(x) + b(x) : (x) => a(x) - b(x)
    }
  }

  const product = (): Evaluate => {
    let left = unary()
    for (;;) {
      const token = tokens[position]
      if (token?.t !== 'op' || (token.op !== '*' && token.op !== '/')) return left
      position++
      const a = left
      const b = unary()
      left = token.op === '*' ? (x) => a(x) * b(x) : (x) => a(x) / b(x)
    }
  }

  const unary = (): Evaluate => {
    const token = tokens[position]
    if (token?.t === 'op' && (token.op === '-' || token.op === '+')) {
      position++
      const inner = unary()
      return token.op === '-' ? (x) => -inner(x) : inner
    }
    return power()
  }

  const power = (): Evaluate => {
    const base = atom()
    const token = tokens[position]
    if (token?.t !== 'op' || token.op !== '^') return base
    position++
    const exponent = unary()
    return (x) => Math.pow(base(x), exponent(x))
  }

  const group = (): Evaluate => {
    if (tokens[position]?.t !== 'lp') throw fail()
    position++
    const inner = sum()
    if (tokens[position]?.t !== 'rp') throw fail()
    position++
    return inner
  }

  const atom = (): Evaluate => {
    const token = tokens[position]
    if (!token) throw fail()
    if (token.t === 'num') {
      position++
      return () => token.value
    }
    if (token.t === 'x') {
      position++
      return (x) => x
    }
    if (token.t === 'func') {
      position++
      const apply = FUNCTIONS[token.name]
      const inner = group()
      return (x) => apply(inner(x))
    }
    if (token.t === 'lp') return group()
    throw fail()
  }

  const result = sum()
  if (position !== tokens.length) throw fail()
  return result
}

/**
 * Compile an expression in x. The returned function gives null wherever the
 * expression has no real, finite value.
 */
export function compileExpr(source: string, allowX = true): (x: number) => number | null {
  const tokens = normalize(tokenize(source), source)
  if (!tokens.length) throw new VisualError('an expression is missing')
  if (!allowX && tokens.some((token) => token.t === 'x')) {
    throw new VisualError(`"${source}" must be a number, not an expression in x`)
  }
  const evaluate = parse(tokens, source)
  return (x) => {
    const value = evaluate(x)
    return Number.isFinite(value) ? value : null
  }
}

/** A constant such as "3", "-1/2", "2pi" or "sqrt(2)". */
export function constValue(source: string): number {
  const value = compileExpr(source, false)(0)
  if (value === null) throw new VisualError(`"${source}" is not a real number`)
  return value
}
