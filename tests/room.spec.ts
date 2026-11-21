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
  await tutor.page.getByRole('tab', { name: 'Answer keys' }).click()
  await expect(tutor.page.getByText('Worked solution')).toBeVisible({ timeout: 15_000 })
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

  // A student cannot ask for a check, even for their own room.
  const studentCheck = await student.request.post('/api/actions/checkRegion', {
    data: { roomId, image: 'data:image/png;base64,AAAA', strokeCount: 1 },
  })
  expect(studentCheck.status()).toBe(401)

  await studentContext.close()
})
