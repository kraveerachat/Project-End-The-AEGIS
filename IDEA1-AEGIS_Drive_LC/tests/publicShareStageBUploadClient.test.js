// tests/publicShareStageBUploadClient.test.js — PUBLIC-SHARE-6 Stage B
//
// ⚠️ THIS FILE EXISTS BECAUSE STAGE B ATTEMPT #3 ISOLATED THE REMAINING FAILURE
//    TO ONE SENTENCE:
//
//        PS6-INT-4 upload transport failure: status=0 error=EPIPE
//
//    with the PS6 Drive container running, healthy, exit code 0, OOMKilled
//    false, zero restarts, PostgreSQL and the gateway healthy, and no error of
//    the Drive's own in its log. Seven dependent subtests were correctly
//    BLOCKED_BY_PS6_INT_4 rather than reported as defects, and the independent
//    topology, default-deny and B5 subtests all passed.
//
//    The one `shares_scope_check` error visible in that Drive log belongs to
//    PS6-INT-3, which deliberately attempts a `scope=public` share while the
//    database is still pre-009 and requires the constraint to refuse it.
//    PS6-INT-3 PASSED. That log line must not be attributed to PS6-INT-4.
//
// ⚠️ WHAT WAS CHANGED, AND WHAT WAS NOT. The harness client's write model, and
//    nothing else. The old client built a complete 64 MiB Buffer, concatenated
//    it with the multipart head and tail into a second complete Buffer, and
//    handed the whole ~190 MiB result to ONE req.write(). It is now streamed in
//    bounded chunks with backpressure honoured. Same shipped endpoint
//    (POST /api/files/upload), same 64 MiB, same deterministic bytes, same
//    explicit Content-Length, same server-side SHA-256 comparison. No shipped
//    Drive, gateway or backend behaviour was touched, and no acceptance was
//    weakened.
//
// ⚠️ NO DOCKER, NO DAEMON, NO NETWORK BEYOND LOOPBACK. The upload client is
//    extracted from the suite as source and evaluated here, so these are tests
//    of the exact code that runs inside the Drive container, driven against a
//    throwaway Node HTTP server on 127.0.0.1:0.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const SUITE = fileURLToPath(new URL('./publicShareInternalIntegration.test.js', import.meta.url))
const suiteSource = readFileSync(SUITE, 'utf8')

/**
 * Pull a `const NAME = ` … `` template literal out of the suite, as the program
 * text the suite would actually emit.
 *
 * ⚠️ The raw slice is NOT the program. A template literal processes escapes, so
 *    the source `\\r\\n` is a two-character CRLF in the emitted program and a
 *    four-character `\r\n` in the raw slice — and a multipart delimiter made of
 *    the literal text `\r\n` would not be a multipart delimiter at all. So the
 *    slice is re-evaluated as a template literal, exactly as the suite does.
 *    Neither PRELUDE nor UPLOAD_CLIENT contains a substitution, which is what
 *    makes that safe.
 */
