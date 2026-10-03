import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { parseNginx } from './helpers/nginxConfig.mjs'
import { securityHeaders } from '../../IDEA2-AEGIS_Monitor/server/middleware/securityHeaders.js'

const AGENT_ORIGIN = 'http://127.0.0.1:8078'
const config = parseNginx(readFileSync(new URL('../nginx.conf', import.meta.url), 'utf8'))
const server = config.blocks.find((block) => block.header === 'server'
  && block.directives.some((directive) => /^listen 443 ssl\b/.test(directive)))
assert.ok(server, 'the Production TLS server exists')

function location(header) {
  const matches = server.blocks.filter((block) => block.header === header)
  assert.equal(matches.length, 1, `exactly one ${header} location exists`)
  return matches[0]
}

function headers(block) {
  const result = new Map()
  for (const directive of block.directives) {
    const match = /^add_header\s+(\S+)\s+"([^"]*)"\s+always$/.exec(directive)
    if (!match) continue
    const name = match[1].toLowerCase()
    assert.equal(result.has(name), false, `duplicate ${name} in ${block.header}`)
    result.set(name, match[2])
  }
  return result
}

function csp(policy) {
  assert.equal(typeof policy, 'string', 'Content-Security-Policy is present')
  const result = new Map()
  for (const raw of policy.split(';')) {
    const parts = raw.trim().split(/\s+/).filter(Boolean)
    if (!parts.length) continue
    assert.equal(result.has(parts[0]), false, `duplicate CSP directive ${parts[0]}`)
    result.set(parts[0], parts.slice(1))
  }
  return result
}

function monitorAppHeaders() {
  const result = new Map()
  let nextCalls = 0
  securityHeaders({}, { setHeader: (name, value) => result.set(name.toLowerCase(), value) }, () => { nextCalls += 1 })
  assert.equal(nextCalls, 1)
  return result
}

test('both enforced Monitor CSP layers allow only the exact browser-association Agent origin', () => {
  const edge = csp(headers(location('location /monitor/')).get('content-security-policy'))
  const app = csp(monitorAppHeaders().get('content-security-policy'))

  for (const [label, policy] of [['HUB /monitor/', edge], ['Monitor application', app]]) {
    assert.deepEqual(policy.get('connect-src'), ["'self'", AGENT_ORIGIN], `${label} connect-src is narrow`)
    const sources = policy.get('connect-src')
    for (const forbidden of ['http://localhost:8078', 'http://127.0.0.1:8079', 'https://example.com', '*', 'http:', 'https:']) {
      assert.equal(sources.includes(forbidden), false, `${label} rejects ${forbidden}`)
    }
  }
})

test('/monitor/ changes no other HUB CSP directive or required security header', () => {
  const global = headers(server)
  const monitor = headers(location('location /monitor/'))
  assert.deepEqual([...monitor.keys()].sort(), [...global.keys()].sort(), 'location repeats every server security header')
  for (const [name, value] of global) {
    if (name !== 'content-security-policy') assert.equal(monitor.get(name), value, `${name} is retained verbatim`)
  }

  const expectedCsp = csp(global.get('content-security-policy'))
  const actualCsp = csp(monitor.get('content-security-policy'))
  assert.deepEqual(expectedCsp.get('connect-src'), ["'self'"], 'global HUB policy remains unchanged')
  expectedCsp.set('connect-src', ["'self'", AGENT_ORIGIN])
  assert.deepEqual(actualCsp, expectedCsp, 'connect-src is the only HUB CSP change')

})

test('/monitor/ retains the upstream CSP intersection for every non-connect directive', () => {
  // The pre-fix browser saw both the app and HUB policies. In particular,
  // their img-src data tokens differ, so hiding the app CSP broadens effective
  // image permissions even if the HUB policy itself is copied verbatim.
  const hidden = location('location /monitor/').directives
    .filter((directive) => /^proxy_hide_header\s/i.test(directive))
  assert.deepEqual(hidden, [], 'the existing upstream security headers stay forwarded')
  assert.deepEqual(csp(monitorAppHeaders().get('content-security-policy')).get('img-src'), ["'self'", 'data'])
  assert.deepEqual(csp(headers(location('location /monitor/')).get('content-security-policy')).get('img-src'), ["'self'", 'data:'])
})

test('the Monitor application retains all other security headers and CSP directives', () => {
  const app = monitorAppHeaders()
  const edge = headers(location('location /monitor/'))
  for (const name of ['x-frame-options', 'x-content-type-options', 'referrer-policy', 'strict-transport-security', 'permissions-policy']) {
    assert.equal(app.get(name), edge.get(name), `${name} remains unchanged across layers`)
  }
  const policy = csp(app.get('content-security-policy'))
  assert.deepEqual([...policy.entries()], [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'"]],
    ['style-src', ["'self'"]],
    ['img-src', ["'self'", 'data']],
    ['font-src', ["'self'"]],
    ['connect-src', ["'self'", AGENT_ORIGIN]],
    ['frame-ancestors', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'self'"]],
    ['object-src', ["'none'"]],
  ])
})

test('HUB root, Drive, IDEA3 and internal machine ingress do not gain the Agent origin', () => {
  assert.equal(headers(server).get('content-security-policy').includes(AGENT_ORIGIN), false)
  for (const header of ['location /drive/', 'location /security/']) {
    assert.equal(headers(location(header)).get('content-security-policy').includes(AGENT_ORIGIN), false, `${header} stays strict`)
  }
  const internal = location('location ~* ^/monitor/internal')
  assert.ok(internal.directives.includes('return 404'), 'internal machine ingress guard remains denied')
  assert.equal(headers(internal).size, 0, 'internal guard has no loopback CSP override')
})
