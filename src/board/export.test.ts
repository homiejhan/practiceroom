import { describe, expect, it } from 'vitest'
import { buildPdf, contentBounds, exportFileName, exportScale, pageSize } from './exportBoard'
import type { Rect, Shape } from './types'

const shape = (type: string, x: number, y: number, width: number, height: number, props = {}): Shape =>
  ({ id: `${type}-${x}-${y}`, type, x, y, width, height, props }) as unknown as Shape
const stored = (s: Shape): Rect => ({ x: s.x, y: s.y, w: s.width, h: s.height })

describe('contentBounds', () => {
  it('is null for an empty board', () => {
    expect(contentBounds([], stored)).toBeNull()
  })

  it('holds everything, with a margin, wherever it is on the board', () => {
    const bounds = contentBounds(
      [shape('stroke', -200, -50, 100, 40, { size: 0 }), shape('math', 300, 400, 80, 30)],
      stored,
    )
    expect(bounds).toEqual({ x: -232, y: -82, w: 644, h: 544 })
  })

  it("reaches to the edge of a stroke's ink, not just its centre line", () => {
    const thin = contentBounds([shape('stroke', 0, 0, 100, 0, { size: 0 })], stored)!
    const wide = contentBounds([shape('stroke', 0, 0, 100, 0, { size: 40 })], stored)!
    expect(wide.w - thin.w).toBe(40)
    expect(wide.y).toBe(thin.y - 20)
  })

  it('uses the measured size of cards, and ignores pictures that would not be shown', () => {
    const card = shape('question', 0, 0, 380, 140)
    const measured = contentBounds([card], () => ({ x: 0, y: 0, w: 380, h: 600 }))!
    expect(measured.h).toBe(600 + 64)
    const foreign = shape('image', 5000, 5000, 100, 100, { src: 'https://elsewhere.example/a.png' })
    expect(contentBounds([card, foreign], stored)!.w).toBe(380 + 64)
  })
})

describe('exportScale', () => {
  it('is twice the on-screen size for an ordinary board', () => {
    expect(exportScale({ x: 0, y: 0, w: 1200, h: 800 })).toBe(2)
  })

  it('comes down for a very large board, to stay inside the canvas limit', () => {
    const bounds = { x: 0, y: 0, w: 9000, h: 6000 }
    const scale = exportScale(bounds)
    expect(scale).toBeLessThan(1)
    expect(bounds.w * scale * bounds.h * scale).toBeLessThanOrEqual(12_000_000 + 1)
  })
})

describe('pageSize', () => {
  it('is the board at 96 units to the inch', () => {
    // 960 x 480 board units are 10 x 5 inches: 720 x 360 points.
    expect(pageSize({ x: 0, y: 0, w: 960, h: 480 })).toEqual({ width: 720, height: 360 })
  })

  it('never exceeds the largest page a PDF allows, and keeps the shape', () => {
    const page = pageSize({ x: 0, y: 0, w: 40_000, h: 10_000 })
    expect(page.width).toBe(14_400)
    expect(page.height).toBe(3600)
  })
})

describe('buildPdf', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 0xff, 0xd9])
  const pdf = buildPdf(jpeg, { width: 1920, height: 960 }, { width: 720, height: 360 })
  // Latin-1 keeps one character per byte, so string positions are byte offsets.
  const text = new TextDecoder('latin1').decode(pdf)

  it('is a one-page PDF the size asked for, showing the image across the page', () => {
    expect(text.startsWith('%PDF-1.4\n')).toBe(true)
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
    expect(text).toContain('/Type /Pages /Kids [3 0 R] /Count 1')
    expect(text).toContain('/MediaBox [0 0 720 360]')
    expect(text).toContain('q 720 0 0 360 0 0 cm /Im0 Do Q')
  })

  it('carries the JPEG bytes untouched, with its size declared', () => {
    expect(text).toContain('/Subtype /Image /Width 1920 /Height 960')
    expect(text).toContain(`/Filter /DCTDecode /Length ${jpeg.length} >>`)
    const start = text.indexOf('stream\n', text.indexOf('/DCTDecode')) + 'stream\n'.length
    expect([...pdf.slice(start, start + jpeg.length)]).toEqual([...jpeg])
    expect(text.slice(start + jpeg.length, start + jpeg.length + 10)).toBe('\nendstream')
  })

  it('has a cross-reference table whose offsets point at the objects', () => {
    const xrefAt = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1])
    expect(text.slice(xrefAt, xrefAt + 9)).toBe('xref\n0 6\n')
    const entries = text
      .slice(xrefAt)
      .split('\n')
      .filter((line) => /^\d{10} \d{5} n $/.test(line))
    expect(entries).toHaveLength(5)
    entries.forEach((entry, index) => {
      const offset = Number(entry.slice(0, 10))
      expect(text.slice(offset, offset + 8)).toBe(`${index + 1} 0 obj\n`)
    })
    expect(text).toContain('trailer\n<< /Size 6 /Root 1 0 R >>')
  })
})

describe('exportFileName', () => {
  const day = new Date(2026, 10, 26)
  it('is the room title and the date', () => {
    expect(exportFileName('Algebra with Maya', 'png', day)).toBe('algebra-with-maya-2026-11-26.png')
    expect(exportFileName('  Fractions / "review" #2  ', 'pdf', day)).toBe('fractions-review-2-2026-11-26.pdf')
  })

  it('falls back when the title has nothing usable in it', () => {
    expect(exportFileName('???', 'png', day)).toBe('whiteboard-2026-11-26.png')
    expect(exportFileName('../../etc/passwd', 'pdf', day)).toBe('etcpasswd-2026-11-26.pdf')
  })
})
