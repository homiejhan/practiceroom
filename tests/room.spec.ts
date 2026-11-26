/**
 * Practice Room end-to-end: a signed-in tutor and a name-only student in two
 * separate browser contexts, against the real workers.
 *
 * The first test covers everything that costs nothing: joining by name, ink,
 * typed math, cursors, chat, and the server-side boundaries around guests.
 * The second makes real Claude calls (question generation and grading), so it
 * runs only when RUN_AI_TESTS=1:
 *
 *   RUN_AI_TESTS=1 npx deepspace test run tests/room.spec.ts --port 5180
 *
 * Set SHOT_DIR to a folder to save screenshots of each stage.
 */

import path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'

const usableTestAccounts = loadAllTestAccounts().length
test.skip(
  usableTestAccounts < 1,
  'Needs 1 usable test account for the tutor. Create one with ' +
    '`npx deepspace test accounts create --email <name>@deepspace.test --name "<name>" --password-stdin`.',
)

const SHOT_DIR = process.env.SHOT_DIR

async function shot(page: Page, name: string): Promise<void> {
  if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
}

/** The tutor opens /rooms and creates a room; returns its path (/r/<id>). */
async function createRoom(page: Page, title: string): Promise<string> {
  await page.goto('/rooms')
  await page.getByLabel('New room').fill(title)
  await page.getByRole('button', { name: 'Create room' }).click()
  await page.waitForURL(/\/r\/[a-z0-9]+$/, { timeout: 20_000 })
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 20_000 })
  return new URL(page.url()).pathname
}

/** A student opens the link with no account and joins by name. */
async function joinAsStudent(page: Page, roomPath: string, name: string): Promise<void> {
  await page.goto(roomPath)
  await page.getByLabel('Your name').fill(name)
  await page.getByRole('button', { name: 'Join the room' }).click()
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 20_000 })
  // Wait until the canvas socket has granted write access.
  await expect(page.getByText('Connecting to the board')).toBeHidden({ timeout: 20_000 })
  await expect(page.getByText('View only')).toBeHidden()
}

async function boardBox(page: Page) {
  const box = await page.getByTestId('board').boundingBox()
  if (!box) throw new Error('board is not laid out')
  return box
}

async function drawLine(page: Page, fromX: number, fromY: number, toX: number, toY: number) {
  await page.mouse.move(fromX, fromY)
  await page.mouse.down()
  await page.mouse.move((fromX + toX) / 2, (fromY + toY) / 2 + 12, { steps: 6 })
  await page.mouse.move(toX, toY, { steps: 6 })
  await page.mouse.up()
}

const inkPaths = (page: Page) => page.locator('.board-world svg path[stroke-linejoin="round"]')

test('a student joins by name and the board, cursors and chat sync both ways', async ({
  users,
  browser,
}) => {
  test.setTimeout(90_000)
  const [tutor] = await users(1)
  const roomPath = await createRoom(tutor.page, 'Algebra practice')

  // The tutor gets the tutor tools; the join link is the room URL.
  await expect(tutor.page.getByRole('tab', { name: 'Questions' })).toBeVisible()
  await expect(tutor.page.getByRole('button', { name: 'Check a region with Claude' })).toBeVisible()

  const studentContext = await browser.newContext()
  const student = await studentContext.newPage()
  await joinAsStudent(student, roomPath, 'Maya')

  // A student sees no tutor tools and no check tool.
  await expect(student.getByRole('tab', { name: 'Questions' })).toHaveCount(0)
  await expect(student.getByRole('button', { name: 'Check a region with Claude' })).toHaveCount(0)

  // Ink: the student draws, the tutor sees it; then the other way round.
  const studentBox = await boardBox(student)
  await drawLine(student, studentBox.x + 300, studentBox.y + 200, studentBox.x + 460, studentBox.y + 260)
  await expect(inkPaths(tutor.page)).toHaveCount(1, { timeout: 10_000 })

  const tutorBox = await boardBox(tutor.page)
  await drawLine(tutor.page, tutorBox.x + 240, tutorBox.y + 380, tutorBox.x + 420, tutorBox.y + 400)
  await expect(inkPaths(student)).toHaveCount(2, { timeout: 10_000 })

  // Highlighter ink lands on its own blended layer for the other side too.
  await student.keyboard.press('5')
  await drawLine(student, studentBox.x + 300, studentBox.y + 230, studentBox.x + 460, studentBox.y + 230)
  await expect(tutor.page.locator('.board-world svg[style*="multiply"] path[stroke-linejoin="round"]')).toHaveCount(1, {
    timeout: 10_000,
  })

  // Select, delete and undo: the tutor removes the student's first stroke,
  // both boards drop it, and undo brings it back for both.
  await tutor.page.keyboard.press('2')
  await tutor.page.mouse.click(tutorBox.x + 300, tutorBox.y + 200)
  await expect(tutor.page.getByText('1 selected')).toBeVisible()
  await tutor.page.keyboard.press('Delete')
  await expect(inkPaths(student)).toHaveCount(2, { timeout: 10_000 })
  await tutor.page.keyboard.press('ControlOrMeta+z')
  await expect(inkPaths(student)).toHaveCount(3, { timeout: 10_000 })
  await expect(inkPaths(tutor.page)).toHaveCount(3)

  // Moving a stroke: the tutor drags it and the student's copy follows.
  const allPaths = (page: Page) =>
    inkPaths(page).evaluateAll((paths) => paths.map((p) => p.getAttribute('d')).sort().join('|'))
  const before = await allPaths(student)
  await tutor.page.mouse.move(tutorBox.x + 300, tutorBox.y + 200)
  await tutor.page.mouse.down()
  await tutor.page.mouse.move(tutorBox.x + 340, tutorBox.y + 150, { steps: 5 })
  await tutor.page.mouse.up()
  await expect.poll(() => allPaths(student), { timeout: 10_000 }).not.toBe(before)
  // The tutor's own copy moved too (the server does not echo a move to its sender).
  expect(await allPaths(tutor.page)).toBe(await allPaths(student))
  await tutor.page.keyboard.press('4')

  // Cursors: each side sees the other's name, taken from the verified identity.
  await student.mouse.move(studentBox.x + 380, studentBox.y + 320)
  await expect(tutor.page.locator('.board-cursor-label')).toContainText('Maya', { timeout: 10_000 })
  await tutor.page.mouse.move(tutorBox.x + 300, tutorBox.y + 300)
  await expect(student.locator('.board-cursor-label')).toContainText('(tutor)', { timeout: 10_000 })

  // Typed math: the Type tool turns "1/2" into a fraction, like Desmos.
  await student.keyboard.press('3')
  await student.mouse.click(studentBox.x + 320, studentBox.y + 440)
  await expect(student.locator('math-field')).toBeFocused()
  await student.keyboard.type('x=1/2')
  await student.keyboard.press('Enter')
  await expect(student.locator('.board-math')).toHaveCount(1)
  await expect(tutor.page.locator('.board-math .katex')).toHaveCount(1, { timeout: 10_000 })
  await expect(tutor.page.locator('.board-math .mfrac')).toHaveCount(1)

  // Chat: the student writes, the tutor's toggle shows it as unread, then it reads.
  await student.getByTestId('chat-toggle').click()
  await student.getByLabel('Message the room').fill('I got x = 1/2')
  await student.getByLabel('Message the room').press('Enter')
  await expect(student.getByText('I got x = 1/2')).toBeVisible({ timeout: 10_000 })
  await expect(tutor.page.getByTestId('chat-toggle')).toContainText('1', { timeout: 10_000 })
  await tutor.page.getByTestId('chat-toggle').click()
  await expect(tutor.page.getByText('I got x = 1/2')).toBeVisible()
  await expect(tutor.page.getByText('Maya', { exact: true })).toBeVisible()

  await shot(tutor.page, 'tutor-board')
  await shot(student, 'student-board')

  // --- Server-side boundaries ----------------------------------------------

  // A visitor with no guest pass cannot post to the room chat.
  const strangerContext = await browser.newContext()
  const stranger = await strangerContext.newPage()
  await stranger.goto('/')
  const roomId = roomPath.split('/').pop()
  const strangerPost = await stranger.request.post(`/api/rooms/${roomId}/messages`, {
    data: { body: 'let me in' },
  })
  expect(strangerPost.status()).toBe(401)

  // The student's pass is for this room only, and tutor actions need a real sign-in.
  const otherRoomPost = await student.request.post('/api/rooms/zzzzzzzzzzzz/messages', {
    data: { body: 'wrong room' },
  })
  expect(otherRoomPost.status()).toBe(404)
  const studentGenerate = await student.request.post('/api/actions/generateQuestion', {
    data: { roomId, mode: 'prompt', prompt: 'anything' },
  })
  expect(studentGenerate.status()).toBe(401)

  // A cookie the browser edits is rejected: the signature no longer matches.
  const cookies = await studentContext.cookies()
  const pass = cookies.find((cookie) => cookie.name === `pr_guest_${roomId}`)
  expect(pass?.httpOnly).toBe(true)
  await strangerContext.addCookies([
    { name: pass!.name, value: `${pass!.value.slice(0, -4)}0000`, url: new URL(student.url()).origin },
  ])
  const forgedPost = await stranger.request.post(`/api/rooms/${roomId}/messages`, {
    data: { body: 'forged' },
  })
  expect(forgedPost.status()).toBe(401)

  await studentContext.close()
  await strangerContext.close()
})

