// tests/publicShareStageBCredentialPlumbing.test.js — PUBLIC-SHARE-6 Stage B
//
// ⚠️ THIS FILE EXISTS BECAUSE STAGE B ATTEMPT #1 FAILED, SAFELY, ON EXACTLY ONE
//    THING. `docker-compose.yml` interpolates four variables:
//
//        PS6_SUPER_USER  PS6_SUPER_PASSWORD  PS6_DRIVE_DB_PASSWORD  PS6_SESSION_SECRET
//
//    The acceptance suite generates all four as throwaway random values in its
//    own child environment. On the AEGIS server host `PS6_DOCKER` is
//
//        sudo -n env -u DOCKER_HOST docker
//
//    and a process environment does not cross a `sudo` boundary — sudo correctly
//    refuses to carry arbitrary variables. So Compose saw none of them:
//
//        error while interpolating services.postgres.environment.POSTGRES_USER:
//        required variable PS6_SUPER_USER is missing a value
//
//    A harness credential-plumbing defect, not a product defect. No PS6 stack was
//    created, Production was untouched, cleanup passed, runner RC = 1.
//
// ⚠️ THE FIX MAY NOT WEAKEN THE PRIVILEGE BOUNDARY. Not `sudo -E`, not
//    `--preserve-env`, not a sudoers `env_keep` entry, not docker-group
//    membership, not passwordless sudo, not a global environment change. This
//    file asserts the absence of every one of those, and asserts the presence of
//    the replacement: one PS6-owned `--env-file` inside `PS6_WORKDIR`, mode 0600,
//    never printed, removed by the existing cleanup trap.
//
// ⚠️ NOTHING HERE NEEDS DOCKER, SUDO OR A NETWORK. The privilege boundary is
//    modelled by a wrapper that strips the environment harder than sudo does
//    (`env -i`), and Docker is modelled by a recorder that implements only
//    Compose's interpolation rule. That is deliberate: this regression has to be
//    runnable on any machine, including one that must never run Stage B.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNNER = fileURLToPath(new URL('../../gateway/public-share/integration/run-stage-b.sh', import.meta.url))
const SUITE = fileURLToPath(new URL('./publicShareInternalIntegration.test.js', import.meta.url))
const DRIVE_ROOT = fileURLToPath(new URL('../', import.meta.url))

const runnerSource = readFileSync(RUNNER, 'utf8')
const suiteSource = readFileSync(SUITE, 'utf8')

/** The four Compose interpolates, in the order the failure reported them. */
const REQUIRED = ['PS6_SUPER_USER', 'PS6_SUPER_PASSWORD', 'PS6_DRIVE_DB_PASSWORD', 'PS6_SESSION_SECRET']

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

/**
 * This file's own children are Node test runners. Inheriting `NODE_TEST_*` from
 * the runner that is executing THIS file makes a child report through the
 * parent's IPC channel and exit 0 whatever it found — which would quietly turn
 * every assertion below into a no-op. Strip that context, and PS6_* with it, so
 * each child starts from exactly the environment the test declares.
 */
function cleanEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST') && !key.startsWith('PS6_')),
  )
}

/** Strip comment lines so a guard cannot be satisfied — or tripped — by prose. */
const shellCode = runnerSource
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

