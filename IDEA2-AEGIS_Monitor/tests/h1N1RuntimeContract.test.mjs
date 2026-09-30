import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runtime = path.join(root, 'deploy/idea2/h1-runtime')
const sha = 'a'.repeat(40)

function artifact(name) {
  const file = path.join(runtime, name)
  assert.ok(fs.existsSync(file), `N1 runtime artifact missing: ${name}`)
  return fs.readFileSync(file, 'utf8')
}

test('N1 has its own aegis-h1-lab Compose lifecycle, not the disposable probe', () => {
  const compose = artifact('compose.yml')
  assert.match(compose, /^name: aegis-h1-lab$/m)
  assert.match(compose, /^  postgres:$/m)
  assert.match(compose, /^  monitor:$/m)
  assert.match(compose, /^  gateway:$/m)
  assert.match(compose, /profiles:\s*\["n2"\]/)
  assert.doesNotMatch(compose, /aegis-h1-capacity-probe|aegis-prod|18078/)
})

test('N1 database and Monitor use lab-only credentials, digest-pinned images and no host ports', () => {
  const compose = artifact('compose.yml')
  assert.match(compose, /postgres:15-alpine@sha256:[a-f0-9]{64}/)
  assert.match(compose, /node:20-alpine@sha256:[a-f0-9]{64}/)
  assert.match(compose, /H1_POSTGRES_PASSWORD:\?[^}]+/)
  assert.match(compose, /H1_APP_PASSWORD:\?[^}]+/)
  assert.match(compose, /H1_DATABASE_URL:\?[^}]+/)
  assert.match(compose, /H1_SESSION_SECRET:\?[^}]+/)
  assert.match(compose, /POSTGRES_DB: aegis_h1_lab/)
  assert.match(compose, /POSTGRES_USER: postgres_h1_admin/)
  assert.match(compose, /pg_isready -h 127\.0\.0\.1 -U postgres_h1_admin -d aegis_h1_lab/)
  assert.match(artifact('init-role.sh'), /CREATE ROLE monitor_h1_app LOGIN/)
  assert.doesNotMatch(compose, /^\s+ports:\s*$/m)
  assert.doesNotMatch(compose, /\bexternal:\s*true\b/)
})

test('N1 has project-scoped network and volume with bounded service memory', () => {
  const compose = artifact('compose.yml')
  assert.match(compose, /aegis-h1-lab_postgres_data/)
  assert.match(compose, /^  lab_ingress:$/m)
  assert.match(compose, /^  lab_backend:$/m)
  assert.match(compose, /internal: true/)
  assert.match(compose, /mem_limit: "1073741824"/)
  assert.match(compose, /mem_limit: "268435456"/)
})

test('N1 schema migration is explicit, ordered, re-runnable, and gates Monitor readiness', () => {
  const compose = artifact('compose.yml')
  const migrate = artifact('migrate.sh')
  assert.match(compose, /service_completed_successfully/)
  assert.match(compose, /service_healthy/)
  assert.match(compose, /migrate\.sh/)
  assert.match(migrate, /schema\.sql/)
  for (const number of ['001', '002', '003', '004']) assert.match(migrate, new RegExp(`${number}_[^\\s]*\\.sql`))
  assert.match(migrate, /ON_ERROR_STOP=1/)
})

test('N1 validation and cleanup are scoped and exclude Production or broad prune', () => {
  const validate = artifact('validate.py')
  const cleanup = artifact('cleanup.py')
  assert.match(validate, /aegis-h1-lab/)
  assert.match(validate, /aegis-prod/)
  assert.match(cleanup, /aegis-h1-lab/)
  assert.match(cleanup, /aegis-h1-lab_postgres_data/)
  assert.match(cleanup, /--env-file/)
  assert.doesNotMatch(cleanup, /system prune|volume prune|container prune|--volumes/)
})

function pythonCommand() {
  if (process.env.AEGIS_TEST_PYTHON) return [process.env.AEGIS_TEST_PYTHON]
  for (const candidate of [['python'], ['py', '-3']]) {
    if (spawnSync(candidate[0], [...candidate.slice(1), '--version'], { encoding: 'utf8' }).status === 0) return candidate
  }
  return null
}

