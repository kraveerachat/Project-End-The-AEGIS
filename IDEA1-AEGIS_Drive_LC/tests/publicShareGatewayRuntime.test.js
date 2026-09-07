// tests/publicShareGatewayRuntime.test.js — PUBLIC-SHARE-3 real-container checks
//
// Opt in with PUBLIC_SHARE_GATEWAY_RUNTIME=1. The default full IDEA1 suite
// skips this one integration harness so it never mutates Docker implicitly.
//
// `aegis_public_share` is a Docker `internal: true` network, which is what
// enforces architecture boundary B5 (Gateway -> everything else = nothing).
// Docker cannot publish a host port from an internal network, and B5 forbids a
// host path to the gateway anyway, so every HTTP request below is generated
// from inside the network by one of the two existing members: the drive test
// recorder drives the gateway at http://public-share-gateway:8080, and the
// gateway drives its own listener when the recorder has to be stopped. No
// third container is added.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ENABLED = process.env.PUBLIC_SHARE_GATEWAY_RUNTIME === '1'
const ROOT = dirname(fileURLToPath(new URL('../../gateway/public-share/docker-compose.yml', import.meta.url)))
const COMPOSE_FILE = fileURLToPath(new URL('../../gateway/public-share/docker-compose.yml', import.meta.url))
const HOST = 'share.example.invalid'
const PROJECT = `aegis-ps3-${process.pid}`

/**
 * Build the client program run inside the recorder container. It speaks raw
 * node:http rather than fetch on purpose: fetch would normalise a request
 * target such as `/s/token/../api`, and the raw target is exactly what the
 * gateway's traversal guard has to be tested against.
 */
