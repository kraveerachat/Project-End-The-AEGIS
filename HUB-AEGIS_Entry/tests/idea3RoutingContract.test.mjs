// HUB-AEGIS_Entry/tests/idea3RoutingContract.test.mjs — the HUB edge contract
// for IDEA3 (PR11 Phase 2, integration requests IR-1, IR-2 and IR-3).
//
// This suite exists because the K1 reconciliation replaced the reviewed HUB
// artifact with the bytes that were actually running in Production, and then
// added the IDEA3 browser route on top. Two things therefore need proving in
// the repository, not in a reviewer's memory:
//
//   1. PRESERVATION — every Drive, Monitor, TLS, redirect, health and landing
//      behavior that the live artifact had still reads exactly the same. A
//      Phase 2A HUB recreate installs this file, so a silent regression here
//      would be deployed as "the IDEA3 change".
//
//   2. ADDITION — the IDEA3 browser route matches the accepted IR-1 contract,
//      and the machine route stays out of the browser block entirely.
//
// The Phase 2B mTLS block lives in nginx.idea3-machine-phase2b.conf and is
// deliberately NOT included by nginx.conf: the certificate, client-CA and CRL
// files do not exist yet, so including it would make `nginx -t` fail and would
// ship in the Phase 2A window. This suite pins that separation too.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseNginx } from './helpers/nginxConfig.mjs'

const HUB_CONF_URL = new URL('../nginx.conf', import.meta.url)
const MACHINE_CONF_URL = new URL('../nginx.idea3-machine-phase2b.conf', import.meta.url)

const hubSource = readFileSync(HUB_CONF_URL, 'utf8')
const hubConf = parseNginx(hubSource)
const machineConf = parseNginx(readFileSync(MACHINE_CONF_URL, 'utf8'))

const IDEA3_WEB = '172.31.243.3'

/** The TLS server block — the only one that serves anything to a browser. */
function tlsServer() {
  const servers = hubConf.blocks.filter((block) => block.header === 'server')
  const tls = servers.filter((block) => block.directives.some((d) => /^listen 443 ssl\b/.test(d)))
  assert.equal(tls.length, 1, 'exactly one server block listens on 443 ssl')
  return tls[0]
}

function locationBlock(scope, header) {
  const matches = scope.blocks.filter((block) => block.header === header)
  assert.equal(matches.length, 1, `exactly one "${header}" block exists`)
  return matches[0]
}

test('IR-1: the browser block is the default_server on 443, for IPv4 and IPv6', () => {
  const directives = tlsServer().directives
  assert.ok(directives.includes('listen 443 ssl default_server'), 'IPv4 443 is default_server')
  assert.ok(directives.includes('listen [::]:443 ssl default_server'), 'IPv6 443 is default_server')
  // An unknown or absent SNI must land here, never on the future machine block.
  assert.ok(directives.includes('server_name _'), 'the browser block still answers any name')
})

