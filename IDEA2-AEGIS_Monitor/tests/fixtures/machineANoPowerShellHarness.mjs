import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

import bcrypt from 'bcryptjs'
import pg from 'pg'

import { canonicalBrowserAssociationPayload } from '../../server/nodeIdentity/browserAssociationProof.js'

const { Client } = pg
const PROTECTED_PORTS = new Set([8077, 8078, 18078])
const NODE_ID = 'machine-a-node'
const PHYSICAL_CAMERA_ID = 41
const ENGINE_KEY = 'task13-disposable-engine-key'
const AUDIENCE = 'urn:aegis:monitor:machine-a-task13'
const STREAM_HOST = 'aegis-stream-host.localhost'

let buildPromise

function ensureBuilt(monitorRoot) {
  if (!buildPromise) {
    buildPromise = Promise.resolve().then(() => {
      const npmCli = process.env.npm_execpath
      if (!npmCli) throw new Error('Task 13 must run through the repository npm script')
      const result = spawnSync(process.execPath, [npmCli, 'run', 'build'], {
        cwd: monitorRoot,
        env: { ...process.env },
        encoding: 'utf8',
        timeout: 120_000,
      })
      if (result.status !== 0) {
        throw new Error(`Vite production build failed (${result.error ?? result.status}):\n${result.stdout}\n${result.stderr}`)
      }
    })
  }
  return buildPromise
}

async function reservePort() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer()
      server.unref()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const value = server.address().port
        server.close((error) => error ? reject(error) : resolve(value))
      })
    })
    if (!PROTECTED_PORTS.has(port)) return port
  }
}

function schemaUrl(databaseUrl, schema) {
  const url = new URL(databaseUrl)
  url.searchParams.set('options', `-csearch_path=${schema}`)
  return url.toString()
}

async function prepareDatabase({ databaseUrl, monitorRoot, publicKeyPem, fingerprint, enginePort }) {
  const schema = `task13_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`
  const admin = new Client({ connectionString: databaseUrl })
  await admin.connect()
  await admin.query(`CREATE SCHEMA "${schema}"`)
  await admin.end()

  const scopedUrl = schemaUrl(databaseUrl, schema)
  const client = new Client({ connectionString: scopedUrl })
  await client.connect()
  try {
    const schemaSql = await fs.readFile(path.join(monitorRoot, 'server', 'db', 'schema.sql'), 'utf8')
    await client.query(schemaSql)
    const migrationRoot = path.join(monitorRoot, 'server', 'db', 'migrations')
    const migrations = (await fs.readdir(migrationRoot))
      .filter((name) => name.endsWith('.sql'))
      .sort()
    for (let run = 0; run < 2; run += 1) {
      for (const migration of migrations) {
        await client.query(await fs.readFile(path.join(migrationRoot, migration), 'utf8'))
      }
    }

    const operatorHash = bcrypt.hashSync('task13-operator-password', 10)
    const operator2Hash = bcrypt.hashSync('task13-operator2-password', 10)
    await client.query(
      `INSERT INTO cameras (id, name, zone, res, online) VALUES
         ('CAM-01', 'Machine A operator alias', 'Task 13', '64x48', true),
         ('CAM-02', 'Machine A operator2 alias', 'Task 13', '64x48', true)`,
    )
    await client.query(
      `INSERT INTO users (id, username, password_hash, role, display_name, active, must_reset_password)
       VALUES
         (101, 'operator', $1, 'CCTV-Operator', 'Task 13 Operator', true, false),
         (102, 'operator2', $2, 'CCTV-Operator', 'Task 13 Operator 2', true, false)`,
      [operatorHash, operator2Hash],
    )
    await client.query(
      `INSERT INTO detection_nodes (
         node_id, camera_id, public_key, public_key_fingerprint,
         key_version, ingest_auth_mode, active)
       VALUES ($1, NULL, $2, $3, 1, 'ed25519_required', true)`,
      [NODE_ID, publicKeyPem, fingerprint],
    )
    await client.query(
      `INSERT INTO physical_cameras (physical_camera_id, node_id, active)
       OVERRIDING SYSTEM VALUE VALUES ($1, $2, true)`,
      [PHYSICAL_CAMERA_ID, NODE_ID],
    )
    await client.query(
      `INSERT INTO node_camera_alias_policy (node_id, mode, fixed_camera_id)
       VALUES ($1, 'account', NULL)`,
      [NODE_ID],
    )
    await client.query(
      `INSERT INTO node_account_camera_alias (node_id, user_id, logical_camera_id)
       VALUES ($1, 101, 'CAM-01'), ($1, 102, 'CAM-02')`,
      [NODE_ID],
    )
    await client.query(
      `INSERT INTO physical_camera_heartbeat (
         physical_camera_id, node_id, last_seen_at, camera_connected, stream_url)
       VALUES ($1, $2, now(), false, $3)`,
      [PHYSICAL_CAMERA_ID, NODE_ID, `http://${STREAM_HOST}:${enginePort}/stream.mjpg`],
    )
  } finally {
    await client.end()
  }
  return { schema, scopedUrl }
}

