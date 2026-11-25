import { describe, expect, it } from 'vitest'
import { segmentDistance, sweepTouchesStroke } from './hit'
import { penBind } from './penInput'
import type { Shape } from './types'

/** A stroke at (x, y) whose points are relative to that corner, as the board stores them. */
function stroke(x: number, y: number, pts: number[], size = 4): Shape {
  let width = 1
  let height = 1
  for (let i = 0; i < pts.length; i += 2) {
    width = Math.max(width, pts[i])
    height = Math.max(height, pts[i + 1])
  }
  return {
    id: 'stroke',
    type: 'stroke',
    x,
    y,
    width,
    height,
    props: { pts, color: '#16161a', size, hl: false },
  } as unknown as Shape
}

describe('penBind', () => {
  it('reads the eraser end from button 5 or buttons bit 32', () => {
    expect(penBind({ pointerType: 'pen', button: 5, buttons: 32 })).toBe('erase')
    // A move mid-gesture reports no changed button, only the held ones.
    expect(penBind({ pointerType: 'pen', button: -1, buttons: 32 })).toBe('erase')
  })

  it('reads the side button from button 2 or buttons bit 2', () => {
    expect(penBind({ pointerType: 'pen', button: 2, buttons: 2 })).toBe('select')
    expect(penBind({ pointerType: 'pen', button: -1, buttons: 2 })).toBe('select')
  })

  it('treats the tip as ordinary input', () => {
    expect(penBind({ pointerType: 'pen', button: 0, buttons: 1 })).toBeNull()
  })

  it('ignores the same buttons on a mouse or a finger', () => {
    expect(penBind({ pointerType: 'mouse', button: 2, buttons: 2 })).toBeNull()
    expect(penBind({ pointerType: 'mouse', button: 5, buttons: 32 })).toBeNull()
    expect(penBind({ pointerType: 'touch', button: 0, buttons: 1 })).toBeNull()
  })
})

describe('segmentDistance', () => {
  it('is 0 for segments that cross', () => {
    expect(segmentDistance({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBe(0)
  })

  it('measures the gap between parallel segments', () => {
    expect(segmentDistance({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 3 }, { x: 10, y: 3 })).toBe(3)
  })

  it('measures from the nearest endpoint when the segments do not overlap', () => {
    expect(segmentDistance({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 13, y: 4 }, { x: 20, y: 4 })).toBe(5)
  })

  it('handles a zero-length segment as a point', () => {
    expect(segmentDistance({ x: 5, y: 2 }, { x: 5, y: 2 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(2)
  })
})

describe('sweepTouchesStroke', () => {
  // A horizontal line from (100, 50) to (200, 50), 4 wide.
  const line = stroke(100, 50, [0, 0, 50, 0, 100, 0])

  it('hits when the sweep crosses the ink', () => {
    expect(sweepTouchesStroke(line, { x: 150, y: 20 }, { x: 150, y: 80 }, 10)).toBe(true)
  })

  it('hits a fast sweep whose samples land on either side of the ink', () => {
    // Neither sample is within reach of the line; the path between them is.
    expect(sweepTouchesStroke(line, { x: 120, y: -200 }, { x: 180, y: 300 }, 10)).toBe(true)
  })

  it('hits a single point within the eraser radius plus half the ink width', () => {
    expect(sweepTouchesStroke(line, { x: 150, y: 61 }, { x: 150, y: 61 }, 10)).toBe(true)
    expect(sweepTouchesStroke(line, { x: 150, y: 63 }, { x: 150, y: 63 }, 10)).toBe(false)
  })

  it('misses a sweep that passes beside the ink', () => {
    expect(sweepTouchesStroke(line, { x: 230, y: 20 }, { x: 230, y: 80 }, 10)).toBe(false)
  })

  it('misses ink inside the bounding box that the sweep does not reach', () => {
    // An L shape: the corner region of its box holds no ink.
    const corner = stroke(0, 0, [0, 0, 0, 100, 100, 100])
    expect(sweepTouchesStroke(corner, { x: 70, y: 20 }, { x: 80, y: 30 }, 10)).toBe(false)
  })

  it('hits a dot (a stroke with one point)', () => {
    const dot = stroke(40, 40, [0, 0])
    expect(sweepTouchesStroke(dot, { x: 30, y: 40 }, { x: 50, y: 40 }, 6)).toBe(true)
  })

  it('ignores a stroke with no points', () => {
    expect(sweepTouchesStroke(stroke(0, 0, []), { x: 0, y: 0 }, { x: 1, y: 1 }, 10)).toBe(false)
  })
})
