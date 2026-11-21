/**
 * Server actions — the tutor-side operations that need more than the caller's
 * own record permissions: creating a room, asking Claude for question types
 * or a new question, and grading a region of the whiteboard.
 *
 * Action tools run with RBAC off (see src/server/action-routes.ts), so every
 * action that takes a room id checks that the caller owns that room before it
 * reads a key, spends a paid call, or posts to the room.
 */

import type { ActionHandler, ActionResult, ActionTools } from 'deepspace/worker'
import { findTopic } from '../catalog/index.js'
import { roomScopeId } from '../schemas/practice-schemas.js'
import {
  callClaude,
  DIFFICULTIES,
  gradingRequest,
  questionFromPromptRequest,
  questionFromTypeRequest,
  questionTypesPrompt,
  readGeneratedQuestion,
  readQuestionTypes,
  type Difficulty,
  type QuestionType,
  type RegionQuestion,
  type RegionTyped,
} from '../server/ai.js'
import { appFiles } from 'deepspace/worker'
import { spendAiCall, spendRecapEmail } from '../server/ai-usage.js'
import { ROOM_ID_RE } from '../server/guest.js'
import { recordTools } from '../server/record-tools.js'
import { buildRecapEmail, buildWorksheetLatex } from '../server/worksheet.js'
import type { Env } from '../../worker.js'

const fail = (error: string): ActionResult<never> => ({ success: false, error })

interface Stored<T> {
  recordId: string
  data: T
}

async function getRecord<T>(
  tools: ActionTools,
  collection: string,
  recordId: string,
): Promise<Stored<T> | null> {
  const result = await tools.get(collection, recordId)
  if (!result.success) return null
  return (result.data as { record?: Stored<T> }).record ?? null
}

/** The room, only if `userId` is its tutor. */
async function ownedRoom(
  tools: ActionTools,
  roomId: unknown,
  userId: string,
): Promise<{ roomId: string; title: string } | null> {
  if (typeof roomId !== 'string' || !ROOM_ID_RE.test(roomId)) return null
  const room = await getRecord<{ title: string; ownerId: string }>(tools, 'rooms', roomId)
  if (!room || room.data.ownerId !== userId) return null
  return { roomId, title: room.data.title }
}

const ROOM_ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

function newRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  let id = ''
  for (const byte of bytes) id += ROOM_ID_ALPHABET[byte % ROOM_ID_ALPHABET.length]
  return id
}

const typesRecordId = (subjectId: string, topicId: string): string =>
  `${subjectId}_${topicId}`.replace(/[^A-Za-z0-9_-]/g, '_')

async function cachedQuestionTypes(
  tools: ActionTools,
  subjectId: string,
  topicId: string,
): Promise<QuestionType[] | null> {
  const record = await getRecord<{ types?: QuestionType[] }>(
    tools,
    'question_types',
    typesRecordId(subjectId, topicId),
  )
  return Array.isArray(record?.data.types) && record.data.types.length ? record.data.types : null
}

const asDifficulty = (value: unknown): Difficulty =>
  DIFFICULTIES.includes(value as Difficulty) ? (value as Difficulty) : 'standard'

const asCoordinate = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0

const MAX_IMAGE_CHARS = 4_000_000
const PNG_PREFIX = 'data:image/png;base64,'

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/

// A type alias, not an interface: the tools API wants an index-signature-compatible shape.
type QuestionKeyData = {
  roomId: string
  title: string
  question: string
  answer: string
  solution?: string
}

interface Worksheet {
  /** Path the app serves the PDF at, relative to its origin. */
  path: string
  questionTitles: string[]
  tutorName: string
  tutorEmail: string
}

/**
 * Typeset a room's questions as a PDF and store it in the app's files.
 *
 * App-scope files are readable by anyone who has the URL, which is what lets
 * a student open the link from an email without an account. The key carries a
 * random id, so the URL is not guessable from the room id.
 */
