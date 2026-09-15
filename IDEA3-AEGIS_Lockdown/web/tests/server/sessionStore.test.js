import { describe, expect, it, vi } from 'vitest'
import session from 'express-session'
import request from 'supertest'
import { loadConfig } from '../../server/config.js'
import { createApp } from '../../server/createApp.js'
import { createMemoryRepository } from '../../server/repositories/memoryRepository.js'
import { BoundedSessionStore, createBoundedSessionStore } from '../../server/security/sessionStore.js'

// PR10 D8 / PR11 Phase 2 (design §4.5): bounded in-memory TTL session store.

function call(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (error, value) => (error ? reject(error) : resolve(value)))
  })
}

function sessionWith({ expires = null, ...rest } = {}) {
  return { cookie: { originalMaxAge: null, expires, httpOnly: true, path: '/' }, ...rest }
}

function mutableClock(start = 1_000_000) {
  const clock = () => clock.now
  clock.now = start
  return clock
}

describe('PR11 Phase 2 D8 bounded session store', () => {
  it('P2-S1: implements the express-session store callback API', async () => {
    const clock = mutableClock()
    const store = createBoundedSessionStore({ idleMs: 60_000, clock })
    const admin = sessionWith({ identity: { role: 'ADMIN' } })

    expect(store).toBeInstanceOf(session.Store)
    await call(store, 'set', 'a', admin)
    expect(await call(store, 'get', 'a')).toEqual(admin)
    expect(await call(store, 'length')).toBe(1)
    expect(await call(store, 'all')).toEqual({ a: admin })
    await call(store, 'touch', 'a', admin)
    await call(store, 'destroy', 'a')
    expect(await call(store, 'get', 'a')).toBeUndefined()
    await call(store, 'set', 'b', sessionWith())
    await call(store, 'clear')
    expect(await call(store, 'length')).toBe(0)
    store.close()
  })

  it('P2-S2: never returns an entry past its cookie expiry and removes it', async () => {
    const clock = mutableClock()
    const store = createBoundedSessionStore({ idleMs: 60_000, clock })

    await call(store, 'set', 'a', sessionWith({ expires: new Date(clock.now + 1_000).toISOString() }))
    clock.now += 1_001

    expect(await call(store, 'get', 'a')).toBeUndefined()
    expect(store.size).toBe(0)
    store.close()
  })

  it('P2-S2: applies the idle TTL without a cookie expiry, and touch extends it', async () => {
    const clock = mutableClock()
    const store = createBoundedSessionStore({ idleMs: 5_000, clock })

    await call(store, 'set', 'a', sessionWith())
    clock.now += 4_000
    await call(store, 'touch', 'a', sessionWith())
    clock.now += 4_000
    expect(await call(store, 'get', 'a')).toBeDefined()
    clock.now += 1_001
    expect(await call(store, 'get', 'a')).toBeUndefined()
    expect(await call(store, 'all')).toEqual({})
    store.close()
  })

  it('P2-S3: evicts expired entries first, then the least-recently-written entry', async () => {
    const clock = mutableClock()
    const store = createBoundedSessionStore({ idleMs: 60_000, maxEntries: 3, clock })

    await call(store, 'set', 'expired', sessionWith({ expires: new Date(clock.now + 10).toISOString() }))
    await call(store, 'set', 'a', sessionWith())
    await call(store, 'set', 'b', sessionWith())
    clock.now += 11
    await call(store, 'set', 'c', sessionWith())
    expect(Object.keys(await call(store, 'all')).sort()).toEqual(['a', 'b', 'c'])

    await call(store, 'set', 'a', sessionWith({ rewritten: true }))
    await call(store, 'set', 'd', sessionWith())

    expect(Object.keys(await call(store, 'all')).sort()).toEqual(['a', 'c', 'd'])
    expect(store.size).toBe(3)
    store.close()
  })

  it('P2-S3: rejects an invalid capacity or TTL instead of running unbounded', () => {
    for (const options of [{ idleMs: 0 }, { idleMs: 1_000, maxEntries: 0 }, { idleMs: 1_000, pruneIntervalMs: -1 }]) {
      expect(() => createBoundedSessionStore(options)).toThrow(/session store/)
    }
  })

  it('P2-S4: prunes expired entries periodically and stops the timer when closed', async () => {
    vi.useFakeTimers()
    try {
      const clock = mutableClock()
      const store = createBoundedSessionStore({ idleMs: 1_000, pruneIntervalMs: 500, clock })
      await call(store, 'set', 'a', sessionWith())

      clock.now += 1_001
      vi.advanceTimersByTime(500)
      expect(store.size).toBe(0)

      store.close()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('P2-S5: returns copies so callers never share mutable state with the store', async () => {
    const store = createBoundedSessionStore({ idleMs: 60_000, clock: mutableClock() })
    const original = sessionWith({ identity: { role: 'ADMIN' } })

    await call(store, 'set', 'a', original)
    original.identity.role = 'ANALYST'
    const first = await call(store, 'get', 'a')
    first.identity.role = 'ANALYST'

    expect((await call(store, 'get', 'a')).identity.role).toBe('ADMIN')
    store.close()
  })

  it('P2-S6: createApp uses the bounded store by default and keeps login, CSRF, and logout', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'test-session-secret-with-at-least-32-characters',
      AEGIS_ALLOW_DEV_LOGIN: 'true',
      AEGIS_IDEA3_ADMIN_USER: 'admin',
      AEGIS_IDEA3_DEV_PASSWORD: 'correct-horse-battery-staple',
    })
    const app = createApp({ config, repository: createMemoryRepository() })
    const store = app.locals.sessionStore
    const close = vi.spyOn(store, 'close')

    try {
      expect(store).toBeInstanceOf(BoundedSessionStore)
      const agent = request.agent(app)
      const login = await agent
        .post('/api/auth/login')
        .set('Origin', 'http://localhost')
        .set('Host', 'localhost')
        .send({ username: 'admin', password: 'correct-horse-battery-staple' })
      expect(login.status).toBe(200)
      expect(await call(store, 'length')).toBe(1)

      const withoutCsrf = await agent.post('/api/auth/logout').set('Origin', 'http://localhost').set('Host', 'localhost')
      expect(withoutCsrf.status).toBe(403)

      const logout = await agent
        .post('/api/auth/logout')
        .set('Origin', 'http://localhost')
        .set('Host', 'localhost')
        .set('X-CSRF-Token', login.body.csrfToken)
      expect(logout.status).toBe(204)
      expect(await call(store, 'length')).toBe(0)
      expect((await agent.get('/api/auth/session')).body).toEqual({ authenticated: false })
    } finally {
      app.locals.close()
    }
    expect(close).toHaveBeenCalledTimes(1)
  })
})
