/**
 * Spend control for owner-billed AI calls.
 *
 * Question generation, grading and the tutor's assistant chat are all billed
 * to the app owner so a tutor needs no credits of their own. Sign-in alone is
 * not a limit — a signed-in account could loop a paid call — so every such
 * call is counted here against a per-user daily allowance.
 */

import { appScopeId, recordTools } from './record-tools.js'
import type { Env } from '../../worker.js'

/** Owner-billed AI calls each signed-in user may make per UTC day. */
export const DAILY_AI_LIMIT = 80

/**
 * Count one call for `userId`. Returns an error message when today's
 * allowance is already used, and null when the call may go ahead.
 */
export async function spendAiCall(env: Env, userId: string): Promise<string | null> {
  const day = new Date().toISOString().slice(0, 10)
  const recordId = `${day}_${userId}`
  const tools = recordTools(env, appScopeId(env), userId)
  const existing = await tools.get<{ count?: number }>('ai_usage', recordId)
  const used = existing?.data.count ?? 0
  if (used >= DAILY_AI_LIMIT) {
    return `You have used today's ${DAILY_AI_LIMIT} AI requests. The limit resets at midnight UTC.`
  }
  if (existing) await tools.update('ai_usage', recordId, { count: used + 1 })
  else await tools.create('ai_usage', { userId, day, count: 1 }, recordId)
  return null
}
