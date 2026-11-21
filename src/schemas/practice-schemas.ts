/**
 * Practice Room collections.
 *
 * Two record scopes are in play:
 *
 * - The app scope (`app:<APP_ID>`) holds what belongs to a tutor's account:
 *   their rooms, their private answer keys, the shared question-type cache,
 *   and the per-user AI spend counter.
 * - Each room has its own scope (`room:<roomId>`) that holds the shared chat.
 *   A separate Durable Object per room means a visitor has to know the room id
 *   (the join link) to read that room's chat — one global collection with a
 *   public read rule would have exposed every room's chat to any visitor.
 *
 * Students join with only a name, so they are never RecordRoom members. Every
 * write they make to these collections goes through the worker
 * (src/server/room-routes.ts), which verifies their guest pass first.
 */

import type { CollectionSchema, RolePermissions } from 'deepspace/schema'

const none: RolePermissions = { read: false, create: false, update: false, delete: false }
const readOnly: RolePermissions = { read: true, create: false, update: false, delete: false }

/**
 * A tutor's rooms. The record id is the room id that appears in the join
 * link, so the worker mints it (the `createRoom` action) rather than letting a
 * client pick one. Tutors can rename or delete their own rooms directly.
 */
export const roomsSchema: CollectionSchema = {
  name: 'rooms',
  columns: [
    { name: 'title', storage: 'text', interpretation: 'plain', required: true, maxLength: 80 },
    { name: 'ownerId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
  ],
  ownerField: 'ownerId',
  permissions: {
    viewer: none,
    member: { read: 'own', create: false, update: 'own', delete: 'own', writableFields: ['title'] },
    admin: { read: 'own', create: false, update: 'own', delete: 'own', writableFields: ['title'] },
  },
}

/**
 * Answer keys for generated questions. Created only by the worker (as the
 * tutor), readable only by that tutor. The question text is copied onto the
 * whiteboard; the answer and solution never leave this collection except in a
 * grading message the tutor asks for.
 */
export const questionKeysSchema: CollectionSchema = {
  name: 'question_keys',
  columns: [
    { name: 'roomId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'title', storage: 'text', interpretation: 'plain', maxLength: 120 },
    { name: 'question', storage: 'text', interpretation: 'plain', required: true },
    { name: 'answer', storage: 'text', interpretation: 'plain', required: true },
    { name: 'solution', storage: 'text', interpretation: 'plain' },
    { name: 'source', storage: 'text', interpretation: 'plain', maxLength: 200 },
  ],
  permissions: {
    viewer: none,
    member: { read: 'own', create: false, update: false, delete: 'own' },
    admin: { read: 'own', create: false, update: false, delete: 'own' },
  },
}

/**
 * Question types per catalog topic, generated once by Claude and then shared
 * by every tutor. The record id is derived from the topic id.
 */
export const questionTypesSchema: CollectionSchema = {
  name: 'question_types',
  columns: [
    { name: 'topicId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'types', storage: 'text', interpretation: { kind: 'json' }, required: true },
  ],
  permissions: {
    viewer: none,
    member: readOnly,
    admin: readOnly,
  },
}

/** Per-user, per-day count of owner-billed AI calls. Worker-only. */
export const aiUsageSchema: CollectionSchema = {
  name: 'ai_usage',
  columns: [
    { name: 'userId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'day', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'count', storage: 'number', interpretation: 'plain', default: 0 },
  ],
  permissions: { viewer: none, member: none, admin: none },
}

/**
 * The shared room chat (lives in the room's own scope). Read-only to every
 * client: posts go through the worker so the author name and the `kind` come
 * from a verified identity, and nobody can forge a grading message.
 */
export const roomMessagesSchema: CollectionSchema = {
  name: 'room_messages',
  columns: [
    { name: 'authorId', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'authorName', storage: 'text', interpretation: 'plain', required: true, maxLength: 60 },
    // 'user' for people, 'grade' for a Claude grading result.
    { name: 'kind', storage: 'text', interpretation: 'plain', required: true, immutable: true },
    { name: 'body', storage: 'text', interpretation: 'plain', required: true },
  ],
  permissions: {
    '*': readOnly,
    viewer: readOnly,
    member: readOnly,
    admin: readOnly,
  },
}

/** Collections the room scope's client needs to know about. */
export const roomScopeSchemas: CollectionSchema[] = [roomMessagesSchema]

export const practiceSchemas: CollectionSchema[] = [
  roomsSchema,
  questionKeysSchema,
  questionTypesSchema,
  aiUsageSchema,
  roomMessagesSchema,
]

export const roomScopeId = (roomId: string): string => `room:${roomId}`
