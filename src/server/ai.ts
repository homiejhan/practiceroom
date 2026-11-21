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
  source: { type: 'base64'; media_type: 'image/png'; data: string }
}
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
      MATH_FORMAT_RULES,
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
  '"question": the problem exactly as the student will see it on a whiteboard. Self-contained, free response unless told otherwise, no answer, no hint, no worked steps. Keep it short enough to read at a glance.',
  '"answer": only the final answer, in simplest form.',
  '"solution": a numbered step-by-step worked solution a tutor could read aloud, ending with the final answer.',
  MATH_FORMAT_RULES,
  'Quality rules, in order:',
  '1. Decide the answer first and pick clean numbers so it comes out as an integer, a simple fraction, or a short exact form.',
  '2. Solve the finished problem from scratch, then check the result by a different method (substitute it back, or solve another way). If the two disagree, fix the problem before you answer.',
  '3. The answer and the last line of the solution must match exactly.',
].join('\n')

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
].join('\n')

export function gradingRequest(input: {
  imageBase64: string
  width: number
  height: number
  questions: RegionQuestion[]
  typed: RegionTyped[]
  strokeCount: number
}): { system: string; content: ContentBlock[] } {
  const lines: string[] = [
    `Region image size: ${input.width} x ${input.height} px.`,
    `Handwritten strokes in the region: ${input.strokeCount}.`,
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
        source: { type: 'base64', media_type: 'image/png', data: input.imageBase64 },
      },
      { type: 'text', text: lines.join('\n') },
    ],
  }
}