/**
 * Send the Pointer Events a stylus would. A pen reports its hardware controls
 * in `button`/`buttons`: 5/32 for the eraser end, 2/2 for the side button.
 * Each event gets its own frame, as it would from real hardware.
 */
async function penGesture(
  page: Page,
  control: 'tip' | 'eraser' | 'side',
  points: Array<[number, number]>,
  { release = true }: { release?: boolean } = {},
): Promise<void> {
  await page.getByTestId('board').evaluate(
    async (board, { control, points, release }) => {
      const [button, buttons] = control === 'eraser' ? [5, 32] : control === 'side' ? [2, 2] : [0, 1]
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
      const fire = (type: string, point: [number, number]) =>
        board.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 41,
            pointerType: 'pen',
            isPrimary: true,
            clientX: point[0],
            clientY: point[1],
            button: type === 'pointermove' ? -1 : button,
            buttons: type === 'pointerup' ? 0 : buttons,
            pressure: type === 'pointerup' ? 0 : 0.5,
          }),
        )
      fire('pointerdown', points[0])
      for (const point of points.slice(1)) {
        await frame()
        fire('pointermove', point)
      }
      await frame()
      if (release) fire('pointerup', points[points.length - 1])
    },
    { control, points, release },
  )
}

test("a pen's eraser end erases and its side button selects, under any tool", async ({
  users,
  browser,
}) => {
  test.setTimeout(90_000)
  const [tutor] = await users(1)
  const roomPath = await createRoom(tutor.page, 'Pen hardware')
  const studentContext = await browser.newContext()
  const student = await studentContext.newPage()
  await joinAsStudent(student, roomPath, 'Maya')

  const box = await boardBox(tutor.page)
  const at = (x: number, y: number): [number, number] => [box.x + x, box.y + y]
  const penTool = tutor.page.locator('[data-tool="pen"]')
  const selectedInk = tutor.page.locator('.board-stroke-selected')
  const allPaths = (page: Page) =>
    inkPaths(page).evaluateAll((paths) => paths.map((p) => p.getAttribute('d')).sort().join('|'))

  // Two strokes with the pen tool, which stays selected throughout.
  await drawLine(tutor.page, ...at(240, 200), ...at(420, 200))
  await drawLine(tutor.page, ...at(240, 340), ...at(420, 340))
  await expect(inkPaths(student)).toHaveCount(2, { timeout: 10_000 })
  await expect(penTool).toHaveAttribute('aria-pressed', 'true')

  // The eraser end swept across the first stroke removes it for everyone,
  // and draws nothing even though the pen tool is the one selected.
  await penGesture(tutor.page, 'eraser', [at(330, 150), at(330, 200), at(330, 260)])
  await expect(inkPaths(tutor.page)).toHaveCount(1)
  await expect(inkPaths(student)).toHaveCount(1, { timeout: 10_000 })
  await expect(tutor.page.locator('.board-eraser')).toBeHidden()
  await expect(penTool).toHaveAttribute('aria-pressed', 'true')

  // A sweep over empty board erases nothing. While the eraser is down, its
  // outline sits under it; lifting it hides the outline.
  await penGesture(tutor.page, 'eraser', [at(600, 100), at(640, 140)], { release: false })
  const ring = await tutor.page.locator('.board-eraser').boundingBox()
  expect(Math.abs(ring!.x + ring!.width / 2 - (box.x + 640))).toBeLessThan(2)
  expect(Math.abs(ring!.y + ring!.height / 2 - (box.y + 140))).toBeLessThan(2)
  await shot(tutor.page, 'pen-eraser-down')
  await penGesture(tutor.page, 'eraser', [at(640, 140)])
  await expect(tutor.page.locator('.board-eraser')).toBeHidden()
  await expect(inkPaths(tutor.page)).toHaveCount(1)

  // Erasing is an ordinary delete, so undo brings the ink back on both boards.
  await tutor.page.keyboard.press('ControlOrMeta+z')
  await expect(inkPaths(tutor.page)).toHaveCount(2, { timeout: 10_000 })
  await expect(inkPaths(student)).toHaveCount(2, { timeout: 10_000 })

  // The side button taps to select without leaving the pen tool...
  await penGesture(tutor.page, 'side', [at(330, 352)])
  await expect(selectedInk).toHaveCount(1)
  await expect(penTool).toHaveAttribute('aria-pressed', 'true')

  // ...and drags to move what it selected; the student's copy follows.
  const before = await allPaths(student)
  await penGesture(tutor.page, 'side', [at(330, 352), at(350, 372), at(380, 400)])
  await expect.poll(() => allPaths(student), { timeout: 10_000 }).not.toBe(before)
  expect(await allPaths(tutor.page)).toBe(await allPaths(student))
  await expect(inkPaths(student)).toHaveCount(2)

  // Back on the tip, the pen draws again and the selection is gone.
  await penGesture(tutor.page, 'tip', [at(520, 220), at(560, 240), at(600, 220)])
  await expect(inkPaths(student)).toHaveCount(3, { timeout: 10_000 })
  await expect(selectedInk).toHaveCount(0)

  // A student's pen has the same controls.
  const studentBox = await boardBox(student)
  await penGesture(student, 'eraser', [
    [studentBox.x + 560, studentBox.y + 180],
    [studentBox.x + 560, studentBox.y + 280],
  ])
  await expect(inkPaths(tutor.page)).toHaveCount(2, { timeout: 10_000 })

  await studentContext.close()
})