function renderedFixture() {
  const pgImage = 'postgres:15-alpine@sha256:25d430274d8a31184f9435cc5b2f56aff254952065bbbcac0c51acedb5a1d1e7'
  const base = { mem_limit: 1073741824, security_opt: ['no-new-privileges:true'], logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '2' } } }
  return {
    name: 'aegis-h1-lab',
    services: {
      postgres: { ...base, restart: 'unless-stopped', image: pgImage, environment: { POSTGRES_DB: 'aegis_h1_lab', POSTGRES_USER: 'postgres_h1_admin', POSTGRES_PASSWORD: 'fixture-secret', H1_APP_PASSWORD: 'fixture-app-secret' }, networks: ['lab_backend'], healthcheck: { test: ['CMD-SHELL', 'pg_isready -h 127.0.0.1 -U postgres_h1_admin -d aegis_h1_lab'] }, volumes: [{ type: 'volume', source: 'postgres_data', target: '/var/lib/postgresql/data' }, { type: 'bind', source: path.join(runtime, 'init-role.sh'), target: '/docker-entrypoint-initdb.d/10-h1-role.sh', read_only: true }] },
      migrate: { ...base, restart: 'no', image: pgImage, entrypoint: ['/bin/sh', '/aegis-h1/migrate.sh'], environment: { PGPASSWORD: 'fixture-secret' }, networks: ['lab_backend'], depends_on: { postgres: { condition: 'service_healthy' } }, volumes: [['/aegis-h1/migrate.sh', path.join(runtime, 'migrate.sh')], ['/aegis-h1/schema.sql', path.join(root, 'IDEA2-AEGIS_Monitor/server/db/schema.sql')], ['/aegis-h1/migrations', path.join(root, 'IDEA2-AEGIS_Monitor/server/db/migrations')]].map(([target, source]) => ({ type: 'bind', source, target, read_only: true })) },
      monitor: { ...base, restart: 'unless-stopped', image: `aegis-h1-lab-monitor:${sha}`, build: { context: path.join(root, 'IDEA2-AEGIS_Monitor'), dockerfile: 'Dockerfile', args: { NODE_BASE_IMAGE: 'node:20-alpine@sha256:afdf98210b07b586eb71fa22ba2e432e058e4cd1304d31ed60888755b8c865fb' } }, networks: ['lab_ingress', 'lab_backend'], depends_on: { migrate: { condition: 'service_completed_successfully' } }, environment: { NODE_ENV: 'production', PORT: '8002', AGENT_AUTH_REQUIRED: 'true', AGENT_AUTH_AUDIENCE: 'https://idea2-h1.aegis-lab.internal:18443', SESSION_SECRET: 'different-fixture-secret', DATABASE_URL: 'postgresql://monitor_h1_app:fixture-app-secret@postgres:5432/aegis_h1_lab' }, healthcheck: { test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:8002/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"] } },
      gateway: { ...base, restart: 'no', mem_limit: 268435456, profiles: ['n2'], networks: ['lab_ingress'], image: 'aegis-h1-lab-gateway:source-only', build: { context: path.join(root, 'deploy/idea2/h1-gateway'), dockerfile: 'Dockerfile', args: { NGINX_BASE_IMAGE: 'nginx:alpine@sha256:0530961ff0592b58c10f767535cc0abdfccf9e389ff7cc90f87320c1bc7e8506' } } },
    },
    networks: { lab_backend: { name: 'aegis-h1-lab_lab_backend', internal: true }, lab_ingress: { name: 'aegis-h1-lab_lab_ingress', internal: true } },
    volumes: { postgres_data: { name: 'aegis-h1-lab_postgres_data' } },
  }
}

function runValidator(python, fixture) {
  const source = 'import json,pathlib,runpy,sys; sys.path.insert(0,str(pathlib.Path(sys.argv[1]).parent)); ns=runpy.run_path(sys.argv[1]); ns["check"](json.loads(sys.stdin.read()),sys.argv[2])'
  return spawnSync(python[0], [...python.slice(1), '-c', source, path.join(runtime, 'validate.py'), sha], {
    input: JSON.stringify(fixture), encoding: 'utf8', cwd: root,
  })
}

test('N1 rendered-config validator accepts only an isolated, bounded lab', t => {
  const python = pythonCommand()
  if (!python) return t.skip('Python unavailable')
  assert.equal(runValidator(python, renderedFixture()).status, 0)
  for (const mutate of [
    f => { f.name = 'aegis-prod' },
    f => { f.services.postgres.ports = [{ published: 5432, target: 5432 }] },
    f => { f.networks.lab_backend.external = true },
    f => { f.volumes.postgres_data.name = 'aegis-prod_postgres_data' },
    f => { f.services.monitor.environment.DATABASE_URL = 'postgresql://monitor_h1_app:fixture-app-secret@prod:5432/aegis_h1_lab' },
    f => { f.services.monitor.environment.SESSION_SECRET = 'fixture-secret' },
    f => { f.services.postgres.environment.H1_APP_PASSWORD = 'fixture-secret' },
    f => { f.services.monitor.mem_limit = 2147483648 },
    f => { f.services.monitor.depends_on.migrate.condition = 'service_started' },
    f => { f.services.gateway.profiles = [] },
    f => { f.services.monitor.volumes = [{ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' }] },
    f => { f.services.postgres.devices = ['/dev/kvm'] },
    f => { f.services.migrate.volumes[1].source = path.join(root, 'docker-compose.yml') },
    f => { f.services.postgres.healthcheck.test = ['CMD-SHELL', 'pg_isready -U postgres_h1_admin -d aegis_h1_lab'] },
    f => { f.services.monitor.environment.EXTRA_SECRET = 'unexpected' },
    f => { f.services.postgres.build = { context: path.join(root, 'IDEA2-AEGIS_Monitor') } },
    f => { f.services.monitor.logging.options['max-size'] = '100m' },
    f => { f.services.gateway.build.context = path.join(root, 'gateway') },
    f => { f.services.monitor.build.privileged = true },
    f => { f.services.gateway.build.network = 'host' },
    f => { f.services.monitor.healthcheck.test = ['CMD', 'node', '-e', '/* /healthz */ process.exit(0)'] },
    f => { f.services.migrate.restart = 'always' },
  ]) {
    const fixture = renderedFixture()
    mutate(fixture)
    assert.notEqual(runValidator(python, fixture).status, 0)
  }
})

test('N1 design names the persistent artifact without rewriting historical N0 evidence', () => {
  const spec = fs.readFileSync(path.join(root, 'docs/superpowers/specs/2026-09-28-idea2-h1-isolated-nonproduction-environment-design.md'), 'utf8')
  assert.match(spec, /H1_N0_PROBE_COMPOSE_ARTIFACT=deploy\/idea2\/h1-capacity-probe\.compose\.yml/)
  assert.match(spec, /H1_N1_RUNTIME_COMPOSE_ARTIFACT=deploy\/idea2\/h1-runtime\/compose\.yml/)
  assert.match(spec, /H1_N1_REPOSITORY_ARTIFACT=IMPLEMENTED_SOURCE_ONLY/)
  assert.match(spec, /H1_N1_LIVE_STATE=NOT_STARTED/)
})
