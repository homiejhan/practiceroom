/**
 * Privileged record access for worker code, addressed at any record scope.
 *
 * The scaffold's action tools (src/server/action-routes.ts) always talk to the
 * app scope. Practice Room also keeps one scope per room (`room:<id>`), so
 * room routes and actions use this helper to reach it.
 *
 * Same trust model as action tools: `X-App-Action` turns per-record RBAC off,
 * and `userId` is only the identity the write is attributed to. Callers must
 * have authorized the request before they get here.
 */

import type { ActionResult } from 'deepspace/worker'
import type { Env } from '../../worker.js'

export interface StoredRecord<T> {
  recordId: string
  data: T
  createdBy?: string
  createdAt?: string
  updatedAt?: string
}

export const appScopeId = (env: Env): string => `app:${env.DEEPSPACE_APP_ID}`

async function exec<TData>(
  env: Env,
  scopeId: string,
  userId: string,
  tool: string,
  params: Record<string, unknown>,
): Promise<ActionResult<TData>> {
  const stub = env.RECORD_ROOMS.get(env.RECORD_ROOMS.idFromName(scopeId))
  const res = await stub.fetch(
    new Request('https://internal/api/tools/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': userId,
        'X-App-Action': 'true',
      },
      body: JSON.stringify({ tool, params }),
    }),
  )
  return res.json() as Promise<ActionResult<TData>>
}

export function recordTools(env: Env, scopeId: string, userId: string) {
  return {
    async get<T>(collection: string, recordId: string): Promise<StoredRecord<T> | null> {
      const r = await exec<{ record?: StoredRecord<T> }>(env, scopeId, userId, 'records.get', {
        collection,
        recordId,
      })
      return r.success && r.data.record ? r.data.record : null
    },
    async query<T>(
      collection: string,
      options: { where?: Record<string, unknown>; orderBy?: string; orderDir?: 'asc' | 'desc'; limit?: number } = {},
    ): Promise<StoredRecord<T>[]> {
      const r = await exec<{ records?: StoredRecord<T>[] }>(env, scopeId, userId, 'records.query', {
        collection,
        ...options,
      })
      return r.success ? (r.data.records ?? []) : []
    },
    create(collection: string, data: Record<string, unknown>, recordId?: string) {
      return exec<{ recordId: string }>(env, scopeId, userId, 'records.create', {
        collection,
        data,
        recordId,
      })
    },
    update(collection: string, recordId: string, data: Record<string, unknown>) {
      return exec<{ recordId: string }>(env, scopeId, userId, 'records.update', {
        collection,
        recordId,
        data,
      })
    },
  }
}
