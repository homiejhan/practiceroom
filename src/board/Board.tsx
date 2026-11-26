/**
 * The shared whiteboard.
 *
 * Shapes (ink strokes, typed math, question cards, pictures) live in the
 * room's CanvasRoom through `useCanvas`; cursors and the tutor's check box
 * travel through the room's PresenceRoom through `usePresenceRoom`. This
 * component adds the tools on top: pan, select, type, pen, highlighter,
 * eraser, and (tutor only) pictures and the region box that Claude grades.
 *
 * A stylus's hardware controls work under any tool (see `penInput.ts`): its
 * eraser end erases ink and its side button selects, each for one gesture.
 * Two fingers always pinch to zoom and slide to pan, whatever tool is
 * selected; a palm that lands while a pen is writing is ignored.
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
  Eraser,
  Hand,
  Highlighter,
  ImagePlus,
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
import { imageFiles } from './imageUpload'
import { MathEditor, type MathCommit } from './MathEditor'
import { renderLatex } from './math'
import { penBind } from './penInput'
import { captureRegion, type RegionCapture } from './renderRegion'
import {
  HIGHLIGHTER_COLORS,
  HIGHLIGHTER_OPACITY,
  MATH_FONT_SIZE,
  PEN_COLORS,
  QUESTION_CARD_WIDTH,
  WIDTHS,
  boardImageSrc,
  mathProps,
  pinchView,
  questionProps,
  readWidths,
  rectContains,
  rectFromPoints,
  rectsOverlap,
  shapeRect,
  strokePath,
  strokeProps,
  type Rect,
  type Shape,
  type Tool,
  type ToolWidths,
  type View,
  type WidthTool,
} from './types'

export interface BoardPeer {
  userId: string
  userName: string
}

export interface BoardHandle {
  /** Put a generated question on the board, below the last one. */
  addQuestion: (question: { questionId: string; title: string; text: string }) => void
}

/** A picture after upload: where it is stored and its size in pixels. */
export interface UploadedImage {
  src: string
  width: number
  height: number
}

interface BoardProps {
  roomId: string
  myUserId: string
  ownerId: string
  isTutor: boolean
  /** Grade the captured region. Resolves true when the result was posted. */
  onCheck?: (capture: RegionCapture) => Promise<boolean>
  /** Upload a picture for the board. Resolves null when it could not be added. */
  onAddImage?: (file: File) => Promise<UploadedImage | null>
  onPeers?: (peers: BoardPeer[]) => void
}