/**
 * Two fingers on a touch screen, as the Pointer Events a tablet sends: each
 * finger is its own pointer, and only the first one is "primary".
 */
async function twoFingers(
  page: Page,
  from: [[number, number], [number, number]],
  to: [[number, number], [number, number]],
): Promise<void> {
  await page.getByTestId('board').evaluate(
    async (board, { from, to }) => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
      const fire = (type: string, finger: number, point: number[]) =>
        board.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 71 + finger,
            pointerType: 'touch',
            isPrimary: finger === 0,
            clientX: point[0],
            clientY: point[1],
            button: type === 'pointermove' ? -1 : 0,
            buttons: type === 'pointerup' ? 0 : 1,
          }),
        )
      fire('pointerdown', 0, from[0])
      await frame()
      fire('pointerdown', 1, from[1])
      const steps = 8
      for (let i = 1; i <= steps; i++) {
        await frame()
        for (const finger of [0, 1]) {
          fire('pointermove', finger, [
            from[finger][0] + ((to[finger][0] - from[finger][0]) * i) / steps,
            from[finger][1] + ((to[finger][1] - from[finger][1]) * i) / steps,
          ])
        }
      }
      await frame()
      fire('pointerup', 0, to[0])
      fire('pointerup', 1, to[1])
    },
    { from, to },
  )
}

/**
 * Real touches, sent through the browser's own input pipeline (Chromium's
 * DevTools protocol) instead of scripted events. This is what exercises
 * `touch-action`, pointer capture and which finger the browser calls primary.
 * Each step is the full list of fingers on the screen at that moment.
 */
async function realTouches(page: Page, steps: Array<Array<[number, number]>>): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  let down = 0
  for (const fingers of steps) {
    const touchPoints = fingers.map(([x, y], id) => ({ x, y, id }))
    const type = fingers.length === 0 ? 'touchEnd' : fingers.length > down ? 'touchStart' : 'touchMove'
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints })
    down = fingers.length
    await page.waitForTimeout(16)
  }
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await cdp.detach()
}

