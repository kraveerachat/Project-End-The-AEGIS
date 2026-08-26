// tests/telemetryClient.test.js — AEGIS Drive (IDEA1) · host agent client
//
// Platform note: Node maps `socketPath` to AF_UNIX on POSIX and to a named pipe
// on Windows. The client code and every assertion here are identical on both —
// what is proven everywhere is that the client addresses a path and has no way
// to express a host or a port. The production transport is AF_UNIX.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES, fetchHostTelemetry,
} from '../server/telemetry/client.js'

const IS_WINDOWS = process.platform === 'win32'
let counter = 0
const nextSocketPath = () => {
  counter += 1
  return IS_WINDOWS
    ? `\\\\.\\pipe\\aegis-drive-client-test-${process.pid}-${counter}`
    : path.join(os.tmpdir(), `aegis-drive-client-${process.pid}-${counter}.sock`)
}

const NOW = Date.parse('2026-08-27T10:00:00.000Z')
const snapshotBody = (measuredAt = '2026-08-27T09:59:58.000Z') => ({
  schemaVersion: 1,
  measuredAt,
  metrics: {
    cpu: { available: true, percent: 12.3, windowSeconds: 5 },
    memory: { available: true, usedBytes: 3_150_000_000, totalBytes: 8_333_651_968, percent: 37.8 },
    network: { available: true, interface: 'enp1s0', rxBytesPerSec: 1024, txBytesPerSec: 512, windowSeconds: 5 },
    uptime: { available: true, hostSeconds: 86_400.55 },
  },
})

const servers = []
/** Stand up a fake agent whose handler the test controls completely. */
async function fakeAgent(handler) {
  const socketPath = nextSocketPath()
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(socketPath, resolve))
  servers.push(server)
  return socketPath
}

after(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve))
})

test('a healthy agent yields a validated snapshot', async () => {
  const socketPath = await fakeAgent((req, res) => {
    assert.equal(req.method, 'GET')
    assert.equal(req.url, '/internal/telemetry')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(snapshotBody()))
  })

  const result = await fetchHostTelemetry({ socketPath, now: NOW })
  assert.equal(result.ok, true)
  assert.equal(result.snapshot.metrics.cpu.percent, 12.3)
  assert.equal(result.snapshot.metrics.network.interface, 'enp1s0')
})

// ── TELEM-11C · Unix socket only ──────────────────────────────────────
test('TELEM-11C the client can only address a socket path, never a host or port', async () => {
  // There is no parameter through which a URL could enter, and anything that
  // looks like one is refused rather than coerced into a request.
  for (const [label, socketPath] of [
    ['http url', 'http://127.0.0.1:9100/internal/telemetry'],
    ['https url', 'https://telemetry.internal/metrics'],
    ['host:port', '127.0.0.1:9100'],
    ['bare host', 'localhost'],
    ['empty', ''],
    ['not a string', 9100],
    ['null', null],
  ]) {
    const result = await fetchHostTelemetry({ socketPath, now: NOW })
    assert.equal(result.ok, false, `${label} must be refused`)
    assert.equal(result.reason, 'invalid-socket-path', `${label} must be refused as a path, not attempted`)
  }
})

test('the client exposes no host, port, or protocol option', async () => {
  const source = await (await import('node:fs/promises'))
    .readFile(new URL('../server/telemetry/client.js', import.meta.url), 'utf8')
  for (const forbidden of ['http://', 'https://', 'port:', 'hostname:', 'node:https']) {
    assert.ok(!source.includes(forbidden), `client.js must not reference ${forbidden}`)
  }
})

// ── timeout ───────────────────────────────────────────────────────────
test('the client timeout defaults to 1500 ms and cannot be raised past it', async () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 1500)

  const socketPath = await fakeAgent(() => { /* never responds */ })
  const startedAt = Date.now()
  // A caller asking for 30s must not be able to hold a Drive request open.
  const result = await fetchHostTelemetry({ socketPath, timeoutMs: 30_000, now: NOW })
  const elapsed = Date.now() - startedAt

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'timeout')
  assert.ok(elapsed < 5_000, `expected the 1500 ms cap to apply, waited ${elapsed} ms`)
})

test('a shorter timeout is honoured', async () => {
  const socketPath = await fakeAgent(() => { /* never responds */ })
  const result = await fetchHostTelemetry({ socketPath, timeoutMs: 200, now: NOW })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'timeout')
})

// ── failure never propagates ──────────────────────────────────────────
test('an absent agent is reported, never thrown', async () => {
  const missing = nextSocketPath()
  await assert.doesNotReject(async () => {
    const result = await fetchHostTelemetry({ socketPath: missing, now: NOW })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'unreachable')
  })
})

test('a non-200 status, empty body, or non-JSON body is reported, never thrown', async () => {
  const cases = [
    ['503 no-sample-yet', (res) => { res.writeHead(503); res.end(JSON.stringify({ error: 'no-sample-yet' })) }, 'agent-status-503'],
    ['500', (res) => { res.writeHead(500); res.end('boom') }, 'agent-status-500'],
    ['404', (res) => { res.writeHead(404); res.end('{}') }, 'agent-status-404'],
    ['html body', (res) => { res.writeHead(200); res.end('<html>nope</html>') }, 'malformed-json'],
    ['empty body', (res) => { res.writeHead(200); res.end('') }, 'malformed-json'],
  ]
  for (const [label, respond, expected] of cases) {
    const socketPath = await fakeAgent((_req, res) => respond(res))
    const result = await fetchHostTelemetry({ socketPath, now: NOW })
    assert.equal(result.ok, false, label)
    assert.equal(result.reason, expected, label)
  }
})

test('an oversized response is cut off instead of buffered without bound', async () => {
  assert.equal(MAX_RESPONSE_BYTES, 64 * 1024)
  const socketPath = await fakeAgent((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    // A compromised or broken agent must not be able to exhaust Drive's memory.
    res.end(`{"pad":"${'x'.repeat(MAX_RESPONSE_BYTES + 1024)}"}`)
  })
  const result = await fetchHostTelemetry({ socketPath, now: NOW })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'response-too-large')
})

test('a structurally invalid snapshot is rejected with the schema reason', async () => {
  const socketPath = await fakeAgent((_req, res) => {
    const body = snapshotBody()
    body.metrics.cpu = { available: true, percent: 400, windowSeconds: 5 }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  const result = await fetchHostTelemetry({ socketPath, now: NOW })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'metrics.cpu-percent-out-of-range')
})

test('an agent that hangs up mid-body is reported, never thrown', async () => {
  const socketPath = await fakeAgent((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '999' })
    res.write('{"schemaVersion":1,')
    res.destroy()
  })
  await assert.doesNotReject(async () => {
    const result = await fetchHostTelemetry({ socketPath, now: NOW })
    assert.equal(result.ok, false)
  })
})
