---
title: Task Receipt — HUB /drive Edge CSP Parity for Vault Preview
date: 2026-08-28T13:00:47+07:00
owner: kla
area: infrastructure
branch: fix/hub-drive-vault-preview-csp-parity
status: complete
integration-review: yes
edit_policy: append-by-new-file
---

# Task Receipt — HUB /drive Edge CSP Parity for Vault Preview

`PR_41_MERGED = YES`

`DRIVE_ONLY_DEPLOYMENT_SUCCEEDED = YES`

`LIVE_BROWSER_FACING_CSP = STILL FAILED (defect)`

`ROOT_CAUSE = HUB_DRIVE_CSP_OVERRIDE`

`HUB_HIDES_UPSTREAM_CSP = YES (intentional, kept)`

`HUB_DRIVE_IMG_BLOB = ADDED`

`HUB_DRIVE_MEDIA_BLOB = ADDED`

`HUB_DRIVE_SCRIPT_BLOB = NOT GRANTED`

`HUB_DRIVE_DEFAULT_BLOB = NOT GRANTED`

`HUB_GLOBAL_POLICY_WIDENED = NO`

`MONITOR_POLICY_WIDENED = NO`

`PROXY_HIDE_CSP_PRESERVED = YES`

`IDEA1_CODE_CHANGED = NO`

`DATABASE_CHANGED = NO`

`SERVER_API_CHANGED = NO`

`PRODUCTION_CHANGED = NO`

## What changed

### The production state this task starts from

PR #41 — the IDEA1 source fix that added `blob:` to the Drive application's own
Content-Security-Policy — **is merged** (`main` is `6ad662b`). Acting on that
receipt's Integration request, a **Drive-only** production build and recreate was
performed, and **the deployment itself succeeded on every measure**:

| Fact | Value |
| --- | --- |
| Drive image | `sha256:c486c7f280bcf027d10e2ffc1df39d7ec9f57a6873e266cd681fc97d98de8935` |
| Drive container | `1bdb8aed037f29cdef4e722dc63b5e3f2c5255bc6f47aa04d533e7dd1ea04dc6` |
| Drive health | PASS |
| Telemetry inode | `903027` before and after — persistence unbroken |
| Drive security boundary | `USER=node`, `PRIVILEGED=false` |
| HUB / Monitor / Postgres | unchanged |

And then the live header over HTTPS was read:

```text
GET https://aegis.internal/drive/healthz

Content-Security-Policy:
  default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';
  img-src 'self' data:; font-src 'self'; connect-src 'self';
  frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'
```

`img-src` had no `blob:`, and there was no `media-src` at all — byte for byte the
policy that was broken before PR #41. `LIVE_IMG_BLOB_ALLOWED = FAIL`.

### The confirmed root cause

The corrected Drive policy was never wrong and was never missing. It was
**discarded at the edge**. `HUB-AEGIS_Entry/nginx.conf`, inside
`location /drive/`, does two things on purpose:

```nginx
proxy_hide_header Content-Security-Policy;   # Express's CSP is thrown away
add_header Content-Security-Policy "…";      # nginx publishes its own instead
```

So the browser-visible CSP on `/drive/*` is **the HUB's**, not the Drive
application's. The HUB copy had never been updated alongside PR #41, and it still
read `img-src 'self' data:` with no `media-src`.

That is why fixing `IDEA1-AEGIS_Drive_LC/server/middleware/securityHeaders.js`
alone was insufficient, and why no IDEA1 test could have caught it: the IDEA1
suite asserts the header Express emits, which is exactly the header this file
deletes. **`location /drive/` is the real owner of the browser-visible CSP.**

### The fix

One `add_header` line — the `/drive` one only. `img-src` gains `blob:`, and
`media-src 'self' blob:` is declared for the first time at the edge:

```diff
-add_header Content-Security-Policy "… img-src 'self' data:; font-src 'self'; …" always;
+add_header Content-Security-Policy "… img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; …" always;
```