test('the eraser tool, adjustable widths and two-finger zoom', async ({ users, browser }) => {
  test.setTimeout(90_000)
  const [tutor] = await users(1)
  const roomPath = await createRoom(tutor.page, 'Eraser and pinch')
  const studentContext = await browser.newContext()
  const student = await studentContext.newPage()
  await joinAsStudent(student, roomPath, 'Maya')

  const page = tutor.page
  const box = await boardBox(page)
  const at = (x: number, y: number): [number, number] => [box.x + x, box.y + y]
  const widthOf = (name: string) => page.getByRole('slider', { name })
  const strokeWidths = (target: Page) =>
    inkPaths(target).evaluateAll((paths) => paths.map((path) => path.getAttribute('stroke-width')))

  // Pen width: the keyboard takes it to the widest, a click on the track sets
  // it by position, and the next stroke is drawn that wide for everyone.
  await widthOf('Pen width').focus()
  await page.keyboard.press('End')
  await expect(widthOf('Pen width')).toHaveAttribute('aria-valuenow', '16')
  await widthOf('Pen width').click({ position: { x: 13, y: 46 } })
  await expect(widthOf('Pen width')).toHaveAttribute('aria-valuenow', '8.5')
  await drawLine(page, ...at(420, 200), ...at(640, 200))
  await expect.poll(() => strokeWidths(student), { timeout: 10_000 }).toEqual(['8.5'])

  // The highlighter has its own width.
  await page.keyboard.press('5')
  await widthOf('Highlighter width').focus()
  await page.keyboard.press('Home')
  await drawLine(page, ...at(420, 320), ...at(640, 320))
  await expect.poll(() => strokeWidths(student), { timeout: 10_000 }).toEqual(['8.5', '8'])
  await shot(page, 'highlighter-width')

  // The widths are remembered on this device.
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('practiceroom:widths') ?? '{}'))).toMatchObject({
    pen: 8.5,
    highlighter: 8,
  })

  // The eraser is a tool of its own. Its outline follows the mouse at the
  // width it is set to, and dragging it over ink removes that ink for everyone.
  await page.getByRole('button', { name: 'Eraser' }).click()
  await expect(page.locator('[data-tool="eraser"]')).toHaveAttribute('aria-pressed', 'true')
  await widthOf('Eraser width').focus()
  await page.keyboard.press('End')
  await page.mouse.move(...at(530, 120))
  const outline = await page.locator('.board-eraser').boundingBox()
  expect(Math.round(outline!.width)).toBe(80)
  expect(Math.abs(outline!.x + outline!.width / 2 - (box.x + 530))).toBeLessThan(2)
  await shot(page, 'eraser-tool')

  await page.mouse.down()
  await page.mouse.move(...at(530, 240), { steps: 6 })
  await page.mouse.up()
  await expect(inkPaths(page)).toHaveCount(1)
  await expect.poll(() => strokeWidths(student), { timeout: 10_000 }).toEqual(['8'])
  // Still the eraser afterwards, and undo brings the stroke back.
  await expect(page.locator('[data-tool="eraser"]')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(inkPaths(student)).toHaveCount(2, { timeout: 10_000 })

  // The eraser took 6, so the tutor's check tool is now 7.
  await page.keyboard.press('7')
  await expect(page.locator('[data-tool="region"]')).toHaveAttribute('aria-pressed', 'true')

  // Two fingers spreading zoom in around the point between them, whatever
  // tool is selected, and leave no ink behind. Here the pen is selected.
  await page.keyboard.press('4')
  const zoom = page.locator('.board-zoom-value')
  await expect(zoom).toHaveText('100%')
  const strokeBox = () => inkPaths(page).first().boundingBox()
  const before = (await strokeBox())!
  const center: [number, number] = [before.x + before.width / 2, before.y + before.height / 2]
  await twoFingers(
    page,
    [
      [center[0] - 50, center[1]],
      [center[0] + 50, center[1]],
    ],
    [
      [center[0] - 100, center[1]],
      [center[0] + 100, center[1]],
    ],
  )
  await expect(zoom).toHaveText('200%')
  const after = (await strokeBox())!
  expect(after.width / before.width).toBeCloseTo(2, 1)
  expect(Math.abs(after.x + after.width / 2 - center[0])).toBeLessThan(3)
  expect(Math.abs(after.y + after.height / 2 - center[1])).toBeLessThan(3)
  await expect(inkPaths(page)).toHaveCount(2)

  // Sliding both fingers together pans; pinching them in zooms back out.
  await twoFingers(
    page,
    [
      [center[0] - 100, center[1]],
      [center[0] + 100, center[1]],
    ],
    [
      [center[0] - 50, center[1] + 60],
      [center[0] + 50, center[1] + 60],
    ],
  )
  await expect(zoom).toHaveText('100%')
  const moved = (await strokeBox())!
  expect(Math.abs(moved.y + moved.height / 2 - (center[1] + 60))).toBeLessThan(3)
  await expect(inkPaths(page)).toHaveCount(2)

  // The same with real touches. The first finger lands alone, as it does on
  // a tablet, and would start a pen stroke; the second turns it into a pinch.
  const spot = at(700, 420)
  const spread = (gap: number): Array<[number, number]> => [
    [spot[0] - gap, spot[1]],
    [spot[0] + gap, spot[1]],
  ]
  await realTouches(page, [
    [[spot[0] - 40, spot[1]]],
    spread(40),
    spread(50),
    spread(60),
    spread(70),
    spread(80),
    [],
  ])
  await expect(zoom).toHaveText('200%')
  await expect(inkPaths(page)).toHaveCount(2)

  // One finger still draws with the pen, as before.
  await realTouches(page, [[[spot[0], spot[1]]], [[spot[0] + 40, spot[1] + 10]], [[spot[0] + 90, spot[1]]], []])
  await expect(inkPaths(page)).toHaveCount(3)
  await expect(inkPaths(student)).toHaveCount(3, { timeout: 10_000 })

  await studentContext.close()
})

