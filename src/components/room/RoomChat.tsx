/**
 * The shared room chat. Everyone in the room reads and writes here; Claude
 * posts only when the tutor checks a region of the board.
 *
 * Messages live in the room's own record scope and are read-only to clients
 * (see practice-schemas.ts). Posting goes through the worker, which stamps the
 * verified author.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { RecordScope, useQuery } from 'deepspace'
import { SendHorizontal, Sparkles } from 'lucide-react'
import { Markdown } from '@/components/Markdown'
import { roomRequest } from '@/lib/api'
import { cn } from '@/lib/utils'
import { roomScopeId, roomScopeSchemas } from '@/schemas/practice-schemas'

interface RoomMessage {
  authorId: string
  authorName: string
  kind: 'user' | 'grade'
  body: string
}

interface RoomChatProps {
  roomId: string
  myUserId: string
  ownerId: string
  /** Reports the message count so the page can badge the toggle while hidden. */
  onCount?: (count: number) => void
  /** Fires when Claude posts a new grading result, so the page can open the chat. */
  onGrade?: () => void
}

export function RoomChat(props: RoomChatProps) {
  return (
    <RecordScope roomId={roomScopeId(props.roomId)} schemas={roomScopeSchemas}>
      <ChatThread {...props} />
    </RecordScope>
  )
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

function ChatThread({ roomId, myUserId, ownerId, onCount, onGrade }: RoomChatProps) {
  const { records, status } = useQuery<RoomMessage>('room_messages', {
    orderBy: 'createdAt',
    orderDir: 'asc',
    limit: 300,
  })
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    onCount?.(records.length)
  }, [records.length, onCount])

  // A grading result that arrives while the room is open brings the chat
  // forward for everyone. Results already there on load do not.
  const latestGradeId = useMemo(() => {
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i].data.kind === 'grade') return records[i].recordId
    }
    return null
  }, [records])
  const knownGradeId = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (status !== 'ready') return
    if (knownGradeId.current === undefined) {
      knownGradeId.current = latestGradeId
      return
    }
    if (latestGradeId && latestGradeId !== knownGradeId.current) {
      knownGradeId.current = latestGradeId
      onGrade?.()
    }
  }, [status, latestGradeId, onGrade])

  // Keep the newest message in view.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [records.length])

  const send = async () => {
    const body = draft.trim()
    if (!body || sending) return
    setSending(true)
    setError(null)
    const result = await roomRequest(roomId, '/messages', { body })
    setSending(false)
    if (result.ok) setDraft('')
    else setError(result.error)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3" aria-live="polite">
        {status === 'loading' && <p className="text-sm text-muted-foreground">Loading chat</p>}
        {status === 'error' && (
          <p className="text-sm text-destructive">The chat could not be loaded. Reload the page to try again.</p>
        )}
        {status === 'ready' && records.length === 0 && (
          <p className="px-1 pt-2 text-sm text-muted-foreground">
            No messages yet. Everyone in the room can write here. Claude posts here when the tutor checks a
            boxed part of the board.
          </p>
        )}
        {records.map((record) => {
          const message = record.data
          const time = record.createdAt ? timeFormat.format(new Date(record.createdAt)) : ''
          if (message.kind === 'grade') {
            return (
              <article key={record.recordId} className="rounded-lg border border-primary/40 bg-card" data-testid="grade-message">
                <header className="flex items-center gap-2 border-b border-border px-3 py-2">
                  <Sparkles className="size-4 text-primary" aria-hidden="true" />
                  <span className="text-sm font-semibold">Claude checked the board</span>
                  <span className="ml-auto text-xs text-muted-foreground">{time}</span>
                </header>
                <Markdown className="px-3 py-3">{message.body}</Markdown>
              </article>
            )
          }
          const mine = message.authorId === myUserId
          return (
            <div key={record.recordId} className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}>
              <div className="mb-0.5 flex items-baseline gap-2 px-1 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {mine ? 'You' : message.authorName}
                  {message.authorId === ownerId ? ' (tutor)' : ''}
                </span>
                <span>{time}</span>
              </div>
              <div
                className={cn(
                  'max-w-[92%] rounded-lg px-3 py-2',
                  mine ? 'bg-primary/10' : 'bg-muted',
                )}
              >
                <Markdown>{message.body}</Markdown>
              </div>
            </div>
          )
        })}
      </div>

      <form
        className="border-t border-border p-2"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        {error && <p className="mb-1 px-1 text-xs text-destructive">{error}</p>}
        <div className="flex items-end gap-2">
          <label className="sr-only" htmlFor="room-chat-input">
            Message the room
          </label>
          <textarea
            id="room-chat-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void send()
              }
            }}
            rows={2}
            maxLength={2000}
            placeholder="Message the room"
            className="min-h-[44px] flex-1 resize-none rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus-visible:border-ring"
          />
          <button
            type="submit"
            disabled={!draft.trim() || sending}
            aria-label="Send message"
            className="grid size-[44px] shrink-0 place-items-center rounded-md bg-primary text-primary-foreground disabled:opacity-40"
          >
            <SendHorizontal className="size-4" aria-hidden="true" />
          </button>
        </div>
      </form>
    </div>
  )
}