const templateOf = (name) => {
  const match = suiteSource.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`\\n'))
  assert.ok(match, `the suite must still define ${name} as a single template literal`)
  assert.ok(!match[1].includes('${'), `${name} must carry no substitution`)
  return new Function('return `' + match[1] + '`')()
}

// The prelude supplies `crypto` and `http`; the upload client is what is tested.
const client = new Function(
  'require',
  `${templateOf('PRELUDE')}\n${templateOf('UPLOAD_CLIENT')}\nreturn { deterministicSource, uploadMultipart, parseJsonBody }`,
)(createRequire(import.meta.url))

const BOUNDARY = '----ps6test-boundary'
const FIELD = 'file'
const FILENAME = 'ps6-payload.bin'
const headFor = (boundary) => Buffer.from(
  `--${boundary}\r\nContent-Disposition: form-data; name="${FIELD}"; filename="${FILENAME}"\r\n` +
  'Content-Type: application/octet-stream\r\n\r\n')
const tailFor = (boundary) => Buffer.from(`\r\n--${boundary}--\r\n`)

/** Start a throwaway server on loopback and hand back its port plus a stopper. */
function listen(handler) {
  const server = createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()) }),
    }))
  })
}

const upload = (port, overrides = {}) => client.uploadMultipart({
  host: '127.0.0.1', port, path: '/api/files/upload',
  headers: { Host: 'localhost' },
  boundary: BOUNDARY, fieldName: FIELD, filename: FILENAME,
  totalBytes: 4 * 1024 * 1024, chunkBytes: 256 * 1024,
  nextChunk: client.deterministicSource('ps6-payload'),
  captureBytes: 65536,
  ...overrides,
})

// ═══ PS6-UP-1 ════════════════════════════════════════════════════════════════

test('PS6-UP-1 a slow receiver applying backpressure still receives every byte', async (t) => {
  let received = 0
  const bodyHash = createHash('sha256')

  const server = await listen((req, res) => {
    // Do not read for a moment, so the client's socket buffer fills and write()
    // returns false. Then drain slowly. This is the condition a single
    // unbounded write cannot survive and a backpressure-aware one must.
    req.pause()
    setTimeout(() => {
      req.on('data', (chunk) => { received += chunk.length; bodyHash.update(chunk) })
      req.on('end', () => {
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ file: { id: 1, size: received } }))
      })
      req.resume()
    }, 250)
  })
  t.after(() => server.close())

  const up = await upload(server.port)

  assert.equal(up.responseStarted, true, 'the server answered')
  assert.equal(up.status, 201)
  assert.equal(up.error, null, 'a completed exchange is never a transport failure')
  assert.equal(up.requestError, null)

  assert.ok(up.drainWaits > 0, `the client must actually have waited for drain, got ${up.drainWaits}`)
  assert.equal(up.endedRequest, true, 'end() only after every chunk was accepted')
  assert.equal(up.generatedBytes, 4 * 1024 * 1024, 'every file byte was generated')
  assert.equal(up.writtenBytes, up.contentLength, 'every request byte was handed to the socket')
  assert.equal(received, up.contentLength, 'and every one of them arrived')

  // The Content-Length the client declared is the body the server actually read.
  assert.equal(up.contentLength, headFor(BOUNDARY).length + 4 * 1024 * 1024 + tailFor(BOUNDARY).length)
})

// ═══ PS6-UP-2 ════════════════════════════════════════════════════════════════

test('PS6-UP-2 an early HTTP rejection is reported as a status, not as EPIPE', async (t) => {
  const server = await listen((req, res) => {
    // Answer immediately and never read the body. The client is still writing,
    // so its pipe will usually break too — and that must NOT win.
    res.writeHead(413, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'payload too large' }))
  })
  t.after(() => server.close())

  const up = await upload(server.port)

  assert.equal(up.responseStarted, true, 'the server did begin a response')
  assert.equal(up.status, 413, 'the HTTP answer is the finding')
  assert.equal(up.error, null, 'an available response must never be collapsed into a transport error')
  assert.match(String(up.text), /payload too large/)

  // The transport condition is still visible, next to the response rather than
  // instead of it. Whether it occurs at all is timing; that it never masks the
  // status is the contract.
  assert.ok(up.requestError === null || typeof up.requestError === 'string')

  // And the shared classifier agrees: this is a status finding, not a transport one.
  const parsed = client.parseJsonBody('upload', up, 201)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.diagnostic.reason, 'status')
  assert.equal(parsed.diagnostic.status, 413)
})

// ═══ PS6-UP-3 ════════════════════════════════════════════════════════════════

test('PS6-UP-3 a destroyed socket is reported as a clean transport failure', async (t) => {
  const server = await listen((req) => {
    let seen = 0
    req.on('data', (chunk) => {
      seen += chunk.length
      if (seen > 512 * 1024) req.socket.destroy()
    })
    req.on('error', () => {})
  })
  t.after(() => server.close())

  const up = await upload(server.port, { errorGraceMs: 200 })

  assert.equal(up.responseStarted, false, 'no response ever began')
  assert.ok(up.error, 'the transport code is the finding')
  assert.match(String(up.error), /^(EPIPE|ECONNRESET|ERR_STREAM_WRITE_AFTER_END|socket hang up)$/)
  assert.equal(up.status, 0)
  assert.equal(up.clientSha256, null, 'the payload was never finished, and nothing pretends otherwise')

  // The counters say how far it got, which is the whole point of keeping them.
  assert.ok(up.writtenBytes > 0, 'some bytes were handed to the socket')
  assert.ok(up.writtenBytes < up.contentLength, 'but not all of them')
  assert.equal(up.endedRequest, false, 'end() was never reached')

  const parsed = client.parseJsonBody('upload', up, 201)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.diagnostic.reason, 'transport')
})

// ═══ PS6-UP-4 ════════════════════════════════════════════════════════════════

test('PS6-UP-4 a successful upload delivers exactly the deterministic bytes', async (t) => {
  const chunks = []
  const server = await listen((req, res) => {
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ file: { id: 42 } }))
    })
  })
  t.after(() => server.close())

  const up = await upload(server.port)
  assert.equal(up.status, 201)
  assert.equal(up.error, null)

  const body = Buffer.concat(chunks)
  assert.equal(body.length, up.contentLength, 'the declared Content-Length is what arrived')

  const head = headFor(BOUNDARY)
  const tail = tailFor(BOUNDARY)
  assert.ok(body.subarray(0, head.length).equals(head), 'the multipart head arrived intact')
  assert.ok(body.subarray(body.length - tail.length).equals(tail), 'the multipart trailer arrived intact')

  // The decisive one: the file bytes the receiver got hash to the digest the
  // client computed incrementally from the same deterministic chunks.
  const file = body.subarray(head.length, body.length - tail.length)
  assert.equal(file.length, 4 * 1024 * 1024)
  assert.equal(createHash('sha256').update(file).digest('hex'), up.clientSha256,
    'the receiver-side digest must equal the incrementally computed client digest')
})

// ═══ PS6-UP-5 ════════════════════════════════════════════════════════════════

test('PS6-UP-5 the streamed payload is byte-identical to the one-shot payload', () => {
  /** Exactly the algorithm the suite used before this change. */
  const oneShot = (label, total) => {
    const body = Buffer.alloc(total)
    let seed = createHash('sha256').update(label).digest()
    for (let off = 0; off < total; off += 32) {
      seed = createHash('sha256').update(seed).digest()
      seed.copy(body, off, 0, Math.min(32, total - off))
    }
    return body
  }

  const total = 512 * 1024
  const expected = oneShot('ps6-payload', total)

  // Every legal chunk size must produce the same file: the chunk boundary is a
  // transport detail, not a property of the artifact under test.
  for (const chunkBytes of [32, 1024, 32 * 1024, 256 * 1024, 512 * 1024]) {
    const source = client.deterministicSource('ps6-payload')
    const parts = []
    for (let off = 0; off < total; off += chunkBytes) parts.push(source(Math.min(chunkBytes, total - off)))
    assert.ok(Buffer.concat(parts).equals(expected), `chunkBytes=${chunkBytes} changed the payload`)
  }
})

// ═══ PS6-UP-6 ════════════════════════════════════════════════════════════════

test('PS6-UP-6 Stage B still uploads exactly 64 MiB to the shipped endpoint', () => {
  // ⚠️ The acceptance requirement, asserted separately from the mechanism so a
  //    smaller regression fixture can never be mistaken for a smaller acceptance.
  assert.match(suiteSource, /const FILE_BYTES = Number\(process\.env\.PS6_FILE_BYTES \?\? 64 \* 1024 \* 1024\)/)
  assert.match(suiteSource, /totalBytes: FILE_BYTES, chunkBytes: CHUNK_BYTES, nextChunk: source,/)
  assert.match(suiteSource, /const CHUNK_BYTES = \$\{UPLOAD_CHUNK_BYTES\}/)

  // Bounded, and bounded within the range the task set.
  assert.match(suiteSource, /const UPLOAD_CHUNK_BYTES = Number\(process\.env\.PS6_UPLOAD_CHUNK_BYTES \?\? 256 \* 1024\)/)
  assert.match(suiteSource, /UPLOAD_CHUNK_BYTES % 32 !== 0/)
  assert.match(suiteSource, /UPLOAD_CHUNK_BYTES < 32 \* 1024 \|\| UPLOAD_CHUNK_BYTES > 1024 \* 1024/)

  // Same shipped endpoint, and no substitution anywhere.
  assert.equal((suiteSource.match(/path: '\/api\/files\/upload'/g) ?? []).length, 2)
  assert.ok(!/\/api\/uploads/.test(suiteSource), 'the V2 chunked upload must not be substituted')

  // The whole body is never resident at once any more.
  assert.ok(!/Buffer\.concat\(\[head, body, tail\]\)/.test(suiteSource), 'no whole-request Buffer may be built')
  assert.ok(!/const body = Buffer\.alloc\(FILE_BYTES\)/.test(suiteSource), 'no whole-file Buffer may be built')

  // And the acceptance assertions still stand.
  for (const claim of [
    "assert.equal(r.uploadStatus, 201, 'the 64 MiB upload must succeed on the private path')",
    "assert.equal(r.serverSize, FILE_BYTES, 'the server must store exactly the bytes that were sent')",
    'assert.equal(r.serverSha256, r.expectedSha256,',
  ]) {
    assert.ok(suiteSource.includes(claim), `PS6-INT-4 must still assert: ${claim}`)
  }
})

// ═══ PS6-UP-7 ════════════════════════════════════════════════════════════════

test('PS6-UP-7 the write counters reach the failure message, and no secret does', () => {
  // TASK D: the PS6-only evidence block survives, and the counters join it.
  assert.match(suiteSource, /upload client: contentLength=\$\{u\.contentLength\} chunkBytes=\$\{u\.chunkBytes\}/)
  assert.match(suiteSource, /generated=\$\{u\.generatedBytes\} written=\$\{u\.writtenBytes\} drainWaits=\$\{u\.drainWaits\}/)
  assert.match(suiteSource, /upload outcome: responseStarted=\$\{u\.responseStarted\} responseStatus=\$\{u\.responseStatus\}/)
  assert.match(suiteSource, /requestError=\$\{u\.requestError \?\? 'none'\} responseError=\$\{u\.responseError \?\? 'none'\}/)
  assert.match(suiteSource, /await ps6FailureEvidence\(headline\)/, 'the PS6-only evidence block is still attached')

  // The counters are numbers, booleans and error codes — nothing else may be in
  // them. In particular no cookie, CSRF token, share token, password or secret.
  const counters = suiteSource.slice(suiteSource.indexOf('  const counters = {'), suiteSource.indexOf('  // The upload is the step'))
  for (const forbidden of ['cookie', 'csrf', 'password', 'token', 'secret', 'SESSION']) {
    assert.ok(!counters.toLowerCase().includes(forbidden.toLowerCase()),
      `the upload counters must never carry ${forbidden}`)
  }

  // A successful run records them too, so the evidence exists either way.
  assert.match(suiteSource, /\[ps6\] PS6-INT-4 upload client: contentLength=/)
  assert.match(suiteSource, /assert\.equal\(u\.writtenBytes, u\.contentLength,/)
})

// ═══ PS6-UP-8 ════════════════════════════════════════════════════════════════

test('PS6-UP-8 the multipart delimiters the container emits are real CRLF', async (t) => {
  // ⚠️ A delimiter made of the literal four characters `\r\n` is not a delimiter,
  //    and multer would reject the body — a harness defect that would look
  //    exactly like a product one. Assert the bytes on the wire, not the source.
  const chunks = []
  const server = await listen((req, res) => {
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => { res.writeHead(201); res.end('{}') })
  })
  t.after(() => server.close())

  await upload(server.port, { totalBytes: 64, chunkBytes: 32 })

  const body = Buffer.concat(chunks)
  const header = body.subarray(0, body.indexOf(Buffer.from('\r\n\r\n')) + 4).toString('latin1')
  assert.ok(header.includes('\r\n'), 'the header uses real CRLF')
  assert.ok(!header.includes('\\r\\n'), 'the header must not contain the literal text backslash-r backslash-n')
  assert.match(header, /^--[-\w]+\r\nContent-Disposition: form-data; name="file"; filename="ps6-payload\.bin"\r\nContent-Type: application\/octet-stream\r\n\r\n$/)

  const trailer = body.subarray(body.length - (BOUNDARY.length + 8)).toString('latin1')
  assert.equal(trailer, `\r\n--${BOUNDARY}--\r\n`)
})

// ═══ PS6-UP-9 ════════════════════════════════════════════════════════════════

test('PS6-UP-9 guard 10 refuses a pinned tree that would repeat attempt #3', () => {
  const RUNNER = fileURLToPath(new URL('../../gateway/public-share/integration/run-stage-b.sh', import.meta.url))
  const runner = readFileSync(RUNNER, 'utf8')

  assert.match(runner, /guard 10 — the pinned source streams its large upload with backpressure/)
  assert.match(runner, /grep -q 'uploadMultipart' "\$TEST_FILE" \|\| die/)
  assert.match(runner, /grep -q "req\.once\('drain'" "\$TEST_FILE" \|\| die/)
  assert.match(runner, /grep -q 'Buffer\\\.concat\(\\\[head, body, tail\\\]\)' "\$TEST_FILE" && die/)

  // The guard's own patterns, applied to the tree that matters.
  assert.ok(/uploadMultipart/.test(suiteSource), 'the current suite satisfies guard 10')
  assert.ok(/req\.once\('drain'/.test(suiteSource), 'the current suite waits for drain')
  assert.ok(!/Buffer\.concat\(\[head, body, tail\]\)/.test(suiteSource), 'no whole-request Buffer remains')

  // The attempt #3 shape, which guard 10 now refuses.
  const attempt3 = 'const parts = Buffer.concat([head, body, tail])'
  assert.ok(/Buffer\.concat\(\[head, body, tail\]\)/.test(attempt3))
  assert.ok(!/uploadMultipart/.test(attempt3))
})
