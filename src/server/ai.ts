/**
 * Claude calls for Practice Room, all through DeepSpace's integration proxy
 * (`anthropic/chat-completion`) — no API key lives in this app.
 *
 * Three jobs: list question types for a topic, write a practice question with
 * its answer key, and grade a selected region of the whiteboard.
 */

import type { ActionTools } from 'deepspace/worker'
import type { TopicLocation } from '../catalog/index.js'

/** One place to change the model. The proxy's own default is the same id. */
export const CLAUDE_MODEL = 'claude-opus-5-5'

type TextBlock = { type: 'text'; text: string }
type ImageBlock = {
  type: 'image'
  source: { type: 'base64'; media_type: RegionImageType; data: string }
}

/** The region capture is a PNG, or a JPEG when it has a photograph in it. */
export type RegionImageType = 'image/png' | 'image/jpeg'
type ContentBlock = TextBlock | ImageBlock

interface ClaudeMessage {
  content?: Array<{ type: string; text?: string }>
  stop_reason?: string | null
}

export type ClaudeResult = { ok: true; text: string } | { ok: false; error: string }

export async function callClaude(
  tools: ActionTools,
  request: { system: string; content: string | ContentBlock[]; maxTokens?: number },
): Promise<ClaudeResult> {
  const result = await tools.integration<ClaudeMessage>('anthropic/chat-completion', {
    model: CLAUDE_MODEL,
    // Thinking is always on for this model and counts toward max_tokens, so
    // leave real room above the visible answer. Not more than that: credits
    // are reserved up front for the full max_tokens and refunded afterwards,
    // so an oversized limit can refuse a call the balance could easily pay for.
    max_tokens: request.maxTokens ?? 8000,
    system: request.system,
    messages: [{ role: 'user', content: request.content }],
  })
  if (!result.success) return { ok: false, error: result.error ?? 'The AI request failed.' }

  const message = result.data
  if (message.stop_reason === 'refusal') {
    return { ok: false, error: 'Claude declined this request.' }
  }
  const text = (message.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
  if (!text) return { ok: false, error: 'Claude returned an empty response.' }
  if (message.stop_reason === 'max_tokens') {
    return { ok: false, error: 'The response was cut off before it finished. Try a smaller request.' }
  }
  return { ok: true, text }
}

/**
 * Pull the JSON object out of a model reply. The proxy exposes no structured
 * output option, so the prompt asks for bare JSON and this tolerates a code
 * fence or a stray sentence around it.
 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Question types
// ---------------------------------------------------------------------------

export interface QuestionType {
  name: string
  description: string
  example: string
}

const MATH_FORMAT_RULES = [
  'Write all math in LaTeX: inline as $...$ and display as $$...$$ on its own line.',
  'Escape a literal dollar sign as \\$.',
  'Do not use LaTeX environments that need extra packages; plain KaTeX-compatible LaTeX only.',
].join(' ')

/**
 * How Claude writes a table, a graph or a geometry figure. The app draws these
 * blocks (`src/visuals/`), so this text has to match what the parser reads:
 * anything it promises here must be something `checkVisuals` accepts.
 */
export const VISUAL_FORMAT_RULES = [
  'VISUALS. Text can include tables, graphs and geometry figures, which the app draws. Use one when the problem is about it, or when a picture makes a step clearer. Do not decorate.',
  '',
  'TABLE: Markdown pipe rows, each starting and ending with |, with a row of dashes after the first row. Leave a cell empty for the student to fill in.',
  '| $x$ | $-1$ | $0$ | $1$ |',
  '|:---:|:---:|:---:|:---:|',
  '| $y$ |  |  |  |',
  '',
  'GRAPH (coordinate plane): a block that starts with a line [graph] and ends with a line [/graph], with one setting or item per line.',
  '[graph]',
  'x: -5 to 5',
  'y: -5 to 5',
  'y = 2x - 3 [label: $f$]',
  'y = x + 3 for -3 <= x < 0',
  'y >= -x + 2',
  'point A (1, -1)',
  '[/graph]',
  'Settings: "x: a to b" and "y: a to b" set the window (default -10 to 10; "-2pi to 2pi" works); "step: 1" (or xstep, ystep) sets the grid spacing; "xlabel: Hours", "ylabel: Cost"; "size: small" (or medium, large); "title: A)"; "grid: off".',
  'Items: "y = ..." or "f(x) = ..." plots a function of x. "y > ...", "y <= ..." shade an inequality (the boundary is dashed when strict). "x = 2" is a vertical line. Ending a function with "for -3 <= x < 1" restricts its domain and draws closed or open endpoint dots. Also: "point A (1, 3)", "open point (2, 1)", "points (0, 1) (1, 3) (2, 5)", "segment P(0, 0) to Q(3, 4)", "line (0, 1) (2, 5)", "vector (0, 0) to (3, 2)", "polygon A(1, 1) B(4, 1) C(4, 3)", "circle (0, 0) radius 3", "text (4, 5) Region $R$".',
  'Expressions use x only: 2x, x^2, (x+1)(x-2), 1/(x-1), |x - 2|, sqrt(x), cbrt(x), sin(x), cos(x), tan(x), ln(x), log(x), exp(x), pi, e. A block with only a window is a blank grid for the student to draw on.',
  '',
  'FIGURE (geometry, drawn to scale, no axes): a block that starts with a line [figure] and ends with a line [/figure]. Points are capital letters, and a point must be created before a later line uses it.',
  '[figure]',
  'triangle ABC AB=8 angle A=50 angle B=60',
  'side AB 8 cm',
  'side BC $x$',
  'angle A 50°',
  '[/figure]',
  'Shapes: "triangle ABC AB=5 BC=6 CA=7" (or two sides and the angle between them, or two angles and a side); "triangle A(0,0) B(6,0) C(2,4)"; "right triangle ABC legs 3 4" (right angle at B); "rectangle ABCD width 6 height 4"; "square ABCD side 4"; "parallelogram ABCD base 7 side 4 angle 65"; "rhombus ABCD side 5 angle 60"; "trapezoid ABCD bottom 10 top 6 height 4"; "regular ABCDEF side 3"; "polygon A(0,0) B(4,0) C(5,3) D(1,3)"; "circle O radius 3"; "sector O radius 4 from 30 to 100".',
  'Points and lines: "point P (2, 3)"; "point M midpoint A B"; "point D foot C A B" (foot of the perpendicular from C to line AB); "point P on A B 0.25"; "point P from O 3 at 40" (3 units from O in the 40 degree direction); "segment A B"; "line A B"; "ray A B".',
  'Marks: "side AB 8 cm" labels a side with any text or $math$; "side AB [ticks: 1]" adds congruence ticks; "side AB [parallel: 1]" adds parallel arrows; "angle A 50°" labels the angle at a corner of a shape; "angle ABC $x^\\circ$" names three points with the vertex in the middle; "right angle ABC" draws the square corner. "side AB measure" and "angle A measure" print the true value: use these only in a solution.',
  '',
  'Options go in one bracket at the end of a line: [red, dashed, label: $f$]. Colors: navy, blue, red, green, orange, purple, gold, gray, black. Also: dotted, thick, thin, fill, noshade.',
  'Rules for visuals: build each one from the real numbers of the problem, so it is true to scale. In a question, never let the picture give away the answer: label the unknown $x$ or leave it unlabeled. Use only the settings, items and options listed here, because anything else is not drawn. Put [graph], [/graph], [figure] and [/figure] on lines of their own.',
].join('\n')

/**
 * The same format in a quarter of the words, for calls where a visual is an
 * occasional extra (grading, the tutor's assistant). Every token of a system
 * prompt is paid for on every call, and those calls are frequent.
 */
export const VISUAL_FORMAT_BRIEF = [
  'VISUALS. The app draws tables, graphs and geometry figures written as below. Use only these kinds of lines, because anything else is not drawn.',
  'Table: pipe rows with a row of dashes after the first.',
  '| $x$ | $1$ | $2$ |',
  '|:---:|:---:|:---:|',
  '| $y$ |  |  |',
  'Graph: functions of x, inequalities, vertical lines, points and segments on a coordinate plane.',
  '[graph]',
  'x: -5 to 5',
  'y: -5 to 5',
  'y = 2x - 3 [red, dashed, label: $f$]',
  'y = x + 3 for -3 <= x < 0',
  'y >= -x + 2',
  'point A (1, -1)',
  'segment P(0, 0) to Q(3, 4)',
  '[/graph]',
  'Figure: geometry drawn to scale from its real measurements. Points are capital letters.',
  '[figure]',
  'triangle ABC AB=8 angle A=50 angle B=60',
  'point M midpoint A B',
  'segment C M [dashed]',
  'side AB 8 cm',
  'angle A 50°',
  '[/figure]',
  'Other shapes: "right triangle ABC legs 3 4", "rectangle ABCD width 6 height 4", "square ABCD side 4", "parallelogram ABCD base 7 side 4 angle 65", "trapezoid ABCD bottom 10 top 6 height 4", "circle O radius 3".',
  'Other marks: "side AB $x$", "angle ABC $x^\\circ$", "right angle ABC".',
  'The tags [graph], [/graph], [figure] and [/figure] go on lines of their own.',
].join('\n')

export function questionTypesPrompt(location: TopicLocation): { system: string; content: string } {
  return {
    system: [
      'You help a tutor pick practice problems for a live one-on-one session.',
      'Given one curriculum topic, list the distinct question types a tutor would actually assign for it.',
      'Return ONLY a JSON object, no prose and no code fence, shaped as:',
      '{"types":[{"name":"...","description":"...","example":"..."}]}',
      'Give 4 to 6 types. Each differs in the skill or format it exercises, not just in the numbers.',
      '"name" is at most 5 words. "description" is one sentence saying what the student has to do.',
      '"example" is one complete, representative problem of that type, free response, with clean numbers and no answer or hint.',
      'When a type is about reading or completing a graph, a geometric figure or a table, its example includes that visual in the format below.',
      MATH_FORMAT_RULES,
      '',
      VISUAL_FORMAT_RULES,
    ].join('\n'),
    content: [
      `Course: ${location.subject.name}`,
      `Unit: ${location.unit.title}`,
      `Topic: ${location.topic.title}`,
      `Scope: ${location.topic.summary}`,
      'Stay inside this scope. Pitch the difficulty to this course.',
    ].join('\n'),
  }
}

export function readQuestionTypes(text: string): QuestionType[] | null {
  const parsed = parseJsonObject(text)
  const raw = parsed?.types
  if (!Array.isArray(raw)) return null
  const types: QuestionType[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { name, description, example } = item as Record<string, unknown>
    if (typeof name !== 'string' || typeof example !== 'string') continue
    types.push({
      name: name.trim().slice(0, 60),
      description: typeof description === 'string' ? description.trim().slice(0, 300) : '',
      example: example.trim().slice(0, 1500),
    })
  }
  return types.length ? types.slice(0, 8) : null
}

// ---------------------------------------------------------------------------
// Question generation
// ---------------------------------------------------------------------------

export interface GeneratedQuestion {
  title: string
  question: string
  answer: string
  solution: string
}

export const DIFFICULTIES = ['easier', 'standard', 'harder'] as const
export type Difficulty = (typeof DIFFICULTIES)[number]

const QUESTION_SYSTEM = [
  'You write one practice problem for a live tutoring session, plus its private answer key.',
  'Return ONLY a JSON object, no prose and no code fence, shaped as:',
  '{"title":"...","question":"...","answer":"...","solution":"..."}',
  '"title": at most 6 words naming the skill.',
  '"question": the problem exactly as the student will see it on a whiteboard. Self-contained, free response unless told otherwise, no answer, no hint, no worked steps. Keep it short enough to read at a glance. If the problem is about a graph, a geometric figure or a table of data, show it as a visual (format below) instead of describing it in words.',
  '"answer": only the final answer, in simplest form.',
  '"solution": a numbered step-by-step worked solution a tutor could read aloud, ending with the final answer. Where a picture makes a step clearer (the finished graph, the figure with the values found), include one visual.',
  MATH_FORMAT_RULES,
  'Quality rules, in order:',
  '1. Decide the answer first and pick clean numbers so it comes out as an integer, a simple fraction, or a short exact form.',
  '2. Solve the finished problem from scratch, then check the result by a different method (substitute it back, or solve another way). If the two disagree, fix the problem before you answer.',
  '3. The answer and the last line of the solution must match exactly.',
  '4. If you draw a visual, check it against the problem: the same numbers, the same labels, and nothing that reveals the answer in the question.',
  '',
  VISUAL_FORMAT_RULES,
].join('\n')

/**
 * A second attempt at a reply whose visuals could not all be drawn. The
 * parser's own messages go back to Claude, which usually fixes the line.
 */
export function visualRepairRequest(
  request: { system: string; content: string },
  previousReply: string,
  problems: string[],
): { system: string; content: string } {
  return {
    system: request.system,
    content: [
      request.content,
      '',
      'Your previous reply was:',
      previousReply,
      '',
      'These lines of its visuals could not be drawn:',
      ...problems.slice(0, 12).map((problem) => `- ${problem}`),
      '',
      'Return the whole JSON object again with the visuals corrected. Keep the problem and its answer the same. Use only lines from the visual format; if a picture cannot be made that way, leave it out and describe it in words.',
    ].join('\n'),
  }
}

export function questionFromPromptRequest(
  prompt: string,
  difficulty: Difficulty,
): { system: string; content: string } {
  return {
    system: QUESTION_SYSTEM,
    content: [
      'The tutor described the problem they want:',
      prompt,
      `Difficulty relative to what they described: ${difficulty}.`,
    ].join('\n\n'),
  }
}

export function questionFromTypeRequest(
  location: TopicLocation,
  type: QuestionType,
  difficulty: Difficulty,
): { system: string; content: string } {
  return {
    system: QUESTION_SYSTEM,
    content: [
      `Course: ${location.subject.name}`,
      `Unit: ${location.unit.title}`,
      `Topic: ${location.topic.title}`,
      `Scope: ${location.topic.summary}`,
      '',
      `Question type: ${type.name}`,
      type.description ? `What it asks: ${type.description}` : '',
      'Model problem for this type:',
      type.example,
      '',
      'Write a new problem of exactly this type and format. Keep the structure and the skill; change the numbers (and the names or setting, if it is a word problem) so it is a fresh problem, then work out the new answer.',
      `Difficulty relative to the model problem: ${difficulty}.`,
    ]
      .filter((line) => line !== '')
      .join('\n'),
  }
}

export function readGeneratedQuestion(text: string): GeneratedQuestion | null {
  const parsed = parseJsonObject(text)
  if (!parsed) return null
  const { title, question, answer, solution } = parsed
  if (typeof question !== 'string' || typeof answer !== 'string') return null
  if (!question.trim() || !answer.trim()) return null
  return {
    title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : 'Practice problem',
    question: question.trim(),
    answer: answer.trim(),
    solution: typeof solution === 'string' ? solution.trim() : '',
  }
}

// ---------------------------------------------------------------------------
// Grading a region of the whiteboard
// ---------------------------------------------------------------------------

/** A question card inside the selected region, with its key when one exists. */
export interface RegionQuestion {
  tag: string
  text: string
  answer?: string
  solution?: string
  x: number
  y: number
}

/** A typed (math-field) entry inside the selected region. */
export interface RegionTyped {
  tag: string
  latex: string
  x: number
  y: number
}

const GRADING_SYSTEM = [
  "You are grading a student's work on a shared tutoring whiteboard. The tutor selected one rectangular region and asked you to check it. Grade only what is inside that region.",
  '',
  'You receive:',
  '- An image of the region. Pen and highlighter strokes appear as drawn: this is handwriting, usually the student working a problem or writing an answer.',
  '- Typed math entries do not appear as rendered math in the image. Each shows as a small box labelled [T1], [T2], ... where it sits on the board, and its LaTeX is listed in the text below.',
  '- Question cards show as boxes labelled [Q1], [Q2], ... and their full text is listed below, with the tutor\'s private answer key when one exists.',
  '- Pictures the tutor placed on the board (a photo or screenshot of a problem, often from homework) appear in the image exactly as they are, with any writing over them. A problem shown in a picture is a question to grade like any other: read it from the picture. It has no answer key.',
  '- Positions (x, y in image pixels, origin top-left) for every labelled item, so you can tell which answer belongs to which question: an answer normally sits beside or below its question.',
  '',
  'For each question in the region:',
  "1. Find the student's final answer, typed or handwritten. If they wrote working, read it too.",
  '2. Solve the problem yourself. Use the answer key as a cross-check; if the key and your own solution disagree, re-derive carefully, trust the mathematics, and say that the key should be reviewed.',
  '3. Decide: correct, incorrect, or no answer found. Equivalent forms count as correct (1/2 and 0.5, unsimplified but equal expressions unless the question asks for simplest form, a different variable order). If handwriting is ambiguous, say what you read and how sure you are instead of guessing silently.',
  '4. Explain the full solution step by step. If the student was wrong and their working shows where, name the step where it went off.',
  '',
  'If the region contains a handwritten or typed problem that has no question card, treat it as a question too and grade it the same way. If the region has no question and no answer at all, say so in one sentence.',
  '',
  'Write the reply in Markdown for a chat sidebar that the student and tutor both read. Use this shape for every question:',
  '### Question N: Correct | Incorrect | No answer found',
  "**Student's answer:** what you read (or \"none found\")",
  '**Correct answer:** the final answer',
  '**Solution**',
  'A numbered list of steps.',
  '',
  'Number the questions in reading order and refer to them by their card title or first few words, never by the [Q1]/[T1] labels, which the readers cannot see.',
  MATH_FORMAT_RULES,
  'Be warm and direct, speak to the student, and do not add a preamble or a closing summary.',
  '',
  'A question\'s text may contain a table, a [graph] block or a [figure] block. The student sees those as drawings on the card; read them as written (the format is below). In a Solution you may add one visual in the same format when it makes the explanation clearer, for example the graph with the answer marked or the figure with the missing length filled in.',
  '',
  VISUAL_FORMAT_BRIEF,
].join('\n')

export function gradingRequest(input: {
  imageBase64: string
  imageType: RegionImageType
  imageCount: number
  width: number
  height: number
  questions: RegionQuestion[]
  typed: RegionTyped[]
  strokeCount: number
}): { system: string; content: ContentBlock[] } {
  const lines: string[] = [
    `Region image size: ${input.width} x ${input.height} px.`,
    `Handwritten strokes in the region: ${input.strokeCount}.`,
    `Pictures in the region: ${input.imageCount}.`,
    '',
  ]

  if (input.questions.length) {
    lines.push('Question cards:')
    for (const q of input.questions) {
      lines.push(`${q.tag} at (x=${q.x}, y=${q.y})`)
      lines.push(`Text: ${q.text}`)
      if (q.answer) lines.push(`Answer key: ${q.answer}`)
      if (q.solution) lines.push(`Key solution: ${q.solution}`)
      lines.push('')
    }
  } else {
    lines.push('Question cards: none in this region.', '')
  }

  if (input.typed.length) {
    lines.push('Typed entries (LaTeX):')
    for (const t of input.typed) {
      lines.push(`${t.tag} at (x=${t.x}, y=${t.y}): ${t.latex}`)
    }
  } else {
    lines.push('Typed entries: none in this region.')
  }

  return {
    system: GRADING_SYSTEM,
    content: [
      {
        type: 'image',
        source: { type: 'base64', media_type: input.imageType, data: input.imageBase64 },
      },
      { type: 'text', text: lines.join('\n') },
    ],
  }
}
