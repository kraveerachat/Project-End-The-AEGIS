// tests/publicShareGatewayStructure.test.js — PUBLIC-SHARE-3 security shape
//
// This suite guards the dedicated gateway as source. Runtime behavior is pinned
// separately in publicShareGatewayRuntime.test.js against real containers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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

  // B5 (Gateway -> everything else = nothing) is enforced by the network
  // itself, not merely by counting members, and it takes two controls:
  //   internal: true    removes normal external/default-route connectivity;
  //   gateway_mode_ipv4 "isolated" removes the Docker-host bridge address,
  //                     which an ordinary internal bridge keeps and through
  //                     which host services would stay reachable.
  // Removing either silently restores a host path, so both are pinned here and
  // re-checked against the real network in PS3-RUNTIME-1/1c.
  assert.match(
    compose,
    /^networks:[\s\S]*?^  aegis_public_share:[\s\S]*?^    internal: true$/m,
    'aegis_public_share must stay a Docker internal network',
  )
  assert.match(
    compose,
    /^networks:[\s\S]*?^  aegis_public_share:[\s\S]*?^      com\.docker\.network\.bridge\.gateway_mode_ipv4: "isolated"$/m,
    'aegis_public_share must use isolated bridge gateway mode so no host bridge address exists',
  )

  assert.match(compose, /subnet:\s*172\.31\.254\.0\/29/)
  assert.match(compose, /public-share-gateway:[\s\S]*?ipv4_address:\s*172\.31\.254\.2/)
  assert.match(compose, /drive:[\s\S]*?ipv4_address:\s*172\.31\.254\.3/)
})

