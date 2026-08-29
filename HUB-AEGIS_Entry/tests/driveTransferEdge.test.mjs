import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseNginx } from './helpers/nginxConfig.mjs'
import {
  MAX_CHUNK_SIZE_BYTES,
} from '../../IDEA1-AEGIS_Drive_LC/server/config/transferLimits.js'
import {
  GCM_TAG_BYTES,
  MAX_VAULT_PLAINTEXT_CHUNK_BYTES,
} from '../../IDEA1-AEGIS_Drive_LC/server/config/vaultTransferLimits.js'

const ROUTES = Object.freeze({
  normalChunk: 'location ~* ^/drive/api/files/uploads/[^/]+/chunks/[^/]+/?$',
  vaultChunk: 'location ~* ^/drive/api/vault/uploads/[^/]+/chunks/[^/]+/?$',
  normalCommit: 'location ~* ^/drive/api/files/uploads/[^/]+/commit/?$',
  vaultCommit: 'location ~* ^/drive/api/vault/uploads/[^/]+/commit/?$',
  normalDownload: 'location ~* ^/drive/api/files/[^/]+/download/?$',
  vaultChunkDownload: 'location ~* ^/drive/api/vault/blobs/[^/]+/chunks/[^/]+/?$',
})

const CONFIGS = [
  {
    name: 'production HUB',
    source: readFileSync(new URL('../nginx.conf', import.meta.url), 'utf8'),
    serverMatch: (block) => block.directives.some((value) => /^listen 443 ssl\b/.test(value)),
    parentHeaders: {
      Host: '$http_host',
      'X-Real-IP': '$remote_addr',
      'X-Forwarded-For': '$remote_addr',
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': '$http_host',
      Forwarded: '""',
    },
    upstreamSet: '$drive_upstream drive-proxy:8001',
    monitorGuard: 'location ~* ^/monitor/internal(/|$)',
  },
  {
    name: 'development gateway',
    source: readFileSync(new URL('../../gateway/nginx.conf', import.meta.url), 'utf8'),
    serverMatch: (block) => block.directives.some((value) => /^listen 80\b/.test(value)),
    parentHeaders: {
      Host: '$host',
      'X-Real-IP': '$remote_addr',
      'X-Forwarded-For': '$remote_addr',
      'X-Forwarded-Proto': '$scheme',
      'X-Forwarded-Host': '$host',
      Forwarded: '""',
    },
    upstreamSet: '$drive_upstream drive-proxy:8001',
    monitorGuard: 'location /monitor/internal/',
  },
]

function serverBlock(config) {
  const parsed = parseNginx(config.source)
  const matches = parsed.blocks.filter((block) => block.header === 'server' && config.serverMatch(block))
  assert.equal(matches.length, 1, `${config.name}: exactly one browser-facing server block`)
  return matches[0]
}

function directBlock(parent, header, label) {
  const matches = parent.blocks.filter((block) => block.header === header)
  assert.equal(matches.length, 1, `${label}: exactly one ${header}`)
  return matches[0]
}

function driveBlock(config) {
  return directBlock(serverBlock(config), 'location /drive/', config.name)
}

function routeBlock(config, routeName) {
  return directBlock(driveBlock(config), ROUTES[routeName], `${config.name} ${routeName}`)
}

function directiveValues(block, name) {
  const prefix = `${name} `
  return block.directives
    .filter((value) => value === name || value.startsWith(prefix))
    .map((value) => value.slice(name.length).trim())
}

function oneDirective(block, name, label) {
  const values = directiveValues(block, name)
  assert.equal(values.length, 1, `${label}: exactly one ${name}`)
  return values[0]
}

function nginxSizeBytes(value) {
  const match = String(value).match(/^(\d+)([kmg])?$/i)
  assert.ok(match, `supported nginx size literal: ${value}`)
  const multiplier = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[String(match[2] || '').toLowerCase()]
  return Number(match[1]) * multiplier
}

function routeProfile(config) {
  const profile = {}
  for (const routeName of Object.keys(ROUTES)) {
    const block = routeBlock(config, routeName)
    profile[routeName] = Object.fromEntries(
      block.directives.map((directive) => {
        const [name, ...rest] = directive.split(/\s+/)
        return [name, rest.join(' ')]
      }),
    )
  }
  return profile
}

function inheritedExecutionDirectives(config) {
  return [
    `set ${config.upstreamSet}`,
    'rewrite ^/drive/?(.*)$ /$1 break',
    'proxy_pass http://$drive_upstream',
  ]
}

