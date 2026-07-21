// server/auth/session.js
import session from 'express-session'

export const SESSION_COOKIE = 'aegis.sid'
const THIRTY_MIN = 30 * 60 * 1000
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000

export function sessionMiddleware() {
  const secret = process.env.SESSION_SECRET || 'dev-only-ephemeral-secret'
  return session({
    name: SESSION_COOKIE,
    secret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: THIRTY_MIN,
    },
  })
}

export function establishSession(req, user, remember) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err)
      req.session.user = {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
      }
      req.session.cookie.maxAge = remember ? THIRTY_DAYS : THIRTY_MIN
      req.session.save((err2) => (err2 ? reject(err2) : resolve()))
    })
  })
}

export function currentUser(req) {
  return req.session?.user ?? null
}

export function destroySession(req, res) {
  return new Promise((resolve) => {
    if (!req.session) {
      res.clearCookie(SESSION_COOKIE)
      return resolve()
    }
    req.session.destroy(() => {
      res.clearCookie(SESSION_COOKIE)
      resolve()
    })
  })
}
