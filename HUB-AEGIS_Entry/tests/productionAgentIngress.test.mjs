import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { parseNginx } from './helpers/nginxConfig.mjs'

const HUB_CONF_URL = new URL('../nginx.conf', import.meta.url)
const MONITOR_ENV_URL = new URL('../../IDEA2-AEGIS_Monitor/.env.example', import.meta.url)

const hubSource = readFileSync(HUB_CONF_URL, 'utf8')
const hubConf = parseNginx(hubSource)
const monitorEnv = readFileSync(MONITOR_ENV_URL, 'utf8')

const MACHINE_LOCATION = 'location ~ ^/monitor/internal/(?:agent-auth/(?:challenge|verify)|heartbeat|detections|alerts|clips)$'
const INTERNAL_DENY = 'location ~* ^/monitor/internal'
const RAW_URI_GUARD = 'if ($request_uri !~ "^/monitor/internal/(?:agent-auth/(?:challenge|verify)|heartbeat|detections|alerts|clips)$")'

const approvedPaths = [
  '/monitor/internal/agent-auth/challenge',
  '/monitor/internal/agent-auth/verify',
  '/monitor/internal/heartbeat',
  '/monitor/internal/detections',
  '/monitor/internal/alerts',
  '/monitor/internal/clips',
]

const rejectedPaths = [
  '/monitor/internal',
  '/monitor/internal/',
  '/monitor/internal/unknown',
  '/monitor/internal/Heartbeat',
  '/monitor/Internal/heartbeat',
  '/monitor/internal/heartbeat/x',
  '/monitor/internal/agent-auth/challenge/x',
  '/monitor/internal/heartbeat-extra',
  '/monitor/internalx/heartbeat',
]

function tlsServer() {
  const matches = hubConf.blocks.filter((block) => (
    block.header === 'server'
    && block.directives.some((directive) => /^listen 443 ssl\b/.test(directive))
  ))
  assert.equal(matches.length, 1, 'exactly one browser TLS server exists')
  return matches[0]
}

function oneBlock(scope, header) {
  const matches = scope.blocks.filter((block) => block.header === header)
  assert.equal(matches.length, 1, `exactly one ${header} block exists`)
  return matches[0]
}

function envValue(name) {
  const match = monitorEnv.match(new RegExp(`^${name}=(.*)$`, 'm'))
  assert.ok(match, `${name} is documented`)
  return match[1]
}

test('machine ingress is a case-sensitive exact allowlist ahead of the broad internal deny', () => {
  const server = tlsServer()
  const headers = server.blocks.map((block) => block.header)
  const allowIndex = headers.indexOf(MACHINE_LOCATION)
  const denyIndex = headers.indexOf(INTERNAL_DENY)
  assert.ok(allowIndex >= 0, 'the bounded machine allowlist exists')
  assert.ok(denyIndex >= 0, 'the broad case-insensitive deny remains')
  assert.ok(allowIndex < denyIndex, 'the exact allowlist wins before the broad regex deny')

  const routePattern = new RegExp(MACHINE_LOCATION.slice('location ~ '.length))
  for (const path of approvedPaths) assert.match(path, routePattern, `${path} is approved`)
  for (const path of rejectedPaths) assert.doesNotMatch(path, routePattern, `${path} stays denied`)
})

test('machine ingress rejects every non-canonical raw URI including all query strings', () => {
  const route = oneBlock(tlsServer(), MACHINE_LOCATION)
  const guard = oneBlock(route, RAW_URI_GUARD)
  assert.deepEqual(guard.directives, ['return 404'])

  const pattern = new RegExp(RAW_URI_GUARD.match(/"(.+)"/)[1])
  for (const path of approvedPaths) assert.match(path, pattern, `${path} is canonical`)
  for (const path of [
    ...rejectedPaths,
    '/monitor/internal/heartbeat?',
    '/monitor/internal/heartbeat?x=1',
    '/monitor/internal/agent-auth/challenge?node=edge-a',
    '/monitor//internal/heartbeat',
    '/monitor/internal/%68eartbeat',
  ]) assert.doesNotMatch(path, pattern, `${path} is rejected as non-canonical`)
})

test('machine ingress is POST-only, bounded, strips browser credentials, and preserves Agent proofs', () => {
  const route = oneBlock(tlsServer(), MACHINE_LOCATION)
  const postOnly = oneBlock(route, 'limit_except POST')
  assert.deepEqual(postOnly.directives, ['deny all'])

  for (const directive of [
    'set $monitor_upstream monitor:8002',
    'rewrite ^/monitor/?(.*)$ /$1 break',
    'proxy_pass http://$monitor_upstream',
    'proxy_http_version 1.1',
    'client_max_body_size 16k',
    'proxy_set_header Cookie ""',
    'proxy_set_header Authorization ""',
  ]) assert.ok(route.directives.includes(directive), `missing: ${directive}`)

  assert.ok(!route.directives.some((directive) => /X-Aegis-(Agent-Session|Request-)/i.test(directive)),
    'the edge does not clear or synthesize Agent proof headers')
})

test('the general Monitor route and Drive/Security routes remain separate from machine ingress', () => {
  const server = tlsServer()
  const monitor = oneBlock(server, 'location /monitor/')
  assert.ok(monitor.directives.includes('rewrite ^/monitor/?(.*)$ /$1 break'))
  assert.ok(monitor.directives.includes('proxy_pass http://$monitor_upstream'))
  assert.deepEqual(oneBlock(server, 'location = /monitor').directives, ['return 301 /monitor/'])
  assert.ok(server.blocks.some((block) => block.header === 'location /drive/'))
  assert.ok(server.blocks.some((block) => block.header === 'location /security/'))
})

test('Production examples use the same canonical HTTPS origin for Agent and browser association', () => {
  assert.equal(envValue('AGENT_AUTH_AUDIENCE'), 'https://aegis.internal')
  assert.equal(envValue('BROWSER_ASSOCIATION_AUDIENCE'), 'https://aegis.internal')
  assert.equal(envValue('AEGIS_REQUIRE_LOCAL_NODE_ASSOCIATION'), 'false')
})
