// server/db/connection.js
import bcrypt from 'bcryptjs'
import { ROLES } from '../rbac/roles.js'

const DEV_SEED = [
  { id: 1, username: 'user', displayName: 'Kanya S.', role: ROLES.USER, password: 'aegis-user' },
  { id: 2, username: 'admin', displayName: 'Veerachat J.', role: ROLES.ADMIN, password: 'aegis-admin' },
].map((u) => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
  role: u.role,
  passwordHash: bcrypt.hashSync(u.password, 10),
}))

export async function getUserByUsername(username) {
  const uname = String(username ?? '').trim().toLowerCase()
  if (!uname) return null
  return DEV_SEED.find((u) => u.username === uname) ?? null
}
