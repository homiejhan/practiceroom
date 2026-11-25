/**
 * What a stylus is asking for, read from the Pointer Events it sends.
 *
 * A pen reports its hardware controls through `button` and `buttons`
 * (https://www.w3.org/TR/pointerevents/#the-button-property):
 * - the eraser end (Surface pens, Wacom, S Pen): button 5, `buttons` bit 32
 * - the side (barrel) button: button 2, `buttons` bit 2
 *
 * Each one acts for a single gesture and leaves the selected tool alone, so
 * flipping the pen back over carries on with whatever was being used.
 */

export type PenBind = 'erase' | 'select'

const ERASER_BUTTON = 5
const ERASER_BIT = 32
const BARREL_BUTTON = 2
const BARREL_BIT = 2

export function penBind(event: {
  pointerType: string
  button: number
  buttons: number
}): PenBind | null {
  // Only a pen: on a mouse, button 2 is a right-click and stays one.
  if (event.pointerType !== 'pen') return null
  if (event.button === ERASER_BUTTON || (event.buttons & ERASER_BIT) !== 0) return 'erase'
  if (event.button === BARREL_BUTTON || (event.buttons & BARREL_BIT) !== 0) return 'select'
  return null
}
