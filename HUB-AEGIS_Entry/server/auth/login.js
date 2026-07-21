// server/auth/login.js
import bcrypt from 'bcryptjs'
import { getUserByUsername } from '../db/connection.js'

const DUMMY_HASH = bcrypt.hashSync('aegis-timing-equalizer', 10)

export async function verifyCredentials(username, password) {
  const pw = String(password ?? '')
  const user = await getUserByUsername(username)

  if (!user) {
    await bcrypt.compare(pw, DUMMY_HASH)
    return null
  }

  const ok = await bcrypt.compare(pw, user.passwordHash)
  if (!ok) return null

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
  }
}