interface Patch {
  base: Shape
  x?: number
  y?: number
  width?: number
  height?: number
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
  /**
   * The eraser tool, or a pen's eraser end. `x`/`y` is the last sample in
   * world space. A finger only starts erasing once it has moved (`armed`), so
   * the first finger of a pinch cannot rub something out.
   */
  | { kind: 'erase'; x: number; y: number; armed: boolean; downX: number; downY: number }
  /** Two fingers: where they started, and the view at that moment. */
  | { kind: 'pinch'; ids: [number, number]; mid: Point; distance: number; view: View }
  /** Dragging a picture's corner. Sizes are the picture's when the drag began. */
  | { kind: 'resize'; id: string; startX: number; startY: number; width: number; height: number }

const MIN_ZOOM = 0.25
const MAX_ZOOM = 4
const DOUBLE_CLICK_MS = 350
const QUESTION_GAP = 280
/** Where each person's chosen tool widths are kept between visits, on their own device. */
const WIDTHS_KEY = 'practiceroom:widths'
/** How close (in screen pixels) a pen-button tap must be to ink to select it. */
const TAP_REACH = 9
/** How far a finger moves (screen pixels) before the eraser starts erasing. */
const TOUCH_ERASE_SLOP = 8
/** A pen that has sent nothing for this long has left the board; stop ignoring fingers. */
const PEN_IDLE_MS = 1500
/** A new picture is shown at most this wide, in board units. */
const IMAGE_START_WIDTH = 520
const IMAGE_MIN_WIDTH = 48

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

/**
 * Pictures sit under everything else, so they can be written on. Only the
 * tutor can pick them up; for a student they are part of the background.
 */
const ImageLayer = memo(function ImageLayer({
  images,
  selected,
  hittable,
}: {
  images: Shape[]
  selected: Set<string>
  hittable: boolean
}) {
  return (
    <>
      {images.map((shape) => {
        const src = boardImageSrc(shape)
        if (!src) return null
        return (
          <div
            key={shape.id}
            data-shape-id={shape.id}
            className={cn('board-image', selected.has(shape.id) && 'is-selected')}
            style={{
              left: shape.x,
              top: shape.y,
              width: shape.width,
              height: shape.height,
              pointerEvents: hittable ? 'auto' : 'none',
            }}
          >
            <img src={src} alt="Picture on the board" draggable={false} decoding="async" />
          </div>
        )
      })}
    </>
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
  { roomId, myUserId, ownerId, isTutor, onCheck, onAddImage, onPeers },
  ref,
) {
  const {
    shapes,
    connected,
    canWrite,
    addShape,
    moveShape,
    resizeShape,
    updateShape,
    deleteShape,
    undo,
    redo,
  } = useCanvas(roomId)
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
  // Pen, highlighter and eraser widths. Remembered on this device; a browser
  // that refuses storage simply starts from the defaults each time.
  const [widths, setWidths] = useState<ToolWidths>(() => {
    try {
      return readWidths(JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? 'null'))
    } catch {
      return readWidths(null)
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths))
    } catch {
      // Private windows and blocked storage: the widths last for this visit.
    }
  }, [widths])
  const setWidth = useCallback(
    (which: WidthTool, value: number) => setWidths((prev) => ({ ...prev, [which]: value })),
    [],
  )
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
  const [resizing, setResizing] = useState<{ id: string; width: number; height: number } | null>(null)
  const [uploading, setUploading] = useState(0)

  const gesture = useRef<Gesture | null>(null)
  // Which pointer owns the gesture, so a second one cannot end or steer it.
  const activePointer = useRef<{ id: number; type: string; at: number } | null>(null)
  /** Fingers currently on the board, by pointer id, in screen pixels. */
  const touches = useRef(new Map<number, Point>())
  const fileInput = useRef<HTMLInputElement>(null)
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
        width: patch.width ?? shape.width,
        height: patch.height ?? shape.height,
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

  // What is on screen right now: the synced shapes with any drag or resize in
  // progress applied, before it has been sent.
  const visible = useMemo(() => {
    if (!drag && !resizing) return all
    return all.map((shape) => {
      if (drag?.ids.has(shape.id)) return { ...shape, x: shape.x + drag.dx, y: shape.y + drag.dy }
      if (resizing?.id === shape.id) return { ...shape, width: resizing.width, height: resizing.height }
      return shape
    })
  }, [all, drag, resizing])

  const penStrokes = useMemo(
    () => visible.filter((s) => s.type === 'stroke' && !strokeProps(s).hl),
    [visible],
  )
  const highlightStrokes = useMemo(
    () => visible.filter((s) => s.type === 'stroke' && strokeProps(s).hl),
    [visible],
  )
  const images = useMemo(() => visible.filter((s) => s.type === 'image'), [visible])
  const items = useMemo(
    () => visible.filter((s) => s.type !== 'stroke' && s.type !== 'image'),
    [visible],
  )

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
      const element = containerRef.current?.querySelector(
        `[data-shape-id="${CSS.escape(shape.id)}"]`,
      )
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

