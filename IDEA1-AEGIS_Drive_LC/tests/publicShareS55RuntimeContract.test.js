// PUBLIC-SHARE-7 S5.5 repository/runtime contract.
//
// This suite is deliberately static, in the same spirit as the S5.4 contract.
// S5.5 Production mutation is not authorized by this branch, so the review gate
// proves the exact future Compose model without contacting or changing
// Production. Nothing here pulls an image, starts a container, reaches
// Cloudflare, or reads a real tunnel credential.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const REPO_ROOT = new URL('../../', import.meta.url)
const S5_4_URL = new URL(
  'gateway/public-share/production/docker-compose.s5-4.yml',
  REPO_ROOT,
)
const S5_5_URL = new URL(
  'gateway/public-share/production/docker-compose.s5-5.yml',
  REPO_ROOT,
)
const PIN_URL = new URL(
  'gateway/public-share/production/cloudflared-pin.json',
  REPO_ROOT,
)

// The accepted S5.4 overlay digest is recorded over LF-normalized content so
// the gate is identical on the Linux Production host and on a CRLF checkout.
const S5_4_SHA256 =
  'cc36d08c16731f888f64cb2dcd84f1c9a41b11e9b447aa16ad67405bcdc12819'

// Owner-approved runtime credential contract. The host path is canonical and
// the container destination is fixed; neither is created or read by this branch.
const TOKEN_HOST_PATH = '/opt/aegis/runtime/public-share/secrets/cloudflared-token'
const TOKEN_CONTAINER_PATH = '/run/secrets/cloudflared-token'

const normalize = (text) => text.replace(/\r\n/g, '\n')
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

const pin = JSON.parse(readFileSync(PIN_URL, 'utf8'))

// Read lazily: before Task 3 this throws ENOENT and every structural contract
// below fails closed, which is the intended RED state.
let overlayCache
function overlay() {
  overlayCache ??= normalize(readFileSync(S5_5_URL, 'utf8'))
  return overlayCache
}

function namedBlock(source, name, indent) {
  const lines = source.split('\n')
  const prefix = ' '.repeat(indent)
  const header = `${prefix}${name}:`
  const start = lines.findIndex((line) => line === header)
  assert.notEqual(start, -1, `missing ${name} block at indent ${indent}`)

  const body = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.trimStart().startsWith('#')) {
      const leading = line.length - line.trimStart().length
      if (leading <= indent) break
    }
    body.push(line)
  }
  return body.join('\n')
}

function directKeys(block, indent) {
  const pattern = new RegExp(`^ {${indent}}([a-z0-9_.-]+):(?:\\s|$)`)
  return block
    .split('\n')
    .map((line) => pattern.exec(line)?.[1])
    .filter(Boolean)
}