test('both edges define the six anchored case-insensitive V2 route boundaries', () => {
  for (const config of CONFIGS) {
    const drive = driveBlock(config)
    for (const header of Object.values(ROUTES)) {
      directBlock(drive, header, config.name)
      assert.match(header, /^location ~\* \^\/drive\//, `${config.name}: route cannot be bypassed by case changes`)
      assert.match(header, /\/\?\$$/, `${config.name}: Express-compatible trailing slash remains inside the boundary`)
    }
  }
})

test('Normal Files V2 chunks are bounded to 64 MiB and never to a logical-file size', () => {
  for (const config of CONFIGS) {
    const value = oneDirective(routeBlock(config, 'normalChunk'), 'client_max_body_size', config.name)
    assert.equal(value, '64m')
    assert.equal(nginxSizeBytes(value), MAX_CHUNK_SIZE_BYTES)
    assert.ok(nginxSizeBytes(value) < 1024 ** 3, `${config.name}: a chunk request is not multi-GiB`)
  }
})

test('Vault V2 chunks have explicit AES-GCM tag headroom above 64 MiB', () => {
  for (const config of CONFIGS) {
    const value = oneDirective(routeBlock(config, 'vaultChunk'), 'client_max_body_size', config.name)
    assert.equal(value, '65m')
    assert.ok(
      nginxSizeBytes(value) >= MAX_VAULT_PLAINTEXT_CHUNK_BYTES + GCM_TAG_BYTES,
      `${config.name}: Vault edge limit must admit a 64 MiB plaintext chunk plus its GCM tag`,
    )
    assert.ok(nginxSizeBytes(value) < 1024 ** 3, `${config.name}: a Vault chunk request is not multi-GiB`)
  }
})

test('both V2 chunk routes stream requests with bounded inactivity and upstream timeouts', () => {
  const expected = {
    proxy_request_buffering: 'off',
    client_body_timeout: '120s',
    proxy_send_timeout: '120s',
    proxy_read_timeout: '120s',
  }
  for (const config of CONFIGS) {
    for (const routeName of ['normalChunk', 'vaultChunk']) {
      const block = routeBlock(config, routeName)
      for (const [name, value] of Object.entries(expected)) {
        assert.equal(oneDirective(block, name, `${config.name} ${routeName}`), value)
      }
    }
  }
})

test('both commit routes extend only their upstream response timeout to 600 seconds', () => {
  for (const config of CONFIGS) {
    assert.equal(oneDirective(driveBlock(config), 'proxy_read_timeout', `${config.name} parent`), '60s')
    for (const routeName of ['normalCommit', 'vaultCommit']) {
      const block = routeBlock(config, routeName)
      assert.deepEqual(block.directives, [
        ...inheritedExecutionDirectives(config),
        'proxy_read_timeout 600s',
      ])
    }
  }
})

test('large streaming download routes disable only upstream response buffering', () => {
  for (const config of CONFIGS) {
    for (const routeName of ['normalDownload', 'vaultChunkDownload']) {
      assert.deepEqual(routeBlock(config, routeName).directives, [
        ...inheritedExecutionDirectives(config),
        'proxy_buffering off',
      ])
    }
  }
})

test('the parent Drive route keeps the 512 MiB V1 request allowance and HTTP/1.1 proxy contract', () => {
  for (const config of CONFIGS) {
    const drive = driveBlock(config)
    assert.equal(oneDirective(drive, 'client_max_body_size', config.name), '512m')
    assert.equal(oneDirective(drive, 'proxy_read_timeout', config.name), '60s')
    assert.equal(oneDirective(drive, 'proxy_connect_timeout', config.name), '5s')
    assert.equal(oneDirective(drive, 'proxy_http_version', config.name), '1.1')
    assert.ok(drive.directives.some((value) => value === 'rewrite ^/drive/?(.*)$ /$1 break'))
    assert.ok(drive.directives.some((value) => value.startsWith('proxy_pass http://$drive_upstream')))
  }
})

test('nested routes repeat only the execution trio and inherit every proxy/security control', () => {
  const forbidden = [
    'proxy_http_version', 'proxy_set_header', 'proxy_hide_header',
    'add_header', 'proxy_connect_timeout',
  ]
  for (const config of CONFIGS) {
    for (const routeName of Object.keys(ROUTES)) {
      const block = routeBlock(config, routeName)
      assert.deepEqual(
        block.directives.slice(0, 3),
        inheritedExecutionDirectives(config),
        `${config.name} ${routeName}: nested locations need set + rewrite + proxy_pass in this order`,
      )
      for (const name of forbidden) {
        assert.deepEqual(
          directiveValues(block, name),
          [],
          `${config.name} ${routeName}: ${name} must stay inherited from the parent`,
        )
      }
    }
  }
})

test('Drive forwarding headers stay fail-closed and Forwarded remains cleared', () => {
  for (const config of CONFIGS) {
    const drive = driveBlock(config)
    const actual = {}
    for (const directive of directiveValues(drive, 'proxy_set_header')) {
      const [name, ...value] = directive.split(/\s+/)
      actual[name] = value.join(' ')
    }
    assert.deepEqual(actual, config.parentHeaders, `${config.name}: trusted forwarding contract changed`)
  }
})

test('production and development expose equivalent V2 tuning profiles', () => {
  assert.deepEqual(routeProfile(CONFIGS[0]), routeProfile(CONFIGS[1]))
})

test('Monitor proxy and internal-ingest block remain at their pre-LFT contract', () => {
  for (const config of CONFIGS) {
    const server = serverBlock(config)
    const guard = directBlock(server, config.monitorGuard, config.name)
    assert.deepEqual(guard.directives, ['return 404'])

    const monitor = directBlock(server, 'location /monitor/', config.name)
    assert.equal(monitor.blocks.length, 0, `${config.name}: LFT adds no Monitor child location`)
    assert.equal(oneDirective(monitor, 'proxy_connect_timeout', config.name), '5s')
    assert.equal(oneDirective(monitor, 'proxy_read_timeout', config.name), '60s')
    assert.equal(oneDirective(monitor, 'proxy_http_version', config.name), '1.1')
    assert.equal(directiveValues(monitor, 'client_max_body_size').length, 0)
    assert.equal(directiveValues(monitor, 'proxy_request_buffering').length, 0)
    assert.equal(directiveValues(monitor, 'proxy_buffering').length, 0)
  }
})
