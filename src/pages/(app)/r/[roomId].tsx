/**
 * A practice room: the shared whiteboard, the room chat, and (for the tutor)
 * the question tools.
 *
 * This page is public on purpose. The tutor arrives signed in; a student
 * opens the same link, types a name, and the worker hands back a guest pass
 * for this one room (src/server/guest.ts). The board mounts only after one of
 * those identities exists, so its sockets always connect as someone.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AuthOverlay, getUserColor, useAuth } from 'deepspace'
import { Check, Link2, MessageSquare, PanelLeft } from 'lucide-react'
import { Board, type BoardHandle, type BoardPeer } from '@/board/Board'
import type { RegionCapture } from '@/board/renderRegion'
import { RoomChat } from '@/components/room/RoomChat'
import { TutorPanel } from '@/components/room/TutorPanel'
import { Button, Input, Label, useToast } from '@/components/ui'
import { APP_DISPLAY_NAME } from '@/constants'
import { callAction, roomRequest, type Me, type RoomInfo } from '@/lib/api'
import { cn } from '@/lib/utils'

type LoadState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ready'; info: RoomInfo }

const NAME_STORAGE_KEY = 'practiceroom:name'

export default function RoomPage() {
  const { roomId = '' } = useParams()
  const { isSignedIn } = useAuth()
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  // Reload when sign-in state changes: a tutor who signs in from the join
  // screen becomes the owner without a page refresh.
  useEffect(() => {
    let alive = true
    setState({ status: 'loading' })
    void roomRequest<RoomInfo>(roomId, '').then((result) => {
      if (!alive) return
      if (result.ok) setState({ status: 'ready', info: result.data })
      else if (result.status === 404) setState({ status: 'missing' })
      else setState({ status: 'error', error: result.error })
    })
    return () => {
      alive = false
    }
  }, [roomId, isSignedIn])

  if (state.status === 'loading') {
    return <CenteredMessage title="Opening the room" />
  }
  if (state.status === 'missing') {
    return (
      <CenteredMessage title="This room does not exist" detail="Check the link with your tutor. Rooms can be deleted by the tutor who made them.">
        <Link to="/" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
          Go to {APP_DISPLAY_NAME}
        </Link>
      </CenteredMessage>
    )
  }
  if (state.status === 'error') {
    return <CenteredMessage title="The room could not be opened" detail={state.error} />
  }

  const { info } = state
  if (!info.me) {
    return (
      <JoinScreen
        info={info}
        onJoined={(me) => setState({ status: 'ready', info: { ...info, me } })}
      />
    )
  }
  return <RoomView info={info} me={info.me} />
}

function CenteredMessage({
  title,
  detail,
  children,
}: {
  title: string
  detail?: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <title>{`${title} · ${APP_DISPLAY_NAME}`}</title>
      <h1 className="text-xl font-semibold">{title}</h1>
      {detail && <p className="max-w-sm text-sm text-muted-foreground">{detail}</p>}
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Join by name
// ---------------------------------------------------------------------------

function JoinScreen({ info, onJoined }: { info: RoomInfo; onJoined: (me: Me) => void }) {
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_STORAGE_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showSignIn, setShowSignIn] = useState(false)

  const join = async () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    const result = await roomRequest<{ me: Me }>(info.roomId, '/join', { name: trimmed })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    try {
      localStorage.setItem(NAME_STORAGE_KEY, trimmed)
    } catch {
      // Private browsing: the name just is not remembered.
    }
    onJoined(result.data.me)
  }

  return (
    <div className="flex h-full items-center justify-center px-6">
      <title>{`Join ${info.title} · ${APP_DISPLAY_NAME}`}</title>
      <div className="w-full max-w-sm">
        <p className="text-sm font-medium text-primary">{APP_DISPLAY_NAME}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{info.title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Enter your name so your tutor knows who you are on the board.
        </p>
        <form
          className="mt-6 space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            void join()
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="join-name">Your name</Label>
            <Input
              id="join-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={40}
              autoFocus
              autoComplete="given-name"
              placeholder="Alex"
              aria-invalid={!!error}
              aria-describedby={error ? 'join-error' : undefined}
            />
            {error && (
              <p id="join-error" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <Button type="submit" className="w-full" disabled={!name.trim() || busy}>
            {busy ? 'Joining' : 'Join the room'}
          </Button>
        </form>
        <p className="mt-6 text-sm text-muted-foreground">
          Are you the tutor?{' '}
          <button
            type="button"
            className="font-medium text-primary underline-offset-4 hover:underline"
            onClick={() => setShowSignIn(true)}
          >
            Sign in
          </button>
        </p>
      </div>
      {showSignIn && <AuthOverlay onClose={() => setShowSignIn(false)} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------

function RoomView({ info, me }: { info: RoomInfo; me: Me }) {
  const { roomId, ownerId, isOwner } = info
  const boardRef = useRef<BoardHandle>(null)
  const toast = useToast()

  const [chatOpen, setChatOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(isOwner)
  const [peers, setPeers] = useState<BoardPeer[]>([])
  const [messageCount, setMessageCount] = useState<number | null>(null)
  const [seenCount, setSeenCount] = useState(0)
  const [copied, setCopied] = useState(false)

  // Everything already in the chat when the room opens counts as seen.
  const onCount = useCallback((count: number) => {
    setMessageCount((prev) => {
      if (prev === null) setSeenCount(count)
      return count
    })
  }, [])

  useEffect(() => {
    if (chatOpen && messageCount !== null) setSeenCount(messageCount)
  }, [chatOpen, messageCount])

  const unread = chatOpen || messageCount === null ? 0 : Math.max(0, messageCount - seenCount)
  const openChat = useCallback(() => setChatOpen(true), [])

  const onCheck = useCallback(
    async (capture: RegionCapture): Promise<boolean> => {
      const result = await callAction<{ messageId: string }>('checkRegion', { roomId, ...capture })
      if (!result.ok) {
        toast.error('Claude could not check that', result.error)
        return false
      }
      return true
    },
    [roomId, toast],
  )

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/r/${roomId}`)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      toast.error('Could not copy the link', 'Copy it from the address bar instead.')
    }
  }

  const everyone = [{ userId: me.userId, userName: me.name }, ...peers]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <title>{`${info.title} · ${APP_DISPLAY_NAME}`}</title>

      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background px-3">
        {isOwner ? (
          <Link to="/rooms" className="text-sm font-semibold text-primary hover:underline">
            {APP_DISPLAY_NAME}
          </Link>
        ) : (
          <span className="text-sm font-semibold text-primary">{APP_DISPLAY_NAME}</span>
        )}
        <span className="text-border" aria-hidden="true">
          /
        </span>
        <h1 className="min-w-0 truncate text-sm font-medium">{info.title}</h1>

        <div className="flex-1" />

        <ul className="flex items-center -space-x-1.5" aria-label="People in this room">
          {everyone.slice(0, 6).map((person) => (
            <li
              key={person.userId}
              title={`${person.userName}${person.userId === ownerId ? ' (tutor)' : ''}${person.userId === me.userId ? ' (you)' : ''}`}
              className="grid size-7 place-items-center rounded-full border-2 border-background text-[11px] font-semibold text-white"
              style={{ background: getUserColor(person.userId) }}
            >
              {(person.userName.trim()[0] ?? '?').toUpperCase()}
            </li>
          ))}
          {everyone.length > 6 && (
            <li className="grid size-7 place-items-center rounded-full border-2 border-background bg-muted text-[11px] font-semibold">
              +{everyone.length - 6}
            </li>
          )}
        </ul>

        <Button variant="outline" size="sm" onClick={copyLink}>
          {copied ? <Check aria-hidden="true" /> : <Link2 aria-hidden="true" />}
          <span className="max-sm:sr-only">{copied ? 'Link copied' : 'Copy join link'}</span>
        </Button>

        {isOwner && (
          <Button
            variant={toolsOpen ? 'secondary' : 'outline'}
            size="sm"
            aria-pressed={toolsOpen}
            onClick={() => setToolsOpen((open) => !open)}
          >
            <PanelLeft aria-hidden="true" />
            <span className="max-sm:sr-only">Tutor tools</span>
          </Button>
        )}

        <Button
          variant={chatOpen ? 'secondary' : 'outline'}
          size="sm"
          aria-pressed={chatOpen}
          onClick={() => setChatOpen((open) => !open)}
          data-testid="chat-toggle"
        >
          <MessageSquare aria-hidden="true" />
          <span className="max-sm:sr-only">{chatOpen ? 'Hide chat' : 'Chat'}</span>
          {unread > 0 && (
            <span className="grid min-w-5 place-items-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
              {unread}
            </span>
          )}
        </Button>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {isOwner && (
          <aside
            aria-label="Tutor tools"
            className={cn(
              'w-[340px] shrink-0 border-r border-border bg-background max-lg:absolute max-lg:inset-y-0 max-lg:left-0 max-lg:z-20 max-lg:shadow-xl',
              !toolsOpen && 'hidden',
            )}
          >
            <TutorPanel
              roomId={roomId}
              userId={me.userId}
              onQuestion={(question) =>
                boardRef.current?.addQuestion({
                  questionId: question.questionId,
                  title: question.title,
                  text: question.question,
                })
              }
            />
          </aside>
        )}

        <main className="min-w-0 flex-1">
          <Board
            ref={boardRef}
            roomId={roomId}
            myUserId={me.userId}
            ownerId={ownerId}
            isTutor={isOwner}
            onCheck={isOwner ? onCheck : undefined}
            onPeers={setPeers}
          />
        </main>

        {/* Stays mounted while hidden so the unread badge keeps counting. */}
        <aside
          aria-label="Room chat"
          className={cn(
            'w-[360px] shrink-0 border-l border-border bg-background max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-20 max-lg:max-w-full max-lg:shadow-xl',
            !chatOpen && 'hidden',
          )}
        >
          <RoomChat
            roomId={roomId}
            myUserId={me.userId}
            ownerId={ownerId}
            onCount={onCount}
            onGrade={openChat}
          />
        </aside>
      </div>
    </div>
  )
}
