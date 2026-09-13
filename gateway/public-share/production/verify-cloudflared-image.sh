#!/usr/bin/env bash
# Offline fail-closed contract gate. Requires Bash and Node.js (20+).
# --verify-pin [pin.json] validates the reviewed artifact only.
# --verify-inspect <docker-image-inspect.json> [pin.json] additionally checks
# supplied image metadata. Neither mode pulls/runs images or proves connectivity.
# Collect inspect data from an explicitly selected authorized Docker context.
# A new pin still requires isolated binary/user/read-only/readiness smoke evidence.
set -euo pipefail

exec node --input-type=commonjs - "${BASH_SOURCE[0]}" "$@" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

try {
  const [scriptFile, mode, ...args] = process.argv.slice(2)
  const defaultPin = path.join(path.dirname(path.resolve(scriptFile)), 'cloudflared-pin.json')
  assert.ok(
    (mode === '--verify-pin' && args.length <= 1) ||
    (mode === '--verify-inspect' && args.length >= 1 && args.length <= 2),
    'usage: --verify-pin [pin.json] | --verify-inspect <inspect.json> [pin.json]',
  )
  const pinFile = (mode === '--verify-pin' ? args[0] : args[1]) ?? defaultPin
  const pin = JSON.parse(fs.readFileSync(pinFile, 'utf8'))
  assert.ok(pin && typeof pin === 'object' && !Array.isArray(pin), 'pin must be an object')
  assert.deepEqual(Object.keys(pin).sort(), [
    'image', 'version', 'digest', 'configDigest', 'platform', 'user',
    'entrypointFlags', 'readinessCommand', 'readOnly', 'tmpfs',
  ].sort(), 'pin fields must match the reviewed schema')
  const match = /^cloudflare\/cloudflared:(202[6-9]\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))@sha256:([a-f0-9]{64})$/.exec(pin.image)
  assert.ok(match, 'official image must contain an exact release tag and sha256 digest')
  assert.equal(pin.version, match[1], 'version must match image tag')
  assert.equal(pin.digest, match[2], 'digest must match image reference')
  const [year, month, patch] = pin.version.split('.').map(Number)
  assert.ok([year, month, patch].every(Number.isSafeInteger), 'invalid release components')
  assert.ok(year > 2026 || (year === 2026 && (month > 5 || (month === 5 && patch >= 2))), 'version must be >= 2026.5.2')
  assert.match(pin.configDigest, /^[a-f0-9]{64}$/, 'config digest must be sha256')
  assert.equal(pin.platform, 'linux/amd64', 'only the verified linux/amd64 platform is supported')
  assert.equal(pin.user, '65532:65532', 'numeric non-root UID:GID required')
  assert.deepEqual(pin.entrypointFlags, [
    'tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:20241',
    '--protocol', 'http2', 'run', '--token-file', '/run/secrets/cloudflared-token',
  ], 'startup must preserve the verified flags and file-only credential contract')
  assert.deepEqual(pin.readinessCommand, [
    'cloudflared', 'tunnel', '--metrics', '127.0.0.1:20241', 'ready',
  ], 'readiness must use the verified loopback syntax')
  assert.equal(pin.readOnly, true, 'read-only root required')
  assert.deepEqual(pin.tmpfs, [], 'verified startup requires no tmpfs')

  if (mode === '--verify-inspect') {
    const inspected = JSON.parse(fs.readFileSync(args[0], 'utf8'))
    assert.ok(Array.isArray(inspected) && inspected.length === 1, 'inspect must contain exactly one image')
    const image = inspected[0]
    assert.ok(image && typeof image === 'object', 'image metadata required')
    const repoDigest = `cloudflare/cloudflared@sha256:${pin.digest}`
    assert.ok(Array.isArray(image.RepoDigests) && image.RepoDigests.some(
      (digest) => digest === repoDigest || digest === `docker.io/${repoDigest}`,
    ), 'official repository digest mismatch')
    // Classic Docker stores use the config digest as Id; containerd stores
    // use the manifest digest. Both remain bound to the authoritative pin.
    assert.ok([`sha256:${pin.configDigest}`, `sha256:${pin.digest}`].includes(image.Id), 'image ID mismatch')
    assert.equal(`${image.Os}/${image.Architecture}`, pin.platform, 'image platform mismatch')
    assert.equal(image.Config?.User, pin.user, 'image Config.User mismatch')
    assert.deepEqual(image.Config?.Entrypoint, ['cloudflared', '--no-autoupdate'], 'image entrypoint mismatch')
    console.log('CLOUDFLARED_INSPECT=PASS (supplied metadata; not a live runtime check)')
  } else {
    console.log('CLOUDFLARED_PIN=PASS (offline contract; not registry or runtime verification)')
  }
} catch (error) {
  // Never echo supplied JSON, assertion actual/expected values, or credentials.
  const detail = error.code === 'ERR_ASSERTION' ? error.message.split('\n')[0] : 'unreadable or invalid JSON input'
  console.error(`CLOUDFLARED_VERIFY=FAIL: ${detail}`)
  process.exitCode = 1
}
NODE