const jsCode = (() => {
  // Cheap but sufficient: this file's own comments are the only multi-line
  // comments that matter, and the suite uses no `/*` inside a string literal.
  const withoutBlock = suiteSource.replace(/\/\*[\s\S]*?\*\//g, '')
  return withoutBlock.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n')
})()

// ═══ PS6-ENV-1 ═══════════════════════════════════════════════════════════════

test('PS6-ENV-1 the fix preserves the privilege boundary — no environment preservation anywhere', () => {
  // Each of these is a way of making sudo carry the caller's environment, and
  // each is explicitly out of scope for this fix.
  const forbidden = [
    [/\bsudo\s+-[A-Za-z]*E\b/, 'sudo -E'],
    [/--preserve-env/, 'sudo --preserve-env'],
    [/env_keep/, 'a sudoers env_keep entry'],
    [/NOPASSWD/, 'passwordless sudo'],
    [/\bvisudo\b/, 'a sudoers edit'],
    [/\/etc\/sudoers/, 'a sudoers file'],
    [/\busermod\b/, 'a group-membership change'],
    [/\bgpasswd\b/, 'a group-membership change'],
    [/\badduser\b/, 'a group-membership change'],
    [/docker\.sock/, 'a Docker socket permission change'],
    [/\bprune\b/, 'a prune of any kind'],
  ]
  for (const [pattern, label] of forbidden) {
    assert.ok(!pattern.test(shellCode), `run-stage-b.sh must not use ${label}`)
    assert.ok(!pattern.test(jsCode), `the acceptance suite must not use ${label}`)
  }

  // Every sudo the runner INVOKES is non-interactive.
  //
  // Quoted strings are blanked out first, because the runner legitimately PRINTS
  // `sudo -v` and a `sudo env …` recovery command for the owner to run by hand,
  // and explains itself in prose that names the sudo boundary. Those are text.
  // What is left after blanking is what the shell would actually execute.
  const executable = shellCode.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
  const invocations = [...executable.matchAll(/\bsudo\s+(\S+)/g)].map((m) => m[1])
  assert.ok(invocations.length > 0, 'the runner still reaches Docker through sudo')
  for (const flag of invocations) {
    assert.equal(flag, '-n', `every sudo invocation must be non-interactive, got: sudo ${flag}`)
  }

  // The boundary itself, which blanking removed, asserted directly and exactly.
  assert.match(shellCode, /DOCKER="sudo -n env -u DOCKER_HOST docker"/)
  assert.equal((shellCode.match(/DOCKER="sudo/g) ?? []).length, 1, 'there is exactly one privileged entry point')
})

// ═══ PS6-ENV-2 ═══════════════════════════════════════════════════════════════

test('PS6-ENV-2 the runner owns exactly one Compose env file, 0600, inside PS6_WORKDIR', () => {
  assert.match(
    shellCode,
    /PS6_COMPOSE_ENV_FILE=\$\{PS6_COMPOSE_ENV_FILE:-\$EVIDENCE_DIR\/compose\.env\}/,
    'the default path is one file under the evidence directory the runner already owns',
  )
  assert.match(
    shellCode,
    /case "\$PS6_COMPOSE_ENV_FILE" in\s*\n\s*"\$PS6_WORKDIR"\/\*\) ;;/,
    'the path must be refused unless it is inside PS6_WORKDIR',
  )
  assert.match(shellCode, /\*\.\.\*\) die "PS6_COMPOSE_ENV_FILE may not contain/, "'..' must be refused")

  // Created owner-only, and verified rather than assumed.
  assert.match(shellCode, /\(umask 077; : > "\$PS6_COMPOSE_ENV_FILE"\)/)
  assert.match(shellCode, /chmod 600 "\$PS6_COMPOSE_ENV_FILE"/)
  assert.match(shellCode, /\[ "\$ENV_FILE_MODE" = 600 \] \|\| die/)

  // Handed to the suite, and to the runner's own teardown, `--env-file` first.
  assert.match(shellCode, /PS6_COMPOSE_ENV_FILE="\$PS6_COMPOSE_ENV_FILE"/)
  assert.match(
    shellCode,
    /\$DOCKER compose --env-file "\$PS6_COMPOSE_ENV_FILE" -p "\$PS6_PROJECT" -f "\$COMPOSE_FILE"/,
    'the project teardown must supply --env-file before -p and -f',
  )
  assert.match(
    shellCode,
    /if \[ -s "\$PS6_COMPOSE_ENV_FILE" \]; then/,
    'the teardown must only use the file when it exists and is non-empty',
  )

  // Removed by the cleanup path, and the removal is checked.
  assert.match(shellCode, /rm -f "\$PS6_COMPOSE_ENV_FILE"/)
  assert.match(shellCode, /fail "\$PS6_COMPOSE_ENV_FILE survived cleanup"/)

  // Never printed. The PATH may be echoed; the CONTENTS may not be read at all.
  // `stat -c %a` is a read of the mode, not of the file, and is what proves 0600.
  for (const line of shellCode.split('\n')) {
    if (!line.includes('PS6_COMPOSE_ENV_FILE')) continue
    assert.ok(
      !/\b(cat|head|tail|od|xxd|base64|strings|less|more)\b/.test(line),
      `the Compose env file's contents must never be read: ${line.trim()}`,
    )
    assert.ok(
      !/^\s*\.\s+"\$PS6_COMPOSE_ENV_FILE"/.test(line),
      `the Compose env file must never be sourced into the runner's own shell: ${line.trim()}`,
    )
  }

  // Guard 8 refuses a pinned tree that predates this amendment.
  assert.match(shellCode, /guard 8 — the pinned source honours PS6_COMPOSE_ENV_FILE/)
  assert.match(shellCode, /grep -q 'PS6_COMPOSE_ENV_FILE' "\$TEST_FILE" \|\| die/)
})

// ═══ PS6-ENV-3 ═══════════════════════════════════════════════════════════════

test('PS6-ENV-3 the acceptance suite writes only throwaway values and reads no Production .env', () => {
  // --env-file is a top-level Compose flag: it must precede -p and -f, and the
  // subcommand. After the subcommand it is a different, service-scoped flag.
  assert.match(
    jsCode,
    /'compose',\s*\n\s*\.\.\.\(COMPOSE_ENV_FILE \? \['--env-file', COMPOSE_ENV_FILE\] : \[\]\),\s*\n\s*'-p', PROJECT, '-f', COMPOSE_FILE,/,
    '--env-file must be emitted before -p and -f',
  )

  // Only the four interpolation keys are ever written to disk.
  const keys = jsCode.match(/const COMPOSE_INTERPOLATION_KEYS = \[([\s\S]*?)\]/)
  assert.ok(keys, 'the suite declares the exact key list it will write')
  const declared = [...keys[1].matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1])
  assert.deepEqual(declared, REQUIRED, 'exactly the four Compose interpolates, and nothing else')

  // The values are minted here, never read from configuration.
  assert.match(jsCode, /PS6_SUPER_PASSWORD: randomBytes\(18\)/)
  assert.match(jsCode, /PS6_DRIVE_DB_PASSWORD: randomBytes\(18\)/)
  assert.match(jsCode, /PS6_SESSION_SECRET: randomBytes\(32\)/)

  // No Production configuration is opened, and no Production database is named.
  assert.ok(!/readFile\([^)]*\.env/.test(jsCode), 'the suite must never read a .env file')
  assert.ok(!/aegis-prod|aegis_prod/.test(jsCode), 'the suite must never name a Production object')
  assert.ok(!/aegis_postgres_data|aegis_drive_storage/.test(jsCode), 'no Production volume may be named')
  assert.ok(!/192\.168\.10\./.test(jsCode), 'no Production address may be named')

  // Mode is asserted in the suite itself, so Stage B carries its own evidence.
  assert.match(jsCode, /assert\.equal\(mode, 0o600/)
})

// ═══ PS6-ENV-4 ═══════════════════════════════════════════════════════════════

/**
 * Load the acceptance suite in a child, with the harness disabled, and report
 * whether module-load validation accepted the environment. The suite is inert
 * without PUBLIC_SHARE_INTEGRATION_RUNTIME=1, so this costs one Node start and
 * touches nothing.
 */
function loadSuite(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', SUITE], {
      cwd: DRIVE_ROOT,
      env: { ...cleanEnv(), PUBLIC_SHARE_INTEGRATION_RUNTIME: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { out += c })
    child.on('close', (code) => resolve({ code, out }))
  })
}

test('PS6-ENV-4 the env-file path is validated at module load, before anything runs', async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), 'ps6-envpath-'))
  t.after(() => rm(workdir, { recursive: true, force: true }))

  const relative = await loadSuite({ PS6_COMPOSE_ENV_FILE: 'evidence/compose.env', PS6_WORKDIR: workdir })
  assert.notEqual(relative.code, 0, 'a relative path must be refused')
  assert.match(relative.out, /PS6_COMPOSE_ENV_FILE must be an absolute path/)

  const outside = await loadSuite({ PS6_COMPOSE_ENV_FILE: join(tmpdir(), 'ps6-elsewhere.env'), PS6_WORKDIR: workdir })
  assert.notEqual(outside.code, 0, 'a path outside PS6_WORKDIR must be refused')
  assert.match(outside.out, /must be inside PS6_WORKDIR/)

  const escaping = await loadSuite({ PS6_COMPOSE_ENV_FILE: join(workdir, '..', 'ps6-escaped.env'), PS6_WORKDIR: workdir })
  assert.notEqual(escaping.code, 0, 'a path that climbs out of PS6_WORKDIR must be refused')
  assert.match(escaping.out, /must be inside PS6_WORKDIR/)

  const inside = await loadSuite({ PS6_COMPOSE_ENV_FILE: join(workdir, 'evidence', 'compose.env'), PS6_WORKDIR: workdir })
  assert.equal(inside.code, 0, 'a path inside PS6_WORKDIR is accepted, and the harness stays skipped')
  assert.match(inside.out, /# skipped 1/)

  // Unset is the developer-machine path and must stay untouched.
  const unset = await loadSuite({ PS6_COMPOSE_ENV_FILE: '', PS6_WORKDIR: '' })
  assert.equal(unset.code, 0)
  assert.match(unset.out, /# skipped 1/)
})

