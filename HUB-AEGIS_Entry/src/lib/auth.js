const JSON_HEADERS = { 'Content-Type': 'application/json' }

async function requestJson(path, { method = 'GET', body } = {}) {
  let res
  try {
    res = await fetch(path, {
      method,
      headers: body ? JSON_HEADERS : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    })
  } catch {
    return { ok: false, status: 0, data: null }
  }
  let data = null
  try {
    data = await res.json()
  } catch {
    /* ignore parse errors */
  }
  return { ok: res.ok, status: res.status, data }
}

const DEMO_ACCOUNTS = [
  { username: 'user', password: 'aegis-user', role: 'User', displayName: 'Kanya S.' },
  { username: 'admin', password: 'aegis-admin', role: 'Admin', displayName: 'Veerachat J.' },
]

export async function login({ username, password, remember }) {
  const { ok, data } = await requestJson('/api/login', {
    method: 'POST',
    body: { username, password, remember: Boolean(remember) },
  })
  if (ok && data?.user) {
    return { ok: true, user: data.user, menu: data.menu ?? [] }
  }
  // Fallback to in-memory mock if API is offline
  const uname = String(username ?? '').trim().toLowerCase()
  const account = DEMO_ACCOUNTS.find((a) => a.username === uname && a.password === password)
  if (!account) return { ok: false }
  return {
    ok: true,
    user: { username: account.username, role: account.role, displayName: account.displayName },
    menu: account.role === 'Admin'
      ? [
          { id: 'drive', titleKey: 'modDrive', descKey: 'modDriveDesc' },
          { id: 'cctv', titleKey: 'modCctv', descKey: 'modCctvDesc' },
          { id: 'monitoring', titleKey: 'modMonitor', descKey: 'modMonitorDesc' },
        ]
      : [{ id: 'drive', titleKey: 'modDrive', descKey: 'modDriveDesc' }],
  }
}

export async function authenticate(args) {
  return login(args)
}

export async function fetchMe() {
  const { ok, data } = await requestJson('/api/me')
  if (!ok || !data?.user) return null
  return { user: data.user, menu: data.menu ?? [] }
}

export async function logout() {
  await requestJson('/api/logout', { method: 'POST' })
}