function clientProgram(specs) {
  return [
    "const http = require('node:http')",
    `const specs = ${JSON.stringify(specs)}`,
    'const run = (spec) => new Promise((resolve) => {',
    '  const payload = !spec.body ? null',
    "    : spec.body.kind === 'fill' ? Buffer.alloc(spec.body.size, spec.body.char)",
    '    : Buffer.from(spec.body.value)',
    '  const headers = Object.assign({ Host: spec.host }, spec.headers || {})',
    "  if (payload && headers['Content-Length'] === undefined) headers['Content-Length'] = String(payload.length)",
    '  const req = http.request({',
    "    hostname: 'public-share-gateway', port: 8080,",
    "    path: spec.path, method: spec.method || 'GET', headers,",
    '  }, (res) => {',
    '    const chunks = []',
    "    res.on('data', (c) => chunks.push(c))",
    "    res.on('end', () => resolve({",
    '      status: res.statusCode, headers: res.headers,',
    "      body: Buffer.concat(chunks).toString('utf8'),",
    '    }))',
    '  })',
    "  req.on('error', (e) => resolve({ error: e.code || e.message }))",
    '  if (payload) req.write(payload)',
    '  req.end()',
    '})',
    'Promise.all(specs.map(run)).then((r) => console.log(JSON.stringify(r)))',
  ].join('\n')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('PS3-RUNTIME dedicated gateway enforces the complete share-only boundary', {
  skip: ENABLED ? false : 'set PUBLIC_SHARE_GATEWAY_RUNTIME=1 to run the isolated Docker harness',
  timeout: 420_000,
}, async (t) => {
  const env = { ...process.env, PUBLIC_SHARE_HOST: HOST }
  const docker = async (args, options = {}) => execFileAsync('docker', args, {
    cwd: ROOT,
    env,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
  const compose = (args, options) => docker([
    'compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...args,
  ], options)

  // A fixed network name is part of the accepted security contract. Refuse to
  // adopt or delete a pre-existing network whose ownership is unknown.
  await assert.rejects(docker(['network', 'inspect', 'aegis_public_share']))

  let started = false
  t.after(async () => {
    if (!started) return
    await compose(['down', '--remove-orphans', '--timeout', '5']).catch(() => {})
  })

  started = true
  await compose(['up', '--build', '-d', '--wait', '--wait-timeout', '120'])

  const gatewayId = (await compose(['ps', '-q', 'public-share-gateway'])).stdout.trim()
  const driveId = (await compose(['ps', '-q', 'drive'])).stdout.trim()
  assert.ok(gatewayId && driveId, 'both isolated containers must be running')

  /** Drive the gateway from inside the network, as the recorder container. */
  const gatewayRequests = async (specs) => {
    const withHost = specs.map((spec) => ({ host: HOST, ...spec }))
    const result = await docker(['exec', driveId, 'node', '-e', clientProgram(withHost)])
    return JSON.parse(result.stdout.trim())
  }
  const gatewayRequest = async (path, options = {}) => (
    (await gatewayRequests([{ path, ...options }]))[0]
  )

  /**
   * Drive the gateway's own listener from inside the gateway container. Used
   * only where the recorder is stopped. Busybox nc exits as soon as stdin is
   * exhausted, so stdin is held open long enough to outlast the response —
   * including the 5s proxy_connect_timeout on a dead upstream.
   */
  const gatewaySelfRequest = async (requestLine, { holdSeconds = 3 } = {}) => {
    const wire = `${requestLine} HTTP/1.1\\r\\nHost: ${HOST}\\r\\nConnection: close\\r\\n\\r\\n`
    const result = await docker(['exec', gatewayId, 'sh', '-c',
      `{ printf '${wire}'; sleep ${holdSeconds}; } | nc 127.0.0.1 8080`])
    const status = /^HTTP\/1\.1 (\d{3})/.exec(result.stdout)
    return { status: status ? Number(status[1]) : 0, raw: result.stdout }
  }

  const recorder = async (pathname = '/__test/state', method = 'GET') => {
    const script = [
      `fetch('http://127.0.0.1:8001${pathname}', { method: '${method}' })`,
      ".then(async (response) => { const text = await response.text(); if (!response.ok) throw new Error(text); console.log(text) })",
      ".catch((error) => { console.error(error.message); process.exit(1) })",
    ].join('')
    const result = await docker(['exec', driveId, 'node', '-e', script])
    return JSON.parse(result.stdout.trim())
  }
  const resetRecorder = () => recorder('/__test/reset', 'POST')

  await t.test('PS3-RUNTIME-1 the dedicated network is internal with exactly two isolated members', async () => {
    const network = JSON.parse((await docker(['network', 'inspect', 'aegis_public_share'])).stdout)[0]

    // B5 is enforced by the network itself, not merely by membership.
    assert.equal(network.Internal, true, 'aegis_public_share must be a Docker internal network')

    const members = Object.values(network.Containers)
    assert.equal(members.length, 2)
    assert.deepEqual(members.map((entry) => entry.Name).sort(), [
      `${PROJECT}-drive-1`, `${PROJECT}-public-share-gateway-1`,
    ])
    assert.ok(members.some((entry) => entry.IPv4Address === '172.31.254.2/29'))
    assert.ok(members.some((entry) => entry.IPv4Address === '172.31.254.3/29'))

    const [gateway] = JSON.parse((await docker(['inspect', gatewayId])).stdout)
    const [drive] = JSON.parse((await docker(['inspect', driveId])).stdout)
    assert.deepEqual(Object.keys(gateway.NetworkSettings.Networks), ['aegis_public_share'])
    assert.deepEqual(Object.keys(drive.NetworkSettings.Networks), ['aegis_public_share'])
    assert.equal(gateway.Config.User, '101:101')
    assert.equal(gateway.HostConfig.ReadonlyRootfs, true)
    assert.ok(gateway.HostConfig.CapDrop.includes('ALL'))

    // Neither member may reach the host. An internal network cannot publish a
    // port, so a request for one would be silently dropped rather than refused.
    assert.deepEqual(gateway.HostConfig.PortBindings ?? {}, {}, 'gateway must request no host port')
    assert.deepEqual(gateway.NetworkSettings.Ports ?? {}, {}, 'gateway must publish no host port')
    assert.deepEqual(drive.HostConfig.PortBindings ?? {}, {}, 'drive must request no host port')
    assert.deepEqual(drive.NetworkSettings.Ports ?? {}, {}, 'drive must publish no host port')

    assert.equal(gateway.Mounts.some((mount) => ['bind', 'volume'].includes(mount.Type)), false)
    assert.equal(gateway.Config.Env.some((value) => /DATABASE_URL|SESSION_SECRET|VAULT|STORAGE|PASSWORD|TOKEN/i.test(value)), false)
  })

  await t.test('PS3-RUNTIME-1b the gateway has no egress path off the dedicated network', async () => {
    // Routing is decided locally: with internal:true there is no route off the
    // bridge at all, so this never depends on real Internet availability.
    const egress = await docker(['exec', gatewayId, 'sh', '-c',
      'wget -qO- -T 4 http://1.1.1.1/ 2>&1 || true'])
    assert.match(egress.stdout, /Network unreachable/i, `gateway reached off-network: ${egress.stdout}`)

    // The one permitted path still works.
    const upstream = await docker(['exec', gatewayId, 'sh', '-c',
      'wget -qO- -T 5 http://drive:8001/__test/health 2>&1'])
    assert.match(upstream.stdout, /"ok":\s*true/)
  })

  await t.test('PS3-RUNTIME-2 generated nginx config is valid', async () => {
    const result = await docker(['exec', gatewayId, 'nginx', '-t', '-c', '/tmp/nginx.conf'])
    assert.match(`${result.stdout}${result.stderr}`, /syntax is ok/)
    assert.match(`${result.stdout}${result.stderr}`, /test is successful/)
  })

  await t.test('PS3-RUNTIME-3 GET, POST, case variant and trailing slash reach only the recorder', async () => {
    await resetRecorder()
    const responses = await gatewayRequests([
      { path: '/s/Abc_123-x', method: 'GET' },
      {
        path: '/s/Abc_123-x',
        method: 'POST',
        body: { kind: 'text', value: 'password=small' },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
      { path: '/S/Abc_123-x', method: 'GET' },
      { path: '/s/Abc_123-x/', method: 'GET' },
    ])
    for (const [index, response] of responses.entries()) {
      assert.equal(response.status, 200, `case ${index}: ${JSON.stringify(response)}`)
    }
    const state = await recorder()
    assert.equal(state.count, 4)
    assert.deepEqual(state.requests.map(({ method }) => method).sort(), ['GET', 'GET', 'GET', 'POST'])
  })

  await t.test('PS3-RUNTIME-4 query cannot select another route and forwarding headers are authored', async () => {
    await resetRecorder()
    const response = await gatewayRequest('/s/QueryToken?next=/api/files', {
      headers: {
        'X-Forwarded-For': '10.0.0.5',
        'X-Real-IP': '10.0.0.6',
        Forwarded: 'for=10.0.0.7',
        'X-Forwarded-Host': 'evil.example',
      },
    })
    assert.equal(response.status, 200)
    const received = JSON.parse(response.body)
    assert.equal(received.path, '/s/QueryToken?next=/api/files')
    assert.equal(received.headers.host, HOST)
    assert.equal(received.headers['x-forwarded-host'], HOST)
    assert.equal(received.headers['x-forwarded-proto'], 'https')
    assert.equal(received.headers.forwarded, undefined)
    assert.equal(received.headers['x-forwarded-for'], received.headers['x-real-ip'])
    assert.notEqual(received.headers['x-forwarded-for'], '10.0.0.5')
    assert.notEqual(received.headers['x-real-ip'], '10.0.0.6')
    assert.match(received.headers['x-forwarded-for'], /^(?:\d{1,3}\.){3}\d{1,3}$/)
    assert.equal((await recorder()).count, 1)
  })

  await t.test('PS3-RUNTIME-5 every forbidden/malformed route fails locally with zero upstream contacts', async () => {
    await resetRecorder()
    const forbidden = [
      '/', '/api', '/api/', '/api/files', '/drive', '/drive/', '/drive/api/files',
      '/login', '/admin', '/admin/users', '/settings', '/internal', '/healthz',
      '/monitor', '/monitor/', '/API/', '/Drive/', '/HEALTHZ', '/Monitor/',
      '/s/', '/s/token/../api', '/s/token/../../api', '/s/token/extra',
      '/s/token=', '/s/token.', '/s/%2e%2e/api', '/static/app.js', '/anything.txt',
    ]
    const responses = await gatewayRequests(forbidden.map((path) => ({ path })))
    for (const [index, response] of responses.entries()) {
      assert.equal(response.status, 404, `${forbidden[index]}: ${JSON.stringify(response)}`)
    }
    const malformed = await gatewayRequest('/s/%ZZ')
    assert.ok([400, 404].includes(malformed.status), `malformed encoding returned ${malformed.status}`)
    assert.equal((await recorder()).count, 0)
  })

  await t.test('PS3-RUNTIME-6 PUT, PATCH, DELETE, OPTIONS and HEAD stop before Drive', async () => {
    await resetRecorder()
    const methods = ['PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']
    const responses = await gatewayRequests(methods.map((method) => ({ path: '/s/MethodToken', method })))
    for (const [index, response] of responses.entries()) {
      assert.equal(response.status, 405, methods[index])
    }
    assert.equal((await recorder()).count, 0)
  })

  await t.test('PS3-RUNTIME-7 an attacker-controlled Host is never forwarded', async () => {
    await resetRecorder()
    const response = await gatewayRequest('/s/HostToken', { host: 'evil.attacker.invalid' })
    assert.equal(response.status, 404)
    assert.equal((await recorder()).count, 0)
  })

  await t.test('PS3-RUNTIME-8 a normal form passes and a body over 16 KiB never reaches Drive', async () => {
    await resetRecorder()
    const small = await gatewayRequest('/s/BodyToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: { kind: 'text', value: 'password=small' },
    })
    assert.equal(small.status, 200)
    assert.equal(JSON.parse(small.body).bodyLength, 14)

    const oversized = await gatewayRequest('/s/BodyToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: { kind: 'fill', size: 16 * 1024 + 1, char: 'x' },
    })
    assert.equal(oversized.status, 413, JSON.stringify(oversized))
    assert.equal((await recorder()).count, 1)
  })

  await t.test('PS3-RUNTIME-9 ordinary traffic passes and a burst is capped with 429', async () => {
    await sleep(2500)
    await resetRecorder()
    assert.equal((await gatewayRequest('/s/RateToken')).status, 200)
    const burst = await gatewayRequests(Array.from({ length: 40 }, () => ({ path: '/s/RateToken' })))
    const statuses = burst.map(({ status }) => status)
    assert.ok(statuses.includes(429), `statuses=${JSON.stringify(statuses)}`)
    const state = await recorder()
    assert.ok(state.count < 41, `gateway forwarded ${state.count}/41 requests`)
    console.log(`[public-share-gateway] rate statuses: 200=${statuses.filter((s) => s === 200).length + 1}, 429=${statuses.filter((s) => s === 429).length}; upstream=${state.count}`)
  })

  await t.test('PS3-RUNTIME-10 self-health is internal; public health is denied', async () => {
    await sleep(2500)
    await resetRecorder()
    const publicHealth = await gatewayRequest('/healthz')
    assert.equal(publicHealth.status, 404)
    assert.equal((await recorder()).count, 0)
    const internal = await docker(['exec', gatewayId, 'wget', '-qO-', 'http://127.0.0.1:8081/healthz'])
    assert.equal(internal.stdout, 'ok\n')
  })

  await t.test('PS3-RUNTIME-11 unrelated AEGIS service names are absent from gateway DNS', async () => {
    await docker(['exec', gatewayId, 'sh', '-c', 'command -v nslookup >/dev/null'])
    const driveLookup = await docker(['exec', gatewayId, 'nslookup', 'drive'])
    assert.match(`${driveLookup.stdout}${driveLookup.stderr}`, /Address:\s*172\.31\.254\.3\b/)
    for (const name of ['postgres', 'monitor', 'gateway']) {
      // The answer itself—not the process code—is the contract under test.
      // BusyBox nslookup exits 0 for "Can't find ...: No answer" but non-zero
      // for the SERVFAIL the embedded resolver returns on an internal network,
      // so the exit status is deliberately discarded here.
      const lookup = await docker(['exec', gatewayId, 'sh', '-c',
        `nslookup ${name} 2>&1 || true`])
      assert.match(
        lookup.stdout,
        /(?:can't find|no answer|nxdomain|servfail)/i,
        `${name} unexpectedly resolved inside the dedicated network`,
      )
      assert.doesNotMatch(
        lookup.stdout,
        /^Address:\s*(?!127\.0\.0\.11)\d/m,
        `${name} returned an address inside the dedicated network`,
      )
    }
  })

  await t.test('PS3-RUNTIME-12 a unique raw token never appears in access or routine error logs', async () => {
    const sentinel = `TOKEN_MUST_NOT_APPEAR_${randomBytes(8).toString('hex')}`
    await sleep(2500)
    await gatewayRequests([
      { path: `/s/${sentinel}` },
      { path: `/api/${sentinel}` },
      { path: `/s/${sentinel}`, method: 'PUT' },
      ...Array.from({ length: 24 }, () => ({ path: `/s/${sentinel}` })),
    ])

    // Routine upstream failure is practical in this isolated harness. Stop and
    // restart only this task's recorder; no existing Docker object is touched.
    // With the recorder down the request must come from the gateway itself,
    // because nothing outside the internal network can reach the listener.
    await docker(['stop', '--time', '1', driveId])
    const unavailable = await gatewaySelfRequest(`GET /s/${sentinel}`, { holdSeconds: 9 })
    assert.ok(
      [502, 504].includes(unavailable.status),
      `stopped upstream must fail closed (received ${unavailable.status}: ${unavailable.raw})`,
    )
    await docker(['start', driveId])

    const logs = `${(await docker(['logs', gatewayId])).stdout}${(await docker(['logs', gatewayId])).stderr}`
    assert.equal(logs.includes(sentinel), false, 'raw bearer token leaked into gateway logs')
    console.log(`[public-share-gateway] log sentinel absent across success/deny/method/rate/upstream-failure: ${sentinel.length} chars`)
  })

  await t.test('PS3-RUNTIME-13 a valid PUBLIC_SHARE_HOST renders exactly one configured server_name', async () => {
    const image = JSON.parse((await docker(['inspect', gatewayId])).stdout)[0].Image
    const rendered = await docker([
      'run', '--rm', '--network', 'none', '-e', `PUBLIC_SHARE_HOST=${HOST}`,
      '--entrypoint', '/bin/sh', image, '-c',
      '/usr/local/bin/aegis-validate-public-share-host.sh && /docker-entrypoint.d/20-envsubst-on-templates.sh >/dev/null 2>&1 && cat /tmp/nginx.conf',
    ])

    assert.ok(rendered.stdout.includes(`server_name ${HOST};`), 'configured host must render as one name')
    assert.ok(rendered.stdout.includes(`proxy_set_header Host ${HOST};`))
    assert.ok(rendered.stdout.includes(`proxy_set_header X-Forwarded-Host ${HOST};`))
    assert.equal(rendered.stdout.includes('$PUBLIC_SHARE_HOST'), false, 'template must be fully substituted')
    // Only the two catch-alls and the one configured listener may exist.
    assert.equal(rendered.stdout.split('server_name ').length - 1, 3)
  })

  await t.test('PS3-RUNTIME-14 every malformed PUBLIC_SHARE_HOST stops the gateway before nginx starts', async () => {
    const image = JSON.parse((await docker(['inspect', gatewayId])).stdout)[0].Image
    const malformed = {
      empty: '',
      'multiple names': 'evil.example another.test',
      wildcard: '*.example.invalid',
      'nginx regex prefix': '~^.*$',
      'directive injection': 'evil;return 200',
      'nginx variable': 'evil${host}',
      scheme: 'https://evil.example',
      path: 'evil.example/path',
      'host:port': 'evil.example:8443',
      'embedded newline': 'evil.example\nanother.test',
      'brace injection': 'evil.example}',
    }

    for (const [label, value] of Object.entries(malformed)) {
      // Run the real entrypoint chain, then report whether a config was ever
      // rendered. The trailing echo keeps the outer shell status usable.
      const probe = await docker([
        'run', '--rm', '--network', 'none', '-e', `PUBLIC_SHARE_HOST=${value}`,
        '--entrypoint', '/bin/sh', image, '-c',
        '/usr/local/bin/aegis-public-share-entrypoint.sh nginx -g "daemon off;" -c /tmp/nginx.conf; echo "GATE_EXIT=$?"; [ -f /tmp/nginx.conf ] && echo RENDERED || echo NOT_RENDERED',
      ])
      const output = `${probe.stdout}${probe.stderr}`
      assert.match(output, /refusing to start/, `${label} must be refused`)
      assert.match(output, /GATE_EXIT=1/, `${label} must fail startup`)
      assert.match(output, /NOT_RENDERED/, `${label} must never render an nginx config`)
      assert.equal(output.includes('Configuration complete'), false, `${label} must not reach nginx start-up`)
    }

    // Under its real entrypoint the container must exit non-zero, so no
    // restart policy or orchestrator can mistake this for a healthy start.
    await assert.rejects(
      docker(['run', '--rm', '--network', 'none', '-e', 'PUBLIC_SHARE_HOST=evil;return 200', image]),
      'a malformed host must make the gateway container exit non-zero',
    )

    // The gate is load-bearing: bypassing it renders an injected directive
    // that nginx would otherwise parse as configuration.
    const bypass = await docker([
      'run', '--rm', '--network', 'none', '-e', 'PUBLIC_SHARE_HOST=evil.example;return 200 "pwned"',
      '--entrypoint', '/bin/sh', image, '-c',
      '/docker-entrypoint.d/20-envsubst-on-templates.sh >/dev/null 2>&1; cat /tmp/nginx.conf',
    ])
    assert.ok(
      bypass.stdout.includes('server_name evil.example;return 200 "pwned";'),
      'without validation the template would accept an injected directive',
    )
    console.log(`[public-share-gateway] ${Object.keys(malformed).length} malformed PUBLIC_SHARE_HOST values refused before nginx start`)
  })
})