// ═══ The sudo-like boundary ══════════════════════════════════════════════════

/**
 * Build a wrapper that models `sudo -n env -u DOCKER_HOST docker` on the server
 * host, plus a Docker recorder that implements Compose's interpolation rule.
 *
 * ⚠️ The wrapper strips the environment with `env -i`, i.e. HARDER than sudo:
 *    sudo keeps a small whitelist, this keeps only PATH and HOME. If the fix
 *    works here it works across sudo. No real sudo, no real Docker, no
 *    privilege and no daemon is involved.
 */
function buildBoundary(dir) {
  const log = join(dir, 'docker-calls.jsonl')
  const recorder = join(dir, 'docker-recorder.mjs')
  const wrapper = join(dir, 'sudo-like-docker.sh')

  writeFileSync(recorder, `
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const LOG = ${JSON.stringify(log)}
const REQUIRED = ${JSON.stringify(REQUIRED)}
const argv = process.argv.slice(2)

// What survived the boundary. Recorded so the regression can prove the
// stripping actually happened rather than assuming it.
const ps6EnvKeys = Object.keys(process.env).filter((k) => k.startsWith('PS6_')).sort()
const record = (entry) => appendFileSync(LOG, JSON.stringify({ argv, ps6EnvKeys, ...entry }) + '\\n')

function parseEnvFile(path) {
  const vars = {}
  for (const line of readFileSync(path, 'utf8').split('\\n')) {
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq > 0) vars[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return vars
}

if (argv[0] === 'network' && argv[1] === 'inspect') {
  record({ kind: 'network-inspect' })
  process.stderr.write('Error: No such network\\n')
  process.exit(1)
}

if (argv[0] === 'compose') {
  let i = 1
  let envFile = null
  let project = null
  while (i < argv.length) {
    if (argv[i] === '--env-file') { envFile = argv[i + 1]; i += 2; continue }
    if (argv[i] === '-p') { project = argv[i + 1]; i += 2; continue }
    if (argv[i] === '-f') { i += 2; continue }
    break
  }
  const subcommand = argv[i] ?? null

  // Compose's own rule: the process environment, then the --env-file, are the
  // interpolation sources. Nothing else is.
  const sources = {}
  for (const key of REQUIRED) if (process.env[key] !== undefined) sources[key] = { source: 'environment', value: process.env[key] }
  if (envFile) {
    const fromFile = parseEnvFile(envFile)
    for (const key of REQUIRED) if (fromFile[key] !== undefined) sources[key] = { source: 'env-file', value: fromFile[key] }
  }

  const missing = REQUIRED.filter((key) => sources[key] === undefined || sources[key].value === '')
  if (missing.length > 0) {
    record({ kind: 'compose', subcommand, project, envFile, interpolation: 'failed', missing })
    // The exact shape Stage B attempt #1 reported.
    for (const key of missing) {
      process.stderr.write('error while interpolating services.postgres.environment.POSTGRES_USER: required variable ' + key + ' is missing a value: ' + key + ' is required\\n')
    }
    process.exit(1)
  }

  // ⚠️ Values are NEVER recorded. Only their digest, so the regression can prove
  //    the plumbing carried them intact without writing a secret to a log.
  record({
    kind: 'compose', subcommand, project, envFile, interpolation: 'ok',
    resolved: REQUIRED.map((key) => ({ key, source: sources[key].source, sha256: createHash('sha256').update(sources[key].value).digest('hex') })),
  })
  process.exit(0)
}

record({ kind: 'unsupported' })
process.exit(1)
`, 'utf8')

  writeFileSync(wrapper, `#!/bin/sh
# Models the server host's PS6_DOCKER: sudo -n env -u DOCKER_HOST docker.
# sudo drops arbitrary environment variables; env -i drops all but two, which is
# strictly stronger. Nothing here is privileged and nothing here is Docker.
exec env -i PATH="$PATH" HOME="$HOME" ${JSON.stringify(process.execPath)} ${JSON.stringify(recorder)} "$@"
`, 'utf8')
  chmodSync(wrapper, 0o755)

  return { log, wrapper }
}

