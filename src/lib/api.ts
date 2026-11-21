/**
 * Browser-side calls to the worker: server actions and the room routes.
 *
 * Signed-in callers send their JWT. Students have no token; their guest pass
 * rides along as an HttpOnly cookie on these same-origin requests.
 */

import { getAuthToken } from 'deepspace'

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number }

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAuthToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null
  return typeof body?.error === 'string' ? body.error : `Request failed (${res.status})`
}

/** Call a server action from src/actions/index.ts. Requires sign-in. */
export async function callAction<T>(
  name: string,
  params: Record<string, unknown>,
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`/api/actions/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(params),
    })
    if (!res.ok) return { ok: false, error: await readError(res), status: res.status }
    const body = (await res.json()) as { success?: boolean; data?: T; error?: string }
    if (!body.success) {
      return { ok: false, error: body.error ?? 'Something went wrong.', status: res.status }
    }
    return { ok: true, data: body.data as T }
  } catch {
    return { ok: false, error: 'Could not reach the server. Check your connection.', status: 0 }
  }
}

export async function roomRequest<T>(
  roomId: string,
  path: '' | '/join' | '/messages',
  body?: Record<string, unknown>,
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await authHeaders()) },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) return { ok: false, error: await readError(res), status: res.status }
    return { ok: true, data: (await res.json()) as T }
  } catch {
    return { ok: false, error: 'Could not reach the server. Check your connection.', status: 0 }
  }
}

export interface Me {
  userId: string
  name: string
  isGuest: boolean
}

export interface RoomInfo {
  roomId: string
  title: string
  ownerId: string
  isOwner: boolean
  me: Me | null
}