The `/drive` edge policy is now semantically equal to the Drive application
policy:

```text
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';
img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self';
connect-src 'self'; frame-ancestors 'none'; base-uri 'none';
form-action 'self'; object-src 'none'
```

`media-src` had to be **declared**, not merely widened: an absent directive falls
back to `default-src 'self'`, which is what was blocking `<video src="blob:…">`.
`data:` was deliberately **not** granted to `media-src` — decrypted video never
arrives as a data URL, so granting it would be an unused permission.

### Header ownership was kept, not traded away

`proxy_hide_header Content-Security-Policy` **remains**, and so does every other
`proxy_hide_header` in the block. The architecture deliberately makes nginx the
single browser-visible owner of security headers at the edge, because two
policies arriving together are enforced by a browser as the intersection of both
— an unpredictable third policy that no file states. That is precisely how
`'wasm-unsafe-eval'` was silently stripped before the duplication was removed.

**The fix is parity, not pass-through.** The failure mode being closed is
drift between two owners, and the answer to drift is a test that fails on it —
not the removal of the ownership boundary.

### Nothing outside /drive was widened

- **The HUB landing-page (server-level) policy is unchanged and stays stricter.**
  It gains no `blob:`, no `media-src`, and no `'wasm-unsafe-eval'`; its
  `script-src` is still exactly `'self'`. The landing page is static nginx output
  that renders no Vault media and compiles no WebAssembly.
- **`/monitor` is unchanged.** It declares no `add_header` of its own, so it
  keeps inheriting the stricter server policy, and the
  `location ~* ^/monitor/internal(/|$) { return 404; }` guard in front of the
  Detection Engine ingest surface is untouched. IDEA2 asked for nothing here and
  received nothing.

### Why the grant is narrow rather than a weakening

`blob:` is a same-tab data source, not a network destination. Private Vault
decrypts in the browser and hands the result to `<img>`/`<video>` through
`URL.createObjectURL()`; the server still never receives plaintext, a filename, a
MIME type, a KEK or a DEK. Allowing `blob:` in `img-src` and `media-src` grants
**display**, and display only.

What keeps that from being an execution hole is the half that did not change and
is asserted just as hard: `script-src` stays exactly `'self' 'wasm-unsafe-eval'`
and `default-src` stays exactly `'self'` — **no `blob:` in either**. `default-src`
matters most, because it is the fallback for every directive not named, including
`worker-src` and `script-src-elem`, and `new Worker(blobUrl)` would execute
attacker-controlled bytes in the application origin. Unchanged and re-asserted:
`object-src 'none'`, `frame-ancestors 'none'`, `connect-src 'self'`,
`style-src 'self'`, `font-src 'self'`, `base-uri 'none'`, `form-action 'self'`.
No `'unsafe-inline'`, no bare `'unsafe-eval'`, no wildcard, no opened scheme, no
remote host anywhere.

**A blob URL may be displayed at the edge; it may never be executed.**

## Source files changed

- `HUB-AEGIS_Entry/nginx.conf` — the `Content-Security-Policy` published by
  `location /drive/` gains `blob:` in `img-src` and declares
  `media-src 'self' blob:`. Rationale comments added above that line recording
  that the edge — not IDEA1 — owns the browser-visible policy for `/drive/*`,
  why `media-src` had to be declared rather than widened, and that `blob:` must
  never reach `script-src`/`default-src`. **The server-level HUB policy, the
  `/monitor` location, every `proxy_hide_header`, every other `add_header`, every
  `proxy_set_header`, the rewrites, the upstreams and the `/monitor/internal`
  guard are all byte-identical to `main`.**
