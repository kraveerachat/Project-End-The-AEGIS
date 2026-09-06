import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDemoSnapshot } from '../fixtures/clientSnapshot.js'

const api = vi.hoisted(() => ({
  fetch: vi.fn(),
  setCsrfToken: vi.fn(),
}))

vi.mock('../../src/lib/api.js', () => ({
  apiFetch: api.fetch,
  setCsrfToken: api.setCsrfToken,
}))

import App from '../../src/App.jsx'

let snapshot

beforeAll(async () => {
  snapshot = await makeDemoSnapshot()
})

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState({}, '', '/security/dashboard')
  document.documentElement.lang = 'th'
  api.fetch.mockReset()
  api.setCsrfToken.mockReset()
  api.fetch.mockImplementation(async (path) => {
    if (path === '/auth/session') {
      return {
        authenticated: true,
        identity: {
          displayName: 'System Administrator',
          role: 'ADMIN',
          workspace: 'AEGIS Security Center',
        },
      }
    }
    if (path === '/auth/csrf') return { csrfToken: 'test-csrf-token' }
    if (path === '/security/snapshot') return snapshot
    throw new Error(`Unexpected API path: ${path}`)
  })
})

describe('Dashboard language preference', () => {
  it('initializes from an allowlisted preference and switches language without refetching evidence', async () => {
    localStorage.setItem('aegis_lang', 'en')
    render(<App />)

    expect(await screen.findByRole('radiogroup', { name: 'Language' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible()
    expect(document.documentElement.lang).toBe('en')
    expect(api.fetch).toHaveBeenCalledTimes(3)

    fireEvent.click(screen.getByRole('radio', { name: '中文' }))

    await waitFor(() => expect(document.documentElement.lang).toBe('zh-CN'))
    expect(localStorage.getItem('aegis_lang')).toBe('zh')
    expect(screen.getByRole('heading', { name: '安全仪表板', level: 1 })).toBeVisible()
    expect(api.fetch).toHaveBeenCalledTimes(3)
  })

  it('falls back to Thai when the persisted language is unsupported', async () => {
    localStorage.setItem('aegis_lang', 'fr')
    render(<App />)

    expect(await screen.findByRole('radiogroup', { name: 'ภาษา' })).toBeVisible()
    expect(screen.getByRole('radio', { name: 'ไทย' })).toHaveAttribute('aria-checked', 'true')
    expect(document.documentElement.lang).toBe('th')
  })
})