/** Run the acceptance suite against the boundary. It is expected to fail. */
function runSuiteAcrossBoundary({ wrapper, workdir, envFile }) {
  return new Promise((resolve) => {
    const env = {
      ...cleanEnv(),
      PUBLIC_SHARE_INTEGRATION_RUNTIME: '1',
      PS6_DOCKER: wrapper,
      PS6_PROJECT: 'aegis-ps6-envplumbing',
      PS6_WORKDIR: workdir,
      PS6_FILE_BYTES: '1024',
    }
    if (envFile) env.PS6_COMPOSE_ENV_FILE = envFile
    else delete env.PS6_COMPOSE_ENV_FILE

    const child = spawn(process.execPath, ['--test', '--test-timeout=120000', SUITE], {
      cwd: DRIVE_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { out += c })
    child.on('close', (code) => resolve({ code, out }))
  })
}

const readLog = (log) => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

// ═══ PS6-ENV-5 — the regression ══════════════════════════════════════════════

test('PS6-ENV-5 across an environment-stripping boundary, Compose is fed only by --env-file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ps6-envplumb-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { log, wrapper } = buildBoundary(dir)
  const envFile = join(dir, 'evidence-compose.env')

  const run = await runSuiteAcrossBoundary({ wrapper, workdir: dir, envFile })

  // The suite itself fails — the recorder is not a Docker daemon and starts no
  // container. What is under test is everything up to and including `up`.
  assert.notEqual(run.code, 0, 'the suite cannot pass against a recorder; that is not what this proves')

  const calls = readLog(log)
  assert.ok(calls.length > 0, 'the boundary was crossed at least once')

  // 1 · the boundary really did strip the environment.
  for (const call of calls) {
    assert.deepEqual(call.ps6EnvKeys, [], 'no PS6_* variable may survive the boundary')
  }

  // 2 · `compose up` happened, and carried --env-file before -p and -f.
  const up = calls.find((c) => c.kind === 'compose' && c.subcommand === 'up')
  assert.ok(up, 'the suite reached `docker compose … up`')
  assert.equal(up.argv[0], 'compose')
  assert.equal(up.argv[1], '--env-file', '--env-file must be the first top-level flag')
  assert.equal(up.argv[2], envFile)
  assert.equal(up.argv[3], '-p')
  assert.equal(up.argv[4], 'aegis-ps6-envplumbing')
  assert.equal(up.argv[5], '-f')

  // 3 · interpolation succeeded, and every value came from the FILE — there was
  //     no environment left for it to come from.
  assert.equal(up.interpolation, 'ok')
  assert.deepEqual(up.resolved.map((r) => r.key), REQUIRED)
  for (const entry of up.resolved) {
    assert.equal(entry.source, 'env-file', `${entry.key} must reach Compose through the env file`)
  }

  // 4 · the values that arrived are the values the suite generated, unmodified.
  const onDisk = Object.fromEntries(
    (await readFile(envFile, 'utf8')).split('\n').filter(Boolean).map((line) => {
      const eq = line.indexOf('=')
      return [line.slice(0, eq), line.slice(eq + 1)]
    }),
  )
  assert.deepEqual(Object.keys(onDisk), REQUIRED, 'the file holds those four keys and nothing else')
  for (const entry of up.resolved) {
    assert.equal(entry.sha256, sha256(onDisk[entry.key]), `${entry.key} crossed the boundary intact`)
  }

  // 5 · the file is owner-only.
  assert.equal((await stat(envFile)).mode & 0o777, 0o600, 'the Compose env file must be mode 0600')

  // 6 · not one of the four values appears anywhere in the run's output.
  for (const key of REQUIRED) {
    assert.ok(onDisk[key].length > 0, `${key} must be non-empty`)
    assert.ok(!run.out.includes(onDisk[key]), `${key}'s value must never be printed`)
  }
  // …nor in the recorder's log, which is the most tempting place to leak it.
  const rawLog = readFileSync(log, 'utf8')
  for (const key of REQUIRED) assert.ok(!rawLog.includes(onDisk[key]), `${key}'s value must never be logged`)

  // 7 · the teardown the suite performs uses the same file, for the same reason.
  const down = calls.find((c) => c.kind === 'compose' && c.subcommand === 'down')
  assert.ok(down, 'the suite tore its project down')
  assert.equal(down.envFile, envFile, 'the teardown must interpolate from the same file')
  assert.equal(down.interpolation, 'ok')
})

