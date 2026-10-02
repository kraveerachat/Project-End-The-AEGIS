// Disposable functional smoke for the real nginx location-selection and
// inheritance behavior used by LFT-V2-C. This starts only uniquely named local
// containers and a uniquely named network, then removes exactly those resources.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

const ROOT = resolve(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const HUB_CONFIG = join(ROOT, 'HUB-AEGIS_Entry', 'nginx.conf')
const GATEWAY_CONFIG = join(ROOT, 'gateway', 'nginx.conf')
const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`
const networkName = `aegis-lft-v2-c-smoke-${suffix}`
const stubName = `aegis-lft-v2-c-stub-${suffix}`
const hubName = `aegis-lft-v2-c-hub-${suffix}`
const gatewayName = `aegis-lft-v2-c-gateway-${suffix}`
const scratch = mkdtempSync(join(tmpdir(), 'aegis-lft-v2-c-'))
const certDir = join(scratch, 'certs')
mkdirSync(certDir)

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function dockerLogs(container) {
  const result = spawnSync('docker', ['logs', container], { encoding: 'utf8' })
  return `${result.stdout || ''}${result.stderr || ''}`.trim()
}

function findOpenSsl() {
  const candidates = [
    process.env.OPENSSL_BIN,
    'openssl',
    ...(process.platform === 'win32' ? [
      'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
      'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    ] : ['/usr/bin/openssl', '/usr/local/bin/openssl']),
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (!existsSync(candidate)) continue
    }
    try {
      execFileSync(candidate, ['version'], { stdio: 'ignore' })
      return candidate
    } catch { /* try the next known local binary */ }
  }
  throw new Error('OpenSSL CLI is required to create the disposable smoke certificate')
}

function publishedPort(container, containerPort) {
  const output = docker(['port', container, `${containerPort}/tcp`])
  const match = output.match(/:(\d+)\s*$/)
  assert.ok(match, `${container}: Docker published ${containerPort}/tcp`)
  return Number(match[1])
}

function request({ protocol, port, path, method = 'GET', ca, body = Buffer.alloc(0), headers: extraHeaders = {} }) {
  const transport = protocol === 'https:' ? https : http
  const headers = {
    Host: 'aegis-smoke.internal',
    Forwarded: 'for=203.0.113.40;proto=http',
    'X-Forwarded-For': '203.0.113.41',
    'X-Real-IP': '203.0.113.42',
    ...extraHeaders,
  }
  if (body.length > 0) {
    headers['Content-Type'] = 'application/octet-stream'
    headers['Content-Length'] = String(body.length)
  }

  return new Promise((resolveRequest, reject) => {
    const req = transport.request({
      protocol,
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers,
      ...(ca ? { ca, servername: 'localhost' } : {}),
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolveRequest({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function verifyProductionAgentIngress({ port, ca }) {
  const approved = [
    '/monitor/internal/agent-auth/challenge',
    '/monitor/internal/agent-auth/verify',
    '/monitor/internal/heartbeat',
    '/monitor/internal/detections',
    '/monitor/internal/alerts',
    '/monitor/internal/clips',
  ]
  for (const path of approved) {
    const response = await request({
      protocol: 'https:', port, ca, path, method: 'POST', body: Buffer.from('{"fixture":true}'),
      headers: {
        Cookie: 'browser-session=must-not-cross-edge',
        Authorization: 'Bearer browser-credential-must-not-cross-edge',
        'X-Aegis-Agent-Session': 'agent-session-fixture',
        'X-Aegis-Request-Signature': 'agent-signature-fixture',
      },
    })
    assert.equal(response.status, 200, `${path} reaches Monitor only for canonical POST`)
    const upstream = JSON.parse(response.body)
    assert.equal(upstream.url, path.slice('/monitor'.length), 'the /monitor prefix is removed exactly once')
    assert.equal(upstream.headers.cookie, undefined, 'browser Cookie is stripped')
    assert.equal(upstream.headers.authorization, undefined, 'browser Authorization is stripped')
    assert.equal(upstream.headers['x-aegis-agent-session'], 'agent-session-fixture')
    assert.equal(upstream.headers['x-aegis-request-signature'], 'agent-signature-fixture')
  }

  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await request({ protocol: 'https:', port, ca, path: approved[2], method })
    assert.equal(response.status, 403, `${method} is rejected before Monitor`)
  }
  for (const path of [
    '/monitor/internal',
    '/monitor/internal/unknown',
    '/monitor/Internal/heartbeat',
    '/monitor/internal/Heartbeat',
    '/monitor/internal/heartbeat/x',
    '/monitor/internalx/heartbeat',
    '/monitor/internal/heartbeat?x=1',
    '/monitor/internal/agent-auth/challenge?node=edge-a',
  ]) {
    const response = await request({ protocol: 'https:', port, ca, path, method: 'POST' })
    assert.equal(response.status, 404, `${path} remains denied at the edge`)
  }
  const oversized = await request({
    protocol: 'https:', port, ca, path: approved[3], method: 'POST', body: Buffer.alloc((16 * 1024) + 1),
  })
  assert.equal(oversized.status, 413, 'machine ingress body is bounded to 16 KiB')
}

async function waitForEdge(options) {
  let lastError
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await request({ ...options, path: '/healthz' })
    } catch (error) {
      lastError = error
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
  }
  throw lastError
}

function assertForwarding(upstream, protocol) {
  assert.equal(upstream.headers.host, 'aegis-smoke.internal')
  assert.equal(upstream.headers['x-forwarded-proto'], protocol)
  assert.equal(upstream.headers['x-forwarded-host'], 'aegis-smoke.internal')
  assert.equal(upstream.headers.forwarded, undefined, 'client-supplied Forwarded is cleared')
  assert.notEqual(upstream.headers['x-forwarded-for'], '203.0.113.41', 'spoofed XFF is overwritten')
  assert.notEqual(upstream.headers['x-real-ip'], '203.0.113.42', 'spoofed X-Real-IP is overwritten')
  assert.equal(upstream.headers['x-forwarded-for'], upstream.headers['x-real-ip'])
}

function assertHubSecurityHeaders(headers) {
  const csp = headers['content-security-policy']
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/)
  assert.match(csp, /img-src 'self' data: blob:/)
  assert.match(csp, /media-src 'self' blob:/)
  assert.equal(headers['x-frame-options'], 'DENY')
  assert.equal(headers['x-content-type-options'], 'nosniff')
  assert.equal(headers['referrer-policy'], 'no-referrer')
  assert.equal(headers['permissions-policy'], 'camera=(), microphone=(), geolocation=(), payment=()')
}

async function verifyEdge({ name, protocol, port, ca }) {
  const id = 'a'.repeat(48)
  const cases = [
    { method: 'PUT', path: `/drive/api/files/uploads/${id}/chunks/0`, upstream: `/api/files/uploads/${id}/chunks/0` },
    { method: 'PUT', path: `/drive/api/vault/uploads/${id}/chunks/0`, upstream: `/api/vault/uploads/${id}/chunks/0` },
    { method: 'POST', path: `/drive/api/files/uploads/${id}/commit`, upstream: `/api/files/uploads/${id}/commit` },
    { method: 'POST', path: `/drive/api/vault/uploads/${id}/commit`, upstream: `/api/vault/uploads/${id}/commit` },
    { method: 'POST', path: '/drive/api/files/upload', upstream: '/api/files/upload' },
  ]

  for (const item of cases) {
    const response = await request({
      protocol,
      port,
      ca,
      path: item.path,
      method: item.method,
      body: item.method === 'PUT' ? Buffer.from('bounded-smoke-chunk') : Buffer.alloc(0),
    })
    assert.equal(
      response.status,
      200,
      `${name}: ${item.path} reaches the stub upstream; server=${response.headers.server}; body=${response.body}`,
    )
    const upstream = JSON.parse(response.body)
    assert.equal(upstream.method, item.method)
    assert.equal(upstream.url, item.upstream, `${name}: /drive prefix is removed exactly once`)
    assertForwarding(upstream, protocol === 'https:' ? 'https' : 'http')
    if (name === 'production HUB') assertHubSecurityHeaders(response.headers)
  }

  const blocked = await request({ protocol, port, ca, path: '/monitor/internal/unknown' })
  assert.equal(blocked.status, 404, `${name}: /monitor/internal remains blocked at the edge`)
}

const createdContainers = []
let networkCreated = false

try {
  docker(['network', 'create', networkName])
  networkCreated = true

  execFileSync(findOpenSsl(), [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', join(certDir, 'aegis.key'),
    '-out', join(certDir, 'aegis.crt'),
  ], { stdio: 'ignore' })

  const stubProgram = [
    "const http=require('http')",
    "const handler=(req,res)=>{let bytes=0;req.on('data',c=>bytes+=c.length);req.on('end',()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({method:req.method,url:req.url,headers:req.headers,bytes}))})}",
    "for(const port of [8001,8002])http.createServer(handler).listen(port,'0.0.0.0')",
  ].join(';')
  docker([
    'run', '-d', '--name', stubName,
    '--network', networkName, '--network-alias', 'drive-proxy', '--network-alias', 'monitor',
    'node:20-alpine', 'node', '-e', stubProgram,
  ])
  createdContainers.push(stubName)

  // Explicit syntax gates use the same files and mounts as the functional run.
  docker([
    'run', '--rm', '--network', networkName,
    '-v', `${HUB_CONFIG}:/etc/nginx/conf.d/default.conf:ro`,
    '-v', `${certDir}:/etc/nginx/certs:ro`,
    'nginx:alpine', 'nginx', '-t',
  ])
  docker([
    'run', '--rm', '--network', networkName,
    '-v', `${GATEWAY_CONFIG}:/etc/nginx/conf.d/default.conf:ro`,
    'nginx:alpine', 'nginx', '-t',
  ])

  docker([
    'run', '-d', '--name', hubName, '--network', networkName,
    '-p', '127.0.0.1::443',
    '-v', `${HUB_CONFIG}:/etc/nginx/conf.d/default.conf:ro`,
    '-v', `${certDir}:/etc/nginx/certs:ro`,
    'nginx:alpine',
  ])
  createdContainers.push(hubName)

  docker([
    'run', '-d', '--name', gatewayName, '--network', networkName,
    '-p', '127.0.0.1::80',
    '-v', `${GATEWAY_CONFIG}:/etc/nginx/conf.d/default.conf:ro`,
    'nginx:alpine',
  ])
  createdContainers.push(gatewayName)

  const hubPort = publishedPort(hubName, 443)
  const gatewayPort = publishedPort(gatewayName, 80)
  const ca = readFileSync(join(certDir, 'aegis.crt'))
  await waitForEdge({ protocol: 'https:', port: hubPort, ca })
  await waitForEdge({ protocol: 'http:', port: gatewayPort })

  await verifyEdge({ name: 'production HUB', protocol: 'https:', port: hubPort, ca })
  await verifyEdge({ name: 'development gateway', protocol: 'http:', port: gatewayPort })
  await verifyProductionAgentIngress({ port: hubPort, ca })
  console.log('NGINX_RUNTIME_SYNTAX_GATE=PASS')
  console.log('NGINX_FUNCTIONAL_ROUTING_SMOKE=PASS')
  console.log('NGINX_SMOKE_CASES=32')
} catch (error) {
  for (const container of createdContainers) {
    try {
      console.error(`DOCKER_LOGS_BEGIN=${container}`)
      console.error(dockerLogs(container))
      console.error(`DOCKER_LOGS_END=${container}`)
    } catch { /* the failed container may already have exited */ }
  }
  throw error
} finally {
  for (const container of createdContainers.reverse()) {
    try { docker(['rm', '-f', container]) } catch { /* exact disposable resource only */ }
  }
  if (networkCreated) {
    try { docker(['network', 'rm', networkName]) } catch { /* exact disposable resource only */ }
  }
  rmSync(scratch, { recursive: true, force: true })
}