async function makeWorksheet(
  context: { userId: string; tools: ActionTools; env: Env },
  room: { roomId: string; title: string },
  options: { includeAnswers: boolean; date: string },
): Promise<{ ok: true; worksheet: Worksheet } | { ok: false; error: string }> {
  const { userId, tools, env } = context
  const found = await tools.query<QuestionKeyData>('question_keys', {
    where: { roomId: room.roomId },
    orderBy: 'createdAt',
    orderDir: 'asc',
    limit: 40,
  })
  const keys = found.success ? found.data.records : []
  if (!keys.length) return { ok: false, error: 'Create at least one question first.' }

  const profile = await getRecord<{ name?: string; email?: string }>(tools, 'users', userId)
  const tutorName = profile?.data.name?.trim() || 'Your tutor'

  const document = buildWorksheetLatex({
    roomTitle: room.title,
    tutorName,
    date: options.date,
    includeAnswers: options.includeAnswers,
    questions: keys.map((key) => ({
      title: key.data.title,
      question: key.data.question,
      answer: key.data.answer,
      solution: key.data.solution ?? '',
    })),
  })

  const compiled = await tools.integration<{ compiled?: boolean; pdfBase64?: string | null; error?: string }>(
    'latex-compiler/compile',
    { compiler: 'pdflatex', document },
  )
  if (!compiled.success) return { ok: false, error: compiled.error ?? 'The PDF service did not respond.' }
  if (!compiled.data.compiled || !compiled.data.pdfBase64) {
    // A failed compile is a normal response, not a transport error; keep the
    // reason in the logs and give the tutor something they can act on.
    console.error(`[worksheet] compile failed room=${room.roomId}: ${compiled.data.error ?? 'no reason given'}`)
    return {
      ok: false,
      error: 'The worksheet could not be typeset. One of the questions may contain notation LaTeX cannot print.',
    }
  }

  const bytes = Uint8Array.from(atob(compiled.data.pdfBase64), (ch) => ch.charCodeAt(0))
  try {
    const file = await appFiles(env, { scope: 'app', userId }).upload(
      new Blob([bytes], { type: 'application/pdf' }),
      { key: `worksheets/${room.roomId}/${crypto.randomUUID()}.pdf`, name: 'worksheet.pdf' },
    )
    return {
      ok: true,
      worksheet: {
        path: file.path,
        questionTitles: keys.map((key) => key.data.title),
        tutorName,
        tutorEmail: profile?.data.email?.trim() ?? '',
      },
    }
  } catch (error) {
    console.error(`[worksheet] upload failed room=${room.roomId}: ${String(error)}`)
    return { ok: false, error: 'The worksheet was created but could not be saved.' }
  }
}

/** A short display date from the tutor's browser, or today's UTC date. */
function worksheetDate(raw: unknown): string {
  if (typeof raw === 'string' && /^[\w ,./-]{4,40}$/.test(raw)) return raw
  return new Date().toISOString().slice(0, 10)
}