async function dropDatabaseSchema(databaseUrl, schema) {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  } finally {
    await client.end()
  }
}

function collectOutput(child) {
  const state = { stdout: '', stderr: '' }
  child.stdout?.on('data', (chunk) => { state.stdout = `${state.stdout}${chunk}`.slice(-20_000) })
  child.stderr?.on('data', (chunk) => { state.stderr = `${state.stderr}${chunk}`.slice(-20_000) })
  return state
}

async function waitForUrl(url, { timeoutMs = 15_000, child, output } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (child?.exitCode != null) {
      throw new Error(`process exited ${child.exitCode}:\n${output?.stdout}\n${output?.stderr}`)
    }
    try {
      const response = await fetch(url)
      if (response.ok) return response
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}\n${output?.stdout}\n${output?.stderr}`)
}

async function stopChild(child) {
  if (!child || child.exitCode != null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill()
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
  if (child.exitCode == null) {
    child.kill('SIGKILL')
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))])
  }
}

function requestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > 16 * 1024) {
        reject(new Error('request too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function createAgent({ port, monitorOrigin, privateKey }) {
  let server
  async function start() {
    if (server) return
    server = http.createServer(async (request, response) => {
      try {
        if (
          request.method !== 'POST'
          || request.url !== '/v1/browser-association/assert'
          || request.headers.origin !== monitorOrigin
          || request.headers['content-type'] !== 'application/json'
        ) {
          response.writeHead(403, { 'Content-Type': 'application/json' })
          response.end('{"error":"ORIGIN_DENIED"}')
          return
        }
        const challenge = JSON.parse((await requestBody(request)).toString('utf8'))
        const nodeId = request.headers['x-task13-node-id'] || NODE_ID
        const claims = {
          version: 1,
          purpose: 'AEGIS-BROWSER-NODE-ASSOCIATION-V1',
          audience: challenge.audience,
          challenge_id: challenge.challenge_id,
          challenge_nonce: challenge.challenge_nonce,
          session_binding: challenge.session_binding,
          node_id: nodeId,
          key_version: 1,
          issued_at_ms: challenge.issued_at_ms,
          expires_at_ms: challenge.expires_at_ms,
        }
        const signature = sign(null, canonicalBrowserAssociationPayload(claims), privateKey).toString('base64url')
        const body = JSON.stringify({ claims, signature })
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(body),
          'Access-Control-Allow-Origin': monitorOrigin,
        })
        response.end(body)
      } catch {
        response.writeHead(400, { 'Content-Type': 'application/json' })
        response.end('{"error":"INVALID_REQUEST"}')
      }
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
  }
  async function stop() {
    if (!server) return
    const current = server
    server = undefined
    await new Promise((resolve, reject) => current.close((error) => error ? reject(error) : resolve()))
  }
  return { start, stop }
}

function cookieFrom(response, current) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean)
  const session = values.find((value) => value.startsWith('aegis.monitor.sid='))
  return session ? session.split(';', 1)[0] : current
}

class BrowserSession {
  constructor({ monitorUrl, agentUrl, username, password }) {
    this.monitorUrl = monitorUrl
    this.agentUrl = agentUrl
    this.username = username
    this.password = password
    this.cookie = ''
    this.csrfToken = ''
  }

  async request(pathname, { method = 'GET', body, signal } = {}) {
    const headers = { Origin: this.monitorUrl }
    if (this.cookie) headers.Cookie = this.cookie
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (this.csrfToken && method !== 'GET') headers['X-CSRF-Token'] = this.csrfToken
    const response = await fetch(`${this.monitorUrl}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    this.cookie = cookieFrom(response, this.cookie)
    return response
  }

  async json(pathname, options) {
    const response = await this.request(pathname, options)
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }

  async login() {
    const result = await this.json('/api/login', {
      method: 'POST',
      body: { username: this.username, password: this.password, remember: false },
    })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    this.csrfToken = result.body.csrfToken
    return this
  }

  async associate({ nodeId } = {}) {
    const challenge = await this.json('/api/local-node/challenge', { method: 'POST', body: {} })
    assert.equal(challenge.status, 200, JSON.stringify(challenge.body))
    let agentResponse
    try {
      agentResponse = await fetch(this.agentUrl, {
        method: 'POST',
        headers: {
          Origin: this.monitorUrl,
          'Content-Type': 'application/json',
          ...(nodeId ? { 'X-Task13-Node-Id': nodeId } : {}),
        },
        body: JSON.stringify(challenge.body),
      })
    } catch (error) {
      throw new Error('loopback Agent unavailable', { cause: error })
    }
    if (!agentResponse.ok) throw new Error(`loopback Agent unavailable (${agentResponse.status})`)
    return this.json('/api/local-node/verify', {
      method: 'POST',
      body: await agentResponse.json(),
    })
  }

  get(pathname) {
    return this.json(pathname)
  }

  async openStream(alias) {
    const controller = new AbortController()
    const response = await this.request(`/api/cameras/${encodeURIComponent(alias)}/stream`, {
      signal: controller.signal,
    })
    const reader = response.body?.getReader()
    if (!reader) throw new Error('stream response has no body')
    const first = await reader.read()
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      firstChunk: first.value ?? new Uint8Array(),
      async close() {
        try { await reader.cancel() } finally { controller.abort() }
      },
    }
  }

  async logout() {
    const result = await this.json('/api/logout', { method: 'POST', body: {} })
    this.cookie = ''
    this.csrfToken = ''
    return result
  }
}

