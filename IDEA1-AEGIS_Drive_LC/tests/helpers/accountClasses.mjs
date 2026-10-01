// tests/helpers/accountClasses.mjs — AEGIS Drive (IDEA1) · Unified Preview · account-neutrality fixture
//
// The three account classes every preview phase must treat identically (spec §30):
//   ADMIN               the seeded Admin account
//   EXISTING_USER       the seeded DataLake user
//   NEWLY_CREATED_USER  a DataLake user provisioned by the Admin during the test run
//                       (first login completes the forced password reset via performLogin)
import { loginClient, DEMO_ADMIN, DEMO_USER } from './testClient.mjs'

export const ACCOUNT_CLASSES = Object.freeze(['ADMIN', 'EXISTING_USER', 'NEWLY_CREATED_USER'])

let created = 0

/**
 * Log in all three classes against one running app.
 * @param {string} baseUrl
 * @returns {Promise<Array<{ className: string, client: object, username: string }>>}
 */
export async function loginAccountClasses(baseUrl) {
  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const existing = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const username = `p0neutral${Date.now().toString(36)}${created++}`
  const res = await admin.req('/api/users', { method: 'POST', body: { name: 'Preview Neutrality', username, role: 'DataLake-User' } })
  if (res.status !== 201 || !res.data?.tempPassword) throw new Error(`could not provision a new user: ${res.status} ${JSON.stringify(res.data)}`)
  const fresh = await loginClient(baseUrl, username, res.data.tempPassword)
  return [
    { className: 'ADMIN', client: admin, username: DEMO_ADMIN.username },
    { className: 'EXISTING_USER', client: existing, username: DEMO_USER.username },
    { className: 'NEWLY_CREATED_USER', client: fresh, username },
  ]
}

/**
 * Run `fn` once per account class, in a fixed order.
 * @param {string} baseUrl
 * @param {(client: object, className: string, all: Array) => Promise<void>} fn
 */
export async function withAccountClasses(baseUrl, fn) {
  const accounts = await loginAccountClasses(baseUrl)
  for (const a of accounts) await fn(a.client, a.className, accounts)
  return accounts
}