// ═══ PS6-ENV-6 — the negative control ════════════════════════════════════════

test('PS6-ENV-6 without the env file, the same boundary reproduces the Stage B attempt #1 failure', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ps6-envplumb-neg-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { log, wrapper } = buildBoundary(dir)

  const run = await runSuiteAcrossBoundary({ wrapper, workdir: '', envFile: null })
  assert.notEqual(run.code, 0)

  const calls = readLog(log)
  const up = calls.find((c) => c.kind === 'compose' && c.subcommand === 'up')
  assert.ok(up, 'the suite still reached `docker compose … up`')
  assert.equal(up.envFile, null, 'with PS6_COMPOSE_ENV_FILE unset, no --env-file is passed')
  assert.equal(up.interpolation, 'failed')
  assert.deepEqual(up.missing, REQUIRED, 'all four are missing, exactly as on the server')

  // The observed Stage B text, reproduced without sudo, Docker or a server.
  assert.match(run.out, /required variable PS6_SUPER_USER is missing a value/)
  assert.match(run.out, /required variable PS6_SUPER_PASSWORD is missing a value/)
  assert.match(run.out, /required variable PS6_DRIVE_DB_PASSWORD is missing a value/)
  assert.match(run.out, /required variable PS6_SESSION_SECRET is missing a value/)

  // And no file was written anywhere, because none was owned.
  assert.ok(!existsSync(join(dir, 'evidence-compose.env')))
})

