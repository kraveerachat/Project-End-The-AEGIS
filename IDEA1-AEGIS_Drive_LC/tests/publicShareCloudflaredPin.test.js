// PUBLIC-SHARE-7 S5.5-C: exercise the offline verifier, including unsafe inputs.
// Live image smoke evidence is recorded separately; these tests never use Docker.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const production = fileURLToPath(new URL('../../gateway/public-share/production/', import.meta.url))
const pinPath = path.join(production, 'cloudflared-pin.json')
const script = path.join(production, 'verify-cloudflared-image.sh')
const shell = process.platform === 'win32' && existsSync('C:/Program Files/Git/bin/bash.exe')
  ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'

test('cloudflared verifier accepts the immutable contract and fails closed on unsafe pins or inspect data', () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  assert.match(pin.image, /^cloudflare\/cloudflared:(202[6-9]\.\d+\.\d+)@sha256:[a-f0-9]{64}$/)
  assert.match(pin.digest, /^[a-f0-9]{64}$/)
  assert.equal(pin.image, `cloudflare/cloudflared:${pin.version}@sha256:${pin.digest}`)
  const version = pin.version.split('.').map(Number)
  assert.ok(version[0] > 2026 || (version[0] === 2026 && (version[1] > 5 || (version[1] === 5 && version[2] >= 2))))
  assert.equal(pin.user, '65532:65532')
  const scratch = mkdtempSync(path.join(tmpdir(), 'aegis-cloudflared-pin-'))
  const run = (...args) => spawnSync(shell, [script, ...args], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  })
  const fixture = (name, value) => {
    const filename = path.join(scratch, name)
    writeFileSync(filename, JSON.stringify(value))
    return filename
  }
  const check = (result, expected) => {
    assert.ifError(result.error)
    assert.equal(result.status, expected, result.stdout + result.stderr)
  }
  try {
    check(run('--verify-pin', pinPath), 0)
    check(run('--verify-pin'), 0)
    // Offline release-floor validation, not registry evidence for these fixtures.
    for (const version of ['2026.5.2', '2027.1.0']) {
      check(run('--verify-pin', fixture('pin.json', {
        ...pin, version, image: `cloudflare/cloudflared:${version}@sha256:${pin.digest}`,
      })), 0)
    }
    for (const changed of [
      { image: 'cloudflare/cloudflared:latest' },
      { image: `cloudflare/cloudflared:latest@sha256:${pin.digest}` },
      { image: `cloudflare/cloudflared@sha256:${pin.digest}` },
      { image: `cloudflare/cloudflared:${pin.version}` },
      { image: `other/cloudflared:${pin.version}@sha256:${pin.digest}` },
      { version: '2026.5.1', image: `cloudflare/cloudflared:2026.5.1@sha256:${pin.digest}` },
      { version: '2026.5.2' }, { digest: '0'.repeat(64) },
      { user: '0:0' }, { user: '65532' }, { platform: 'linux/arm64' },
      { configDigest: 'not-a-digest' }, { entrypointFlags: ['tunnel', 'run'] },
      { entrypointFlags: [...pin.entrypointFlags, '--token', 'unsafe-inline-value'] },
      { readinessCommand: ['cloudflared', 'tunnel', 'ready'] },
      { readOnly: false }, { tmpfs: ['/tmp'] }, { unexpectedField: 'reject-me' },
    ]) check(run('--verify-pin', fixture('pin.json', { ...pin, ...changed })), 1)
    check(run('--verify-pin', fixture('pin.json', null)), 1)
    check(run('--verify-pin', path.join(scratch, 'missing.json')), 1)
    writeFileSync(path.join(scratch, 'bad.json'), '{')
    check(run('--verify-pin', path.join(scratch, 'bad.json')), 1)

    const inspected = {
      Id: `sha256:${pin.configDigest}`, RepoDigests: [`cloudflare/cloudflared@sha256:${pin.digest}`],
      Os: 'linux', Architecture: 'amd64',
      Config: { User: '65532:65532', Entrypoint: ['cloudflared', '--no-autoupdate'] },
    }
    check(run('--verify-inspect', fixture('inspect.json', [inspected]), pinPath), 0)
    // Docker's containerd image store exposes the manifest digest as Id;
    // the classic image store exposes the config digest instead.
    check(run('--verify-inspect', fixture('inspect.json', [{ ...inspected, Id: `sha256:${pin.digest}` }]), pinPath), 0)
    for (const changed of [
      { Id: `sha256:${'0'.repeat(64)}` }, { RepoDigests: [] },
      { RepoDigests: [`other/cloudflared@sha256:${pin.digest}`] },
      { Os: 'windows' }, { Architecture: 'arm64' },
      { Config: { ...inspected.Config, User: '0:0' } },
      { Config: { ...inspected.Config, Entrypoint: ['sh'] } }, { Config: null },
    ]) check(run('--verify-inspect', fixture('inspect.json', [{ ...inspected, ...changed }]), pinPath), 1)
    for (const invalid of [null, {}, [], [inspected, inspected]]) {
      check(run('--verify-inspect', fixture('inspect.json', invalid), pinPath), 1)
    }
    check(run('--verify-inspect'), 1)
    check(run('--unsupported'), 1)
    check(run('--verify-pin', pinPath, 'extra'), 1)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
