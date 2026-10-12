import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  outputDir: './node_modules/.cache/camera-selector-results',
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:15177',
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
    // Existing English-copy regressions have an explicit user preference;
    // production still defaults to Thai. Locale tests change this preference.
    storageState: { cookies: [], origins: [{
      origin: 'http://127.0.0.1:15177',
      localStorage: [{ name: 'aegis_lang', value: 'en' }],
    }] },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node tests/browser/server.mjs',
    url: 'http://127.0.0.1:15177/monitor/',
    env: { CAMERA_SELECTOR_FIXTURE_PORT: '15177' },
    reuseExistingServer: false,
  },
})