// ═══ The runner's own cleanup ════════════════════════════════════════════════


/**
 * Stubs that let the runner reach its own guards without a daemon, a privilege
 * or a network.
 *
 * ⚠️ `sudo` here is NOT privileged and grants nothing: it drops the `-n` it is
 *    handed and execs the rest as the current user. It exists only so the
 *    runner walks the same code path it would on the server.
 */
function buildRunnerStubs(dir, { gitBehaviour }) {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const write = (name, body) => {
    const path = join(bin, name)
    writeFileSync(path, body, 'utf8')
    chmodSync(path, 0o755)
  }

  write('sudo', `#!/bin/sh
[ "$1" = "-n" ] && shift
[ "$1" = "true" ] && exit 0
[ "$1" = "-v" ] && exit 0
exec "$@"
`)

  // Enough Docker to satisfy guards 1 and 3–6, and nothing more. Every listing
  // is empty, so no object is ever adopted and nothing is ever removed.
  write('docker', `#!/bin/sh
case "$1 $2" in
  "version --format") echo "server 0.0.0-stub"; exit 0 ;;
  "compose version") echo "Docker Compose version v0.0.0-stub"; exit 0 ;;
  "image inspect")    exit 0 ;;
  "network inspect")  exit 1 ;;
esac
exit 0
`)

  write('git', gitBehaviour)
  return bin
}

