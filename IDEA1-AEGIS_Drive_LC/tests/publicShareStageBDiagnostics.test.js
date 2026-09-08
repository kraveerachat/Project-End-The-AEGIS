// tests/publicShareStageBDiagnostics.test.js — PUBLIC-SHARE-6 Stage B
//
// ⚠️ THIS FILE EXISTS BECAUSE STAGE B ATTEMPT #2 REPORTED NINE FAILURES THAT
//    WERE ONE FAILURE.
//
//    PS6-INT-4 uploads a deterministic 64 MiB object on the private path. The
//    in-container `send()` helper resolves `{ error, status: 0 }` and NO `text`
//    when the request never completes — and the program then did:
//
//        const uploaded = JSON.parse(up.text)
//
//    so the real transport failure surfaced, inside the container, as
//
//        SyntaxError: "undefined" is not valid JSON
//
//    The cause — whatever actually stopped a 64 MiB upload on the Beelink that
//    succeeded on the developer machine — was destroyed by the diagnostic.
//    PS6-INT-4 then provisioned no token, no share id and no file id, and seven
//    dependent subtests asked the gateway for `/s/undefined`, got the 404 it
//    correctly returns, and were reported as confirmed defects.
//
// ⚠️ THIS FILE CHANGES NO SHIPPED BEHAVIOUR AND ASSERTS NONE. It pins three
//    harness properties: the upload response is classified before it is parsed,
//    the failure evidence captured before teardown is PS6-only and redacted,
//    and a dependent subtest is BLOCKED rather than failed when the artifact it
//    needs was never created.
//
// ⚠️ NOTHING HERE NEEDS DOCKER, A DAEMON OR A NETWORK. The in-container prelude
//    is extracted from the suite as source and evaluated here, so these are
//    tests of the exact code that runs inside the Drive container.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const SUITE = fileURLToPath(new URL('./publicShareInternalIntegration.test.js', import.meta.url))
const suiteSource = readFileSync(SUITE, 'utf8')

/**
 * The program prelude that is fed to `node` on stdin inside the containers.
 *
 * It is a template literal in the suite and contains no backtick of its own —
 * deliberately, since one would terminate it — so the first backtick after the
 * opening one closes it. Evaluating it here means these tests exercise the
 * shipped source rather than a copy that can drift away from it.
 */
const PRELUDE = (() => {
  const match = suiteSource.match(/const PRELUDE = `([\s\S]*?)`\n/)
  assert.ok(match, 'the suite must still define PRELUDE as a single template literal')
  return match[1]
})()

// The prelude is CommonJS — it is fed to `node` on stdin inside a container —
// so it is handed a `require` rather than rewritten to import.
const prelude = new Function('require', `${PRELUDE}\nreturn { describe, parseJsonBody, redactPreview, REDACT }`)(
  createRequire(import.meta.url),
)

/** What `send()` resolves when the request or the response errors. */
const transportError = (code) => ({ error: code, status: 0 })
/** What `send()` resolves when the exchange completed. */
const completed = ({ status, text, headers = {} }) => ({
  status, headers, length: text ? Buffer.byteLength(text) : 0,
  sha256: '0'.repeat(64), text: text ?? '',
})

// ═══ PS6-DIAG-1 ══════════════════════════════════════════════════════════════

test('PS6-DIAG-1 a transport error is classified, never parsed', () => {
  // This is the exact attempt #2 shape: no `text` at all.
  const res = transportError('ECONNRESET')
  assert.equal(res.text, undefined, 'the failing shape really does carry no body')

  const parsed = prelude.parseJsonBody('64 MiB upload', res, 201)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.value, undefined, 'nothing may be parsed out of a transport error')

  const d = parsed.diagnostic
  assert.equal(d.reason, 'transport', 'a transport error must be named as one')
  assert.equal(d.error, 'ECONNRESET', 'the transport code is the finding')
  assert.equal(d.status, 0)
  assert.equal(d.hasText, false)
  assert.equal(d.expectedStatus, 201)
  // The old failure text must not be reachable from here any more.
  assert.ok(!JSON.stringify(d).includes('is not valid JSON'))

  // Every transport condition the task asks to be told apart survives the trip.
  for (const code of ['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ETIMEDOUT', 'socket hang up']) {
    assert.equal(prelude.parseJsonBody('x', transportError(code), 201).diagnostic.error, code)
  }
})

// ═══ PS6-DIAG-2 ══════════════════════════════════════════════════════════════

