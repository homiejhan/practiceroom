/**
 * The inline math editor the Type tool opens on the board.
 *
 * The <math-field> element is created imperatively: it is a custom element
 * with its own lifecycle, and React only needs to place it and hear back once
 * (commit or cancel).
 */

import { useEffect, useRef } from 'react'
import { configureMathLive, MathfieldElement } from './math'
import { MATH_FONT_SIZE } from './types'

export interface MathCommit {
  latex: string
  /** Rendered size in screen pixels; the board converts it to world units. */
  width: number
  height: number
}

export function MathEditor({
  initialLatex,
  onCommit,
  onCancel,
}: {
  initialLatex: string
  onCommit: (result: MathCommit) => void
  onCancel: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  // The latest callbacks, so the element is built once per editing session.
  const handlers = useRef({ onCommit, onCancel })
  handlers.current = { onCommit, onCancel }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    configureMathLive()

    const field = new MathfieldElement()
    field.value = initialLatex
    field.mathVirtualKeyboardPolicy = 'manual'
    field.smartFence = true
    field.style.fontSize = `${MATH_FONT_SIZE}px`
    field.setAttribute('aria-label', 'Math entry')
    host.appendChild(field)

    let finished = false
    const finish = (commit: boolean) => {
      if (finished) return
      finished = true
      if (!commit) {
        handlers.current.onCancel()
        return
      }
      const box = field.getBoundingClientRect()
      handlers.current.onCommit({
        latex: field.getValue('latex').trim(),
        width: box.width,
        height: box.height,
      })
    }

    const onKeyDown = (event: KeyboardEvent) => {
      // Keep board shortcuts (Delete, number keys) from firing while typing.
      event.stopPropagation()
      if (event.key === 'Escape') {
        event.preventDefault()
        finish(false)
      }
    }
    // MathLive fires `change` on Enter and when focus leaves with new content;
    // `blur` covers leaving without a change.
    const onChange = () => finish(true)
    const onBlur = () => finish(true)

    field.addEventListener('keydown', onKeyDown)
    field.addEventListener('change', onChange)
    field.addEventListener('blur', onBlur)
    // Focus now so the first keystroke lands in the field, and once more on
    // the next frame in case the browser moved focus while the click settled.
    field.focus()
    const focusFrame = requestAnimationFrame(() => {
      if (!finished && document.activeElement !== field) field.focus()
    })

    return () => {
      finished = true
      cancelAnimationFrame(focusFrame)
      field.removeEventListener('keydown', onKeyDown)
      field.removeEventListener('change', onChange)
      field.removeEventListener('blur', onBlur)
      field.remove()
    }
    // One editor instance per mount: the parent remounts it with a new key,
    // so `initialLatex` is read once on purpose.
  }, [])

  return (
    <div
      ref={hostRef}
      className="board-math-editor"
      onPointerDown={(event) => event.stopPropagation()}
    />
  )
}
