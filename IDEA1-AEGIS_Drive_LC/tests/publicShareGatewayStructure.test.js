// tests/publicShareGatewayStructure.test.js — PUBLIC-SHARE-3 security shape
//
// This suite guards the dedicated gateway as source. Runtime behavior is pinned
// separately in publicShareGatewayRuntime.test.js against real containers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const GATEWAY_ROOT = new URL('../../gateway/public-share/', import.meta.url)
const readGateway = (name) => readFileSync(new URL(name, GATEWAY_ROOT), 'utf8')

/**
 * Parse the nginx subset used here. Quoted strings, comments, semicolons and
 * nested blocks are understood; malformed braces/strings fail closed.
 */
function parseNginx(source) {
  let index = 0

  function parseBlock(nested) {
    const node = { directives: [], blocks: [] }
    let token = ''

    while (index < source.length) {
      const char = source[index]
      if (char === '"' || char === "'") {
        let end = index + 1
        while (end < source.length && source[end] !== char) {
          if (source[end] === '\\') end += 1
          end += 1
        }
        assert.ok(end < source.length, `unterminated ${char} string near offset ${index}`)
        token += source.slice(index, end + 1)
        index = end + 1
        continue
      }
      if (char === '#') {
        while (index < source.length && source[index] !== '\n') index += 1
        continue
      }
      if (char === ';') {
        const directive = token.trim().replace(/\s+/g, ' ')
        if (directive) node.directives.push(directive)
        token = ''
        index += 1
        continue
      }
      if (char === '{') {
        index += 1
        const child = parseBlock(true)
        node.blocks.push({ header: token.trim().replace(/\s+/g, ' '), ...child })
        token = ''
        continue
      }
      if (char === '}') {
        index += 1
        assert.ok(nested, 'unbalanced closing brace in nginx config')
        return node
      }
      token += char
      index += 1
    }

    assert.equal(nested, false, 'unbalanced opening brace in nginx config')
    return node
  }

  return parseBlock(false)
}

function directBlock(parent, header, label = header) {
  const matches = parent.blocks.filter((block) => block.header === header)
  assert.equal(matches.length, 1, `${label}: expected exactly one block`)
  return matches[0]
}

function directiveValues(block, name) {
  const prefix = `${name} `
  return block.directives
    .filter((value) => value === name || value.startsWith(prefix))
    .map((value) => value.slice(name.length).trim())
}

function oneDirective(block, name, label = name) {
  const values = directiveValues(block, name)
  assert.equal(values.length, 1, `${label}: expected exactly one ${name}`)
  return values[0]
}

function descendants(block) {
  return [block, ...block.blocks.flatMap(descendants)]
}

