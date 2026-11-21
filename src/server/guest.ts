/**
 * Guest passes — how a student who only typed a name gets a real identity.
 *
 * DeepSpace rooms take identity from a verified JWT, and a tokenless socket is
 * an anonymous read-only viewer. Students have no account, so the worker
 * issues its own credential instead: a pass naming one room, one guest id and
 * the display name, signed with HMAC under the app's GUEST_SECRET and stored in
 * an HttpOnly cookie. Same-origin WebSocket upgrades carry cookies, so the
 * realtime routes can verify the pass and forward a member identity for that
 * one room. The browser never holds anything it could edit: change the name or
 * the room in the cookie and the signature no longer matches.
 */

import { computeHmacHex, timingSafeEqualHex } from 'deepspace/worker'
import type { Env } from '../../worker.js'

export interface GuestPass {
  roomId: string
  guestId: string
  name: string
  /** Expiry, epoch seconds. */
  exp: number
}

const PASS_TTL_SECONDS = 60 * 60 * 24 * 7
export const GUEST_ID_PREFIX = 'guest-'
export const MAX_NAME_LENGTH = 40

/** Room ids come from URLs; only ids that are safe in a cookie name get a pass. */
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{6,64}$/

const cookieName = (roomId: string): string => `pr_guest_${roomId}`

const encoder = new TextEncoder()

function toBase64Url(text: string): string {
  let binary = ''
  for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): string | null {
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

/** Collapse whitespace, drop control characters, cap the length. */
export function cleanDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
}

export async function issueGuestPass(
  env: Env,
  roomId: string,
  name: string,
): Promise<{ pass: GuestPass; token: string } | null> {
  if (!env.GUEST_SECRET) return null
  const pass: GuestPass = {
    roomId,
    guestId: `${GUEST_ID_PREFIX}${crypto.randomUUID()}`,
    name,
    exp: Math.floor(Date.now() / 1000) + PASS_TTL_SECONDS,
  }
  const payload = toBase64Url(JSON.stringify(pass))
  const signature = await computeHmacHex(env.GUEST_SECRET, payload)
  return { pass, token: `${payload}.${signature}` }
}

export function guestCookie(roomId: string, token: string, secure: boolean): string {
  const parts = [
    `${cookieName(roomId)}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${PASS_TTL_SECONDS}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

/** The verified guest pass this request carries for `roomId`, or null. */
export async function readGuestPass(
  request: Request,
  env: Env,
  roomId: string,
): Promise<GuestPass | null> {
  if (!env.GUEST_SECRET || !ROOM_ID_RE.test(roomId)) return null
  const token = readCookie(request, cookieName(roomId))
  if (!token) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const payload = token.slice(0, dot)
  const signature = token.slice(dot + 1)
  const expected = await computeHmacHex(env.GUEST_SECRET, payload)
  if (!(await timingSafeEqualHex(signature, expected))) return null

  const json = fromBase64Url(payload)
  if (!json) return null
  let pass: GuestPass
  try {
    pass = JSON.parse(json) as GuestPass
  } catch {
    return null
  }
  // The signature covers the room id, so a pass for one room is useless in another.
  if (pass.roomId !== roomId) return null
  if (typeof pass.exp !== 'number' || pass.exp < Date.now() / 1000) return null
  if (typeof pass.guestId !== 'string' || !pass.guestId.startsWith(GUEST_ID_PREFIX)) return null
  if (typeof pass.name !== 'string' || !pass.name) return null
  return pass
}