/**
 * Run the real runner far enough that it creates its work directory and its
 * Compose env file, then make it end the way `end` says. Returns once it has.
 */
function runRunner({ dir, gitBehaviour, project, signal }) {
  const bin = buildRunnerStubs(dir, { gitBehaviour })
  const workdir = `/tmp/${project}`
  const envFile = `${workdir}/evidence/compose.env`

  return new Promise((resolve) => {
    const child = spawn('sh', [RUNNER], {
      cwd: dir,
      // `detached` gives the runner its own process group, so a signal can be
      // delivered to the group — which is what Ctrl-C at a terminal does.
      detached: true,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: process.env.HOME,
        PS6_PROJECT: project,
        PS6_SOURCE_SHA: 'a'.repeat(40),
        PS6_SUDO_KEEPALIVE: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { out += c })

    let sawEnvFile = false
    let poll = null
    if (signal) {
      poll = setInterval(() => {
        if (!existsSync(envFile)) return
        sawEnvFile = true
        clearInterval(poll)
        poll = null
        try { process.kill(-child.pid, signal) } catch { /* already gone */ }
      }, 25)
    }

    child.on('close', (code) => {
      if (poll) clearInterval(poll)
      resolve({ code, out, workdir, envFile, sawEnvFile })
    })
  })
}

// ═══ PS6-ENV-7 ═══════════════════════════════════════════════════════════════

test('PS6-ENV-7 a failure after the env file exists still removes it, via the workdir cleanup trap', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ps6-runner-fail-'))
  const project = `aegis-ps6-envfail-${process.pid}`
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(`/tmp/${project}`, { recursive: true, force: true })
  })

  // The runner creates its work directory and env file, then dies at `git clone`.
  const run = await runRunner({
    dir, project,
    gitBehaviour: '#!/bin/sh\nexit 1\n',
  })

  assert.notEqual(run.code, 0, 'the runner fails when it cannot pin its source')
  assert.match(run.out, /compose env file — explicit interpolation plumbing/)
  assert.match(run.out, new RegExp(`path: ${run.envFile}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(run.out, /mode: 0600/)

  assert.ok(!existsSync(run.envFile), 'the Compose env file must not survive a failed run')
  assert.ok(!existsSync(run.workdir), 'the whole owned work directory must not survive a failed run')

  // Nothing was torn down, because nothing was created: STARTED was never 1.
  assert.ok(!/cleanup — Docker objects owned by project/.test(run.out))
})

// ═══ PS6-ENV-8 ═══════════════════════════════════════════════════════════════

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`PS6-ENV-8 ${signal} to the runner still removes the Compose env file`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), `ps6-runner-${signal.toLowerCase()}-`))
    const project = `aegis-ps6-env${signal.toLowerCase()}-${process.pid}`
    t.after(() => {
      rmSync(dir, { recursive: true, force: true })
      rmSync(`/tmp/${project}`, { recursive: true, force: true })
    })

    // `git clone` blocks, so the signal arrives while the file is on disk.
    const run = await runRunner({
      dir, project, signal,
      gitBehaviour: '#!/bin/sh\nsleep 60\n',
    })

    assert.ok(run.sawEnvFile, 'the env file existed at the moment the signal was sent')
    assert.notEqual(run.code, 0, `${signal} must not be reported as success`)
    assert.ok(!existsSync(run.envFile), `the Compose env file must not survive ${signal}`)
    assert.ok(!existsSync(run.workdir), `the owned work directory must not survive ${signal}`)
  })
}
