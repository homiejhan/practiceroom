/**
 * Draws one `[graph]` or `[figure]` block.
 *
 * The block is laid out into a Scene (see `visuals/scene.ts`): paths and dots
 * go into an SVG, and text labels are HTML placed over it so their math can be
 * typeset with KaTeX like the rest of the page.
 */

import { memo, useMemo } from 'react'
import { renderLatex } from '@/board/math'
import { buildVisual, type VisualKind } from '@/visuals'
import type { Anchor, SceneItem } from '@/visuals/scene'

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Label text is plain text with `$...$` math; `\$` is a literal dollar sign. */
function labelHtml(text: string): string {
  let html = ''
  for (const part of text.split(/(\\\$|\$[^$]*\$)/)) {
    if (!part) continue
    if (part === '\\$') html += '$'
    else if (part.length >= 2 && part.startsWith('$') && part.endsWith('$')) {
      html += renderLatex(part.slice(1, -1))
    } else html += escapeHtml(part)
  }
  return html
}

/** Moves a label so the named side of its box, not its corner, sits on the point. */
const ANCHOR_SHIFT: Record<Anchor, string> = {
  c: 'translate(-50%, -50%)',
  n: 'translate(-50%, -100%)',
  s: 'translate(-50%, 0)',
  e: 'translate(0, -50%)',
  w: 'translate(-100%, -50%)',
  ne: 'translate(0, -100%)',
  nw: 'translate(-100%, -100%)',
  se: 'translate(0, 0)',
  sw: 'translate(-100%, 0)',
}

const DASHES = { solid: undefined, dashed: '5 3.5', dotted: '1 3.4' } as const

function pathData(points: number[], closed?: boolean): string {
  let d = ''
  for (let i = 0; i + 1 < points.length; i += 2) {
    d += `${i === 0 ? 'M' : 'L'}${points[i].toFixed(2)},${points[i + 1].toFixed(2)}`
  }
  return closed ? `${d}Z` : d
}

function Shape({ item }: { item: Exclude<SceneItem, { kind: 'label' }> }) {
  if (item.kind === 'dot') {
    return item.open ? (
      <circle cx={item.x} cy={item.y} r={item.r} fill="#ffffff" stroke={item.color} strokeWidth={1.3} />
    ) : (
      <circle cx={item.x} cy={item.y} r={item.r} fill={item.color} />
    )
  }
  return (
    <path
      d={pathData(item.points, item.closed)}
      fill={item.fill ?? 'none'}
      fillOpacity={item.fill ? (item.fillOpacity ?? 1) : undefined}
      stroke={item.stroke ?? 'none'}
      strokeWidth={item.stroke ? (item.width ?? 1) : undefined}
      strokeDasharray={DASHES[item.dash ?? 'solid']}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  )
}

export const Visual = memo(function Visual({ kind, source }: { kind: VisualKind; source: string }) {
  const scene = useMemo(() => buildVisual(kind, source.split('\n')), [kind, source])
  const drawable = scene.items.length > 0 && scene.width > 0

  if (!drawable) {
    return (
      <figure className="visual visual-failed" data-visual={kind}>
        <figcaption>This {kind} could not be drawn.</figcaption>
      </figure>
    )
  }

  return (
    <figure className="visual" data-visual={kind}>
      <div className="visual-canvas" style={{ width: scene.width, height: scene.height }}>
        <svg width={scene.width} height={scene.height} viewBox={`0 0 ${scene.width} ${scene.height}`} aria-hidden="true">
          {scene.items.map((item, index) =>
            item.kind === 'label' ? null : <Shape key={index} item={item} />,
          )}
        </svg>
        {scene.items.map((item, index) =>
          item.kind === 'label' ? (
            <span
              key={index}
              className={`visual-label${item.small ? ' is-small' : ''}${item.bold ? ' is-bold' : ''}${item.anchor === 'c' ? ' is-backed' : ''}`}
              style={{ left: item.x, top: item.y, transform: ANCHOR_SHIFT[item.anchor], color: item.color }}
              dangerouslySetInnerHTML={{ __html: labelHtml(item.text) }}
            />
          ) : null,
        )}
      </div>
      {scene.errors.length > 0 && <figcaption>Part of this {kind} could not be drawn.</figcaption>}
    </figure>
  )
})
