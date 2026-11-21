import { defineConfig } from '@playwright/test'
import { chromiumLaunchOptions } from 'deepspace/testing'

/**
 * Runs specs against the deployed app instead of a local dev server:
 *
 *   npx playwright test -c tests/playwright.live.config.ts tests/room.spec.ts
 *
 * LIVE_URL overrides the target. No web server is started. Specs create real
 * rooms on the live app, so run it deliberately, not on every change.
 */
const LIVE_URL = process.env.LIVE_URL ?? 'https://practiceroom.app.space'

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: LIVE_URL,
    headless: true,
    launchOptions: chromiumLaunchOptions(),
  },
})