/** Minimal indentation parser for the deliberately small Compose harness. */
function composeServices(source) {
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex((line) => /^services:\s*(?:#.*)?$/.test(line))
  assert.notEqual(start, -1, 'Compose must define services')
  const services = new Map()
  let current = null
  for (const line of lines.slice(start + 1)) {
    if (/^[A-Za-z]/.test(line)) break
    const service = /^  ([a-z0-9-]+):\s*(?:#.*)?$/.exec(line)
    if (service) {
      current = service[1]
      services.set(current, [])
    } else if (current) {
      services.get(current).push(line)
    }
  }
  return services
}

function serviceNetworks(lines) {
  const start = lines.findIndex((line) => /^    networks:\s*(?:#.*)?$/.test(line))
  assert.notEqual(start, -1, 'service must declare networks explicitly')
  const networks = []
  for (const line of lines.slice(start + 1)) {
    if (/^    \S/.test(line)) break
    const match = /^      ([a-z0-9_-]+):?\s*(?:#.*)?$/.exec(line)
    if (match) networks.push(match[1])
  }
  return networks
}

test('PS3-STRUCT-1 dedicated Compose keeps aegis_public_share to exactly gateway and Drive', () => {
  const compose = readGateway('docker-compose.yml')
  const services = composeServices(compose)
  assert.deepEqual([...services.keys()].sort(), ['drive', 'public-share-gateway'])

  const members = [...services]
    .filter(([, lines]) => serviceNetworks(lines).includes('aegis_public_share'))
    .map(([name]) => name)
    .sort()
  assert.deepEqual(members, ['drive', 'public-share-gateway'])
  assert.deepEqual(serviceNetworks(services.get('public-share-gateway')), ['aegis_public_share'])

  assert.match(compose, /^networks:\s*[\s\S]*?^  aegis_public_share:\s*[\s\S]*?^    name: aegis_public_share$/m)
  assert.match(compose, /subnet:\s*172\.31\.254\.0\/29/)
  assert.match(compose, /public-share-gateway:[\s\S]*?ipv4_address:\s*172\.31\.254\.2/)
  assert.match(compose, /drive:[\s\S]*?ipv4_address:\s*172\.31\.254\.3/)
})

test('PS3-STRUCT-2 only the gateway is host-published, and only on localhost', () => {
  const services = composeServices(readGateway('docker-compose.yml'))
  const gateway = services.get('public-share-gateway').join('\n')
  const drive = services.get('drive').join('\n')

  assert.match(gateway, /127\.0\.0\.1:\$\{PUBLIC_SHARE_GATEWAY_PORT:-18080\}:8080/)
  assert.doesNotMatch(gateway, /0\.0\.0\.0:/)
  assert.doesNotMatch(drive, /^    ports:/m)
  assert.match(drive, /^    expose:\s*[\s\S]*?8001/m)
})

test('PS3-STRUCT-3 gateway is non-root, read-only, credential-free, and has no volume', () => {
  const compose = composeServices(readGateway('docker-compose.yml'))
  const gateway = compose.get('public-share-gateway').join('\n')
  const dockerfile = readGateway('Dockerfile')

  assert.match(dockerfile, /^FROM nginx:[^\s]+@sha256:[0-9a-f]{64}$/m)
  assert.match(dockerfile, /^USER 101:101$/m)
  assert.match(gateway, /^    read_only:\s*true$/m)
  assert.match(gateway, /^    cap_drop:\s*[\s\S]*?^      - ALL$/m)
  assert.match(gateway, /no-new-privileges:true/)
  assert.doesNotMatch(gateway, /^    volumes:/m)
  assert.doesNotMatch(
    gateway,
    /DATABASE_URL|SESSION_SECRET|VAULT|STORAGE_ROOT|POSTGRES|PASSWORD|TOKEN|PRIVATE_KEY/i,
  )
  assert.match(gateway, /PUBLIC_SHARE_HOST/)
})

test('PS3-STRUCT-4 only one anchored share location can proxy, and every fallback is local', () => {
  const config = parseNginx(readGateway('nginx.conf.template'))
  const http = directBlock(config, 'http')
  const publicServer = http.blocks.find((block) => (
    block.header === 'server' && directiveValues(block, 'server_name').includes('$PUBLIC_SHARE_HOST')
  ))
  assert.ok(publicServer, 'configured-host public listener must exist')

  const share = directBlock(publicServer, 'location ~* ^/s/[A-Za-z0-9_-]+/?$', 'share route')
  assert.equal(oneDirective(share, 'proxy_pass'), 'http://drive:8001')
  assert.deepEqual(
    descendants(config).flatMap((block) => directiveValues(block, 'proxy_pass')),
    ['http://drive:8001'],
    'no proxy_pass may exist outside the one share location',
  )
  assert.deepEqual(directBlock(publicServer, 'location /').directives, ['return 404'])

  const defaultServer = http.blocks.find((block) => (
    block.header === 'server' && directiveValues(block, 'listen').includes('8080 default_server')
  ))
  assert.ok(defaultServer, 'unapproved Host must land in a default server')
  assert.deepEqual(defaultServer.directives.filter((value) => value.startsWith('return ')), ['return 404'])
})

test('PS3-STRUCT-5 raw-route and method guards fail closed before proxying', () => {
  const config = parseNginx(readGateway('nginx.conf.template'))
  const http = directBlock(config, 'http')
  const routeMap = directBlock(http, 'map $request_uri $public_share_route_ok')
  assert.ok(routeMap.directives.includes('default 0'))
  assert.ok(
    routeMap.directives.some((value) => /^~\*\^\/s\/\[A-Za-z0-9_-\]\+\/\?\(\?:\\\?\.\*\)\?\$ 1$/.test(value)),
    'raw URI map must reject traversal-normalized paths while admitting harmless query strings',
  )

  const publicServer = http.blocks.find((block) => directiveValues(block, 'server_name').includes('$PUBLIC_SHARE_HOST'))
  const share = directBlock(publicServer, 'location ~* ^/s/[A-Za-z0-9_-]+/?$')
  assert.ok(share.blocks.some((block) => (
    block.header === 'if ($public_share_route_ok = 0)' && block.directives.includes('return 404')
  )))
  assert.ok(share.blocks.some((block) => (
    block.header === 'if ($request_method !~ ^(GET|POST)$)' && block.directives.includes('return 405')
  )))
})

test('PS3-STRUCT-6 gateway authors every trusted forwarding header', () => {
  const config = parseNginx(readGateway('nginx.conf.template'))
  const http = directBlock(config, 'http')
  const publicServer = http.blocks.find((block) => directiveValues(block, 'server_name').includes('$PUBLIC_SHARE_HOST'))
  const share = directBlock(publicServer, 'location ~* ^/s/[A-Za-z0-9_-]+/?$')
  const actual = Object.fromEntries(directiveValues(share, 'proxy_set_header').map((value) => {
    const [name, ...rest] = value.split(/\s+/)
    return [name, rest.join(' ')]
  }))
  assert.deepEqual(actual, {
    Host: '$PUBLIC_SHARE_HOST',
    'X-Forwarded-Host': '$PUBLIC_SHARE_HOST',
    'X-Forwarded-For': '$remote_addr',
    'X-Real-IP': '$remote_addr',
    Forwarded: '""',
    'X-Forwarded-Proto': 'https',
  })
})

test('PS3-STRUCT-7 small bodies, streaming, and explicit timeouts are pinned', () => {
  const config = parseNginx(readGateway('nginx.conf.template'))
  const http = directBlock(config, 'http')
  const publicServer = http.blocks.find((block) => directiveValues(block, 'server_name').includes('$PUBLIC_SHARE_HOST'))
  const share = directBlock(publicServer, 'location ~* ^/s/[A-Za-z0-9_-]+/?$')

  assert.equal(oneDirective(share, 'client_max_body_size'), '16k')
  assert.equal(oneDirective(share, 'proxy_buffering'), 'off')
  assert.equal(oneDirective(share, 'proxy_http_version'), '1.1')
  assert.equal(oneDirective(share, 'proxy_connect_timeout'), '5s')
  assert.equal(oneDirective(share, 'proxy_send_timeout'), '30s')
  assert.equal(oneDirective(share, 'proxy_read_timeout'), '300s')
  assert.equal(oneDirective(share, 'client_body_timeout'), '15s')
  assert.equal(oneDirective(share, 'send_timeout'), '300s')
  for (const [name, value] of [
    ['client_body_temp_path', '/tmp/client_temp'],
    ['proxy_temp_path', '/tmp/proxy_temp'],
    ['fastcgi_temp_path', '/tmp/fastcgi_temp'],
    ['uwsgi_temp_path', '/tmp/uwsgi_temp'],
    ['scgi_temp_path', '/tmp/scgi_temp'],
  ]) {
    assert.equal(oneDirective(http, name), value, `${name} must work on a read-only root filesystem`)
  }
  assert.equal(directiveValues(share, 'proxy_cache').length, 0)
  assert.equal(directiveValues(share, 'slice').length, 0)
  assert.equal(directiveValues(share, 'proxy_set_header').some((value) => /^Range\b/i.test(value)), false)
})

test('PS3-STRUCT-8 edge limiting and token-safe logs are explicit', () => {
  const config = parseNginx(readGateway('nginx.conf.template'))
  const http = directBlock(config, 'http')
  assert.match(oneDirective(http, 'limit_req_zone'), /^\$binary_remote_addr zone=public_share_edge:1m rate=5r\/s$/)
  const logFormat = oneDirective(http, 'log_format')
  assert.match(logFormat, /^public_share_safe /)
  assert.doesNotMatch(logFormat, /\$(request|request_uri|uri|args|http_referer|http_host|remote_addr)\b/)
  assert.equal(oneDirective(config, 'error_log'), '/dev/stderr crit')

  const publicServer = http.blocks.find((block) => directiveValues(block, 'server_name').includes('$PUBLIC_SHARE_HOST'))
  const share = directBlock(publicServer, 'location ~* ^/s/[A-Za-z0-9_-]+/?$')
  assert.equal(oneDirective(share, 'limit_req'), 'zone=public_share_edge burst=10 nodelay')
  assert.equal(oneDirective(share, 'limit_req_status'), '429')
  assert.equal(oneDirective(publicServer, 'access_log'), '/dev/stdout public_share_safe')
})

test('PS3-STRUCT-9 self-health is loopback-only and public health falls through to 404', () => {
  const config = parseNginx(readGateway('nginx.conf.template'))
  const http = directBlock(config, 'http')
  const health = http.blocks.find((block) => (
    block.header === 'server' && directiveValues(block, 'listen').includes('127.0.0.1:8081')
  ))
  assert.ok(health, 'gateway-local health listener must exist')
  const location = directBlock(health, 'location = /healthz')
  assert.ok(location.directives.includes('access_log off'))
  assert.ok(location.directives.includes('return 200 "ok\\n"'))

  const publicServer = http.blocks.find((block) => directiveValues(block, 'server_name').includes('$PUBLIC_SHARE_HOST'))
  assert.equal(publicServer.blocks.some((block) => block.header === 'location = /healthz'), false)
})
