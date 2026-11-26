import { describe, expect, it } from 'vitest'
import { WIDTHS, boardImageSrc, pinchView, readWidths, rectContains, type Shape, type View } from './types'

const image = (src: unknown): Shape =>
  ({ id: 'picture', type: 'image', x: 0, y: 0, width: 100, height: 80, props: { src } }) as unknown as Shape

describe('boardImageSrc', () => {
  it("accepts a file stored on this app's own origin", () => {
    const src = '/api/files/apps/app_01ABC/boards/abcdefghjkmn/0b5f7c1e-3f0a-4a7e-9a55-1c2d3e4f5a6b.png?scope=app'
    expect(boardImageSrc(image(src))).toBe(src)
  })

  it('refuses anything that would make a browser fetch from somewhere else', () => {
    // Shape props are written by anyone in the room, so these are all reachable.
    for (const src of [
      'https://tracker.example/pixel.png',
      '//tracker.example/pixel.png',
      '/api/files//tracker.example/pixel.png',
      '/api/files/../../somewhere/else.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      '/api/other/thing.png',
      '/api/files/a b.png',
      '',
      42,
      null,
      undefined,
    ]) {
      expect(boardImageSrc(image(src)), String(src)).toBeNull()
    }
    expect(boardImageSrc(image(`/api/files/${'a'.repeat(700)}.png`))).toBeNull()
  })
})

describe('pinchView', () => {
  const start: View = { x: -96, y: -72, zoom: 1 }
  /** The board point under a screen point (relative to the board) in a view. */
  const under = (view: View, point: { x: number; y: number }) => ({
    x: point.x / view.zoom + view.x,
    y: point.y / view.zoom + view.y,
  })

  it('zooms by how far the fingers spread, keeping the point between them still', () => {
    const mid = { x: 400, y: 300 }
    const view = pinchView(start, mid, 100, mid, 200, 0.25, 4)
    expect(view.zoom).toBe(2)
    expect(under(view, mid).x).toBeCloseTo(under(start, mid).x)
    expect(under(view, mid).y).toBeCloseTo(under(start, mid).y)
  })

  it('pans when both fingers slide without spreading', () => {
    const view = pinchView(start, { x: 400, y: 300 }, 100, { x: 460, y: 250 }, 100, 0.25, 4)
    expect(view.zoom).toBe(1)
    // The board moved with the fingers: 60 right, 50 up.
    expect(view.x).toBeCloseTo(start.x - 60)
    expect(view.y).toBeCloseTo(start.y + 50)
  })

  it('does both at once: the starting midpoint ends up under the fingers', () => {
    const startMid = { x: 300, y: 300 }
    const mid = { x: 380, y: 260 }
    const view = pinchView({ x: 10, y: 20, zoom: 1.5 }, startMid, 120, mid, 60, 0.25, 4)
    expect(view.zoom).toBe(0.75)
    const anchor = under({ x: 10, y: 20, zoom: 1.5 }, startMid)
    expect(under(view, mid).x).toBeCloseTo(anchor.x)
    expect(under(view, mid).y).toBeCloseTo(anchor.y)
  })

  it('stops at the zoom limits and survives fingers that start on the same spot', () => {
    const mid = { x: 100, y: 100 }
    expect(pinchView(start, mid, 100, mid, 5000, 0.25, 4).zoom).toBe(4)
    expect(pinchView(start, mid, 100, mid, 1, 0.25, 4).zoom).toBe(0.25)
    expect(Number.isFinite(pinchView(start, mid, 0, mid, 80, 0.25, 4).zoom)).toBe(true)
  })
})

describe('readWidths', () => {
  it('starts from the defaults', () => {
    const defaults = { pen: WIDTHS.pen.initial, highlighter: WIDTHS.highlighter.initial, eraser: WIDTHS.eraser.initial }
    expect(readWidths(null)).toEqual(defaults)
    expect(readWidths('nonsense')).toEqual(defaults)
    expect(readWidths({ pen: 'wide', highlighter: NaN })).toEqual(defaults)
  })

  it('keeps saved widths and pulls out-of-range ones back inside the limits', () => {
    expect(readWidths({ pen: 9.5, highlighter: 30, eraser: 44 })).toEqual({ pen: 9.5, highlighter: 30, eraser: 44 })
    expect(readWidths({ pen: 500, highlighter: -3, eraser: 1e9 })).toEqual({
      pen: WIDTHS.pen.max,
      highlighter: WIDTHS.highlighter.min,
      eraser: WIDTHS.eraser.max,
    })
  })
})

describe('rectContains', () => {
  const outer = { x: 0, y: 0, w: 100, h: 100 }
  it('is true only when the whole inner rectangle is inside', () => {
    expect(rectContains(outer, { x: 10, y: 10, w: 50, h: 50 })).toBe(true)
    expect(rectContains(outer, { x: 0, y: 0, w: 100, h: 100 })).toBe(true)
    expect(rectContains(outer, { x: 60, y: 10, w: 50, h: 50 })).toBe(false)
    expect(rectContains(outer, { x: -1, y: 10, w: 50, h: 50 })).toBe(false)
  })
})
