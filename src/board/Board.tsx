/**
 * The shared whiteboard.
 *
 * Shapes (ink strokes, typed math, question cards) live in the room's
 * CanvasRoom through `useCanvas`; cursors and the tutor's check box travel
 * through the room's PresenceRoom through `usePresenceRoom`. This component
 * adds the tools on top: pan, select, type, pen, highlighter, and (tutor only)
 * the region box that Claude grades.
 *
 * A stylus's hardware controls work under any tool (see `penInput.ts`): its
 * eraser end erases ink and its side button selects, each for one gesture.
 *
 * Three pieces of local state paper over how CanvasRoom echoes writes:
 * - `pending`: a new shape is drawn immediately and dropped once the server's
 *   copy (same id) arrives, so ink never flickers.
 * - `erased`: ink the eraser touched is hidden immediately and stays hidden
 *   until the server's delete arrives. Like a patch, the hide is tied to the
 *   exact shape object, so an undo that brings the ink back shows it again.
 * - `patches`: the server does not echo a move or a prop update back to its
 *   sender, so the sender keeps its own change on top of the synced shape. A
 *   patch is tied to the exact shape object it was made against; any later
 *   message that replaces that object (someone else's edit, an undo, a full
 *   resync) retires the patch and the server's version wins.
 */

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { getUserColor, useCanvas, usePresenceRoom } from 'deepspace'
import {
  Hand,
  Highlighter,
  LoaderCircle,
  Minus,
  MousePointer2,
  Pen,
  Plus,
  Redo2,
  ScanSearch,
  Type,
  Undo2,
  X,
} from 'lucide-react'
import { Markdown } from '@/components/Markdown'
import { cn } from '@/lib/utils'
import { sweepTouchesStroke, type Point } from './hit'
import { MathEditor, type MathCommit } from './MathEditor'
import { renderLatex } from './math'
import { penBind } from './penInput'
import { captureRegion, type RegionCapture } from './renderRegion'
import {
  HIGHLIGHTER_COLORS,
  HIGHLIGHTER_OPACITY,
  HIGHLIGHTER_SIZE,
  MATH_FONT_SIZE,
  PEN_COLORS,
  PEN_SIZES,
  QUESTION_CARD_WIDTH,
  mathProps,
  questionProps,
  rectFromPoints,
  rectsOverlap,
  shapeRect,
  strokePath,
  strokeProps,
  type Rect,
  type Shape,
  type Tool,
  type View,
} from './types'

export interface BoardPeer {
  userId: string
  userName: string
}

export interface BoardHandle {
  /** Put a generated question on the board, below the last one. */
  addQuestion: (question: { questionId: string; title: string; text: string }) => void
}

interface BoardProps {
  roomId: string
  myUserId: string
  ownerId: string
  isTutor: boolean
  /** Grade the captured region. Resolves true when the result was posted. */
  onCheck?: (capture: RegionCapture) => Promise<boolean>
  onPeers?: (peers: BoardPeer[]) => void
}

interface Patch {
  base: Shape
  x?: number
  y?: number
  props?: Record<string, unknown>
}

interface EditorState {
  key: number
  id: string | null
  x: number
  y: number
  latex: string
}

type Gesture =
  | { kind: 'pan'; startX: number; startY: number; view: View }
  | { kind: 'draw' }
  | { kind: 'move'; startX: number; startY: number; ids: string[]; moved: boolean }
  | { kind: 'marquee'; startX: number; startY: number }
  | { kind: 'region'; startX: number; startY: number }
  | { kind: 'type'; startX: number; startY: number; hitId: string | null }
  /** The pen's eraser end. `x`/`y` is the last sample, in world space. */
  | { kind: 'erase'; x: number; y: number }

const MIN_ZOOM = 0.25
const MAX_ZOOM = 4
const DOUBLE_CLICK_MS = 350
const QUESTION_GAP = 280
/** Screen pixels, so the eraser feels the same size at any zoom. */
const ERASER_RADIUS = 10
/** How close (in screen pixels) a pen-button tap must be to ink to select it. */
const TAP_REACH = 9

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/** Every sample the browser folded into one pointermove, so fast strokes keep their shape. */
const samplesOf = (event: React.PointerEvent): PointerEvent[] => {
  const samples = event.nativeEvent.getCoalescedEvents?.() ?? []
  return samples.length ? samples : [event.nativeEvent]
}

const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  !!target.closest('input, textarea, select, [contenteditable="true"], math-field')

/** World-space size of a math entry: measured at commit time, kept in props. */
function mathRect(shape: Shape): Rect {
  const props = shape.props as { w?: number; h?: number }
  return { x: shape.x, y: shape.y, w: props.w ?? shape.width, h: props.h ?? shape.height }
}

// ---------------------------------------------------------------------------
// Layers. Memoized so a moving cursor or an in-progress stroke does not
// re-render every shape on the board.
// ---------------------------------------------------------------------------

