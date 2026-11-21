/**
 * The tutor's home: their rooms, and a form to open a new one.
 *
 * Rooms are read straight from the `rooms` collection (RBAC limits the query
 * to the caller's own). Creating one goes through the `createRoom` action,
 * because the worker mints the id that becomes the join link.
 */

import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutations, useQuery } from 'deepspace'
import { Check, Link2, Trash2 } from 'lucide-react'
import { Button, ConfirmModal, Input, Label, useToast } from '@/components/ui'
import { APP_DISPLAY_NAME } from '@/constants'
import { callAction } from '@/lib/api'

interface Room {
  title: string
  ownerId: string
}

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

export default function RoomsPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const { records, status } = useQuery<Room>('rooms', { orderBy: 'createdAt', orderDir: 'desc' })
  const { remove, ready } = useMutations<Room>('rooms')

  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null)

  const create = async () => {
    const trimmed = title.trim()
    if (!trimmed || creating) return
    setCreating(true)
    const result = await callAction<{ roomId: string }>('createRoom', { title: trimmed })
    setCreating(false)
    if (!result.ok) {
      toast.error('The room was not created', result.error)
      return
    }
    navigate(`/r/${result.data.roomId}`)
  }

  const copyLink = async (roomId: string) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/r/${roomId}`)
      setCopiedId(roomId)
      window.setTimeout(() => setCopiedId((current) => (current === roomId ? null : current)), 1800)
    } catch {
      toast.error('Could not copy the link')
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <title>{`Your rooms · ${APP_DISPLAY_NAME}`}</title>
      <h1 className="text-2xl font-semibold tracking-tight">Your rooms</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Each room is one whiteboard with its own join link. Students open the link and type their name.
      </p>

      <form
        className="mt-6 flex items-end gap-3 rounded-lg border border-border bg-card p-4"
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="room-title">New room</Label>
          <Input
            id="room-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={80}
            placeholder="Algebra with Maya, Tuesday"
          />
        </div>
        <Button type="submit" disabled={!title.trim() || creating}>
          {creating ? 'Creating' : 'Create room'}
        </Button>
      </form>

      <div className="mt-8">
        {status === 'loading' && <p className="text-sm text-muted-foreground">Loading your rooms</p>}
        {status === 'error' && (
          <p className="text-sm text-destructive">Your rooms could not be loaded. Reload the page to try again.</p>
        )}
        {status === 'ready' && records.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No rooms yet. Name one above to open your first whiteboard.
          </p>
        )}
        <ul className="divide-y divide-border rounded-lg border border-border bg-card empty:hidden">
          {records.map((record) => (
            <li key={record.recordId} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <Link
                  to={`/r/${record.recordId}`}
                  className="block truncate font-medium hover:text-primary hover:underline"
                >
                  {record.data.title}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {record.createdAt ? `Created ${dateFormat.format(new Date(record.createdAt))}` : ''}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => copyLink(record.recordId)}>
                {copiedId === record.recordId ? <Check aria-hidden="true" /> : <Link2 aria-hidden="true" />}
                {copiedId === record.recordId ? 'Copied' : 'Copy link'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Delete ${record.data.title}`}
                disabled={!ready}
                onClick={() => setDeleting({ id: record.recordId, title: record.data.title })}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      </div>

      <ConfirmModal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove(deleting.id)
          setDeleting(null)
        }}
        title={`Delete "${deleting?.title ?? ''}"?`}
        description="The join link stops working for everyone. This cannot be undone."
        confirmText="Delete room"
        variant="destructive"
      />
    </div>
  )
}