- `HUB-AEGIS_Entry/tests/driveCspParity.test.mjs` — **new**, 10 tests, and the
  first test file in the HUB. Parses `nginx.conf` structurally (a small
  quote-aware, comment-aware, brace-matching reader — `return 200 '{"…"}'`
  contains braces and double quotes that must not be read as syntax), generates
  the IDEA1 policy by **running** the real `securityHeaders` middleware rather
  than grepping its text, and compares the two **semantically** — directive names
  and source-token sets, never raw formatting.

No other file in the repository was changed. `IDEA1-AEGIS_Drive_LC/` was not
touched at any path.

## Verification evidence

- `node --test HUB-AEGIS_Entry/tests/driveCspParity.test.mjs` — pass: 10/10.
- `npm ci && npm run build` (HUB) — pass: built in 2.73s. `git status` after the
  build shows only the two intended source paths; `dist/` and `node_modules/` are
  ignored, so no build artefact is committed.
- `docker build -t aegis-hub:csp-parity-verify .` (HUB) — pass. Verification
  only; the image was deleted afterwards and never pushed, tagged for release, or
  deployed.
- **`nginx -t` — pass, in an isolated container.**
  `docker run --rm -v <worktree>/HUB-AEGIS_Entry/nginx.conf:/etc/nginx/conf.d/default.conf:ro -v <scratch>/certs:/etc/nginx/certs:ro nginx:alpine nginx -t`
  → `syntax is ok` / `test is successful`, using a throwaway self-signed
  certificate generated into a scratch directory. No production runtime, no
  production certificate and no production container was involved.
- **Live header read from the locally built image** (not production). The
  verification image was run on `127.0.0.1:18443` with the dummy certificate and
  queried with `curl -k -D -`. Upstreams are absent locally, so `/drive/` answers
  `502` and `/monitor/` answers `504` — and because every `add_header` here uses
  `always`, the headers are still emitted, which is exactly what makes this a
  real browser-visible measurement:

  | Request | Status | `Content-Security-Policy` |
  | --- | --- | --- |
  | `GET /drive/healthz` | 502 | `… img-src 'self' data: blob:; media-src 'self' blob:; …` with `script-src 'self' 'wasm-unsafe-eval'` |
  | `GET /` | 200 | the strict landing policy — **no `blob:`, no `media-src`, `script-src 'self'`** |
  | `GET /monitor/` | 504 | the same strict landing policy, inherited, **unchanged** |

  The `/drive` response also carried `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Strict-Transport-Security: max-age=31536000; includeSubDomains` and
  `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()`,
  proving the location still republishes everything it stops inheriting.
  The container was stopped and removed immediately afterwards.
- `node --test --test-concurrency=1 tests/contentSecurityPolicy.test.js tests/vaultMediaPreview.test.js`
  (IDEA1) — pass: 34/34, 0 failed, 0 skipped. IDEA1 is unmodified; this confirms
  the application policy this task reads is still the one PR #41 shipped.