const StrokeLayer = memo(function StrokeLayer({
  strokes,
  selected,
  hittable,
  highlighter,
}: {
  strokes: Shape[]
  selected: Set<string>
  hittable: boolean
  highlighter: boolean
}) {
  return (
    <svg
      className="board-svg"
      style={highlighter ? { mixBlendMode: 'multiply' } : undefined}
      aria-hidden="true"
    >
      {strokes.map((shape) => {
        const { pts, color, size } = strokeProps(shape)
        if (!Array.isArray(pts)) return null
        const d = strokePath(pts, shape.x, shape.y)
        return (
          <g key={shape.id}>
            {selected.has(shape.id) && (
              <path d={d} className="board-stroke-selected" strokeWidth={size + 8} />
            )}
            <path
              d={d}
              fill="none"
              stroke={color}
              strokeWidth={size}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={highlighter ? HIGHLIGHTER_OPACITY : 1}
            />
            {hittable && (
              <path
                d={d}
                data-shape-id={shape.id}
                fill="none"
                stroke="transparent"
                strokeWidth={Math.max(size + 14, 18)}
                strokeLinecap="round"
                style={{ pointerEvents: 'stroke' }}
              />
            )}
          </g>
        )
      })}
    </svg>
  )
})

const ItemLayer = memo(function ItemLayer({
  items,
  selected,
  hittable,
  editingId,
}: {
  items: Shape[]
  selected: Set<string>
  hittable: boolean
  editingId: string | null
}) {
  return (
    <>
      {items.map((shape) => {
        const isSelected = selected.has(shape.id)
        if (shape.type === 'math') {
          if (shape.id === editingId) return null
          return (
            <div
              key={shape.id}
              data-shape-id={shape.id}
              className={cn('board-math', isSelected && 'is-selected')}
              style={{
                left: shape.x,
                top: shape.y,
                fontSize: MATH_FONT_SIZE,
                pointerEvents: hittable ? 'auto' : 'none',
              }}
              dangerouslySetInnerHTML={{ __html: renderLatex(mathProps(shape).latex) }}
            />
          )
        }
        if (shape.type === 'question') {
          const { n, title, text } = questionProps(shape)
          return (
            <div
              key={shape.id}
              data-shape-id={shape.id}
              className={cn('board-question', isSelected && 'is-selected')}
              style={{
                left: shape.x,
                top: shape.y,
                width: QUESTION_CARD_WIDTH,
                pointerEvents: hittable ? 'auto' : 'none',
              }}
            >
              <div className="board-question-head">
                <span className="board-question-number">Question {n}</span>
                <span className="board-question-title">{title}</span>
              </div>
              <Markdown className="board-question-body">{text}</Markdown>
            </div>
          )
        }
        return null
      })}
    </>
  )
})

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