test('a picture on the board: upload, paste, share, resize and grade', async ({ users, browser }) => {
  test.setTimeout(120_000)
  const [tutor] = await users(1)
  const roomPath = await createRoom(tutor.page, 'Homework photo')
  const roomId = roomPath.split('/').pop()
  const studentContext = await browser.newContext()
  const student = await studentContext.newPage()
  await joinAsStudent(student, roomPath, 'Maya')
  const page = tutor.page

  // A stand-in for a screenshot of a homework problem: 600 x 400, white, with
  // the problem as text and a dark bar under it.
  const pngBase64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 600
    canvas.height = 400
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 600, 400)
    ctx.fillStyle = '#1b1c1f'
    ctx.font = '600 40px Helvetica, Arial, sans-serif'
    ctx.fillText('Solve for x:', 40, 80)
    ctx.fillText('3x + 5 = 20', 40, 150)
    ctx.fillRect(40, 190, 520, 24)
    return canvas.toDataURL('image/png').split(',')[1]
  })

  // Only the tutor can add one, in the interface and on the server.
  await expect(student.getByRole('button', { name: 'Add a picture' })).toHaveCount(0)
  const refused = await student.request.post('/api/actions/addBoardImage', {
    data: { roomId, image: `data:image/png;base64,${pngBase64}` },
  })
  expect(refused.status()).toBe(401)

  await page.getByTestId('image-input').setInputFiles({
    name: 'homework.png',
    mimeType: 'image/png',
    buffer: Buffer.from(pngBase64, 'base64'),
  })
  const tutorPicture = page.locator('.board-image img')
  const studentPicture = student.locator('.board-image img')
  await expect(tutorPicture).toHaveCount(1, { timeout: 30_000 })
  await expect(studentPicture).toHaveCount(1, { timeout: 15_000 })

  // It is stored with this app and loads for the student, who has no account.
  expect(await studentPicture.getAttribute('src')).toMatch(/^\/api\/files\/[^?]+\.png(\?|$)/)
  await expect
    .poll(() => studentPicture.evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0)), {
      timeout: 15_000,
    })
    .toBe(600)

  // It arrives selected, with a corner to resize it by; the shape is kept.
  await expect(page.locator('[data-tool="select"]')).toHaveAttribute('aria-pressed', 'true')
  const handle = (await page.locator('.board-resize').boundingBox())!
  const sizeBefore = (await studentPicture.boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2 + 60, handle.y + handle.height / 2 + 10, { steps: 5 })
  await page.mouse.up()
  await expect
    .poll(async () => Math.round((await studentPicture.boundingBox())!.width), { timeout: 10_000 })
    .toBe(Math.round(sizeBefore.width + 60))
  const sizeAfter = (await studentPicture.boundingBox())!
  expect(sizeAfter.width / sizeAfter.height).toBeCloseTo(600 / 400, 1)
  expect(Math.round((await tutorPicture.boundingBox())!.width)).toBe(Math.round(sizeAfter.width))

  // Ink goes on top of it, and the student can write on it too.
  const picture = (await tutorPicture.boundingBox())!
  await page.keyboard.press('4')
  await drawLine(page, picture.x + 60, picture.y + 200, picture.x + 260, picture.y + 200)
  await expect(inkPaths(student)).toHaveCount(1, { timeout: 10_000 })
  const studentSide = (await studentPicture.boundingBox())!
  await drawLine(student, studentSide.x + 60, studentSide.y + 260, studentSide.x + 260, studentSide.y + 260)
  await expect(inkPaths(page)).toHaveCount(2, { timeout: 10_000 })
  await shot(page, 'pictures-annotated')

  // For the student the picture is background: dragging across it selects
  // their ink and leaves the picture where it is.
  await student.keyboard.press('2')
  await student.mouse.move(studentSide.x + 30, studentSide.y + 230)
  await student.mouse.down()
  await student.mouse.move(studentSide.x + 300, studentSide.y + 290, { steps: 5 })
  await student.mouse.up()
  await expect(student.getByText('1 selected')).toBeVisible()
  expect(Math.round((await studentPicture.boundingBox())!.x)).toBe(Math.round(studentSide.x))

  // The tutor's box picks the picture up only when it holds all of it, so
  // selecting ink that overlaps it leaves the picture out.
  await page.keyboard.press('2')
  await page.mouse.move(picture.x - 30, picture.y + 170)
  await page.mouse.down()
  await page.mouse.move(picture.x + 300, picture.y + 230, { steps: 5 })
  await page.mouse.up()
  await expect(page.getByText('1 selected')).toBeVisible()

  // Checking a region sends the picture too, under the ink, as a JPEG.
  let sent: { image?: string; imageCount?: number; strokeCount?: number } = {}
  await page.route('**/api/actions/checkRegion', async (route) => {
    sent = route.request().postDataJSON()
    await route.fulfill({ json: { success: true, data: { messageId: 'not-sent-to-claude' } } })
  })
  await page.getByRole('button', { name: 'Check a region with Claude' }).click()
  await page.mouse.move(picture.x - 12, picture.y - 12)
  await page.mouse.down()
  await page.mouse.move(picture.x + picture.width + 12, picture.y + picture.height + 12, { steps: 6 })
  await page.mouse.up()
  await page.getByRole('button', { name: 'Check', exact: true }).click()
  await expect.poll(() => sent.imageCount).toBe(1)
  expect(sent.strokeCount).toBe(2)
  expect(sent.image).toMatch(/^data:image\/jpeg;base64,/)
  // The capture really has the picture in it: its dark bars are there.
  const darkPixels = await page.evaluate(async (dataUrl) => {
    const image = new Image()
    image.src = dataUrl
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(image, 0, 0)
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let dark = 0
    for (let i = 0; i < data.length; i += 4) if (data[i] < 80 && data[i + 1] < 80 && data[i + 2] < 80) dark++
    return dark / (canvas.width * canvas.height)
  }, sent.image!)
  expect(darkPixels).toBeGreaterThan(0.03)
  await page.unroute('**/api/actions/checkRegion')

  // With billed calls allowed, do it for real: the student types an answer on
  // the photographed problem, and Claude reads the problem from the picture.
  if (process.env.RUN_AI_TESTS === '1') {
    await student.keyboard.press('3')
    await student.mouse.click(studentSide.x + 80, studentSide.y + studentSide.height - 40)
    await expect(student.locator('math-field')).toBeFocused()
    await student.keyboard.type('x=5')
    await student.keyboard.press('Enter')
    await expect(page.locator('.board-math')).toHaveCount(1, { timeout: 10_000 })

    await page.getByRole('button', { name: 'Check a region with Claude' }).click()
    await page.mouse.move(picture.x - 12, picture.y - 12)
    await page.mouse.down()
    await page.mouse.move(picture.x + picture.width + 12, picture.y + picture.height + 12, { steps: 6 })
    await page.mouse.up()
    await page.getByRole('button', { name: 'Check', exact: true }).click()
    const grade = page.getByTestId('grade-message')
    await expect(grade).toBeVisible({ timeout: 150_000 })
    await expect(grade).toContainText(/:\s*Correct/)
    await shot(page, 'pictures-graded')
    await page.getByTestId('chat-toggle').click()
  }

  // A screenshot on the clipboard pastes straight onto the board.
  await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))
    const clipboard = new DataTransfer()
    clipboard.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }))
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }))
  }, pngBase64)
  await expect(studentPicture).toHaveCount(2, { timeout: 30_000 })
  await expect
    .poll(() => tutorPicture.evaluateAll((all) => all.every((img) => (img as HTMLImageElement).complete)))
    .toBe(true)
  await shot(page, 'pictures-pasted')

  // The pasted picture is selected; Delete removes it for everyone, and undo restores it.
  await page.keyboard.press('Delete')
  await expect(studentPicture).toHaveCount(1, { timeout: 10_000 })
  await page.keyboard.press('ControlOrMeta+z')
  await expect(studentPicture).toHaveCount(2, { timeout: 10_000 })

  await studentContext.close()
})