  // Question cards and pictures are the tutor's to move or remove. CanvasRoom
  // has no per-shape permissions, so this is a rule of the interface only.
  const canMove = useCallback(
    (shape: Shape | undefined): boolean =>
      !!shape && (isTutor || (shape.type !== 'question' && shape.type !== 'image')),
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
          size: highlighter ? widths.highlighter : widths.pen,
          hl: highlighter,
        },
      })
    },
    [addLocal, highlightColor, penColor, widths.highlighter, widths.pen],
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
    const radius = widths.eraser / 2 / viewRef.current.zoom
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
      // For a student a picture is background, not something to pick up.
      if (shape.type === 'image' && !isTutor) continue
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

  /** Give up the gesture in progress without committing any of it. */
  const cancelGesture = () => {
    const active = gesture.current
    gesture.current = null
    activePointer.current = null
    if (!active) return
    if (active.kind === 'draw') {
      draft.current = []
      setDraftTick((tick) => tick + 1)
    } else if (active.kind === 'move') setDrag(null)
    else if (active.kind === 'marquee') setMarquee(null)
    else if (active.kind === 'region') setRegion(null)
    else if (active.kind === 'erase') moveEraserRing(null)
    else if (active.kind === 'resize') setResizing(null)
  }

  /** A second finger has landed: whatever the first was doing becomes a pinch. */
  const beginPinch = () => {
    cancelGesture()
    const [[idA, a], [idB, b]] = [...touches.current]
    const box = containerRef.current?.getBoundingClientRect()
    capture(idA)
    capture(idB)
    gesture.current = {
      kind: 'pinch',
      ids: [idA, idB],
      mid: { x: (a.x + b.x) / 2 - (box?.left ?? 0), y: (a.y + b.y) / 2 - (box?.top ?? 0) },
      distance: Math.hypot(a.x - b.x, a.y - b.y),
      view: viewRef.current,
    }
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    lastPointerType.current = event.pointerType
    const bind = penBind(event)
    if (event.button === 2 && !bind) return
    if ((event.target as Element).closest('[data-board-ui]')) return
    if (!containerRef.current) return

    if (event.pointerType === 'touch') {
      // A palm that lands while the pen is writing is not a second finger.
      const owner = activePointer.current
      if (gesture.current && owner?.type === 'pen' && performance.now() - owner.at < PEN_IDLE_MS) {
        return
      }
      // The first finger of a touch means no others are down, whatever is remembered.
      if (event.isPrimary) touches.current.clear()
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (touches.current.size === 2) {
        beginPinch()
        return
      }
      if (touches.current.size > 2) return
    }

    // One pointer at a time: a new one takes over from whatever was in progress.
    cancelGesture()
    beginGesture(event, bind)
    if (gesture.current) {
      activePointer.current = { id: event.pointerId, type: event.pointerType, at: performance.now() }
    }
  }

  /** Start the gesture for a pointer that has just gone down, if it starts one. */
  const beginGesture = (event: React.PointerEvent<HTMLDivElement>, bind: ReturnType<typeof penBind>) => {
    const target = event.target as Element
    const world = toWorld(event.clientX, event.clientY)

    // The corner handle of the selected picture resizes it.
    const resizeId = target.closest('[data-resize]')?.getAttribute('data-resize')
    if (resizeId) {
      const shape = allRef.current.find((candidate) => candidate.id === resizeId)
      if (!shape || !canWrite) return
      capture(event.pointerId)
      gesture.current = {
        kind: 'resize',
        id: resizeId,
        startX: world.x,
        startY: world.y,
        width: shape.width,
        height: shape.height,
      }
      return
    }

    const panning = !bind && (event.button === 1 || tool === 'pan' || spaceHeld)

    // The eraser tool, or a pen's eraser end under any tool.
    if (bind === 'erase' || (tool === 'eraser' && !bind && !panning)) {
      if (!canWrite) return
      capture(event.pointerId)
      const finger = event.pointerType === 'touch'
      gesture.current = {
        kind: 'erase',
        x: world.x,
        y: world.y,
        armed: !finger,
        downX: event.clientX,
        downY: event.clientY,
      }
      if (!finger) {
        moveEraserRing(event)
        eraseAlong(world, world)
      }
      return
    }

    // The pen's side button selects for this one gesture.
    const active: Tool = bind === 'select' ? 'select' : tool
    const hitId =
      bind === 'select'
        ? hitAt(world)
        : (target.closest('[data-shape-id]')?.getAttribute('data-shape-id') ?? null)

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
    if (touches.current.has(event.pointerId)) {
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    }
    const active = gesture.current

    if (active?.kind === 'pinch') {
      const a = touches.current.get(active.ids[0])
      const b = touches.current.get(active.ids[1])
      const box = containerRef.current?.getBoundingClientRect()
      if (!a || !b || !box) return
      const mid = { x: (a.x + b.x) / 2 - box.left, y: (a.y + b.y) / 2 - box.top }
      const distance = Math.hypot(a.x - b.x, a.y - b.y)
      setView(pinchView(active.view, active.mid, active.distance, mid, distance, MIN_ZOOM, MAX_ZOOM))
      return
    }

    const world = toWorld(event.clientX, event.clientY)
    publishCursor(world)
    if (!active) {
      // With the eraser selected, its outline follows a mouse or a hovering pen.
      if (tool === 'eraser' && event.pointerType !== 'touch') {
        moveEraserRing((event.target as Element).closest('[data-board-ui]') ? null : event)
      }
      return
    }
    const owner = activePointer.current
    if (owner && owner.id !== event.pointerId) return
    if (owner) owner.at = performance.now()

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
      case 'resize': {
        // The corner follows the pointer; the height keeps the picture's shape.
        const width = Math.max(IMAGE_MIN_WIDTH, active.width + (world.x - active.startX))
        setResizing({ id: active.id, width, height: (width * active.height) / active.width })
        break
      }
      case 'erase': {
        if (!active.armed) {
          const moved = Math.hypot(event.clientX - active.downX, event.clientY - active.downY)
          if (moved < TOUCH_ERASE_SLOP) break
          active.armed = true
        }
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
    touches.current.delete(event.pointerId)
    const active = gesture.current
    if (!active) return
    const container = containerRef.current
    const release = (pointerId: number) => {
      if (container?.hasPointerCapture(pointerId)) container.releasePointerCapture(pointerId)
    }

    if (active.kind === 'pinch') {
      // Either finger lifting ends the pinch; the one still down does nothing more.
      if (!active.ids.includes(event.pointerId)) return
      gesture.current = null
      active.ids.forEach(release)
      return
    }

    const owner = activePointer.current
    if (owner && owner.id !== event.pointerId) return
    gesture.current = null
    activePointer.current = null
    release(event.pointerId)
    const world = toWorld(event.clientX, event.clientY)

    switch (active.kind) {
      case 'erase':
        // A finger that tapped without moving erases what it tapped.
        if (!active.armed && event.type !== 'pointercancel') eraseAlong(world, world)
        // With the eraser selected, the outline stays under a mouse or pen.
        if (tool !== 'eraser' || event.pointerType === 'touch') moveEraserRing(null)
        break
      case 'resize': {
        setResizing(null)
        const width = Math.max(IMAGE_MIN_WIDTH, active.width + (world.x - active.startX))
        if (Math.abs(width - active.width) < 0.5) break
        const height = (width * active.height) / active.width
        patchShape(active.id, { width, height })
        resizeShape(active.id, width, height)
        break
      }
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
        const hits = allRef.current.filter((shape) => {
          const rect = measure(shape)
          // A picture is something to write on: the box picks it up only when
          // it holds the whole picture, so selecting ink on top leaves it be.
          if (shape.type === 'image') return isTutor && rectContains(box, rect)
          return rectsOverlap(rect, box)
        })
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

  // --- Pictures (tutor) ----------------------------------------------------

  const addImage = useCallback(
    async (file: File, at?: Point) => {
      if (!onAddImage || !canWrite) return
      setUploading((count) => count + 1)
      let uploaded: UploadedImage | null = null
      try {
        uploaded = await onAddImage(file)
      } finally {
        setUploading((count) => count - 1)
      }
      if (!uploaded) return

      // Shown at a comfortable size in the middle of what the tutor is
      // looking at (or where it was dropped), never larger than its pixels.
      const box = containerRef.current?.getBoundingClientRect()
      const v = viewRef.current
      const viewWidth = (box?.width ?? 900) / v.zoom
      const viewHeight = (box?.height ?? 600) / v.zoom
      const fit = Math.min(
        1,
        IMAGE_START_WIDTH / uploaded.width,
        (viewWidth * 0.7) / uploaded.width,
        (viewHeight * 0.7) / uploaded.height,
      )
      const width = uploaded.width * fit
      const height = uploaded.height * fit
      const center = at ?? { x: v.x + viewWidth / 2, y: v.y + viewHeight / 2 }
      const id = crypto.randomUUID()
      addLocal({
        id,
        type: 'image',
        x: center.x - width / 2,
        y: center.y - height / 2,
        width,
        height,
        props: { src: uploaded.src },
      })
      // Selected, so it can be moved or resized straight away.
      setTool('select')
      setSelection(new Set([id]))
    },
    [addLocal, canWrite, onAddImage],
  )

  // A screenshot on the clipboard goes straight onto the board.
  useEffect(() => {
    if (!onAddImage) return
    const onPaste = (event: ClipboardEvent) => {
      if (isTypingTarget(event.target)) return
      const files = imageFiles(event.clipboardData)
      if (!files.length) return
      event.preventDefault()
      for (const file of files.slice(0, 4)) void addImage(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addImage, onAddImage])

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!onAddImage) return
    const files = imageFiles(event.dataTransfer)
    if (!files.length) return
    event.preventDefault()
    const at = toWorld(event.clientX, event.clientY)
    for (const file of files.slice(0, 4)) void addImage(file, at)
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
        '6': 'eraser',
      }
      if (isTutor) shortcuts['7'] = 'region'
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

  // The eraser's outline belongs to the eraser tool; put it away with the tool.
  useEffect(() => {
    if (tool !== 'eraser' && eraserRing.current) delete eraserRing.current.dataset.on
  }, [tool])

  // --- Region check (tutor) ------------------------------------------------

  const runCheck = async () => {
    if (!region || !onCheck || checking) return
    // Pictures are drawn into the capture from the <img> already on screen.
    const pictureOf = (shape: Shape) =>
      containerRef.current?.querySelector<HTMLImageElement>(
        `[data-shape-id="${CSS.escape(shape.id)}"] img`,
      ) ?? null
    const capture = captureRegion(region, allRef.current, measure, pictureOf)
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
  // The one selected picture gets a corner handle to resize it by.
  const [onlySelected] = selection.size === 1 ? [...selection] : []
  const resizable =
    isTutor && tool === 'select' && !panCursor
      ? images.find((image) => image.id === onlySelected)
      : undefined

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
      onPointerLeave={() => {
        publishCursor(null)
        if (gesture.current?.kind !== 'erase') moveEraserRing(null)
      }}
      // Dropping an image file on the board adds it where it was dropped.
      onDragOver={(event) => {
        if (onAddImage && event.dataTransfer.types.includes('Files')) event.preventDefault()
      }}
      onDrop={onDrop}
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
        <ImageLayer
          images={images}
          selected={selection}
          hittable={isTutor && tool === 'select' && !panCursor}
        />
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
              strokeWidth={tool === 'highlighter' ? widths.highlighter : widths.pen}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={tool === 'highlighter' ? HIGHLIGHTER_OPACITY : 1}
            />
          </svg>
        )}
      </div>

      {/* Screen-space overlays */}
      <div
        ref={eraserRing}
        className="board-eraser"
        aria-hidden="true"
        style={{ width: widths.eraser, height: widths.eraser, margin: -widths.eraser / 2 }}
      />
      {marquee && <div className="board-marquee" style={toScreen(marquee)} />}
      {resizable && (
        <div
          className="board-resize"
          data-resize={resizable.id}
          title="Drag to resize"
          style={{
            left: (resizable.x + resizable.width - view.x) * view.zoom,
            top: (resizable.y + resizable.height - view.y) * view.zoom,
          }}
        />
      )}

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
        <ToolButton tool="eraser" label="Eraser" hint="6" active={tool} onSelect={setTool}>
          <Eraser className="size-[18px]" aria-hidden="true" />
        </ToolButton>
        {isTutor && (
          <>
            <div className="board-toolbar-rule" />
            <ToolButton tool="region" label="Check a region with Claude" hint="7" active={tool} onSelect={setTool}>
              <ScanSearch className="size-[18px]" aria-hidden="true" />
            </ToolButton>
          </>
        )}
        {onAddImage && (
          <>
            <button
              type="button"
              className="board-tool"
              title="Add a picture (or paste a screenshot)"
              aria-label="Add a picture"
              disabled={!canWrite}
              onClick={() => fileInput.current?.click()}
            >
              <ImagePlus className="size-[18px]" aria-hidden="true" />
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              hidden
              data-testid="image-input"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                // Cleared so that picking the same file again still fires a change.
                event.target.value = ''
                for (const file of files.slice(0, 4)) void addImage(file)
              }}
            />
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
          <div className="board-palette-rule" />
          <WidthSlider
            tool={tool === 'pen' ? 'pen' : 'highlighter'}
            label={tool === 'pen' ? 'Pen width' : 'Highlighter width'}
            value={tool === 'pen' ? widths.pen : widths.highlighter}
            color={tool === 'pen' ? penColor : highlightColor}
            onChange={setWidth}
          />
        </div>
      )}
      {tool === 'eraser' && (
        <div className="board-palette" data-board-ui>
          <WidthSlider tool="eraser" label="Eraser width" value={widths.eraser} onChange={setWidth} />
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
      {tool === 'eraser' && (
        <div className="board-hint" data-board-ui>
          Drag over ink to erase it. Undo brings it back.
        </div>
      )}
      {selection.size > 0 && tool === 'select' && (
        <div className="board-hint" data-board-ui>
          {selection.size} selected. Drag to move, {resizable ? 'drag the corner to resize, ' : ''}Delete to remove.
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
      {uploading > 0 && connected && canWrite && (
        <div className="board-status" role="status">
          <LoaderCircle className="mr-1.5 inline size-3.5 animate-spin align-[-2px]" aria-hidden="true" />
          Adding the picture
        </div>
      )}
    </div>
  )
})

/**
 * How wide a tool draws (or erases): a vertical slider with a dot that shows
 * the size. Built from plain elements so it behaves the same under a mouse, a
 * finger and a pen; a native range input turned on its side does not.
 */
function WidthSlider({
  tool,
  label,
  value,
  color,
  onChange,
}: {
  tool: WidthTool
  label: string
  value: number
  /** The ink colour, for the pen and highlighter. The eraser shows an outline. */
  color?: string
  onChange: (tool: WidthTool, value: number) => void
}) {
  const { min, max, step } = WIDTHS[tool]
  const fraction = (value - min) / (max - min)
  const set = (next: number) => {
    const snapped = Math.round(next / step) * step
    onChange(tool, Math.min(max, Math.max(min, Math.round(snapped * 100) / 100)))
  }
  // The top of the track is the widest.
  const fromPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    set(min + (1 - (event.clientY - box.top) / box.height) * (max - min))
  }
  const dot = Math.min(26, Math.max(2, value))

  return (
    <div className="board-width">
      <div className="board-width-preview" aria-hidden="true">
        <span
          className={color ? undefined : 'is-outline'}
          style={{
            width: dot,
            height: dot,
            background: color,
            opacity: tool === 'highlighter' ? HIGHLIGHTER_OPACITY + 0.25 : undefined,
          }}
        />
      </div>
      <div
        className="board-width-track"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-orientation="vertical"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        title={`${label}: ${value}`}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          fromPointer(event)
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) fromPointer(event)
        }}
        onKeyDown={(event) => {
          const steps: Record<string, number> = {
            ArrowUp: step,
            ArrowRight: step,
            ArrowDown: -step,
            ArrowLeft: -step,
            PageUp: step * 4,
            PageDown: -step * 4,
          }
          if (event.key === 'Home') set(min)
          else if (event.key === 'End') set(max)
          else if (steps[event.key]) set(value + steps[event.key])
          else return
          event.preventDefault()
        }}
      >
        <div className="board-width-fill" style={{ height: `${fraction * 100}%` }} />
        <div className="board-width-thumb" style={{ bottom: `${fraction * 100}%` }} />
      </div>
      <output className="board-width-value">{value}</output>
    </div>
  )
}

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