export const Board = forwardRef<BoardHandle, BoardProps>(function Board(
  { roomId, myUserId, ownerId, isTutor, onCheck, onPeers },
  ref,
) {
  const { shapes, connected, canWrite, addShape, moveShape, updateShape, deleteShape, undo, redo } =
    useCanvas(roomId)
  const { peers, updateState } = usePresenceRoom(roomId)

  const containerRef = useRef<HTMLDivElement>(null)
  const [view, setViewState] = useState<View>({ x: -96, y: -72, zoom: 1 })
  const viewRef = useRef(view)
  const setView = useCallback((next: View) => {
    viewRef.current = next
    setViewState(next)
  }, [])

  const [tool, setTool] = useState<Tool>('pen')
  const [penColor, setPenColor] = useState(PEN_COLORS[0].value)
  const [penSize, setPenSize] = useState<number>(PEN_SIZES[1])
  const [highlightColor, setHighlightColor] = useState(HIGHLIGHTER_COLORS[2].value)

  const [pending, setPending] = useState<Shape[]>([])
  const [patches, setPatches] = useState<Map<string, Patch>>(() => new Map())
  const [erased, setErased] = useState<Map<string, Shape>>(() => new Map())
  const [selection, setSelection] = useState<Set<string>>(() => new Set())
  const [drag, setDrag] = useState<{ ids: Set<string>; dx: number; dy: number } | null>(null)
  const [marquee, setMarquee] = useState<Rect | null>(null)
  const [region, setRegion] = useState<Rect | null>(null)
  const [checking, setChecking] = useState(false)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [draftTick, setDraftTick] = useState(0)
  const [spaceHeld, setSpaceHeld] = useState(false)

  const gesture = useRef<Gesture | null>(null)
  const draft = useRef<number[]>([])
  const draftFrame = useRef(0)
  const cursorFrame = useRef(0)
  const cursorPoint = useRef<{ x: number; y: number } | null>(null)
  const lastTap = useRef<{ id: string | null; at: number }>({ id: null, at: 0 })
  const editorKey = useRef(0)
  const eraserRing = useRef<HTMLDivElement>(null)
  const lastPointerType = useRef('')
  // Read by pointer handlers that can fire several times before a re-render.
  const erasedRef = useRef(erased)
  erasedRef.current = erased

  // --- Synced shapes + local overlay ---------------------------------------

  const hookById = useMemo(() => new Map(shapes.map((shape) => [shape.id, shape])), [shapes])

  const all = useMemo(() => {
    const merged: Shape[] = []
    for (const shape of shapes) {
      if (erased.get(shape.id) === shape) continue
      const patch = patches.get(shape.id)
      if (!patch || patch.base !== shape) {
        merged.push(shape)
        continue
      }
      merged.push({
        ...shape,
        x: patch.x ?? shape.x,
        y: patch.y ?? shape.y,
        props: patch.props ? { ...shape.props, ...patch.props } : shape.props,
      })
    }
    for (const shape of pending) if (!hookById.has(shape.id)) merged.push(shape)
    return merged
  }, [shapes, pending, patches, erased, hookById])

  const allRef = useRef(all)
  allRef.current = all

  // Drop pending copies once the server's version exists, and patches and
  // eraser hides whose base shape has been removed or replaced by a newer message.
  useEffect(() => {
    setPending((prev) => {
      const next = prev.filter((shape) => !hookById.has(shape.id))
      return next.length === prev.length ? prev : next
    })
    setPatches((prev) => {
      let changed = false
      const next = new Map(prev)
      for (const [id, patch] of prev) {
        if (hookById.get(id) !== patch.base) {
          next.delete(id)
          changed = true
        }
      }
      return changed ? next : prev
    })
    setErased((prev) => {
      let changed = false
      const next = new Map(prev)
      for (const [id, base] of prev) {
        if (hookById.get(id) !== base) {
          next.delete(id)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [hookById])

  const visible = useMemo(() => {
    if (!drag) return all
    return all.map((shape) =>
      drag.ids.has(shape.id) ? { ...shape, x: shape.x + drag.dx, y: shape.y + drag.dy } : shape,
    )
  }, [all, drag])

  const penStrokes = useMemo(
    () => visible.filter((s) => s.type === 'stroke' && !strokeProps(s).hl),
    [visible],
  )
  const highlightStrokes = useMemo(
    () => visible.filter((s) => s.type === 'stroke' && strokeProps(s).hl),
    [visible],
  )
  const items = useMemo(() => visible.filter((s) => s.type !== 'stroke'), [visible])

  const patchShape = useCallback(
    (id: string, change: Omit<Patch, 'base'>) => {
      const base = hookById.get(id)
      if (!base) return
      setPatches((prev) => {
        const existing = prev.get(id)
        const merged: Patch =
          existing && existing.base === base
            ? { ...existing, ...change, props: { ...existing.props, ...change.props } }
            : { base, ...change }
        return new Map(prev).set(id, merged)
      })
    },
    [hookById],
  )

  const addLocal = useCallback(
    (shape: Pick<Shape, 'id' | 'type' | 'x' | 'y' | 'width' | 'height' | 'props'>) => {
      const now = new Date().toISOString()
      setPending((prev) => [
        ...prev,
        { ...shape, createdBy: myUserId, createdAt: now, updatedAt: now },
      ])
      addShape(shape)
    },
    [addShape, myUserId],
  )

  // --- Coordinates ---------------------------------------------------------

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const box = containerRef.current?.getBoundingClientRect()
    const v = viewRef.current
    return {
      x: (clientX - (box?.left ?? 0)) / v.zoom + v.x,
      y: (clientY - (box?.top ?? 0)) / v.zoom + v.y,
    }
  }, [])

  const zoomAt = useCallback(
    (clientX: number, clientY: number, nextZoom: number) => {
      const box = containerRef.current?.getBoundingClientRect()
      if (!box) return
      const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM)
      const anchor = toWorld(clientX, clientY)
      setView({
        zoom,
        x: anchor.x - (clientX - box.left) / zoom,
        y: anchor.y - (clientY - box.top) / zoom,
      })
    },
    [setView, toWorld],
  )

  const zoomBy = useCallback(
    (factor: number) => {
      const box = containerRef.current?.getBoundingClientRect()
      if (!box) return
      zoomAt(box.left + box.width / 2, box.top + box.height / 2, viewRef.current.zoom * factor)
    },
    [zoomAt],
  )

  /** On-screen size of a shape in world units (cards grow with their text). */
  const measure = useCallback(
    (shape: Shape): Rect => {
      if (shape.type === 'stroke') return shapeRect(shape)
      const element = containerRef.current?.querySelector(`[data-shape-id="${shape.id}"]`)
      if (element) {
        const box = element.getBoundingClientRect()
        const topLeft = toWorld(box.left, box.top)
        const zoom = viewRef.current.zoom
        return { x: topLeft.x, y: topLeft.y, w: box.width / zoom, h: box.height / zoom }
      }
      return shape.type === 'math' ? mathRect(shape) : shapeRect(shape)
    },
    [toWorld],
  )

  // --- Presence ------------------------------------------------------------

  useEffect(() => {
    onPeers?.(peers.map((peer) => ({ userId: peer.userId, userName: peer.userName })))
  }, [peers, onPeers])

  const publishCursor = useCallback(
    (point: { x: number; y: number } | null) => {
      cursorPoint.current = point
      if (cursorFrame.current) return
      cursorFrame.current = requestAnimationFrame(() => {
        cursorFrame.current = 0
        const latest = cursorPoint.current
        updateState({ cursor: latest ? { x: Math.round(latest.x), y: Math.round(latest.y) } : null })
      })
    },
    [updateState],
  )

  // A reconnect rejoins presence with empty state, so re-send the check box.
  useEffect(() => {
    if (isTutor) updateState({ region: region ?? null, checking })
  }, [isTutor, region, checking, updateState])

  // --- Questions (tutor) ---------------------------------------------------

  useImperativeHandle(
    ref,
    () => ({
      addQuestion({ questionId, title, text }) {
        const box = containerRef.current?.getBoundingClientRect()
        const v = viewRef.current
        const questions = allRef.current.filter((shape) => shape.type === 'question')
        let x = v.x + 72 / v.zoom
        let y = v.y + 96 / v.zoom
        if (questions.length) {
          const last = questions.reduce((a, b) => (measure(a).y > measure(b).y ? a : b))
          const lastRect = measure(last)
          x = lastRect.x
          y = lastRect.y + lastRect.h + QUESTION_GAP
        }
        addLocal({
          id: crypto.randomUUID(),
          type: 'question',
          x,
          y,
          width: QUESTION_CARD_WIDTH,
          height: 140,
          props: { qid: questionId, title, text, n: questions.length + 1 },
        })
        // Bring the new card into the tutor's view if it landed off-screen.
        if (box) {
          const bottom = v.y + box.height / v.zoom
          const right = v.x + box.width / v.zoom
          if (y + 200 > bottom || y < v.y || x < v.x || x + QUESTION_CARD_WIDTH > right) {
            setView({ ...v, x: x - 72 / v.zoom, y: y - 96 / v.zoom })
          }
        }
      },
    }),
    [addLocal, measure, setView],
  )

  // --- Editing math --------------------------------------------------------

  const editorRef = useRef(editor)
  editorRef.current = editor

  const openEditor = useCallback((next: Omit<EditorState, 'key'>) => {
    editorKey.current += 1
    setSelection(new Set())
    setEditor({ ...next, key: editorKey.current })
  }, [])

  const commitEditor = useCallback(
    (result: MathCommit) => {
      const current = editorRef.current
      if (!current) return
      setEditor(null)
      const zoom = viewRef.current.zoom
      const w = Math.max(24, result.width / zoom)
      const h = Math.max(24, result.height / zoom)
      if (current.id) {
        if (!result.latex) {
          deleteShape(current.id)
        } else if (result.latex !== current.latex) {
          // Size rides in props so an edit is one update (and one undo step).
          const props = { latex: result.latex, w, h }
          patchShape(current.id, { props })
          updateShape(current.id, props)
        }
      } else if (result.latex) {
        addLocal({
          id: crypto.randomUUID(),
          type: 'math',
          x: current.x,
          y: current.y,
          width: w,
          height: h,
          props: { latex: result.latex, w, h },
        })
      }
    },
    [addLocal, deleteShape, patchShape, updateShape],
  )

  // --- Pointer gestures ----------------------------------------------------

  const canMove = useCallback(
    (shape: Shape | undefined): boolean => !!shape && (isTutor || shape.type !== 'question'),
    [isTutor],
  )

  const finishStroke = useCallback(
    (highlighter: boolean) => {
      const points = draft.current
      draft.current = []
      setDraftTick((tick) => tick + 1)
      if (points.length < 2) return
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (let i = 0; i < points.length; i += 2) {
        minX = Math.min(minX, points[i])
        maxX = Math.max(maxX, points[i])
        minY = Math.min(minY, points[i + 1])
        maxY = Math.max(maxY, points[i + 1])
      }
      const pts = points.map((value, index) =>
        Math.round((value - (index % 2 === 0 ? minX : minY)) * 10) / 10,
      )
      addLocal({
        id: crypto.randomUUID(),
        type: 'stroke',
        x: minX,
        y: minY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY),
        props: {
          pts,
          color: highlighter ? highlightColor : penColor,
          size: highlighter ? HIGHLIGHTER_SIZE : penSize,
          hl: highlighter,
        },
      })
    },
    [addLocal, highlightColor, penColor, penSize],
  )

  const capture = (pointerId: number) => {
    try {
      containerRef.current?.setPointerCapture(pointerId)
    } catch {
      // The pointer was already released; the gesture just ends at the edge.
    }
  }

  /** Show the eraser's outline at a screen position, or hide it with `null`. */
  const moveEraserRing = (at: { clientX: number; clientY: number } | null) => {
    const ring = eraserRing.current
    if (!ring) return
    if (!at) {
      delete ring.dataset.on
      return
    }
    const box = containerRef.current?.getBoundingClientRect()
    ring.style.transform = `translate(${at.clientX - (box?.left ?? 0)}px, ${at.clientY - (box?.top ?? 0)}px)`
    ring.dataset.on = ''
  }

  /** Erase every stroke the eraser passed over between two world points. */
  const eraseAlong = (from: Point, to: Point) => {
    const radius = ERASER_RADIUS / viewRef.current.zoom
    let next: Map<string, Shape> | null = null
    for (const shape of allRef.current) {
      if (shape.type !== 'stroke') continue
      // Only ink the server already has: its delete message is what ends the hide.
      const base = hookById.get(shape.id)
      if (!base || erasedRef.current.get(shape.id) === base) continue
      if (!sweepTouchesStroke(shape, from, to, radius)) continue
      next ??= new Map(erasedRef.current)
      next.set(shape.id, base)
      deleteShape(shape.id)
    }
    if (next) {
      erasedRef.current = next
      setErased(next)
    }
  }

  /**
   * The topmost shape under a world point, found by geometry. The Select
   * tool's clickable layers are only rendered while that tool is active, so a
   * pen-button selection under another tool cannot use them.
   */
  const hitAt = (point: Point): string | null => {
    const shapesHere = allRef.current
    const reach = TAP_REACH / viewRef.current.zoom
    for (let i = shapesHere.length - 1; i >= 0; i--) {
      const shape = shapesHere[i]
      if (shape.type === 'stroke' && sweepTouchesStroke(shape, point, point, reach)) return shape.id
    }
    for (let i = shapesHere.length - 1; i >= 0; i--) {
      const shape = shapesHere[i]
      if (shape.type === 'stroke') continue
      const box = measure(shape)
      if (
        point.x >= box.x &&
        point.x <= box.x + box.w &&
        point.y >= box.y &&
        point.y <= box.y + box.h
      ) {
        return shape.id
      }
    }
    return null
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    lastPointerType.current = event.pointerType
    const bind = penBind(event)
    if (event.button === 2 && !bind) return
    const target = event.target as Element
    if (target.closest('[data-board-ui]')) return
    if (!containerRef.current) return
    const world = toWorld(event.clientX, event.clientY)

    // The pen's eraser end erases ink, whichever tool is selected.
    if (bind === 'erase') {
      if (!canWrite) return
      capture(event.pointerId)
      gesture.current = { kind: 'erase', x: world.x, y: world.y }
      moveEraserRing(event)
      eraseAlong(world, world)
      return
    }

    // The pen's side button selects for this one gesture.
    const active: Tool = bind === 'select' ? 'select' : tool
    const hitId =
      bind === 'select'
        ? hitAt(world)
        : (target.closest('[data-shape-id]')?.getAttribute('data-shape-id') ?? null)

    const panning = !bind && (event.button === 1 || tool === 'pan' || spaceHeld)
    if (panning) {
      capture(event.pointerId)
      gesture.current = {
        kind: 'pan',
        startX: event.clientX,
        startY: event.clientY,
        view: viewRef.current,
      }
      return
    }

    if (active === 'region') {
      if (!isTutor || checking) return
      capture(event.pointerId)
      gesture.current = { kind: 'region', startX: world.x, startY: world.y }
      setRegion({ x: world.x, y: world.y, w: 0, h: 0 })
      return
    }

    if (!canWrite) return
    capture(event.pointerId)

    if (active === 'pen' || active === 'highlighter') {
      // A selection made with the pen's side button should not linger under new ink.
      if (selection.size) setSelection(new Set())
      gesture.current = { kind: 'draw' }
      draft.current = [world.x, world.y]
      setDraftTick((tick) => tick + 1)
      return
    }

    if (active === 'type') {
      gesture.current = { kind: 'type', startX: event.clientX, startY: event.clientY, hitId }
      return
    }

    // Select tool.
    const hit = hitId ? allRef.current.find((shape) => shape.id === hitId) : undefined
    if (hit) {
      const now = Date.now()
      const isDouble = lastTap.current.id === hit.id && now - lastTap.current.at < DOUBLE_CLICK_MS
      lastTap.current = { id: hit.id, at: now }
      if (isDouble && hit.type === 'math') {
        gesture.current = null
        openEditor({ id: hit.id, x: hit.x, y: hit.y, latex: mathProps(hit).latex })
        return
      }
      let next = selection
      if (event.shiftKey) {
        next = new Set(selection)
        if (next.has(hit.id)) next.delete(hit.id)
        else next.add(hit.id)
      } else if (!selection.has(hit.id)) {
        next = new Set([hit.id])
      }
      setSelection(next)
      const ids = [...next].filter((id) => canMove(allRef.current.find((s) => s.id === id)))
      gesture.current = { kind: 'move', startX: world.x, startY: world.y, ids, moved: false }
      return
    }
    lastTap.current = { id: null, at: 0 }
    if (!event.shiftKey) setSelection(new Set())
    gesture.current = { kind: 'marquee', startX: world.x, startY: world.y }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const world = toWorld(event.clientX, event.clientY)
    publishCursor(world)
    const active = gesture.current
    if (!active) return

    switch (active.kind) {
      case 'pan': {
        const { view: start } = active
        setView({
          zoom: start.zoom,
          x: start.x - (event.clientX - active.startX) / start.zoom,
          y: start.y - (event.clientY - active.startY) / start.zoom,
        })
        break
      }
      case 'erase': {
        let from: Point = { x: active.x, y: active.y }
        for (const sample of samplesOf(event)) {
          const to = toWorld(sample.clientX, sample.clientY)
          eraseAlong(from, to)
          from = to
        }
        active.x = from.x
        active.y = from.y
        moveEraserRing(event)
        break
      }
      case 'draw': {
        const minStep = 1.2 / viewRef.current.zoom
        for (const sample of samplesOf(event)) {
          const point = toWorld(sample.clientX, sample.clientY)
          const points = draft.current
          const dx = point.x - points[points.length - 2]
          const dy = point.y - points[points.length - 1]
          if (dx * dx + dy * dy >= minStep * minStep) points.push(point.x, point.y)
        }
        if (!draftFrame.current) {
          draftFrame.current = requestAnimationFrame(() => {
            draftFrame.current = 0
            setDraftTick((tick) => tick + 1)
          })
        }
        break
      }
      case 'move': {
        const dx = world.x - active.startX
        const dy = world.y - active.startY
        if (!active.moved && Math.hypot(dx, dy) * viewRef.current.zoom < 3) break
        active.moved = true
        setDrag({ ids: new Set(active.ids), dx, dy })
        break
      }
      case 'marquee':
        setMarquee(rectFromPoints(active.startX, active.startY, world.x, world.y))
        break
      case 'region':
        setRegion(rectFromPoints(active.startX, active.startY, world.x, world.y))
        break
      case 'type':
        break
    }
  }

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const active = gesture.current
    gesture.current = null
    if (!active) return
    const container = containerRef.current
    if (container?.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId)
    const world = toWorld(event.clientX, event.clientY)

    switch (active.kind) {
      case 'erase':
        moveEraserRing(null)
        break
      case 'draw':
        if (draft.current.length === 2) draft.current.push(world.x + 0.01, world.y)
        finishStroke(tool === 'highlighter')
        break
      case 'move': {
        setDrag(null)
        if (!active.moved) break
        const dx = world.x - active.startX
        const dy = world.y - active.startY
        for (const id of active.ids) {
          const shape = allRef.current.find((s) => s.id === id)
          if (!shape) continue
          patchShape(id, { x: shape.x + dx, y: shape.y + dy })
          moveShape(id, shape.x + dx, shape.y + dy)
        }
        break
      }
      case 'marquee': {
        const box = rectFromPoints(active.startX, active.startY, world.x, world.y)
        setMarquee(null)
        if (box.w < 4 && box.h < 4) break
        const hits = allRef.current.filter((shape) => rectsOverlap(measure(shape), box))
        setSelection((prev) => {
          const next = event.shiftKey ? new Set(prev) : new Set<string>()
          for (const shape of hits) next.add(shape.id)
          return next
        })
        break
      }
      case 'region': {
        const box = rectFromPoints(active.startX, active.startY, world.x, world.y)
        setRegion(box.w * viewRef.current.zoom < 16 || box.h * viewRef.current.zoom < 16 ? null : box)
        break
      }
      case 'type': {
        if (Math.hypot(event.clientX - active.startX, event.clientY - active.startY) > 6) break
        const hit = active.hitId ? allRef.current.find((s) => s.id === active.hitId) : undefined
        if (hit?.type === 'math') {
          openEditor({ id: hit.id, x: hit.x, y: hit.y, latex: mathProps(hit).latex })
        } else {
          openEditor({ id: null, x: world.x, y: world.y - MATH_FONT_SIZE * 0.8, latex: '' })
        }
        break
      }
      case 'pan':
        break
    }
  }

  // --- Wheel + keyboard ----------------------------------------------------

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onWheel = (event: WheelEvent) => {
      if ((event.target as Element).closest('[data-board-ui]')) return
      event.preventDefault()
      const v = viewRef.current
      if (event.ctrlKey || event.metaKey) {
        zoomAt(event.clientX, event.clientY, v.zoom * Math.exp(-event.deltaY * 0.01))
      } else {
        setView({ ...v, x: v.x + event.deltaX / v.zoom, y: v.y + event.deltaY / v.zoom })
      }
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [setView, zoomAt])

  const deleteSelection = useCallback(() => {
    for (const id of selection) {
      const shape = allRef.current.find((s) => s.id === id)
      if (canMove(shape)) deleteShape(id)
    }
    setSelection(new Set())
  }, [selection, canMove, deleteShape])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        redo()
        return
      }
      if (mod || event.altKey) return
      if (event.key === ' ') {
        event.preventDefault()
        setSpaceHeld(true)
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selection.size) {
          event.preventDefault()
          deleteSelection()
        }
        return
      }
      if (event.key === 'Escape') {
        setSelection(new Set())
        if (!checking) setRegion(null)
        return
      }
      const shortcuts: Record<string, Tool> = {
        '1': 'pan',
        '2': 'select',
        '3': 'type',
        '4': 'pen',
        '5': 'highlighter',
      }
      if (isTutor) shortcuts['6'] = 'region'
      const next = shortcuts[event.key]
      if (next) setTool(next)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === ' ') setSpaceHeld(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [checking, deleteSelection, isTutor, redo, selection, undo])

  useEffect(
    () => () => {
      cancelAnimationFrame(draftFrame.current)
      cancelAnimationFrame(cursorFrame.current)
    },
    [],
  )

  // --- Region check (tutor) ------------------------------------------------

  const runCheck = async () => {
    if (!region || !onCheck || checking) return
    const capture = captureRegion(region, allRef.current, measure)
    if (!capture) return
    setChecking(true)
    const posted = await onCheck(capture)
    setChecking(false)
    if (posted) setRegion(null)
  }

  // --- Render --------------------------------------------------------------

  const toScreen = (rect: Rect): React.CSSProperties => ({
    left: (rect.x - view.x) * view.zoom,
    top: (rect.y - view.y) * view.zoom,
    width: rect.w * view.zoom,
    height: rect.h * view.zoom,
  })

  const drawing = tool === 'pen' || tool === 'highlighter'
  const draftPoints = draft.current
  const gridSize = 28 * view.zoom
  const hittable = tool === 'select' || tool === 'type'
  const panCursor = tool === 'pan' || spaceHeld

  return (
    <div
      ref={containerRef}
      className={cn('board', panCursor ? 'tool-pan' : `tool-${tool}`)}
      style={{
        backgroundSize: `${gridSize}px ${gridSize}px`,
        backgroundPosition: `${-view.x * view.zoom}px ${-view.y * view.zoom}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => publishCursor(null)}
      // A pen's side button and its press-and-hold both ask for a context
      // menu; on a drawing surface that would cover the ink. A mouse keeps it.
      onContextMenu={(event) => {
        if (lastPointerType.current === 'pen') event.preventDefault()
      }}
      data-testid="board"
    >
      <div
        className="board-world"
        style={{
          transform: `translate(${-view.x * view.zoom}px, ${-view.y * view.zoom}px) scale(${view.zoom})`,
        }}
      >
        <ItemLayer
          items={items}
          selected={selection}
          hittable={hittable && !panCursor}
          editingId={editor?.id ?? null}
        />
        <StrokeLayer
          strokes={penStrokes}
          selected={selection}
          hittable={tool === 'select' && !panCursor}
          highlighter={false}
        />
        <StrokeLayer
          strokes={highlightStrokes}
          selected={selection}
          hittable={tool === 'select' && !panCursor}
          highlighter
        />
        {draftPoints.length >= 2 && (
          <svg
            className="board-svg"
            style={tool === 'highlighter' ? { mixBlendMode: 'multiply' } : undefined}
            aria-hidden="true"
            data-tick={draftTick}
          >
            <path
              d={strokePath(draftPoints)}
              fill="none"
              stroke={tool === 'highlighter' ? highlightColor : penColor}
              strokeWidth={tool === 'highlighter' ? HIGHLIGHTER_SIZE : penSize}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={tool === 'highlighter' ? HIGHLIGHTER_OPACITY : 1}
            />
          </svg>
        )}
      </div>

      {/* Screen-space overlays */}
      <div ref={eraserRing} className="board-eraser" aria-hidden="true" />
      {marquee && <div className="board-marquee" style={toScreen(marquee)} />}

      {peers.map((peer) => {
        const peerRegion = peer.state.region as Rect | null | undefined
        if (!peerRegion || typeof peerRegion.w !== 'number') return null
        return (
          <div key={`region-${peer.userId}`} className="board-region is-remote" style={toScreen(peerRegion)}>
            <span className="board-region-label">
              {peer.state.checking ? 'Claude is checking this' : `${peer.userName} is selecting`}
            </span>
          </div>
        )
      })}

      {region && (
        <div className={cn('board-region', checking && 'is-busy')} style={toScreen(region)}>
          {gesture.current?.kind !== 'region' && (
            <div className="board-region-actions" data-board-ui>
              {checking ? (
                <span className="board-region-status">
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                  Claude is checking
                </span>
              ) : (
                <>
                  <button type="button" className="board-region-check" onClick={runCheck}>
                    Check
                  </button>
                  <button
                    type="button"
                    className="board-region-cancel"
                    aria-label="Remove the check box"
                    onClick={() => setRegion(null)}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {editor && (
        <div
          className="board-editor-anchor"
          style={{
            left: (editor.x - view.x) * view.zoom,
            top: (editor.y - view.y) * view.zoom,
            transform: `scale(${view.zoom})`,
          }}
          data-board-ui
        >
          <MathEditor
            key={editor.key}
            initialLatex={editor.latex}
            onCommit={commitEditor}
            onCancel={() => setEditor(null)}
          />
        </div>
      )}

      {peers.map((peer) => {
        const cursor = peer.state.cursor as { x: number; y: number } | null | undefined
        if (!cursor || typeof cursor.x !== 'number') return null
        const color = getUserColor(peer.userId)
        return (
          <div
            key={`cursor-${peer.userId}`}
            className="board-cursor"
            style={{
              transform: `translate(${(cursor.x - view.x) * view.zoom}px, ${(cursor.y - view.y) * view.zoom}px)`,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <path d="M2 1.5 L15.5 8.5 L9 10 L7 16.5 Z" fill={color} stroke="#ffffff" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
            <span className="board-cursor-label" style={{ background: color }}>
              {peer.userName}
              {peer.userId === ownerId ? ' (tutor)' : ''}
            </span>
          </div>
        )
      })}

      {/* Toolbar */}
      <div className="board-toolbar" data-board-ui role="toolbar" aria-label="Whiteboard tools">
        <ToolButton tool="pan" label="Move around" hint="1" active={tool} onSelect={setTool}>
          <Hand className="size-[18px]" aria-hidden="true" />
        </ToolButton>
        <ToolButton tool="select" label="Select" hint="2" active={tool} onSelect={setTool}>
          <MousePointer2 className="size-[18px]" aria-hidden="true" />
        </ToolButton>
        <ToolButton tool="type" label="Type math" hint="3" active={tool} onSelect={setTool}>
          <Type className="size-[18px]" aria-hidden="true" />
        </ToolButton>
        <ToolButton tool="pen" label="Pen" hint="4" active={tool} onSelect={setTool}>
          <Pen className="size-[18px]" aria-hidden="true" />
        </ToolButton>
        <ToolButton tool="highlighter" label="Highlighter" hint="5" active={tool} onSelect={setTool}>
          <Highlighter className="size-[18px]" aria-hidden="true" />
        </ToolButton>
        {isTutor && (
          <>
            <div className="board-toolbar-rule" />
            <ToolButton tool="region" label="Check a region with Claude" hint="6" active={tool} onSelect={setTool}>
              <ScanSearch className="size-[18px]" aria-hidden="true" />
            </ToolButton>
          </>
        )}
        <div className="board-toolbar-rule" />
        <button type="button" className="board-tool" title="Undo (Ctrl/⌘ Z)" aria-label="Undo" onClick={undo} disabled={!canWrite}>
          <Undo2 className="size-[18px]" aria-hidden="true" />
        </button>
        <button type="button" className="board-tool" title="Redo (Ctrl/⌘ Shift Z)" aria-label="Redo" onClick={redo} disabled={!canWrite}>
          <Redo2 className="size-[18px]" aria-hidden="true" />
        </button>
      </div>

      {drawing && (
        <div className="board-palette" data-board-ui>
          {(tool === 'pen' ? PEN_COLORS : HIGHLIGHTER_COLORS).map((swatch) => {
            const current = tool === 'pen' ? penColor : highlightColor
            return (
              <button
                key={swatch.value}
                type="button"
                className={cn('board-swatch', current === swatch.value && 'is-active')}
                style={{ background: swatch.value }}
                title={swatch.name}
                aria-label={swatch.name}
                aria-pressed={current === swatch.value}
                onClick={() =>
                  tool === 'pen' ? setPenColor(swatch.value) : setHighlightColor(swatch.value)
                }
              />
            )
          })}
          {tool === 'pen' && (
            <>
              <div className="board-palette-rule" />
              {PEN_SIZES.map((size) => (
                <button
                  key={size}
                  type="button"
                  className={cn('board-size', penSize === size && 'is-active')}
                  title={`Pen width ${size}`}
                  aria-label={`Pen width ${size}`}
                  aria-pressed={penSize === size}
                  onClick={() => setPenSize(size)}
                >
                  <span style={{ width: size + 3, height: size + 3 }} />
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {tool === 'type' && !editor && (
        <div className="board-hint" data-board-ui>
          Click the board and type. <kbd>/</kbd> fraction, <kbd>^</kbd> exponent, <kbd>sqrt</kbd>, <kbd>pi</kbd>. Enter to place.
        </div>
      )}
      {tool === 'region' && !region && (
        <div className="board-hint" data-board-ui>
          Drag a box around the question and the answer, then press Check.
        </div>
      )}
      {selection.size > 0 && tool === 'select' && (
        <div className="board-hint" data-board-ui>
          {selection.size} selected. Drag to move, Delete to remove.
        </div>
      )}

      <div className="board-zoom" data-board-ui>
        <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
          <Minus className="size-4" aria-hidden="true" />
        </button>
        <button type="button" className="board-zoom-value" title="Reset zoom" onClick={() => zoomBy(1 / view.zoom)}>
          {Math.round(view.zoom * 100)}%
        </button>
        <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.2)}>
          <Plus className="size-4" aria-hidden="true" />
        </button>
      </div>

      {(!connected || !canWrite) && (
        <div className="board-status" role="status">
          {connected ? 'View only' : 'Connecting to the board'}
        </div>
      )}
    </div>
  )
})

function ToolButton({
  tool,
  label,
  hint,
  active,
  onSelect,
  children,
}: {
  tool: Tool
  label: string
  hint: string
  active: Tool
  onSelect: (tool: Tool) => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      className={cn('board-tool', active === tool && 'is-active')}
      title={`${label} (${hint})`}
      aria-label={label}
      aria-pressed={active === tool}
      data-tool={tool}
      onClick={() => onSelect(tool)}
    >
      {children}
    </button>
  )
}