export const actions: Record<string, ActionHandler<Env>> = {
  /** Create a room owned by the caller. The id is the secret part of the join link. */
  createRoom: async ({ userId, params, tools }) => {
    const title = typeof params.title === 'string' ? params.title.trim().slice(0, 80) : ''
    if (!title) return fail('Give the room a name.')
    const roomId = newRoomId()
    const created = await tools.create('rooms', { title, ownerId: userId }, roomId)
    if (!created.success) return fail('Could not create the room.')
    return { success: true, data: { roomId } }
  },

  /**
   * Question types for one catalog topic. Generated by Claude the first time
   * any tutor opens the topic, then served from the shared cache.
   */
  listQuestionTypes: async ({ userId, params, tools, env }) => {
    const subjectId = typeof params.subjectId === 'string' ? params.subjectId : ''
    const topicId = typeof params.topicId === 'string' ? params.topicId : ''
    const location = findTopic(topicId, subjectId)
    if (!location) return fail('Unknown topic.')

    const cached = await cachedQuestionTypes(tools, subjectId, topicId)
    if (cached) return { success: true, data: { types: cached, cached: true } }

    const overLimit = await spendAiCall(env, userId)
    if (overLimit) return fail(overLimit)

    const reply = await callClaude(tools, { ...questionTypesPrompt(location), maxTokens: 6000 })
    if (!reply.ok) return fail(reply.error)
    const types = readQuestionTypes(reply.text)
    if (!types) return fail('Claude did not return usable question types. Try again.')

    await tools.create('question_types', { topicId, types }, typesRecordId(subjectId, topicId))
    return { success: true, data: { types, cached: false } }
  },

  /**
   * Write one practice question for a room the caller tutors. The question
   * text goes back to the tutor's browser to place on the board; the answer
   * and solution are stored in `question_keys`, which only the tutor can read.
   */
  generateQuestion: async ({ userId, params, tools, env }) => {
    const room = await ownedRoom(tools, params.roomId, userId)
    if (!room) return fail('Only the tutor of this room can create questions.')

    const difficulty = asDifficulty(params.difficulty)
    let request: { system: string; content: string }
    let source: string

    if (params.mode === 'type') {
      const subjectId = typeof params.subjectId === 'string' ? params.subjectId : ''
      const topicId = typeof params.topicId === 'string' ? params.topicId : ''
      const location = findTopic(topicId, subjectId)
      if (!location) return fail('Unknown topic.')
      const types = await cachedQuestionTypes(tools, subjectId, topicId)
      const type = types?.[typeof params.typeIndex === 'number' ? params.typeIndex : -1]
      if (!type) return fail('Pick a question type first.')
      request = questionFromTypeRequest(location, type, difficulty)
      source = `${location.subject.name} · ${location.topic.title} · ${type.name}`.slice(0, 200)
    } else {
      const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : ''
      if (prompt.length < 3) return fail('Describe the problem you want.')
      if (prompt.length > 1500) return fail('Keep the description under 1,500 characters.')
      request = questionFromPromptRequest(prompt, difficulty)
      source = 'Described by tutor'
    }

    const overLimit = await spendAiCall(env, userId)
    if (overLimit) return fail(overLimit)

    const reply = await callClaude(tools, request)
    if (!reply.ok) return fail(reply.error)
    const question = readGeneratedQuestion(reply.text)
    if (!question) return fail('Claude did not return a usable question. Try again.')

    const stored = await tools.create('question_keys', {
      roomId: room.roomId,
      title: question.title,
      question: question.question,
      answer: question.answer,
      solution: question.solution,
      source,
    })
    if (!stored.success) return fail('Could not save the answer key.')

    return {
      success: true,
      data: { questionId: stored.data.recordId, title: question.title, question: question.question },
    }
  },

  /**
   * Grade one region of the whiteboard. The tutor's browser sends an image of
   * the selected rectangle plus the typed entries and question cards inside
   * it; the worker adds the private answer keys, asks Claude, and posts the
   * result to the room chat where everyone can read it.
   */
  checkRegion: async ({ userId, params, tools, env }) => {
    const room = await ownedRoom(tools, params.roomId, userId)
    if (!room) return fail('Only the tutor of this room can check work.')

    const image = typeof params.image === 'string' ? params.image : ''
    if (!image.startsWith(PNG_PREFIX)) return fail('The region image is missing.')
    if (image.length > MAX_IMAGE_CHARS) return fail('That region is too large to check. Select a smaller area.')

    const rawQuestions = Array.isArray(params.questions) ? params.questions.slice(0, 12) : []
    const rawTyped = Array.isArray(params.typed) ? params.typed.slice(0, 60) : []
    const strokeCount = asCoordinate(params.strokeCount)
    if (!rawQuestions.length && !rawTyped.length && strokeCount <= 0) {
      return fail('There is nothing inside that box to check.')
    }

    const questions: RegionQuestion[] = []
    for (const [index, item] of rawQuestions.entries()) {
      if (!item || typeof item !== 'object') continue
      const raw = item as Record<string, unknown>
      const question: RegionQuestion = {
        tag: `[Q${index + 1}]`,
        text: typeof raw.text === 'string' ? raw.text.slice(0, 4000) : '',
        x: asCoordinate(raw.x),
        y: asCoordinate(raw.y),
      }
      // Attach the private key only when it belongs to this room.
      if (typeof raw.questionId === 'string' && raw.questionId) {
        const key = await getRecord<{ roomId: string; question: string; answer: string; solution?: string }>(
          tools,
          'question_keys',
          raw.questionId,
        )
        if (key && key.data.roomId === room.roomId) {
          question.text = key.data.question
          question.answer = key.data.answer
          question.solution = key.data.solution
        }
      }
      if (question.text) questions.push(question)
    }

    const typed: RegionTyped[] = []
    for (const [index, item] of rawTyped.entries()) {
      if (!item || typeof item !== 'object') continue
      const raw = item as Record<string, unknown>
      if (typeof raw.latex !== 'string' || !raw.latex.trim()) continue
      typed.push({
        tag: `[T${index + 1}]`,
        latex: raw.latex.slice(0, 600),
        x: asCoordinate(raw.x),
        y: asCoordinate(raw.y),
      })
    }

    const overLimit = await spendAiCall(env, userId)
    if (overLimit) return fail(overLimit)

    const reply = await callClaude(tools, {
      ...gradingRequest({
        imageBase64: image.slice(PNG_PREFIX.length),
        width: asCoordinate(params.width),
        height: asCoordinate(params.height),
        questions,
        typed,
        strokeCount,
      }),
      maxTokens: 10000,
    })
    if (!reply.ok) return fail(reply.error)

    const posted = await recordTools(env, roomScopeId(room.roomId), 'claude').create(
      'room_messages',
      { authorId: 'claude', authorName: 'Claude', kind: 'grade', body: reply.text },
    )
    if (!posted.success) return fail('Claude finished, but the result could not be posted to the chat.')
    return { success: true, data: { messageId: posted.data.recordId } }
  },

  /** Typeset the room's questions as a printable PDF and return its link. */
  createWorksheet: async ({ userId, params, tools, env }) => {
    const room = await ownedRoom(tools, params.roomId, userId)
    if (!room) return fail('Only the tutor of this room can make a worksheet.')
    const overLimit = await spendAiCall(env, userId)
    if (overLimit) return fail(overLimit)

    const made = await makeWorksheet(
      { userId, tools, env },
      room,
      { includeAnswers: params.includeAnswers === true, date: worksheetDate(params.date) },
    )
    if (!made.ok) return fail(made.error)
    return { success: true, data: { path: made.worksheet.path } }
  },

  /**
   * Email a session recap with a link to the worksheet PDF. The recipient is
   * whatever address the tutor types, so the message is a fixed template and
   * sends are capped per tutor per day.
   */
  sendRecap: async ({ userId, params, tools, env }) => {
    const room = await ownedRoom(tools, params.roomId, userId)
    if (!room) return fail('Only the tutor of this room can send a recap.')

    const to = typeof params.to === 'string' ? params.to.trim() : ''
    if (to.length > 254 || !EMAIL_RE.test(to)) return fail('Enter one valid email address.')
    const includeAnswers = params.includeAnswers === true

    const overLimit = await spendRecapEmail(env, userId)
    if (overLimit) return fail(overLimit)

    const made = await makeWorksheet(
      { userId, tools, env },
      room,
      { includeAnswers, date: worksheetDate(params.date) },
    )
    if (!made.ok) return fail(made.error)

    const { worksheet } = made
    const email = buildRecapEmail({
      roomTitle: room.title,
      tutorName: worksheet.tutorName,
      questionTitles: worksheet.questionTitles,
      // The link has to work from an inbox, so it uses the app's public origin.
      worksheetUrl: `https://${env.APP_NAME}.app.space${worksheet.path}`,
      includeAnswers,
    })
    const sent = await tools.integration('email/send', {
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
      // The platform sends from its own address; replies should reach the tutor.
      ...(worksheet.tutorEmail ? { reply_to: worksheet.tutorEmail } : {}),
    })
    if (!sent.success) return fail(sent.error ?? 'The email could not be sent.')
    return { success: true, data: { to, path: worksheet.path } }
  },
}
