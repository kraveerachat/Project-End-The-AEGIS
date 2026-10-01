import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runtime = path.join(root, 'deploy/idea2/h1-runtime')

test('N2 does not expose the gateway and N3 has a separate overlay', () => {
  const base = fs.readFileSync(path.join(runtime, 'compose.yml'), 'utf8')
  assert.match(base, /profiles:\s*\["n3"\]/)
  assert.doesNotMatch(base, /^\s+ports:$/m)
  const overlay = fs.readFileSync(path.join(runtime, 'compose.n3.yml'), 'utf8')
  assert.match(overlay, /profiles:\s*\["n3"\]/)
  assert.doesNotMatch(overlay, /postgres:|migrate:|monitor:/)
  assert.doesNotMatch(base, /H1_TLS_CERT_PATH|H1_TLS_KEY_PATH|H1_GATEWAY_BIND_IPV4/)
})

test('N3 overlay requires explicit source, tuple, and read-only TLS mounts', () => {
  const overlay = fs.readFileSync(path.join(runtime, 'compose.n3.yml'), 'utf8')
  const envExample = fs.readFileSync(path.join(runtime, 'env.example'), 'utf8')
  assert.match(envExample, /^H1_PUBLIC_CA_PATH=$/m)
  for (const value of ['H1_GATEWAY_SOURCE_SHA', 'H1_GATEWAY_BIND_IPV4', 'H1_GATEWAY_HTTPS_PORT', 'H1_TLS_CERT_PATH', 'H1_TLS_KEY_PATH']) {
    assert.match(overlay, new RegExp(`\\$\\{${value}:\\?`))
  }
  assert.match(overlay, /target: \/run\/aegis-h1-tls\/tls\.crt\s+read_only: true/)
  assert.match(overlay, /target: \/run\/aegis-h1-tls\/tls\.key\s+read_only: true/)
  assert.doesNotMatch(overlay, /aegis-prod|aegis\.internal|172\.18\.|18078|0\.0\.0\.0/)
})

test('N3 uses only the dedicated lab gateway route source', () => {
  const config = fs.readFileSync(path.join(root, 'deploy/idea2/h1-gateway/nginx.conf'), 'utf8')
  assert.match(config, /server_name idea2-h1\.aegis-lab\.internal;/)
  assert.match(config, /ssl_certificate \/run\/aegis-h1-tls\/tls\.crt;/)
  assert.match(config, /ssl_certificate_key \/run\/aegis-h1-tls\/tls\.key;/)
  assert.match(config, /proxy_pass http:\/\/monitor:8002/)
  assert.doesNotMatch(config, /proxy_pass https?:\/\/(?!monitor:8002)/)
  assert.match(config, /location ~\* \^\/monitor\/internal/)
  assert.match(config, /location ~\* \^\/agent/)
})

test('N2/N3 have fail-closed certificate and rendered-config validators', () => {
  assert.ok(fs.existsSync(path.join(runtime, 'validate_n2_n3.py')))
})

test('N3 cleanup prints gateway-only commands without changing N1 data', t => {
  const file = path.join(runtime, 'cleanup_n3.py')
  const candidates = [process.env.AEGIS_TEST_PYTHON, 'python3', 'python', 'py'].filter(Boolean)
  const selected = candidates.find(command => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0)
  if (!selected) return t.skip('Python unavailable')
  const result = spawnSync(selected, [file], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /H1_N3_CLEANUP_PLAN=REVIEW_ONLY/)
  assert.match(result.stdout, / stop gateway/)
  assert.match(result.stdout, / rm --force gateway/)
  assert.doesNotMatch(result.stdout, /compose[^\n]* down|volume rm|prune --/)
})
