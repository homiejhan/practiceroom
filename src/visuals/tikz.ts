/**
 * A Scene as a TikZ picture, for the worksheet PDF. The scene is already laid
 * out in pixels, so this only converts units (y flips: TikZ's y runs up) and
 * writes each item out.
 */

import type { Anchor, Scene } from './scene'

/** Points per scene pixel: a 200px graph prints 2.2 inches wide. */
const SCALE = 0.8

const TIKZ_ANCHOR: Record<Anchor, string> = {
  c: 'center',
  n: 'south',
  s: 'north',
  e: 'west',
  w: 'east',
  ne: 'south west',
  nw: 'south east',
  se: 'north west',
  sw: 'north east',
}

const num = (value: number): string => {
  const text = value.toFixed(2).replace(/\.?0+$/, '')
  return text === '-0' || text === '' ? '0' : text
}

/**
 * `formatText` turns a label ("8 cm", "$x^\circ$") into LaTeX; the worksheet
 * passes its own inline converter so labels are escaped like the rest of the page.
 */
export function sceneToTikz(scene: Scene, formatText: (text: string) => string): string {
  if (!scene.items.length || scene.width <= 0 || scene.height <= 0) return ''
  const colors = new Map<string, string>()
  const color = (hex: string): string => {
    const key = hex.replace('#', '').toUpperCase()
    let name = colors.get(key)
    if (!name) colors.set(key, (name = `prc${key}`))
    return name
  }
  const at = (x: number, y: number) => `(${num(x * SCALE)},${num((scene.height - y) * SCALE)})`

  const body: string[] = []
  for (const item of scene.items) {
    if (item.kind === 'path') {
      const options: string[] = []
      if (item.stroke) {
        options.push(`draw=${color(item.stroke)}`, `line width=${num((item.width ?? 1) * SCALE)}pt`)
        if (item.dash === 'dashed') options.push('dash pattern=on 4pt off 2.5pt')
        if (item.dash === 'dotted') options.push('dash pattern=on 0.9pt off 2.2pt')
      }
      if (item.fill) options.push(`fill=${color(item.fill)}`, `fill opacity=${num(item.fillOpacity ?? 1)}`)
      const points: string[] = []
      for (let i = 0; i + 1 < item.points.length; i += 2) points.push(at(item.points[i], item.points[i + 1]))
      if (points.length < 2) continue
      // Short source lines: a long curve would otherwise be one enormous line.
      const rows: string[] = []
      for (let i = 0; i < points.length; i += 6) rows.push(points.slice(i, i + 6).join(' -- '))
      body.push(`\\path[${options.join(', ')}] ${rows.join(' --\n  ')}${item.closed ? ' -- cycle' : ''};`)
    } else if (item.kind === 'dot') {
      const style = item.open
        ? `draw=${color(item.color)}, fill=white, line width=0.9pt`
        : `fill=${color(item.color)}`
      body.push(`\\path[${style}] ${at(item.x, item.y)} circle[radius=${num(item.r * SCALE)}pt];`)
    } else {
      const font = `${item.small ? '\\scriptsize' : '\\small'}${item.bold ? '\\bfseries' : ''}`
      const options = [
        `anchor=${TIKZ_ANCHOR[item.anchor]}`,
        'inner sep=1.2pt',
        `font=${font}`,
        `text=${color(item.color ?? '#16161a')}`,
      ]
      // Labels placed beside lines get a pale backing so nothing strikes through them.
      if (item.anchor === 'c') options.push('fill=white', 'fill opacity=0.85', 'text opacity=1')
      body.push(`\\node[${options.join(', ')}] at ${at(item.x, item.y)} {${formatText(item.text)}};`)
    }
  }

  const definitions = [...colors].map(([hex, name]) => `\\definecolor{${name}}{HTML}{${hex}}`)
  return [
    '\\begin{tikzpicture}[x=1pt, y=1pt, line cap=round, line join=round, baseline=(current bounding box.north)]',
    ...definitions,
    `\\path[use as bounding box] (0,0) rectangle (${num(scene.width * SCALE)},${num(scene.height * SCALE)});`,
    ...body,
    '\\end{tikzpicture}',
  ].join('\n')
}