test('PS6-DIAG-2 an unexpected status is reported with a bounded, redacted excerpt', () => {
  const html = `<html><body>${'413 Request Entity Too Large '.repeat(200)}</body></html>`
  const parsed = prelude.parseJsonBody('64 MiB upload', completed({ status: 413, text: html }), 201)

  assert.equal(parsed.ok, false)
  const d = parsed.diagnostic
  assert.equal(d.reason, 'status')
  assert.equal(d.status, 413)
  assert.equal(d.expectedStatus, 201)
  assert.ok(d.length > 0, 'the response length is part of the finding')
  assert.equal(d.hasText, true)
  assert.ok(d.preview.includes('413 Request Entity Too Large'), 'the excerpt must say what came back')
  assert.ok(d.preview.length <= 300, `the excerpt must be bounded, got ${d.preview.length}`)
})

test('PS6-DIAG-2b an empty body and a non-JSON body are distinct findings', () => {
  const empty = prelude.parseJsonBody('x', completed({ status: 201, text: '' }), 201)
  assert.equal(empty.ok, false)
  assert.equal(empty.diagnostic.reason, 'empty-body')
  assert.equal(empty.diagnostic.hasText, false)

  const garbage = prelude.parseJsonBody('x', completed({ status: 201, text: '<!doctype html>' }), 201)
  assert.equal(garbage.ok, false)
  assert.equal(garbage.diagnostic.reason, 'not-json')
  assert.ok(garbage.diagnostic.parseError.length > 0, 'the parse error is kept, bounded')
  assert.ok(garbage.diagnostic.preview.includes('<!doctype html>'))
})

test('PS6-DIAG-2c a good response still parses exactly as before', () => {
  const body = JSON.stringify({ file: { id: 7, sha256: 'a'.repeat(64), size: 67108864 } })
  const parsed = prelude.parseJsonBody('x', completed({ status: 201, text: body }), 201)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.value.file.id, 7)
  assert.equal(parsed.value.file.size, 67108864)
  assert.equal(parsed.diagnostic, undefined)
})

// ═══ PS6-DIAG-3 ══════════════════════════════════════════════════════════════

test('PS6-DIAG-3 a diagnostic excerpt never carries a secret it was told about', () => {
  const cookie = 'aegis.sid=s%3AthisIsASessionCookieValue.signature'
  const csrf = 'csrf-8f3a1c9b2d4e6f70'
  const linkPassword = 'ps6-link-a41d9c72'
  prelude.REDACT.push(cookie, csrf, linkPassword)

  const leaky = `{"error":"bad","cookie":"${cookie}","csrf":"${csrf}","password":"${linkPassword}"}`
  const parsed = prelude.parseJsonBody('x', completed({ status: 400, text: leaky }), 201)

  const serialised = JSON.stringify(parsed.diagnostic)
  for (const secret of [cookie, csrf, linkPassword]) {
    assert.ok(!serialised.includes(secret), 'a secret must never survive into a diagnostic')
  }
  assert.ok(parsed.diagnostic.preview.includes('<<redacted>>'), 'the redaction must be visible, not silent')
})

// ═══ PS6-DIAG-4 ══════════════════════════════════════════════════════════════

