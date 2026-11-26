/**
 * Spend control for owner-billed calls.
 *
 * Question generation, grading, the tutor's assistant chat, worksheet PDFs
 * and recap emails are all billed to the app owner, so a tutor needs no
 * credits of their own. Sign-in alone is not a limit — a signed-in account
 * could loop a paid call — so every such call is counted here against a
 * per-user daily allowance.
 *
 * Recap emails have their own, much smaller allowance: they go to an address
 * the tutor types, so the cap is also what keeps the app from being useful as
 * a way to send mail to strangers.
 */

import { appScopeId, recordTools } from './record-tools.js'
import type { Env } from '../../worker.js'

/** Owner-billed AI and PDF calls each signed-in user may make per UTC day. */
export const DAILY_AI_LIMIT = 80

/** Recap emails each signed-in user may send per UTC day. */
export const DAILY_EMAIL_LIMIT = 10

/** Pictures each tutor may put on their boards per UTC day. They are stored in the owner's files. */
export const DAILY_IMAGE_LIMIT = 60

async function spend(
  env: Env,
  userId: string,
  bucket: '' | '_email' | '_image',
  limit: number,
  refusal: string,
): Promise<string | null> {
  const day = new Date().toISOString().slice(0, 10)
  const recordId = `${day}_${userId}${bucket}`
  const tools = recordTools(env, appScopeId(env), userId)
  const existing = await tools.get<{ count?: number }>('ai_usage', recordId)
  const used = existing?.data.count ?? 0
  if (used >= limit) return refusal
  if (existing) await tools.update('ai_usage', recordId, { count: used + 1 })
  else await tools.create('ai_usage', { userId, day, count: 1 }, recordId)
  return null
}

/**
 * Count one paid call for `userId`. Returns an error message when today's
 * allowance is already used, and null when the call may go ahead.
 */
export function spendAiCall(env: Env, userId: string): Promise<string | null> {
  return spend(
    env,
    userId,
    '',
    DAILY_AI_LIMIT,
    `You have used today's ${DAILY_AI_LIMIT} AI requests. The limit resets at midnight UTC.`,
  )
}

/** Count one recap email for `userId`; same contract as {@link spendAiCall}. */
export function spendRecapEmail(env: Env, userId: string): Promise<string | null> {
  return spend(
    env,
    userId,
    '_email',
    DAILY_EMAIL_LIMIT,
    `You have sent today's ${DAILY_EMAIL_LIMIT} recap emails. The limit resets at midnight UTC.`,
  )
}

/** Count one board picture for `userId`; same contract as {@link spendAiCall}. */
export function spendBoardImage(env: Env, userId: string): Promise<string | null> {
  return spend(
    env,
    userId,
    '_image',
    DAILY_IMAGE_LIMIT,
    `You have added today's ${DAILY_IMAGE_LIMIT} pictures. The limit resets at midnight UTC.`,
  )
}
