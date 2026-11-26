/**
 * Saving the whiteboard as a PNG or a PDF, in the browser.
 *
 * The export is everything on the board, not just what is on screen, on a
 * white page. It is built in layers, in the order the board stacks them:
 *
 *   1. pictures       drawn from the <img> elements already loaded
 *   2. typed math and question cards
 *                     these are HTML (KaTeX, Markdown, figures), so they are
 *                     rasterized with html-to-image
 *   3. pen ink        drawn from the stroke data, the same paths as on screen
 *   4. highlighter    drawn on its own layer and multiplied on, as on screen
 *
 * Ink and pictures never go through the HTML step, so a board that is only
 * handwriting exports without it, quickly and exactly.
 *
 * A PDF is the same image on a single page the size of the board.
 */

import { toCanvas } from 'html-to-image'
import {
  HIGHLIGHTER_OPACITY,
  boardImageSrc,
  shapeRect,
  strokePath,
  strokeProps,
  type Rect,
  type Shape,
} from './types'

export type ExportFormat = 'png' | 'pdf'

/** White space around the content, in board units. */
const PADDING = 32
/** Pixels per board unit: twice the on-screen size, so it stays sharp zoomed in or printed. */
const MAX_SCALE = 2
/** Below every browser's canvas limit (the smallest, on iPads, is about 16.7 million pixels). */
const MAX_PIXELS = 12_000_000
/** Board units are CSS pixels at 100% zoom: 96 to the inch, and a PDF point is 1/72 inch. */
const POINTS_PER_UNIT = 72 / 96
/** The largest page a PDF allows, in points. */
const MAX_PAGE_POINTS = 14_400

/** The rectangle that holds everything on the board, with a margin; null when the board is empty. */
export function contentBounds(shapes: Shape[], measure: (shape: Shape) => Rect): Rect | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const shape of shapes) {
    let rect: Rect
    if (shape.type === 'stroke') {
      // A stroke's box is its centre line; the ink reaches half its width further.
      const half = (Number(strokeProps(shape).size) || 0) / 2
      const box = shapeRect(shape)
      rect = { x: box.x - half, y: box.y - half, w: box.w + half * 2, h: box.h + half * 2 }
    } else if (shape.type === 'image') {
      if (!boardImageSrc(shape)) continue
      rect = shapeRect(shape)
    } else {
      rect = measure(shape)
    }
    if (![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)) continue
    x0 = Math.min(x0, rect.x)
    y0 = Math.min(y0, rect.y)
    x1 = Math.max(x1, rect.x + rect.w)
    y1 = Math.max(y1, rect.y + rect.h)
  }
  if (!Number.isFinite(x0)) return null
  return { x: x0 - PADDING, y: y0 - PADDING, w: x1 - x0 + PADDING * 2, h: y1 - y0 + PADDING * 2 }
}

/** Pixels per board unit for an export of this size: as sharp as the canvas limit allows. */
export function exportScale(bounds: Rect): number {
  return Math.min(MAX_SCALE, Math.sqrt(MAX_PIXELS / (bounds.w * bounds.h)))
}

// ---------------------------------------------------------------------------
// Fonts for the HTML layer
//
// The cards are rasterized as an SVG image, and an image cannot reach the
// page's fonts: every font its text uses has to travel inside it. (The math
// is set in KaTeX's own fonts; without them it falls back to something else.)
// html-to-image can do this itself, but its option to keep one file format
// per font drops the file from every other @font-face rule, which left the
// regular-weight math font out and set all math in bold. So the fonts are
// gathered here and handed to it ready-made.
// ---------------------------------------------------------------------------

/** Every @font-face rule in the page, including ones nested in @layer or @media. */
function fontFaceRules(): CSSFontFaceRule[] {
  const found: CSSFontFaceRule[] = []
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSFontFaceRule) found.push(rule)
      else if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules)
    }
  }
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules)
    } catch {
      // A stylesheet from another origin cannot be read; its fonts are skipped.
    }
  }
  return found
}

/** Font files already fetched, as data URLs: a second export reuses them. */
const fontData = new Map<string, Promise<string>>()

function fontDataUrl(url: string): Promise<string> {
  let data = fontData.get(url)
  if (!data) {
    data = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`font ${response.status}`)
        return response.blob()
      })
      .then(
        (blob) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result))
            reader.onerror = () => reject(reader.error)
            reader.readAsDataURL(blob)
          }),
      )
    fontData.set(url, data)
    // A failed fetch is not remembered, so the next export tries again.
    data.catch(() => fontData.delete(url))
  }
  return data
}