async function waitForPortReleased(port) {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const available = await new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (available) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`disposable port ${port} was not released`)
}

export async function withMachineANoPowerShellHarness(options, callback) {
  const { databaseUrl, pythonExecutable, monitorRoot, engineRoot } = options
  if (!databaseUrl || !pythonExecutable) throw new Error('Task 13 requires disposable PostgreSQL and Engine Python')
  await ensureBuilt(monitorRoot)

  const reservedPorts = await Promise.all([reservePort(), reservePort(), reservePort()])
  assert.equal(new Set(reservedPorts).size, reservedPorts.length)
  const [monitorPort, agentPort, enginePort] = reservedPorts
  const monitorUrl = `http://127.0.0.1:${monitorPort}`
  const agentUrl = `http://127.0.0.1:${agentPort}/v1/browser-association/assert`
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' })
  const fingerprint = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex')

  let database
  let engine
  let monitor
  let agent
  let callbackError
  try {
    database = await prepareDatabase({
      databaseUrl,
      monitorRoot,
      publicKeyPem,
      fingerprint,
      enginePort,
    })

    engine = spawn(pythonExecutable, [
      path.join(monitorRoot, 'tests', 'fixtures', 'machineAEngineHarness.py'),
      '--serve',
      '--port', String(enginePort),
      '--key', ENGINE_KEY,
    ], {
      cwd: engineRoot,
      env: { ...process.env, AEGIS_ENGINE_ROOT: engineRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const engineOutput = collectOutput(engine)
    await waitForUrl(`http://127.0.0.1:${enginePort}/health`, { child: engine, output: engineOutput })

    agent = createAgent({ port: agentPort, monitorOrigin: monitorUrl, privateKey })
    await agent.start()

    monitor = spawn(process.execPath, ['server/index.js'], {
      cwd: monitorRoot,
      env: {
        ...process.env,
        PORT: String(monitorPort),
        DATABASE_URL: database.scopedUrl,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'false',
        SESSION_SECRET: 'task13-disposable-session-secret-do-not-deploy',
        BROWSER_ASSOCIATION_AUDIENCE: AUDIENCE,
        AEGIS_REQUIRE_LOCAL_NODE_ASSOCIATION: 'true',
        AEGIS_MONITOR_STREAM_HOST: STREAM_HOST,
        AEGIS_TRUSTED_PHYSICAL_STREAM_SOURCES: JSON.stringify({
          [PHYSICAL_CAMERA_ID]: {
            nodeId: NODE_ID,
            url: `http://${STREAM_HOST}:${enginePort}/stream.mjpg`,
          },
        }),
        DETECTION_ENGINE_API_KEY: ENGINE_KEY,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const monitorOutput = collectOutput(monitor)
    await waitForUrl(`${monitorUrl}/healthz`, { child: monitor, output: monitorOutput })

    const db = new Client({ connectionString: database.scopedUrl })
    await db.connect()
    const harness = {
      monitorUrl,
      migrationRuns: 2,
      reservedPorts,
      forbiddenHarnessRequirements: Object.freeze({
        temporaryBridge: false,
        manualCam01Heartbeat: false,
        manualCam02Heartbeat: false,
        manualNpmRuntime: false,
        manualPythonHelperRuntime: false,
      }),
      async login(username, password) {
        return new BrowserSession({ monitorUrl, agentUrl, username, password }).login()
      },
      async engineHealth() {
        const response = await fetch(`http://127.0.0.1:${enginePort}/health`)
        const body = await response.json()
        return { cameraDemanded: body.camera_demanded, streamViewers: body.stream_viewers }
      },
      async waitForEngineState(expected) {
        const deadline = Date.now() + 8_000
        let current
        while (Date.now() < deadline) {
          current = await this.engineHealth()
          if (Object.entries(expected).every(([key, value]) => current[key] === value)) return current
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        throw new Error(`Engine state did not converge: expected=${JSON.stringify(expected)} actual=${JSON.stringify(current)}`)
      },
      async physicalCameraForNode(nodeId) {
        const result = await db.query(
          'SELECT physical_camera_id FROM physical_cameras WHERE node_id = $1',
          [nodeId],
        )
        return result.rows.length === 1 ? Number(result.rows[0].physical_camera_id) : null
      },
      async rotateNodeKeyVersion() {
        await db.query('UPDATE detection_nodes SET key_version = key_version + 1 WHERE node_id = $1', [NODE_ID])
      },
      stopAgent: () => agent.stop(),
      startAgent: () => agent.start(),
      async agePhysicalHeartbeat(ageMs) {
        await db.query(
          `UPDATE physical_camera_heartbeat
              SET last_seen_at = now() - ($1::bigint * interval '1 millisecond')
            WHERE physical_camera_id = $2`,
          [ageMs, PHYSICAL_CAMERA_ID],
        )
      },
    }
    try {
      await callback(harness)
    } finally {
      await db.end()
    }
  } catch (error) {
    callbackError = error
  } finally {
    const cleanupErrors = []
    for (const action of [
      () => agent?.stop(),
      () => stopChild(monitor),
      () => stopChild(engine),
      () => database && dropDatabaseSchema(databaseUrl, database.schema),
    ]) {
      try { await action() } catch (error) { cleanupErrors.push(error) }
    }
    for (const port of reservedPorts) {
      try { await waitForPortReleased(port) } catch (error) { cleanupErrors.push(error) }
    }
    if (!callbackError && cleanupErrors.length) callbackError = new AggregateError(cleanupErrors, 'Task 13 cleanup failed')
  }
  if (callbackError) throw callbackError
}
