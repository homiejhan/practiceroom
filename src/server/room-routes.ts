/**
 * Room HTTP routes: look a room up, join it with a name, post to its chat.
 *
 * These are the only routes a student (no account) can write through, so each
 * one resolves a verified participant first: a signed-in user from their JWT,
 * or a guest from the signed pass in their cookie (src/server/guest.ts).
 */

import type { Context, Hono } from 'hono'
import type { VerifyResult } from 'deepspace/worker'
import { roomScopeId } from '../schemas/practice-schemas.js'
import {
  cleanDisplayName,
  guestCookie,
  issueGuestPass,
  readGuestPass,
  ROOM_ID_RE,
} from './guest.js'
import { appScopeId, recordTools } from './record-tools.js'
import type { AppContext, Env } from '../../worker.js'

type ResolveAuth = (req: Request, env: Env) => Promise<VerifyResult | null>

export interface RoomRecord {
  title: string
  ownerId: string
}

export interface Participant {
  userId: string
  name: string
  isGuest: boolean
}

const MAX_MESSAGE_LENGTH = 2000

export async function getRoom(env: Env, roomId: string): Promise<RoomRecord | null> {
  if (!ROOM_ID_RE.test(roomId)) return null
  const record = await recordTools(env, appScopeId(env), env.OWNER_USER_ID).get<RoomRecord>(
    'rooms',
    roomId,
  )
  return record?.data ?? null
}

/** Who is calling, for this room: a signed-in user, a guest with a valid pass, or nobody. */
async function resolveParticipant(
  c: Context<AppContext>,
  resolveAuth: ResolveAuth,
  roomId: string,
): Promise<Participant | null> {
  const auth = await resolveAuth(c.req.raw, c.env)
  if (auth) {
    return {
      userId: auth.userId,
      name: cleanDisplayName(auth.claims.name) || 'Tutor',
      isGuest: false,
    }
  }
  const pass = await readGuestPass(c.req.raw, c.env, roomId)
  return pass ? { userId: pass.guestId, name: pass.name, isGuest: true } : null
}

export function registerRoomRoutes(app: Hono<AppContext>, resolveAuth: ResolveAuth): void {
  // Public: the join screen needs the title before the visitor has an identity.
  app.get('/api/rooms/:roomId', async (c) => {
    const roomId = c.req.param('roomId')
    const room = await getRoom(c.env, roomId)
    if (!room) return c.json({ error: 'Room not found' }, 404)
    const me = await resolveParticipant(c, resolveAuth, roomId)
    return c.json({
      roomId,
      title: room.title,
      ownerId: room.ownerId,
      isOwner: !!me && !me.isGuest && me.userId === room.ownerId,
      me,
    })
  })

  // A student joins with just a name and gets a signed guest pass for this room.
  app.post('/api/rooms/:roomId/join', async (c) => {
    const roomId = c.req.param('roomId')
    const room = await getRoom(c.env, roomId)
    if (!room) return c.json({ error: 'Room not found' }, 404)

    const body = await c.req.json<{ name?: unknown }>().catch(() => ({ name: undefined }))
    const name = cleanDisplayName(body.name)
    if (!name) return c.json({ error: 'Enter your name to join.' }, 400)

    const issued = await issueGuestPass(c.env, roomId, name)
    if (!issued) {
      // Fail closed: without the signing secret nobody gets a guest identity.
      console.error('[rooms] GUEST_SECRET is not set; guest join refused')
      return c.json({ error: 'Joining is not available right now.' }, 503)
    }
    const secure = new URL(c.req.url).protocol === 'https:'
    c.header('Set-Cookie', guestCookie(roomId, issued.token, secure))
    return c.json({ me: { userId: issued.pass.guestId, name, isGuest: true } })
  })

  // Chat posts go through the worker so the author name is the verified one.
  app.post('/api/rooms/:roomId/messages', async (c) => {
    const roomId = c.req.param('roomId')
    const room = await getRoom(c.env, roomId)
    if (!room) return c.json({ error: 'Room not found' }, 404)
    const me = await resolveParticipant(c, resolveAuth, roomId)
    if (!me) return c.json({ error: 'Join the room before posting.' }, 401)

    const body = await c.req.json<{ body?: unknown }>().catch(() => ({ body: undefined }))
    const text = typeof body.body === 'string' ? body.body.trim() : ''
    if (!text) return c.json({ error: 'Message is empty.' }, 400)
    if (text.length > MAX_MESSAGE_LENGTH) {
      return c.json({ error: `Messages are limited to ${MAX_MESSAGE_LENGTH} characters.` }, 400)
    }

    const result = await recordTools(c.env, roomScopeId(roomId), me.userId).create(
      'room_messages',
      { authorId: me.userId, authorName: me.name, kind: 'user', body: text },
    )
    if (!result.success) return c.json({ error: 'Could not post the message.' }, 500)
    return c.json({ recordId: result.data.recordId })
  })
}