const familyName = (value: string): string => value.trim().replace(/["']/g, '')

/** @font-face rules, with their files inlined, for the font families the element's text uses. */
async function embeddedFonts(root: HTMLElement): Promise<string> {
  const used = new Set<string>()
  for (const element of [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))]) {
    for (const family of getComputedStyle(element).fontFamily.split(',')) used.add(familyName(family))
  }
  const faces = await Promise.all(
    fontFaceRules().map(async (rule) => {
      const family = familyName(rule.style.getPropertyValue('font-family'))
      if (!used.has(family)) return ''
      // One file per face is enough. woff2 is the smallest, and every browser
      // that can run this app reads it.
      const sources = [
        ...rule.style
          .getPropertyValue('src')
          .matchAll(/url\((["']?)([^"')]+)\1\)(?:\s*format\((["']?)([^"')]+)\3\))?/g),
      ]
      const chosen = sources.find((source) => source[4] === 'woff2') ?? sources[0]
      if (!chosen) return ''
      try {
        const base = rule.parentStyleSheet?.href ?? document.baseURI
        const data = chosen[2].startsWith('data:') ? chosen[2] : await fontDataUrl(new URL(chosen[2], base).href)
        const descriptors = ['font-style', 'font-weight', 'font-stretch', 'unicode-range']
          .map((name) => [name, rule.style.getPropertyValue(name)])
          .filter(([, value]) => value)
          .map(([name, value]) => `${name}:${value};`)
          .join('')
        const format = chosen[4] ? ` format("${chosen[4]}")` : ''
        return `@font-face{font-family:"${family}";${descriptors}src:url(${data})${format};}`
      } catch {
        return ''
      }
    }),
  )
  return faces.filter(Boolean).join('\n')
}

export interface BoardRender {
  shapes: Shape[]
  bounds: Rect
  /** The element holding typed math and question cards. */
  items: HTMLElement | null
  /** The loaded <img> showing a picture shape, if it is on screen. */
  pictureOf: (shape: Shape) => HTMLImageElement | null
}

/** Draw the whole board onto a canvas. */
export async function renderBoard({ shapes, bounds, items, pictureOf }: BoardRender): Promise<HTMLCanvasElement> {
  const scale = exportScale(bounds)
  const width = Math.max(1, Math.round(bounds.w * scale))
  const height = Math.max(1, Math.round(bounds.h * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot draw the board to an image.')

  /** Draw in board units from here on. */
  const inBoardUnits = (target: CanvasRenderingContext2D) => {
    target.setTransform(scale, 0, 0, scale, -bounds.x * scale, -bounds.y * scale)
    target.lineCap = 'round'
    target.lineJoin = 'round'
  }

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  inBoardUnits(ctx)

  // 1. Pictures.
  for (const shape of shapes) {
    if (shape.type !== 'image' || !boardImageSrc(shape)) continue
    const picture = pictureOf(shape)
    if (!picture || !picture.complete || !picture.naturalWidth) continue
    ctx.drawImage(picture, shape.x, shape.y, shape.width, shape.height)
  }

  // 2. Typed math and question cards.
  if (items && items.childElementCount > 0) {
    const fonts = await embeddedFonts(items)
    const copy = () =>
      toCanvas(items, {
        width: bounds.w,
        height: bounds.h,
        pixelRatio: scale,
        skipAutoScale: true,
        fontEmbedCSS: fonts,
        // The layer is a zero-size anchor at the board's origin. Give the copy
        // the size of the export and slide the content into it.
        style: {
          position: 'relative',
          left: '0',
          top: '0',
          margin: '0',
          transform: `translate(${-bounds.x}px, ${-bounds.y}px)`,
          transformOrigin: '0 0',
        },
        // KaTeX keeps a hidden MathML copy of every formula for screen readers.
        filter: (node) => !(node instanceof Element && node.classList.contains('katex-mathml')),
      })
    // WebKit (Safari, and every browser on an iPad) can paint an SVG image
    // before the fonts inside it have loaded, leaving the math in a fallback
    // font. A second pass has them. This is a known workaround for Safari,
    // added as a precaution: it has not been tried on a real one.
    const webkit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg/.test(navigator.userAgent)
    if (webkit) await copy()
    const layer = await copy()
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(layer, 0, 0, width, height)
    ctx.restore()
  }

  const drawStrokes = (target: CanvasRenderingContext2D, highlighter: boolean) => {
    let drawn = 0
    for (const shape of shapes) {
      if (shape.type !== 'stroke') continue
      const { pts, color, size, hl } = strokeProps(shape)
      if (!!hl !== highlighter || !Array.isArray(pts) || pts.length < 2) continue
      target.strokeStyle = typeof color === 'string' ? color : '#16161a'
      target.lineWidth = Math.max(0.5, Number(size) || 1)
      target.stroke(new Path2D(strokePath(pts, shape.x, shape.y)))
      drawn++
    }
    return drawn
  }

  // 3. Pen ink.
  drawStrokes(ctx, false)

  // 4. Highlighter: on its own layer, then multiplied on, so it tints what
  //    is under it instead of covering it.
  const highlightLayer = document.createElement('canvas')
  highlightLayer.width = width
  highlightLayer.height = height
  const highlightCtx = highlightLayer.getContext('2d')
  if (highlightCtx) {
    inBoardUnits(highlightCtx)
    highlightCtx.globalAlpha = HIGHLIGHTER_OPACITY
    if (drawStrokes(highlightCtx, true)) {
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalCompositeOperation = 'multiply'
      ctx.drawImage(highlightLayer, 0, 0)
      ctx.restore()
    }
  }

  return canvas
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/** The page size for a board of this size, in PDF points. */
export function pageSize(bounds: Rect): { width: number; height: number } {
  const fit = Math.min(1, MAX_PAGE_POINTS / (Math.max(bounds.w, bounds.h) * POINTS_PER_UNIT))
  const round = (value: number) => Math.round(value * 100) / 100
  return {
    width: round(bounds.w * POINTS_PER_UNIT * fit),
    height: round(bounds.h * POINTS_PER_UNIT * fit),
  }
}

/**
 * A one-page PDF showing one JPEG across the whole page.
 *
 * A PDF can hold JPEG data as it is (the DCTDecode filter), so this needs no
 * PDF library: five objects, a cross-reference table of their byte offsets,
 * and a trailer.
 */
export function buildPdf(
  jpeg: Uint8Array,
  pixels: { width: number; height: number },
  page: { width: number; height: number },
): Uint8Array {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  const offsets: number[] = []
  let length = 0
  const write = (data: string | Uint8Array) => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data
    chunks.push(bytes)
    length += bytes.length
  }
  const object = (body: string, stream?: Uint8Array) => {
    offsets.push(length)
    write(`${offsets.length} 0 obj\n${body}\n`)
    if (stream) {
      write('stream\n')
      write(stream)
      write('\nendstream\n')
    }
    write('endobj\n')
  }

  // The second line is four bytes above 127, which tells tools the file is binary.
  write('%PDF-1.4\n')
  write(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]))
  // Place the image: scale the unit square it is drawn in to the page.
  const content = encoder.encode(`q ${page.width} 0 0 ${page.height} 0 0 cm /Im0 Do Q`)

  object('<< /Type /Catalog /Pages 2 0 R >>')
  object('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  object(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] ` +
      '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
  )
  object(
    `<< /Type /XObject /Subtype /Image /Width ${pixels.width} /Height ${pixels.height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`,
    jpeg,
  )
  object(`<< /Length ${content.length} >>`, content)

  const xref = length
  write(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`)
  for (const offset of offsets) write(`${String(offset).padStart(10, '0')} 00000 n \n`)
  write(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)

  const pdf = new Uint8Array(length)
  let position = 0
  for (const chunk of chunks) {
    pdf.set(chunk, position)
    position += chunk.length
  }
  return pdf
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** "Algebra with Maya" on 26 November -> "algebra-with-maya-2026-11-26.png". */
export function exportFileName(title: string, format: ExportFormat, date = new Date()): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
    .slice(0, 60)
    .replace(/^-+|-+$/g, '')
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return `${slug || 'whiteboard'}-${day}.${format}`
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The image could not be encoded.'))),
      type,
      quality,
    )
  })
}

/** The finished file for a rendered board. */
export async function exportBlob(canvas: HTMLCanvasElement, bounds: Rect, format: ExportFormat): Promise<Blob> {
  if (format === 'png') return canvasBlob(canvas, 'image/png')
  const jpeg = new Uint8Array(await (await canvasBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer())
  const pdf = buildPdf(jpeg, { width: canvas.width, height: canvas.height }, pageSize(bounds))
  return new Blob([pdf.buffer as ArrayBuffer], { type: 'application/pdf' })
}

/** Hand a file to the browser to save. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  // The download has started by then; the address is only needed to start it.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