test('the board exports as a PNG and as a PDF, with everything on it', async ({ users, browser }) => {
  test.setTimeout(120_000)
  const [tutor] = await users(1)
  const roomPath = await createRoom(tutor.page, 'Export test: Algebra')
  const roomId = roomPath.split('/').pop()
  const studentContext = await browser.newContext()
  const student = await studentContext.newPage()
  await joinAsStudent(student, roomPath, 'Maya')
  const page = tutor.page
  const exportButton = (target: Page) => target.getByRole('button', { name: 'Export the board' })

  // Nothing on the board: there is nothing to save, and it says so.
  await exportButton(page).click()
  await page.getByRole('menuitem', { name: 'PNG image' }).click()
  await expect(page.getByText('Nothing to export yet')).toBeVisible()

  // One of everything. A picture, under the rest:
  const pngBase64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 480
    canvas.height = 200
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 480, 200)
    ctx.fillStyle = '#7c3aed'
    ctx.fillRect(20, 20, 440, 60)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  await page.getByTestId('image-input').setInputFiles({
    name: 'homework.png',
    mimeType: 'image/png',
    buffer: Buffer.from(pngBase64, 'base64'),
  })
  await expect(page.locator('.board-image img')).toHaveCount(1, { timeout: 30_000 })
  await expect
    .poll(() => page.locator('.board-image img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true)

  // A question card with a table and a graph in it. Cards are ordinary board
  // shapes, so one can be added through the board's own sync socket without
  // asking Claude for a question.
  const questionText = [
    'Complete the table for $y = 2x - 1$, then graph it.',
    '| $x$ | $0$ | $1$ |',
    '|:---:|:---:|:---:|',
    '| $y$ |  |  |',
    '[graph]',
    'size: small',
    'x: -5 to 5',
    'y: -5 to 5',
    'y = 2x - 1 [label: $f$]',
    '[/graph]',
  ].join('\n')
  await student.evaluate(
    async ({ roomId, text }) => {
      const socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws/canvas/${roomId}`)
      await new Promise((resolve, reject) => {
        socket.onopen = resolve
        socket.onerror = reject
      })
      socket.send(
        JSON.stringify({
          type: 'canvas.add',
          payload: {
            id: crypto.randomUUID(),
            type: 'question',
            x: 620,
            y: -40,
            width: 380,
            height: 140,
            props: { qid: '', title: 'Graph a line', text, n: 1 },
          },
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 400))
      socket.close()
    },
    { roomId, text: questionText },
  )
  await expect(page.locator('.board-question [data-visual="graph"] svg')).toBeVisible({ timeout: 15_000 })

  // Pen ink in red, highlighter over it, and typed math.
  const box = await boardBox(page)
  await page.keyboard.press('4')
  await page.getByRole('button', { name: 'Red', exact: true }).click()
  await drawLine(page, box.x + 140, box.y + 430, box.x + 420, box.y + 430)
  await page.keyboard.press('5')
  await drawLine(page, box.x + 140, box.y + 440, box.x + 420, box.y + 440)
  const studentBox = await boardBox(student)
  await student.keyboard.press('3')
  await student.mouse.click(studentBox.x + 180, studentBox.y + 520)
  await expect(student.locator('math-field')).toBeFocused()
  await student.keyboard.type('x=1/2')
  await student.keyboard.press('Enter')
  await expect(page.locator('.board-math .mfrac')).toHaveCount(1, { timeout: 10_000 })
  // A selection is part of the screen, not the board; it must not show in the file.
  await page.keyboard.press('2')
  await page.locator('.board-math').click()
  await expect(page.getByText('1 selected')).toBeVisible()

  /** Decode an image in the page and count how much of it is each kind of content. */
  const inspect = (target: Page, dataUrl: string) =>
    target.evaluate(async (url) => {
      const image = new Image()
      image.src = url
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(image, 0, 0)
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const count = { white: 0, red: 0, purple: 0, yellowOnRed: 0, teal: 0, navy: 0, dark: 0, selection: 0 }
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]]
        if (r > 245 && g > 245 && b > 245) count.white++
        else if (r > 200 && g < 70 && b < 70) count.red++
        else if (Math.abs(r - 124) < 25 && Math.abs(g - 58) < 25 && Math.abs(b - 237) < 25) count.purple++
        else if (Math.abs(r - 15) < 25 && Math.abs(g - 107) < 25 && Math.abs(b - 92) < 25) count.teal++
        else if (Math.abs(r - 25) < 22 && Math.abs(g - 70) < 22 && Math.abs(b - 140) < 22) count.navy++
        else if (r < 70 && g < 70 && b < 70) count.dark++
      }
      return { width: canvas.width, height: canvas.height, count }
    }, dataUrl)

  // --- PNG, from the tutor ---
  await exportButton(page).click()
  const [pngDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: 'PNG image' }).click(),
  ])
  expect(pngDownload.suggestedFilename()).toMatch(/^export-test-algebra-\d{4}-\d{2}-\d{2}\.png$/)
  const fs = await import('node:fs')
  const png = fs.readFileSync((await pngDownload.path())!)
  if (SHOT_DIR) fs.writeFileSync(path.join(SHOT_DIR, 'board-export.png'), png)
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  const pngInfo = await inspect(page, `data:image/png;base64,${png.toString('base64')}`)
  // The whole board at twice its on-screen size: well over a thousand pixels each way.
  expect(pngInfo.width).toBeGreaterThan(1500)
  expect(pngInfo.height).toBeGreaterThan(900)
  const area = pngInfo.width * pngInfo.height
  expect(pngInfo.count.white / area).toBeGreaterThan(0.5)
  expect(pngInfo.count.red).toBeGreaterThan(1500) // the pen stroke
  expect(pngInfo.count.purple).toBeGreaterThan(20_000) // the picture
  expect(pngInfo.count.teal).toBeGreaterThan(400) // the question card's edge
  expect(pngInfo.count.navy).toBeGreaterThan(150) // the graph's line, inside the card
  expect(pngInfo.count.dark).toBeGreaterThan(1500) // text and math
  // Exporting cleared the selection on screen as well.
  await expect(page.getByText('1 selected')).toHaveCount(0)

  // --- PDF, from the student: anyone in the room can save the board ---
  await exportButton(student).click()
  const [pdfDownload] = await Promise.all([
    student.waitForEvent('download'),
    student.getByRole('menuitem', { name: 'PDF document' }).click(),
  ])
  expect(pdfDownload.suggestedFilename()).toMatch(/^export-test-algebra-\d{4}-\d{2}-\d{2}\.pdf$/)
  const pdf = fs.readFileSync((await pdfDownload.path())!)
  if (SHOT_DIR) fs.writeFileSync(path.join(SHOT_DIR, 'board-export.pdf'), pdf)
  const pdfText = pdf.toString('latin1')
  expect(pdfText.startsWith('%PDF-1.4')).toBe(true)
  expect(pdfText.trimEnd().endsWith('%%EOF')).toBe(true)
  // One page shaped like the board, holding one JPEG with the same content.
  const [, pageWidth, pageHeight] = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdfText)!.map(Number)
  const [, imageWidth, imageHeight, imageLength] = /\/Width (\d+) \/Height (\d+) .*?\/Length (\d+)/
    .exec(pdfText)!
    .map(Number)
  expect(pageWidth / pageHeight).toBeCloseTo(imageWidth / imageHeight, 2)
  const jpegStart = pdfText.indexOf('stream\n', pdfText.indexOf('/DCTDecode')) + 'stream\n'.length
  const jpeg = pdf.subarray(jpegStart, jpegStart + imageLength)
  expect(jpeg.subarray(0, 3).toString('hex')).toBe('ffd8ff')
  const pdfInfo = await inspect(student, `data:image/jpeg;base64,${jpeg.toString('base64')}`)
  expect([pdfInfo.width, pdfInfo.height]).toEqual([imageWidth, imageHeight])
  expect(pdfInfo.count.purple).toBeGreaterThan(20_000)
  expect(pdfInfo.count.red).toBeGreaterThan(1000)
  expect(pdfInfo.count.dark).toBeGreaterThan(1500)

  await studentContext.close()
})

test('graphs, figures and tables written in text are drawn for everyone', async ({ users, browser }) => {
  test.setTimeout(90_000)
  const [tutor] = await users(1)
  const roomPath = await createRoom(tutor.page, 'Visuals')
  const roomId = roomPath.split('/').pop()
  const studentContext = await browser.newContext()
  const student = await studentContext.newPage()
  await joinAsStudent(student, roomPath, 'Maya')

  // Chat text goes through the same renderer as question cards, answer keys
  // and grading results, so a message exercises it end to end at no cost.
  const body = [
    'Fill in the table, then graph it.',
    '| $x$ | $-1$ | $0$ | $1$ |',
    '| $y$ |  |  |  |',
    '[graph]',
    'x: -5 to 5',
    'y: -5 to 5',
    'y = 2x - 1 [label: $f$]',
    'y = x + 3 for -3 <= x < 0',
    'point A (1, 1)',
    '[/graph]',
    '[figure]',
    'triangle ABC AB=8 angle A=50 angle B=60',
    'side AB 8 cm',
    'angle C $x^\\circ$',
    '[/figure]',
  ].join('\n')
  const posted = await student.request.post(`/api/rooms/${roomId}/messages`, { data: { body } })
  expect(posted.ok()).toBe(true)

  for (const page of [tutor.page, student]) {
    await page.getByTestId('chat-toggle').click()
    const graph = page.locator('[data-visual="graph"]')
    const figure = page.locator('[data-visual="figure"]')
    await expect(graph).toHaveCount(1, { timeout: 15_000 })
    await expect(figure).toHaveCount(1)

    // The graph: two curves in the first two colours, the point, and both
    // endpoint dots of the restricted piece (one of them open).
    await expect(graph.locator('svg path[stroke="#19468c"]')).toHaveCount(1)
    await expect(graph.locator('svg path[stroke="#c8322b"]')).toHaveCount(1)
    await expect(graph.locator('svg circle')).toHaveCount(3)
    await expect(graph.locator('svg circle[fill="#ffffff"]')).toHaveCount(1)
    await expect(graph.locator('.visual-label .katex').filter({ hasText: 'f' }).first()).toBeVisible()

    // The figure: a closed outline and its labels, with math typeset.
    await expect(figure.locator('svg path[d$="Z"]')).toHaveCount(1)
    await expect(figure.getByText('8 cm')).toBeVisible()
    await expect(figure.locator('.visual-label .katex').filter({ hasText: 'x' }).first()).toBeVisible()

    // The table: the missing rule row is supplied, and empty cells are kept to write in.
    const table = page.locator('.md table')
    await expect(table).toHaveCount(1)
    await expect(table.locator('th')).toHaveCount(4)
    await expect(table.locator('td')).toHaveCount(4)

    // Everything fits the chat column, and nothing fell back to an error note.
    const chatColumn = 360
    for (const visual of [graph, figure]) {
      const box = await visual.boundingBox()
      expect(box!.width).toBeLessThan(chatColumn - 40)
    }
    await expect(page.getByText(/could not be drawn/)).toHaveCount(0)
  }
  await shot(tutor.page, 'visuals-chat')

  // A block the app cannot draw says so instead of showing something wrong.
  await student.request.post(`/api/rooms/${roomId}/messages`, {
    data: { body: '[figure]\ntriangle ABC AB=1 BC=1 CA=5\n[/figure]' },
  })
  await expect(tutor.page.getByText('This figure could not be drawn.')).toBeVisible({ timeout: 15_000 })

  await studentContext.close()
})

test('Claude draws a figure, a table and a graph when a problem calls for them', async ({ users, browser }) => {
  test.skip(process.env.RUN_AI_TESTS !== '1', 'Makes real, billed Claude calls. Set RUN_AI_TESTS=1 to run.')
  test.setTimeout(420_000)

  const [tutor] = await users(1)
  const roomPath = await createRoom(tutor.page, 'Visual questions')
  const studentContext = await browser.newContext()
  const student = await studentContext.newPage()
  await joinAsStudent(student, roomPath, 'Maya')
  const describe = tutor.page.getByLabel('Describe the problem')
  const create = tutor.page.getByRole('button', { name: 'Create question' })

  // A geometry problem: the card shows a to-scale figure on both boards.
  await describe.fill(
    'Triangle ABC has angle A = 50 degrees, angle B = 60 degrees and side AB = 8 cm. Show the triangle and ask for angle C.',
  )
  await create.click()
  await expect(student.locator('.board-question')).toHaveCount(1, { timeout: 120_000 })
  const first = student.locator('.board-question').nth(0)
  await expect(first.locator('[data-visual="figure"] svg')).toBeVisible({ timeout: 15_000 })
  await shot(tutor.page, 'visuals-figure-question')

  // A table of values to complete and a blank grid to graph on.
  await describe.fill(
    'Give a table of values for y = 2x - 1 at x = -1, 0, 1, 2 with the y row left blank for the student, and a blank coordinate grid from -5 to 5 to graph the line on.',
  )
  await create.click()
  await expect(student.locator('.board-question')).toHaveCount(2, { timeout: 120_000 })
  const second = student.locator('.board-question').nth(1)
  await expect(second.locator('table')).toHaveCount(1, { timeout: 15_000 })
  await expect(second.locator('[data-visual="graph"] svg')).toBeVisible()
  // The tutor's board scrolls to a new card; the student's stays where it was.
  await shot(tutor.page, 'visuals-table-graph-question')

  // Claude wrote only lines the app can draw.
  await expect(student.getByText(/could not be drawn/)).toHaveCount(0)

  // The same text typesets for print: the worksheet compiles with its figures.
  await tutor.page.getByRole('tab', { name: 'Session' }).click()
  await expect(tutor.page.getByText('Worked solution', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
  await shot(tutor.page, 'visuals-answer-keys')
  await tutor.page.getByRole('button', { name: 'Make worksheet PDF' }).click()
  const worksheetLink = tutor.page.getByRole('link', { name: 'Open worksheet' })
  await expect(worksheetLink).toBeVisible({ timeout: 90_000 })
  const worksheet = await student.request.get((await worksheetLink.getAttribute('href'))!)
  expect((await worksheet.body()).subarray(0, 5).toString()).toBe('%PDF-')
  if (SHOT_DIR) {
    const fs = await import('node:fs')
    fs.writeFileSync(path.join(SHOT_DIR, 'visuals-worksheet.pdf'), await worksheet.body())
  }

  await studentContext.close()
})

test('the tutor creates a question and Claude grades the boxed region', async ({ users, browser }) => {
  test.skip(process.env.RUN_AI_TESTS !== '1', 'Makes real, billed Claude calls. Set RUN_AI_TESTS=1 to run.')
  test.setTimeout(420_000)

  const [tutor] = await users(1)
  const roomPath = await createRoom(tutor.page, 'Linear equations')
  const roomId = roomPath.split('/').pop()

  const studentContext = await browser.newContext()
  const student = await studentContext.newPage()
  await joinAsStudent(student, roomPath, 'Maya')

  // The tutor describes a problem; the card lands on both boards.
  await tutor.page
    .getByLabel('Describe the problem')
    .fill('Solve for x: a two-step linear equation with integer coefficients whose answer is x = 6.')
  await tutor.page.getByRole('button', { name: 'Create question' }).click()
  await expect(tutor.page.locator('.board-question')).toHaveCount(1, { timeout: 90_000 })
  await expect(student.locator('.board-question')).toHaveCount(1, { timeout: 15_000 })
  await shot(tutor.page, 'tutor-question')

  // The private key reaches the tutor's panel and never the student's page.
  await tutor.page.getByRole('tab', { name: 'Session' }).click()
  await expect(tutor.page.getByText('Worked solution', { exact: true })).toBeVisible({ timeout: 15_000 })
  expect(await student.content()).not.toContain('Worked solution')

  // The student types a wrong answer just under the question card.
  const card = await student.locator('.board-question').boundingBox()
  if (!card) throw new Error('question card is not laid out')
  await student.keyboard.press('3')
  await student.mouse.click(card.x + 40, card.y + card.height + 60)
  await expect(student.locator('math-field')).toBeFocused()
  await student.keyboard.type('x=5')
  await student.keyboard.press('Enter')
  await expect(tutor.page.locator('.board-math')).toHaveCount(1, { timeout: 10_000 })

  // The tutor boxes the question and the answer, then asks Claude to check.
  const tutorCard = await tutor.page.locator('.board-question').boundingBox()
  if (!tutorCard) throw new Error('question card is not laid out for the tutor')
  await tutor.page.getByRole('button', { name: 'Check a region with Claude' }).click()
  await tutor.page.mouse.move(tutorCard.x - 16, tutorCard.y - 16)
  await tutor.page.mouse.down()
  await tutor.page.mouse.move(tutorCard.x + tutorCard.width + 16, tutorCard.y + tutorCard.height + 130, {
    steps: 8,
  })
  await tutor.page.mouse.up()
  await shot(tutor.page, 'tutor-region')
  await tutor.page.getByRole('button', { name: 'Check', exact: true }).click()

  // The result is posted to the room chat, which opens by itself for both
  // the tutor and the student.
  await expect(tutor.page.getByTestId('grade-message')).toBeVisible({ timeout: 150_000 })
  await expect(tutor.page.getByTestId('grade-message')).toContainText(/incorrect/i)
  await expect(tutor.page.getByTestId('grade-message').locator('.katex').first()).toBeVisible()
  await expect(student.getByTestId('grade-message')).toBeVisible({ timeout: 15_000 })
  await shot(tutor.page, 'tutor-graded')
  await shot(student, 'student-graded')

  // Browse subject → unit → topic: Claude lists question types for the topic
  // (cached for every tutor after the first time), then writes a fresh one.
  await tutor.page.getByRole('tab', { name: 'Questions' }).click()
  await tutor.page.getByRole('tab', { name: 'Browse topics' }).click()
  await tutor.page.getByLabel('Subject').selectOption({ label: 'Algebra I' })
  await tutor.page.getByLabel('Unit').selectOption({ label: 'Solving Linear Equations' })
  await tutor.page.getByLabel('Topic').selectOption({ label: 'Solving Multi-Step Equations' })
  const firstType = tutor.page.getByRole('radio').first()
  await expect(firstType).toBeVisible({ timeout: 120_000 })
  await firstType.check()
  await expect(tutor.page.getByText('Model problem')).toBeVisible()
  await shot(tutor.page, 'tutor-browse')
  await tutor.page.getByRole('button', { name: 'Create question' }).click()
  await expect(student.locator('.board-question')).toHaveCount(2, { timeout: 120_000 })

  // The tutor's private assistant answers with typeset math, and nothing of
  // it reaches the student's page.
  await tutor.page.getByRole('tab', { name: 'Ask Claude' }).click()
  const assistantInput = tutor.page.getByPlaceholder('Message the assistant…')
  await assistantInput.fill('Reply with exactly this and nothing else: The vertex form is $y = a(x-h)^2 + k$.')
  await assistantInput.press('Enter')
  const conversation = tutor.page.getByLabel('Assistant conversation')
  await expect(conversation.locator('.katex').first()).toBeVisible({ timeout: 120_000 })
  await shot(tutor.page, 'tutor-assistant')
  expect(await student.content()).not.toContain('vertex form')

  // Send the session home: the questions are typeset as a PDF that opens
  // without an account (the student's context has none), and the recap email
  // goes out. delivered@resend.dev is the mail provider's own test inbox, so
  // no real person is emailed.
  await tutor.page.getByRole('tab', { name: 'Session' }).click()
  await tutor.page.getByRole('button', { name: 'Make worksheet PDF' }).click()
  const worksheetLink = tutor.page.getByRole('link', { name: 'Open worksheet' })
  await expect(worksheetLink).toBeVisible({ timeout: 90_000 })
  const worksheetPath = await worksheetLink.getAttribute('href')
  const worksheet = await student.request.get(worksheetPath!)
  expect(worksheet.status()).toBe(200)
  expect(worksheet.headers()['content-type']).toContain('application/pdf')
  expect((await worksheet.body()).subarray(0, 5).toString()).toBe('%PDF-')

  await tutor.page.getByLabel('Email the recap to').fill('delivered@resend.dev')
  await tutor.page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(tutor.page.getByText('Recap sent')).toBeVisible({ timeout: 90_000 })
  await shot(tutor.page, 'tutor-recap')

  // A student cannot ask for a check, a worksheet or a recap.
  for (const action of ['createWorksheet', 'sendRecap']) {
    const refused = await student.request.post(`/api/actions/${action}`, {
      data: { roomId, to: 'someone@example.com' },
    })
    expect(refused.status()).toBe(401)
  }

  // A student cannot ask for a check, even for their own room.
  const studentCheck = await student.request.post('/api/actions/checkRegion', {
    data: { roomId, image: 'data:image/png;base64,AAAA', strokeCount: 1 },
  })
  expect(studentCheck.status()).toBe(401)

  await studentContext.close()
})