function scalar(block, indent, key) {
  const pattern = new RegExp(`^ {${indent}}${key}:\\s*(.+?)\\s*$`, 'm')
  const match = pattern.exec(block)
  assert.ok(match, `missing scalar ${key} at indent ${indent}`)
  return match[1].replace(/^['"]|['"]$/g, '')
}

// Credential scanning runs against effective configuration only. Explanatory
// comments are documentation, not directives, and must not trip the gate.
const withoutComments = (text) =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')

function listItems(block, indent) {
  const pattern = new RegExp(`^ {${indent}}- (.+?)\\s*$`)
  return block
    .split('\n')
    .map((line) => pattern.exec(line)?.[1])
    .filter(Boolean)
    .map((value) => value.replace(/^['"]|['"]$/g, ''))
}

const service = (name) => namedBlock(namedBlock(overlay(), 'services', 0), name, 2)
const network = (name) => namedBlock(namedBlock(overlay(), 'networks', 0), name, 2)

test('S5.5-OVERLAY-IMMUTABLE the accepted S5.4 overlay is unchanged byte-for-byte', () => {
  const s5_4 = normalize(readFileSync(S5_4_URL, 'utf8'))
  assert.equal(
    sha256(s5_4),
    S5_4_SHA256,
    'the accepted S5.4 overlay must not be modified by S5.5',
  )
})

test('S5.5-COMPOSE-EXISTS the S5.5 overlay exists and is a Compose document', () => {
  const text = overlay()
  assert.ok(text.trim().length > 0, 'the S5.5 overlay must not be empty')
  assert.match(text, /^services:$/m, 'the S5.5 overlay must declare services')
  assert.match(text, /^networks:$/m, 'the S5.5 overlay must declare networks')
})

test('S5.5-IMAGE-PIN-CONSUMPTION the connector uses the exact verified pin', () => {
  const image = scalar(service('public-share-connector'), 4, 'image')
  assert.equal(
    image,
    pin.image,
    'the connector image must be the exact verified tag@sha256 from cloudflared-pin.json',
  )
  assert.match(
    image,
    /^cloudflare\/cloudflared:202[6-9]\.\d+\.\d+@sha256:[a-f0-9]{64}$/,
    'only an official immutable tag@sha256 reference is allowed',
  )
  assert.doesNotMatch(image, /:latest/, 'floating tags are forbidden')
})

test('S5.5-SERVICE-CONNECTOR the connector is hardened and correctly attached', () => {
  const services = directKeys(namedBlock(overlay(), 'services', 0), 2).sort()
  assert.deepEqual(
    services,
    ['public-share-connector'],
    'S5.5 adds only the connector; it must not restate drive or the gateway',
  )

  const connector = service('public-share-connector')
  assert.equal(scalar(connector, 4, 'user'), '65532:65532', 'connector must run non-root')
  assert.equal(scalar(connector, 4, 'read_only'), 'true', 'connector rootfs must be read-only')
  assert.equal(
    scalar(connector, 4, 'restart'),
    'on-failure:5',
    'connector must fail closed rather than restart forever',
  )
  assert.deepEqual(listItems(namedBlock(connector, 'cap_drop', 4), 6), ['ALL'])
  assert.deepEqual(
    listItems(namedBlock(connector, 'security_opt', 4), 6),
    ['no-new-privileges:true'],
  )
  assert.doesNotMatch(connector, /^ {4}container_name:/m, 'no fixed container_name')
  assert.doesNotMatch(connector, /^ {4}ports:/m, 'the connector must never publish a host port')
  assert.doesNotMatch(connector, /^ {4}privileged:/m, 'the connector must never be privileged')
  assert.doesNotMatch(connector, /^ {4}network_mode:/m, 'the connector must never use host networking')
  assert.doesNotMatch(connector, /^ {4}tmpfs:/m, 'the verified image needs no tmpfs to start read-only')

  // Verified startup contract, proven against the pinned image in Task 1.
  assert.deepEqual(listItems(namedBlock(connector, 'command', 4), 6), pin.entrypointFlags)

  const attached = namedBlock(connector, 'networks', 4)
  assert.deepEqual(
    directKeys(attached, 6).sort(),
    ['aegis_public_share_edge', 'aegis_public_share_egress'],
    'the connector attaches to exactly the edge and egress networks',
  )
  assert.equal(scalar(namedBlock(attached, 'aegis_public_share_edge', 6), 8, 'ipv4_address'), '172.31.240.3')
  assert.equal(scalar(namedBlock(attached, 'aegis_public_share_egress', 6), 8, 'ipv4_address'), '172.31.242.2')

  for (const forbidden of [
    'aegis_public_share_upstream',
    'aegis_internal',
    'aegis_drive_proxy',
    'aegis_vlan10',
    'aegis_vlan10_macvlan',
    'default',
  ]) {
    assert.equal(
      directKeys(attached, 6).includes(forbidden),
      false,
      `the connector must never attach to ${forbidden}`,
    )
  }
})

test('S5.5-NETWORK-EGRESS the egress bridge is exact, routable and masqueraded', () => {
  assert.deepEqual(
    directKeys(namedBlock(overlay(), 'networks', 0), 2).sort(),
    ['aegis_public_share_egress'],
    'S5.5 adds only the egress network; edge and upstream come from S5.4',
  )

  const egress = network('aegis_public_share_egress')
  assert.equal(scalar(egress, 4, 'name'), 'aegis_public_share_egress')
  assert.equal(scalar(egress, 4, 'driver'), 'bridge')
  assert.equal(scalar(egress, 4, 'internal'), 'false', 'egress must reach the Cloudflare edge')

  const opts = namedBlock(egress, 'driver_opts', 4)
  assert.equal(scalar(opts, 6, 'com\\.docker\\.network\\.bridge\\.name'), 'aegis-ps-eg')
  assert.equal(
    scalar(opts, 6, 'com\\.docker\\.network\\.bridge\\.enable_ip_masquerade'),
    'true',
  )

  const ipam = namedBlock(namedBlock(egress, 'ipam', 4), 'config', 6)
  assert.match(ipam, /^ {8}- subnet: 172\.31\.242\.0\/29$/m)
  assert.match(ipam, /^ {10}gateway: 172\.31\.242\.1$/m)
})

test('S5.5-CREDENTIAL-BOUNDS the token is file-only, read-only and never inline', () => {
  const connector = service('public-share-connector')
  const command = listItems(namedBlock(connector, 'command', 4), 6)

  const tokenFileAt = command.indexOf('--token-file')
  assert.notEqual(tokenFileAt, -1, 'the connector must read its token from a file')
  assert.equal(command[tokenFileAt + 1], '/run/secrets/cloudflared-token')
  assert.equal(command.includes('--token'), false, 'an inline --token literal is forbidden')

  // The owner-approved runtime credential lives under the canonical
  // /opt/aegis/runtime/public-share/secrets/ path on the Production host.
  const mounts = listItems(namedBlock(connector, 'volumes', 4), 6)
  assert.deepEqual(
    mounts,
    [`${TOKEN_HOST_PATH}:${TOKEN_CONTAINER_PATH}:ro`],
    'the connector mounts exactly the canonical token file, read-only',
  )

  const [hostPath, containerPath, mode] = mounts[0].split(':')
  assert.equal(hostPath, TOKEN_HOST_PATH, 'token host path must be the canonical source')
  assert.equal(containerPath, TOKEN_CONTAINER_PATH, 'token container destination is fixed')
  assert.equal(mode, 'ro', 'the token mount must be read-only')
  assert.equal(
    command[tokenFileAt + 1],
    containerPath,
    '--token-file must point at the mounted destination',
  )

  const effective = withoutComments(overlay())
  assert.doesNotMatch(effective, /TUNNEL_TOKEN/, 'no TUNNEL_TOKEN environment variable')
  assert.doesNotMatch(effective, /^ {4}environment:/m, 'the connector takes no environment credentials')
  // A real connector token is a long base64url JSON blob; none may be committed.
  assert.doesNotMatch(
    effective,
    /eyJ[A-Za-z0-9_-]{40,}/,
    'no encoded tunnel credential may appear in the overlay',
  )
})

test('S5.5-GATEWAY-DRIVE-PRESERVED S5.5 does not re-topologize drive or the gateway', () => {
  const text = overlay()
  assert.doesNotMatch(text, /^ {2}drive:$/m, 'drive topology stays owned by S5.4 and the base')
  assert.doesNotMatch(text, /^ {2}public-share-gateway:$/m, 'gateway topology stays owned by S5.4')
  assert.doesNotMatch(text, /172\.31\.241\./, 'S5.5 must not touch the upstream network')
  assert.doesNotMatch(text, /172\.31\.240\.2/, 'S5.5 must not move the gateway edge address')
  assert.doesNotMatch(text, /PUBLIC_SHARE_UI_ENABLED/, 'S5.5 must not enable the Public Share UI')
})