- `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/collaborationPolicy.test.mjs tests/dockerBootstrap.test.mjs tests/endpointOnboarding.test.mjs`
  — pass: 53 tests, 53 passed, 0 failed.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge`
  — pass, with the same two unchanged owner-review Canvas warnings recorded on
  `main` (`AEGIS_Architecture_Canvas.canvas`, `AEGIS_Knowledge_Network.canvas`).
- `node scripts/validate-collaboration-policy.mjs --event <pr-event.json> --changed-files <delta>`
  over this branch's Pull Request body and changed-file delta — pass.
- `git diff --check` — pass: no whitespace errors.
- Targeted secret scan over the changed delta — pass: no key material,
  credential assignment, token value, password or API key. The only matches are
  the identifier `token` inside the test's nginx tokenizer and the English word
  "token" in its comments. The self-signed certificate used for `nginx -t` was
  generated into the scratch directory and is not in the repository.
- No destructive Vault PostgreSQL test was run, and no production database,
  container, image or configuration was touched.

### The regression proof: this suite fails against current `main`

The new suite was run with `HUB-AEGIS_Entry/nginx.conf` reverted to `main`
(`6ad662b`), to prove it fails **for the production reason** rather than passing
vacuously.

**4 of 10 failed, and exactly the right 4:**

| Test | Against `main` | Reason |
| --- | --- | --- |
| `the browser-visible /drive policy is semantically equal to the Drive application policy` | ✖ fail | edge `img-src` was `['self','data:']`, application `['self','blob:','data:']` |
| `/drive img-src admits the object URLs the vault preview creates` | ✖ fail | `blob:` absent |
| `/drive media-src is declared and admits the vault video object URL` | ✖ fail | `media-src` undefined entirely at the edge |
| `blob: appears nowhere in this config except the /drive img-src and media-src grants` | ✖ fail | zero grants found, expected one |

The other 6 passed against `main`, which is correct — they assert what must
**not** change, and nothing had changed yet.

**Three inverse reverts were then run**, to prove those 6 are not decorative.
Each was applied on top of the correct fix and then undone:

| Injected mistake | Failures | Caught by |
| --- | --- | --- |
| `blob:` added to `/drive` `script-src` **and** `default-src` | 3 | the parity test, `/drive script-src and default-src do not admit blob:`, and the single-grant test |
| `blob:` + `'wasm-unsafe-eval'` added to the **global HUB** policy | 2 | `the global HUB landing-page policy gains neither blob: nor wasm-unsafe-eval`, and the single-grant test |
| `/monitor` given its own widened CSP with `blob:` | 2 | `/monitor is not widened and still inherits the strict server policy`, and the single-grant test |
| `proxy_hide_header Content-Security-Policy` deleted from `/drive` | 1 | `/drive still hides the upstream CSP and every other duplicated header` |

Both directions of the contract are therefore load-bearing and independently
proven. All reverts were undone and the suite re-run green (10/10) afterwards.

### Coverage recorded

Parity — for `default-src`, `script-src`, `style-src`, `img-src`, `media-src`,
`font-src`, `connect-src`, `frame-ancestors`, `base-uri`, `form-action` and
`object-src`, the HUB `/drive` source-token set is asserted equal to the set the
IDEA1 middleware emits, and the two directive-name sets are asserted equal, so a
directive appearing on one side only also fails. Comparison is by parsed
directive and source token; formatting and ordering are irrelevant by
construction. This makes the drift that caused the bug — IDEA1 changed, HUB did
not — a test failure in either direction.

The grants — `/drive` `img-src` is exactly `'self' data: blob:` and `media-src`
is exactly `'self' blob:`, asserted as complete sets rather than `includes()`
alone, so a later widening fails; `data:` is asserted **absent** from
`media-src`.

Execution boundary — `/drive` `script-src` is asserted as the exact array
`["'self'", "'wasm-unsafe-eval'"]` and `default-src` as `["'self'"]`; `blob:` is
asserted absent from `style-src`, `font-src`, `connect-src`, `form-action`,
`base-uri`, `object-src`, and — through the `default-src` fallback chain a
browser applies — from `worker-src`, `child-src`, `script-src-elem` and
`frame-src`.

Edge ownership — `proxy_hide_header` is asserted present for
`Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`,
`Referrer-Policy`, `Strict-Transport-Security` and `Permissions-Policy`; and
because one `add_header` in a location suppresses inheritance of all of them, the
five non-CSP headers `/drive` republishes are asserted by exact value.

Blast radius — the global HUB policy is asserted to contain neither `blob:` nor
`wasm-unsafe-eval`, to declare no `media-src`, and to keep `script-src 'self'`;
`/monitor` is asserted to declare no `add_header` at all, to contain neither
token anywhere in its block, and to still sit behind the `/monitor/internal`
`return 404` guard. A whole-file assertion pins that exactly **one** non-comment
line in `nginx.conf` grants `blob:`, and that it is the `/drive` CSP.

Policy hygiene — no directive is declared twice on either side (a browser honours
the first occurrence and ignores repeats, so a duplicate must not be able to
masquerade as a change); no source is `*`, a bare `http:`/`https:` scheme, a `*.`
host wildcard, or a remote origin; no `'unsafe-inline'`; no bare `'unsafe-eval'`.

Structure — parsing throws on an unbalanced brace or an unterminated quoted
string, and the suite asserts exactly one `listen 443 ssl` server block and
exactly one each of `location /drive/` and `location /monitor/`, so a structural
edit that breaks the file fails the suite before any policy assertion runs. This
is in addition to, not instead of, the real `nginx -t` recorded above.

## Canonical notes updated

- `None` — this task changes one edge response header to unblock a capability
  that is **not yet accepted in production**. No durable implemented, tested,
  deployed, blocked or maturity fact changed in
  `infrastructure/infrastructure-status.md` or `idea1/idea1-status.md`. The HUB
  in production is still running the image built from the `main` config, so
  "the HUB publishes a `/drive` policy that permits Vault media" is not yet a
  true statement about the deployed system. Recording Vault Preview as a
  delivered production capability would be doubly premature: the source is fixed
  here, but neither the HUB rebuild nor the browser acceptance has happened. Both
  facts belong to the receipt of the task that performs them.

## Shared surfaces touched

- `HUB-AEGIS_Entry/nginx.conf` — **the shared security surface affecting IDEA1.**
  The path is owned by `infrastructure`, so the collaboration-policy check sees
  no cross-scope path and would not force review on its own. It is named here
  anyway, and `integration-review: yes` is set deliberately, because this file
  publishes the Content-Security-Policy that **the IDEA1 Drive application runs
  under in a browser**, and it does so by discarding the policy IDEA1 declares
  for itself. A change here can break or weaken IDEA1 without a single byte of
  `IDEA1-AEGIS_Drive_LC/` changing — which is exactly the failure this task is
  closing. Ownership by directory is not ownership of the effect.
- `HUB-AEGIS_Entry/tests/driveCspParity.test.mjs` — reads
  `IDEA1-AEGIS_Drive_LC/server/middleware/securityHeaders.js` across the area
  boundary, deliberately. It imports and executes that middleware but changes
  nothing in it; the coupling is the point, and it is one-way. If IDEA1's policy
  legitimately changes in future, this infrastructure-owned test fails until the
  edge is brought along — which is the intended contract and the intended
  hand-off, not an obstruction.

## Integration requests

- **Kla, integration review — an edge Content-Security-Policy change is a
  security boundary change for a different area's application.** The decision to
  confirm is: *the HUB's `/drive` edge policy may grant `blob:` to `img-src` and
  `media-src` so Private Vault can display what it decrypts in the tab, and that
  grant is acceptable precisely because `script-src` and `default-src` do not
  receive it, `connect-src` stays `'self'`, and `object-src` stays `'none'`.*
  A future request for `blob:` in `script-src`, `default-src`, `worker-src` or
  `connect-src` — at the edge or in the application — is a different decision
  with a different risk profile and must come back through review rather than
  being appended to this precedent. The same applies to any request to relax the
  **global** HUB policy or `/monitor`: both were deliberately left stricter here.
  Rollback is a revert of this Pull Request plus a HUB rebuild and recreate; it
  restores the `main` config string exactly, involves no migration, no data and
  no artefact, and would return `/drive` to the currently-broken preview rather
  than to any other broken state.
- **Kla, deployment decision — this source fix is not yet real, and the previous
  deployment does not count towards it.** The Drive-only deployment already
  performed cannot help: the header a browser sees on `/drive/*` comes from the
  HUB container, and the HUB was explicitly left unchanged. Nothing improves for
  a user until the **HUB** image is rebuilt and the HUB container recreated. That
  build, the live `curl` of `https://aegis.internal/drive/healthz`, and the
  manual image-and-video Preview acceptance in a real browser are the next steps
  and are deliberately not performed here.

## Known limitations

- **Not verified in a browser, and not verified in production.** The production
  HUB was not changed. The live `https://aegis.internal/drive/healthz` header is
  still the failing one quoted at the top of this receipt, because the running
  HUB container was built from the `main` config. The claim proven here is *"the
  edge now publishes a policy that permits the scheme the preview mints, and it
  matches the application policy"*, measured on a locally built image over real
  HTTP. The claim **not** proven here is *"a real browser renders the decrypted
  image and plays the decrypted video through the production HUB"* — that
  requires a HUB-only rebuild, recreate, and one manual acceptance run.
- **`PRODUCTION_ACCEPTANCE` for Vault Preview stays open.** It is deliberately
  not marked PASS. Two of the three links in the chain (IDEA1 policy, edge
  policy) are now correct in source; the third (a browser rendering it through
  the deployed HUB) is unverified.
- **The live-header measurement used a 502/504 response.** Upstreams are absent
  in the local verification container, so `/drive/` and `/monitor/` could not
  return a real body. Because every `add_header` in this file carries `always`,
  the headers are emitted on error responses too, and the CSP measured is the
  same string a 200 would carry — but this is an inference from `always`
  semantics plus the measured error responses, not a measurement of a 200 from
  `/drive/`. A 200 through `/drive/` requires a reachable Drive upstream, which
  belongs to the deployment task.
- **CSP is not executed by the test runner.** Node neither enforces nor
  interprets a Content-Security-Policy. The suite parses both policies the way a
  user agent parses them — including the `default-src` fallback chain — and
  asserts against that model. The model is a faithful reading of the CSP Level 3
  source algorithm, but it is a model, and only a browser is authoritative.
- **The nginx reader in the test is a partial parser, by design.** It handles
  quoted strings, comments, directive terminators and nested blocks — enough for
  this file, and it throws rather than guessing when the input is malformed. It
  is not a general nginx grammar, and it does not model `include`, `map`,
  variables, or location-matching precedence. The authoritative structural check
  is the `nginx -t` run recorded under Verification evidence; the parser exists
  to make *semantic* assertions that `nginx -t` cannot make.
- **`nginx -t` was run against the file, not against production.** It used a
  throwaway self-signed certificate in a stock `nginx:alpine` container. It
  proves the config is syntactically valid and that certificate paths resolve
  when mounted; it does not prove anything about the production certificate,
  the production Docker network, or DNS resolution of `drive-proxy:8001`.
- **Whether the edge CSP was the only remaining blocker is unproven.** It is the
  confirmed cause of the live `LIVE_IMG_BLOB_ALLOWED = FAIL`, and it is a genuine
  blocker. If the browser acceptance run still fails after the HUB rebuild, the
  next cause is a separate defect, not a regression of this one.
- **`gateway/nginx.conf` was not examined or changed**, and is out of scope for
  this task. If any traffic path reaches the Drive through the gateway rather
  than through the HUB, that path has its own policy and is not covered by the
  parity test added here. No such path was in the reported failure, which came
  through `https://aegis.internal/drive/…`.
- **HUB still has no `test` script.** The new suite is run directly with
  `node --test`, following the convention of the root `tests/` suites.
  `HUB-AEGIS_Entry/package.json` was deliberately left unchanged to keep the
  diff to the security surface and its test.
- The 19 `TEST_DATABASE_URL`-gated IDEA1 Postgres vault tests were not run; no
  destructive suite was run against the live production database. The IDEA1
  suites executed here were the two named CSP and preview suites only, IDEA1
  being unmodified by this task.
- Everything the PR #41 receipt recorded under its own Known limitations — no
  focus trap on the shared `Modal`, whole-file decrypt before the first video
  frame, preview plaintext released by garbage collection rather than an explicit
  wipe, and the stubbed `vaultCrypto` in the screen suites — remains true and was
  not addressed here. This task is scoped to the edge CSP defect only.