test('IR-1: /security redirects, and /security/ proxies the full path to IDEA3', () => {
  const server = tlsServer()
  assert.deepEqual(locationBlock(server, 'location = /security').directives, ['return 301 /security/'])

  const security = locationBlock(server, 'location /security/')
  // No URI part on proxy_pass and no rewrite: IDEA3 mounts /security itself.
  assert.ok(security.directives.includes(`proxy_pass http://${IDEA3_WEB}:8003`), 'proxies to the pinned IDEA3 address')
  assert.ok(!security.directives.some((d) => d.startsWith('rewrite ')), 'the /security prefix is never stripped')
  // A URI part on proxy_pass would replace the matched prefix, which is exactly
  // what /drive/ and /monitor/ do and what /security/ must never do.
  const target = security.directives.find((d) => d.startsWith('proxy_pass ')).slice('proxy_pass '.length)
  assert.ok(!target.replace(/^https?:\/\//, '').includes('/'), 'proxy_pass carries no URI part')
  assert.ok(security.directives.includes('proxy_http_version 1.1'))
  assert.ok(security.directives.includes('client_max_body_size 64k'))
})

test('IR-1: the edge sets the proxy identity and clears anything a client sent', () => {
  const security = locationBlock(tlsServer(), 'location /security/')
  for (const directive of [
    'proxy_set_header Host $http_host',
    'proxy_set_header X-Forwarded-For $remote_addr',
    'proxy_set_header X-Forwarded-Proto https',
    'proxy_set_header X-Forwarded-Host ""',
    'proxy_set_header X-Real-IP ""',
    'proxy_set_header Forwarded ""',
    // A browser must never be able to forge machine identity.
    'proxy_set_header X-Aegis-Client-Verify ""',
    'proxy_set_header X-Aegis-Client-Dn ""',
  ]) {
    assert.ok(security.directives.includes(directive), `missing: ${directive}`)
  }
})

test('IR-1: nginx owns every security header on /security/*', () => {
  const security = locationBlock(tlsServer(), 'location /security/')
  const owned = [
    'Content-Security-Policy', 'Cross-Origin-Opener-Policy', 'Cross-Origin-Resource-Policy',
    'Origin-Agent-Cluster', 'Referrer-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options',
    'X-DNS-Prefetch-Control', 'X-Download-Options', 'X-Frame-Options',
    'X-Permitted-Cross-Domain-Policies', 'X-XSS-Protection',
  ]
  for (const header of owned) {
    assert.ok(security.directives.includes(`proxy_hide_header ${header}`), `IDEA3's ${header} must be hidden`)
    assert.ok(
      security.directives.some((d) => d.startsWith(`add_header ${header} "`) && d.endsWith(' always')),
      `${header} must be re-declared with always`,
    )
  }
  // Intentionally stricter than IDEA3's own SAMEORIGIN.
  assert.ok(security.directives.includes('add_header X-Frame-Options "DENY" always'))
  // The edge policy mirrors what IDEA3 declares for itself (design §4.10).
  const csp = security.directives.find((d) => d.startsWith('add_header Content-Security-Policy'))
  const expected = [
    "default-src 'self'", "base-uri 'self'", "font-src 'self'", "form-action 'self'",
    "frame-ancestors 'none'", "img-src 'self' data:", "object-src 'none'", "script-src 'self'",
    "script-src-attr 'none'", "style-src 'self' 'unsafe-inline'", 'upgrade-insecure-requests',
    "connect-src 'self'",
  ]
  const directives = csp.slice(csp.indexOf('"') + 1, csp.lastIndexOf('"')).split(';').map((part) => part.trim())
  assert.deepEqual(directives, expected, 'edge CSP must equal the policy IDEA3 declares')
  assert.ok(security.directives.some((d) => d.startsWith('add_header Permissions-Policy "')), 'the edge adds Permissions-Policy')
})

test('IR-1/IR-2: the browser block refuses the machine path in any case variant', () => {
  const guard = locationBlock(tlsServer(), 'location ~* ^/security/api/machine(/|$)')
  assert.deepEqual(guard.directives, ['return 404'])
  // Route separation is enforced by listener, not only by path: nothing in the
  // browser block may reach the machine listener on 8004.
  assert.ok(!hubSource.includes(':8004'), 'the browser artifact never references the machine port')
  assert.ok(!hubSource.includes('ssl_verify_client'), 'mTLS never appears in the browser artifact')
})

test('IR-2: the Phase 2B machine block is reviewed but not yet included', () => {
  assert.ok(!/\binclude\b[^;]*idea3-machine-phase2b/.test(hubSource), 'nginx.conf must not include the Phase 2B file yet')

  const servers = machineConf.blocks.filter((block) => block.header === 'server')
  assert.equal(servers.length, 1, 'the Phase 2B file declares exactly one server block')
  const machine = servers[0]
  assert.ok(machine.directives.includes('server_name idea3-core.aegis.internal'))
  // A separate server certificate: a shared one lets browsers coalesce HTTP/2
  // connections across the browser and machine blocks.
  assert.ok(machine.directives.includes('ssl_certificate /etc/nginx/certs/idea3-core.aegis.internal.crt'))
  assert.ok(!machine.directives.some((d) => d.includes('aegis.crt')), 'the machine block never reuses the browser certificate')
  for (const directive of [
    'ssl_client_certificate /etc/nginx/certs/idea3-machine-client-ca.crt',
    'ssl_crl /etc/nginx/certs/idea3-machine-client-ca.crl',
    'ssl_verify_client on',
    'ssl_verify_depth 1',
  ]) {
    assert.ok(machine.directives.includes(directive), `missing: ${directive}`)
  }
  assert.ok(!machine.directives.includes('listen 443 ssl default_server'), 'the machine block is never the default server')

  const route = locationBlock(machine, 'location /security/api/machine/v1/')
  assert.ok(route.directives.includes(`proxy_pass http://${IDEA3_WEB}:8004`), 'the machine route reaches only the machine listener')
  assert.ok(route.directives.includes('proxy_set_header X-Aegis-Client-Verify $ssl_client_verify'))
  assert.ok(route.directives.includes('proxy_set_header X-Aegis-Client-Dn $ssl_client_s_dn'))
  for (const cleared of ['Cookie', 'Origin', 'X-Forwarded-For', 'X-Forwarded-Proto', 'X-Forwarded-Host', 'X-Real-IP', 'Forwarded']) {
    assert.ok(route.directives.includes(`proxy_set_header ${cleared} ""`), `${cleared} must be cleared`)
  }
  assert.ok(route.directives.includes('client_max_body_size 8k'))
  assert.deepEqual(locationBlock(machine, 'location /').directives, ['return 404'], 'everything else is 404')
})

test('preservation: the Drive route and its owned headers are unchanged', () => {
  const drive = locationBlock(tlsServer(), 'location /drive/')
  assert.ok(drive.directives.includes('set $drive_upstream drive-proxy:8001'))
  assert.ok(drive.directives.includes('rewrite ^/drive/?(.*)$ /$1 break'))
  assert.ok(drive.directives.includes('proxy_pass http://$drive_upstream'))
  assert.ok(drive.directives.includes('client_max_body_size 512m'))
  assert.ok(drive.directives.includes('proxy_set_header Host $http_host'))
  // The Vault preview grant must survive: blob: on img-src and media-src only.
  const csp = drive.directives.find((d) => d.startsWith('add_header Content-Security-Policy'))
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/)
  assert.match(csp, /img-src 'self' data: blob:/)
  assert.match(csp, /media-src 'self' blob:/)
  // The bounded-chunk children still exist with their own ceilings.
  const children = drive.blocks.map((block) => block.header)
  for (const header of [
    'location ~* ^/drive/api/files/uploads/[^/]+/chunks/[^/]+/?$',
    'location ~* ^/drive/api/vault/uploads/[^/]+/chunks/[^/]+/?$',
    'location ~* ^/drive/api/files/uploads/[^/]+/commit/?$',
    'location ~* ^/drive/api/vault/uploads/[^/]+/commit/?$',
    'location ~* ^/drive/api/files/[^/]+/download/?$',
    'location ~* ^/drive/api/vault/blobs/[^/]+/chunks/[^/]+/?$',
  ]) {
    assert.ok(children.includes(header), `missing Drive child location: ${header}`)
  }
  assert.deepEqual(locationBlock(tlsServer(), 'location = /drive').directives, ['return 301 /drive/'])
})

test('preservation: the Monitor route, its internal guard, health and landing page are unchanged', () => {
  const server = tlsServer()
  const monitor = locationBlock(server, 'location /monitor/')
  // The live artifact resolves Monitor by Docker name; K1 adopted that.
  assert.ok(monitor.directives.includes('set $monitor_upstream monitor:8002'))
  assert.ok(monitor.directives.includes('proxy_pass http://$monitor_upstream'))
  assert.ok(monitor.directives.includes('rewrite ^/monitor/?(.*)$ /$1 break'))
  assert.ok(monitor.directives.includes('proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for'))
  assert.deepEqual(locationBlock(server, 'location = /monitor').directives, ['return 301 /monitor/'])
  // Defense in depth for the Detection Engine ingest surface, case-insensitive.
  assert.deepEqual(locationBlock(server, 'location ~* ^/monitor/internal(/|$)').directives, ['return 404'])

  const health = locationBlock(server, 'location = /healthz')
  assert.ok(health.directives.some((d) => d.startsWith('return 200') && d.includes('routing-only')))
  assert.deepEqual(locationBlock(server, 'location /').directives, ['try_files $uri $uri/ /index.html'])
})

test('preservation: TLS material, resolver and the HTTP redirect are unchanged', () => {
  const server = tlsServer()
  for (const directive of [
    'ssl_certificate /etc/nginx/certs/aegis.crt',
    'ssl_certificate_key /etc/nginx/certs/aegis.key',
    'ssl_protocols TLSv1.2 TLSv1.3',
    'ssl_ciphers HIGH:!aNULL:!MD5',
    'ssl_prefer_server_ciphers on',
    'resolver 127.0.0.11 valid=10s ipv6=off',
    // Adopted from the live artifact by K1.
    'resolver_timeout 5s',
    'root /usr/share/nginx/html',
  ]) {
    assert.ok(server.directives.includes(directive), `missing: ${directive}`)
  }

  const redirect = hubConf.blocks
    .filter((block) => block.header === 'server')
    .find((block) => block.directives.includes('listen 80'))
  assert.ok(redirect, 'the port 80 server block still exists')
  assert.ok(redirect.directives.includes('return 301 https://$host$request_uri'))
})

test('the artifact contains no certificate, key or credential material', () => {
  assert.ok(!/-----BEGIN/.test(hubSource), 'no inline key or certificate')
  assert.ok(!/\b(password|passwd|secret|token)\s*[=:]/i.test(hubSource), 'no credential assignment')
})