test('PS3-STRUCT-2 neither member publishes a host port', () => {
  const services = composeServices(readGateway('docker-compose.yml'))
  const gateway = services.get('public-share-gateway').join('\n')
  const drive = services.get('drive').join('\n')

  // An internal network cannot publish a port, and B5 forbids a host path to
  // the gateway. Both listeners are reachable only from inside the network.
  assert.doesNotMatch(gateway, /^    ports:/m, 'the gateway must not request a host port')
  assert.doesNotMatch(drive, /^    ports:/m, 'the recorder must not request a host port')
  assert.doesNotMatch(gateway, /0\.0\.0\.0:/)
  assert.match(gateway, /^    expose:\s*[\s\S]*?8080/m)
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

test('PS3-STRUCT-10 PUBLIC_SHARE_HOST is validated fail-closed before the template renders', () => {
  const dockerfile = readGateway('Dockerfile')
  const entrypoint = readGateway('entrypoint.sh')
  const dockerignore = readGateway('.dockerignore')

  // Both scripts must survive the deliberately restrictive build context.
  assert.match(dockerignore, /^!entrypoint\.sh$/m)
  assert.match(dockerignore, /^!validate-public-share-host\.sh$/m)

  // The image must run the wrapper, not the stock nginx entrypoint.
  assert.match(
    dockerfile,
    /^ENTRYPOINT \["\/usr\/local\/bin\/aegis-public-share-entrypoint\.sh"\]$/m,
    'the validating wrapper must be the image entrypoint',
  )
  assert.match(dockerfile, /^COPY .*validate-public-share-host\.sh \/usr\/local\/bin\/aegis-validate-public-share-host\.sh$/m)
  assert.match(dockerfile, /^COPY .*entrypoint\.sh \/usr\/local\/bin\/aegis-public-share-entrypoint\.sh$/m)
  assert.match(dockerfile, /chmod 0555 \/usr\/local\/bin\/aegis-validate-public-share-host\.sh/)
  assert.match(dockerfile, /chmod 0555 \/usr\/local\/bin\/aegis-public-share-entrypoint\.sh/)

  // Defence in depth: the base image otherwise feeds every environment
  // variable to envsubst, so a variable named after an nginx variable used in
  // the template would silently rewrite it.
  assert.match(
    dockerfile,
    /^ENV NGINX_ENVSUBST_FILTER=\^PUBLIC_SHARE_HOST\$$/m,
    'envsubst must be restricted to PUBLIC_SHARE_HOST only',
  )

  // Order is the whole control: validate, and only then hand over to nginx.
  const validateAt = entrypoint.indexOf('/usr/local/bin/aegis-validate-public-share-host.sh')
  const handoverAt = entrypoint.indexOf('exec /docker-entrypoint.sh')
  assert.ok(validateAt > -1, 'entrypoint must run the validator')
  assert.ok(handoverAt > -1, 'entrypoint must hand over to the stock nginx entrypoint')
  assert.ok(validateAt < handoverAt, 'validation must precede nginx template rendering and start')
  assert.match(entrypoint, /^set -eu$/m, 'entrypoint must abort on a failed validation')
})

test('PS3-STRUCT-11 the host validator is a strict allowlist that never sanitizes', () => {
  const validator = readGateway('validate-public-share-host.sh')

  // A denylist would be bypassable; the contract is one positive character
  // class plus explicit structural rules, and refusal instead of rewriting.
  assert.match(
    validator,
    /\[0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ\.-\]/,
    'validation must be an explicit, locale-independent allowlist',
  )
  assert.match(validator, /\bexit 1\b/, 'a rejected value must fail startup')
  assert.doesNotMatch(
    validator,
    /\b(tr|sed|cut)\b\s|PUBLIC_SHARE_HOST=/,
    'the validator must not rewrite or normalise PUBLIC_SHARE_HOST',
  )
  for (const rule of [/253/, /63/, /must not begin with a dot/, /must not end with a dot/, /empty label/]) {
    assert.match(validator, rule, `hostname grammar rule missing: ${rule}`)
  }
})

// Real execution of the shipped script. The authoritative proof that nginx
// never starts on a bad value lives in publicShareGatewayRuntime.test.js; this
// runs the same file directly so the grammar is covered by the default suite.
const shAvailable = (() => {
  try {
    return spawnSync('sh', ['-c', 'exit 0']).status === 0
  } catch {
    return false
  }
})()

test('PS3-STRUCT-12 the shipped validator accepts one hostname and rejects every malformed form', {
  skip: shAvailable ? false : 'no POSIX sh on PATH; the Docker runtime suite proves this end to end',
}, () => {
  const script = fileURLToPath(new URL('validate-public-share-host.sh', GATEWAY_ROOT))
  const validate = (value) => spawnSync('sh', [script], {
    env: value === null ? { ...process.env, PUBLIC_SHARE_HOST: undefined } : { ...process.env, PUBLIC_SHARE_HOST: value },
    encoding: 'utf8',
  })

  for (const good of [
    'share.example.invalid',
    'a.co',
    'Share.Example.INVALID',
    'x-y.z-w.example',
    `${'a'.repeat(63)}.example`,
  ]) {
    assert.equal(validate(good).status, 0, `valid hostname rejected: ${good}`)
  }

  const bad = {
    empty: '',
    whitespace: 'evil.example ',
    'multiple names': 'evil.example another.test',
    semicolon: 'evil;return 200',
    'open brace': 'evil.example{',
    'close brace': 'evil.example}',
    'nginx variable': 'evil${host}',
    slash: 'evil.example/path',
    backslash: 'evil.example\\path',
    newline: 'evil.example\nanother.test',
    'trailing newline': 'evil.example\n',
    'carriage return': 'evil.example\revil',
    tab: 'evil.example\tanother.test',
    wildcard: '*.example.invalid',
    'regex prefix': '~^.*$',
    scheme: 'https://evil.example',
    query: 'evil.example?a=b',
    fragment: 'evil.example#f',
    credentials: 'user:pass@evil.example',
    'host:port': 'evil.example:8443',
    underscore: 'bad_host.example',
    'leading dot': '.example.invalid',
    'trailing dot': 'example.invalid.',
    'empty label': 'a..b.example',
    'hyphen-led label': '-bad.example',
    'hyphen-tailed label': 'bad-.example',
    'over-long label': `${'a'.repeat(64)}.example`,
    'over-long name': `${`${'a'.repeat(63)}.`.repeat(4)}example`,
    'IPv4 literal': '172.31.254.2',
    'nginx catch-all': '_',
  }
  for (const [label, value] of Object.entries(bad)) {
    const result = validate(value)
    assert.equal(result.status, 1, `${label} must fail startup (got exit ${result.status})`)
    assert.match(result.stderr, /refusing to start/, `${label} must explain the refusal`)
  }

  // The refusal must never echo attacker-influenced input back into logs.
  assert.doesNotMatch(validate('evil;return 200').stderr, /return 200/)
})