test('PS6-DIAG-4 no unguarded parse of a possibly-absent body remains in the suite', () => {
  // The precise defect: JSON.parse of a `.text` that may not exist, with no
  // guard around it. Two guarded parses are legitimate and must survive — the
  // one inside `parseJsonBody`, which runs only after `hasText`, and the
  // `try`-wrapped one in the private-session helper that falls back to null.
  const parses = suiteSource
    .split('\n')
    .filter((line) => /JSON\.parse\(\s*\w+\.text\s*\)/.test(line))
  assert.ok(parses.length > 0, 'the suite still parses response bodies somewhere')
  for (const line of parses) {
    assert.ok(
      /\btry\b/.test(line) || /ok: true, value:/.test(line),
      `a response body may only be parsed behind a guard, found: ${line.trim()}`,
    )
  }
  // The exact attempt #2 line must be gone.
  assert.ok(!/const \w+ = JSON\.parse\(\w+\.text\)/.test(suiteSource),
    'no assignment may parse a response body that might not exist')

  // Both upload sites classify before they parse.
  assert.equal(
    (suiteSource.match(/parseJsonBody\('PS6-INT-3 probe upload', up, 201\)/g) ?? []).length, 1,
    'PS6-INT-3 must classify its probe upload',
  )
  assert.equal(
    (suiteSource.match(/parseJsonBody\('PS6-INT-4 64 MiB private upload', up, 201\)/g) ?? []).length, 1,
    'PS6-INT-4 must classify the 64 MiB upload',
  )

  // The in-container programs report a failure as data instead of dying with a
  // stack on stderr, so the test process can capture evidence before teardown.
  assert.ok(!/process\.exit\(1\)/.test(suiteSource), 'an in-container program must not exit(1) and lose its cause')
  assert.match(suiteSource, /out\(\{ ps6Failure: \{ stage: 'upload'/)
  assert.match(suiteSource, /if \(r\.ps6Failure\) assert\.fail\(await explainFailure\('PS6-INT-4 upload', r\.ps6Failure\)\)/)

  // A failure to RUN the program at all is captured too, not just a failure
  // reported by it — an OOM kill inside the container looks like the former.
  assert.match(suiteSource, /PS6-INT-4 provisioning program did not complete/)

  // The headline the task asked for, verbatim in shape.
  assert.match(suiteSource, /\$\{label\} transport failure: status=\$\{f\.status \?\? 0\} error=\$\{f\.error \?\? 'unknown'\}/)
})

// ═══ PS6-DIAG-5 ══════════════════════════════════════════════════════════════

test('PS6-DIAG-5 failure evidence is PS6-only, bounded and redacted', () => {
  const evidence = suiteSource.slice(
    suiteSource.indexOf('const ps6FailureEvidence'),
    suiteSource.indexOf('const explainFailure'),
  )
  assert.ok(evidence.length > 0, 'the evidence helper must still exist')

  // Ownership is checked before anything is inspected or read.
  assert.match(suiteSource, /const ownedByThisProject = async \(id\) => \{/)
  assert.match(suiteSource, /stdout\.trim\(\) === PROJECT/)
  assert.match(evidence, /if \(!\(await ownedByThisProject\(id\)\)\) \{/)
  assert.match(evidence, /if \(await ownedByThisProject\(driveId\)\) \{/)

  // Only this project's own containers are ever named.
  for (const forbidden of ['aegis-prod', 'aegis_prod', 'aegis_postgres_data', 'aegis_drive_storage', '192.168.10.']) {
    assert.ok(!evidence.includes(forbidden), `PS6 evidence must never name ${forbidden}`)
  }
  // `docker logs` appears exactly where it is allowed to, and nowhere else.
  const logCalls = [...suiteSource.matchAll(/docker\(\['logs',[^\]]*\]/g)].map((m) => m[0])
  assert.ok(logCalls.length > 0, 'the harness reads its own container logs')
  for (const call of logCalls) {
    assert.ok(
      /driveId|gatewayId/.test(call),
      `only this project's own containers may be read, got: ${call}`,
    )
  }

  // Each of the conditions the task asks to be told apart is actually captured.
  for (const field of ['.State.Status', '.State.Running', '.State.ExitCode', '.State.OOMKilled', '.RestartCount', '.State.Health']) {
    assert.ok(evidence.includes(field), `the evidence must capture ${field}`)
  }
  assert.match(evidence, /--tail', '160'/, 'the log tail must be bounded')
  assert.match(evidence, /bounded\(`\$\{stdout\}\$\{stderr\}`, 6000\)/, 'the log tail must be bounded and redacted')
  assert.match(evidence, /compose\(\['ps', '--format', 'json'\]\)/, 'compose ps is part of the evidence')

  // Redaction covers the four throwaway PS6 credentials plus the link and reset
  // passwords, and is applied by `bounded` on every path.
  const redactions = suiteSource.slice(suiteSource.indexOf('const REDACTIONS = ['), suiteSource.indexOf('const bounded ='))
  for (const key of ['PS6_SUPER_PASSWORD', 'PS6_DRIVE_DB_PASSWORD', 'PS6_SESSION_SECRET', 'PS6_SUPER_USER', 'LINK_PASSWORD', 'RESET_PASSWORD']) {
    assert.ok(redactions.includes(key), `${key} must be redacted out of any captured output`)
  }
  assert.match(suiteSource, /const bounded = \(value, max\) => \{\s*\n\s*const text = redact\(value\)/)
})

// ═══ PS6-DIAG-6 ══════════════════════════════════════════════════════════════

test('PS6-DIAG-6 artifact-dependent subtests are BLOCKED, not failed', () => {
  // Exactly the seven that cascaded in attempt #2, and the keys each one needs.
  const expected = {
    'PS6-INT-5': "blockedByInt4('token', 'shareId', 'sha256')",
    'PS6-INT-6': "blockedByInt4('token', 'sha256')",
    'PS6-INT-7': "blockedByInt4('token', 'shareId', 'sha256')",
    'PS6-INT-8': "blockedByInt4('token', 'shareId', 'sha256')",
    'PS6-INT-10': "blockedByInt4('token')",
    'PS6-INT-12': "blockedByInt4('privateToken', 'sha256')",
    'PS6-INT-14': "blockedByInt4('token', 'shareId')",
  }
  for (const [id, guard] of Object.entries(expected)) {
    const declaration = suiteSource.slice(suiteSource.indexOf(`await t.test('${id} `))
    const head = declaration.slice(0, declaration.indexOf('async ('))
    assert.ok(head.includes(`skip: ${guard}`), `${id} must be skipped with ${guard}, saw: ${head.trim()}`)
  }

  // The reason a reader will see, and the promise that it is not a defect.
  assert.match(suiteSource, /BLOCKED_BY_PS6_INT_4 — PS6-INT-4 did not provision \$\{missing\.join\(', '\)\}/)
  assert.match(suiteSource, /nothing here is evidence of a product defect/)

  // The independent three keep running, on a token that cannot be mistaken for
  // a real one, and the one assertion that would become vacuous is skipped
  // rather than allowed to pass for free.
  assert.match(suiteSource, /const UNPROVISIONED_TOKEN = 'ps6-unprovisioned-token'/)
  assert.equal((suiteSource.match(/routingToken\(\)/g) ?? []).length, 5, 'the five route-map probes use the synthetic token')
  assert.match(suiteSource, /BLOCKED_BY_PS6_INT_4 — the raw-token log assertion was NOT evaluated/)

  // ⚠️ The guard must be a no-op once PS6-INT-4 succeeds. It is evaluated when
  //    the subtest is declared, which is after PS6-INT-4 has already run, and it
  //    returns false when every required field is present.
  const blocked = suiteSource.slice(suiteSource.indexOf('const blockedByInt4'), suiteSource.indexOf('const UNPROVISIONED_TOKEN'))
  assert.match(blocked, /missing\.length === 0\s*\n\s*\? false/, 'a provisioned artifact must skip nothing')
})

// ═══ PS6-DIAG-7 ══════════════════════════════════════════════════════════════

test('PS6-DIAG-7 the diagnostics change no shipped behaviour and weaken no acceptance', () => {
  // The acceptance object is still a real, deterministic 64 MiB file.
  assert.match(suiteSource, /const FILE_BYTES = Number\(process\.env\.PS6_FILE_BYTES \?\? 64 \* 1024 \* 1024\)/)
  assert.match(suiteSource, /const expected = crypto\.createHash\('sha256'\)\.update\(body\)\.digest\('hex'\)/)
  // Still the same legacy private endpoint: nothing was swapped for a passing one.
  assert.equal(
    (suiteSource.match(/path: '\/api\/files\/upload'/g) ?? []).length, 2,
    'both uploads must still use the shipped private upload endpoint',
  )
  assert.ok(!/chunked|\/api\/uploads\/v2|resumable/i.test(suiteSource.split('// ═══ The suite')[1] ?? ''),
    'no alternative upload path may be substituted to obtain a pass')

  // The digest, size and status assertions that make PS6-INT-4 acceptance are
  // still there, after the diagnostics.
  for (const claim of [
    "assert.equal(r.uploadStatus, 201, 'the 64 MiB upload must succeed on the private path')",
    "assert.equal(r.serverSize, FILE_BYTES, 'the server must store exactly the bytes that were sent')",
    'assert.equal(r.serverSha256, r.expectedSha256,',
  ]) {
    assert.ok(suiteSource.includes(claim), `PS6-INT-4 must still assert: ${claim}`)
  }
})

// ═══ PS6-DIAG-8 ══════════════════════════════════════════════════════════════

test('PS6-DIAG-8 guard 9 refuses a pinned tree that would repeat attempt #2', () => {
  const RUNNER = fileURLToPath(new URL('../../gateway/public-share/integration/run-stage-b.sh', import.meta.url))
  const runner = readFileSync(RUNNER, 'utf8')

  assert.match(runner, /guard 9 — the pinned source classifies a response before parsing it/)
  assert.match(runner, /grep -q 'parseJsonBody' "\$TEST_FILE" \|\| die/)
  assert.match(runner, /grep -q 'BLOCKED_BY_PS6_INT_4' "\$TEST_FILE" \|\| die/)

  // The guard's own patterns, applied here to the two trees that matter: the
  // current suite must pass all three, and the attempt #2 shape must be refused.
  const requiresParseHelper = /parseJsonBody/
  const refusesUnguardedParse = /const [A-Za-z_]+ = JSON\.parse\([A-Za-z_]+\.text\)/
  const requiresBlocking = /BLOCKED_BY_PS6_INT_4/

  assert.ok(requiresParseHelper.test(suiteSource), 'the current suite satisfies guard 9')
  assert.ok(!refusesUnguardedParse.test(suiteSource), 'the current suite carries no unguarded assignment-parse')
  assert.ok(requiresBlocking.test(suiteSource), 'the current suite blocks dependent subtests')

  // The exact line Stage B attempt #2 ran, which guard 9 now refuses.
  const attempt2 = 'const uploaded = JSON.parse(up.text)'
  assert.ok(refusesUnguardedParse.test(attempt2), 'guard 9 must refuse the attempt #2 line')
  assert.ok(!requiresParseHelper.test(attempt2))
})
