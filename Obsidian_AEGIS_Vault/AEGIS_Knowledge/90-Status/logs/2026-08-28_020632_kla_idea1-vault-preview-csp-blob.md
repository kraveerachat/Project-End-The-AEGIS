---
title: Task Receipt — IDEA1 Vault Preview CSP blob: Media Hotfix
date: 2026-08-28T02:06:32+07:00
owner: kla
area: idea1
branch: fix/idea1-vault-preview-csp-blob
status: complete
integration-review: yes
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 Vault Preview CSP blob: Media Hotfix

`PR_40_DEPLOYED = YES`

`PREVIEW_MODAL_OPENED_IN_BROWSER = YES`

`PREVIEW_MEDIA_RENDERED_IN_BROWSER = NO (defect)`

`ROOT_CAUSE = CSP_BLOB_MEDIA_BLOCK`

`IMG_SRC_BLOB = ADDED`

`MEDIA_SRC_BLOB = ADDED`

`SCRIPT_SRC_BLOB = NOT GRANTED`

`DEFAULT_SRC_BLOB = NOT GRANTED`

`PREVIEW_ALLOWLIST_CHANGED = NO`

`VAULT_CRYPTOGRAPHY_CHANGED = NO`

`SERVER_API_CHANGED = NO`

`DATABASE_CHANGED = NO`

`PRODUCTION_CHANGED = NO`

## What changed

### The production defect this task closes

PR #40 is merged and deployed. The production Drive image
`sha256:1104fb8919d03dc0626d3a91923c1db0c71b1ceda1274eff7f79f5d3d056a66b`
was exercised manually in a real browser and **the deployment itself succeeded**.
Everything the PR #40 receipt claimed about the preview pipeline held:

- Vault unlock — worked
- the `Preview` command — present and worked
- the Preview modal — opened
- decrypted metadata — correct
- MIME type — read `image/png`
- plaintext size and ciphertext size — both displayed
- an `<img>` element — present in the DOM

And then the picture rendered as a **broken-image icon**.

Nothing in the preview implementation was wrong. The application's own
Content-Security-Policy was refusing the `blob:` URL that the implementation
exists to create. `server/middleware/securityHeaders.js` declared:

```text
img-src 'self' data:       ← no blob:, so <img src="blob:…"> is blocked
(no media-src directive)   ← falls back to default-src 'self', so <video> too
```

The Zero-Knowledge preview architecture is, by design:

```text
GET /api/vault/blobs/:id  →  ciphertext
  →  decryptFileContent(kek, entry.blob, ciphertext)   ← in the browser only
  →  Blob
  →  URL.createObjectURL()  →  a blob: URL
  →  <img>  /  <video controls>
```

That `blob:` URL is the whole point: it is the only place decrypted plaintext is
allowed to exist. The CSP was therefore blocking the exact local URLs the
zero-knowledge design intentionally creates. **The defect is in the policy, not
in the preview.**

### The fix

`img-src` gains `blob:`, and `media-src` is declared for the first time as
`'self' blob:`. Nothing else in the policy moved.

```diff
-      "img-src 'self' data:",
+      "img-src 'self' data: blob:",
+      "media-src 'self' blob:",
```

`media-src` had to be **declared**, not merely widened: an absent directive falls
back to `default-src 'self'`, which is what was blocking `<video src="blob:…">`.
`data:` was deliberately **not** granted to `media-src` — decrypted video never
arrives as a data URL, so granting it would be an unused permission.

### Why this is a narrow grant and not a weakening

`blob:` is a same-tab data source, not a network destination. A blob URL is
minted by this tab, is readable only by this tab, and is revoked by the existing
PR #40 lifecycle controls (close, manual lock, the 10-minute idle auto-lock,
unmount, and one preview replacing another). Allowing it in `img-src` and
`media-src` grants **display**, and display only.

What makes that safe is the half of the contract that did **not** change, and
which this task asserts just as hard as the grant itself:

- `script-src` remains `'self' 'wasm-unsafe-eval'` — **no `blob:`**. A blob URL
  cannot be loaded as script, so decrypted bytes are never an execution sink.
- `default-src` remains `'self'` — **no `blob:`**. This matters more than it
  looks: `default-src` is the fallback for every directive not named, including
  `worker-src` and `script-src-elem`. Granting `blob:` there would have granted
  it everywhere through the back door, and `new Worker(blobUrl)` executes
  attacker-controlled bytes in the application origin.

So: **a blob URL may be displayed; it may never be executed.**

Unchanged and re-asserted: `object-src 'none'`, `frame-ancestors 'none'`,
`connect-src 'self'`, `style-src 'self'`, `font-src 'self'`, `base-uri 'none'`,
`form-action 'self'`. No `'unsafe-inline'`, no `'unsafe-eval'`, no wildcard, no
opened scheme, no remote host was introduced anywhere.

### The Zero-Knowledge contract is unaffected

This task changes one response header. It does not touch the vault
cryptography, Argon2id, AES-GCM, KEK/DEK handling, the preview allowlist, the
SVG refusal, the vault lock policy, the vault delete policy, the database
schema, the Vault API, Docker Compose, nginx, systemd, firewall, or Twingate. No
endpoint was added.

The server still stores ciphertext, still never receives plaintext, still never
generates a preview, and still never receives a filename, MIME type, KEK or DEK
for preview rendering. Loosening a **client-side rendering** policy cannot move
any of those facts, because the server's knowledge is determined by what is sent
to it, and nothing new is sent to it.

### Why every existing test passed while production was broken

This is the part worth recording, because it is the reason the defect shipped.

`tests/vaultMediaPreview.test.js` proved the `<img>` receives a `blob:` source
and passed — correctly. jsdom does not enforce CSP and never fetches an object
URL, so a screen-level test passes whether or not a real browser would load the
picture. The pipeline was verified; the *permission* to use its output was not,
because nothing tested the header.

Two tests now close that gap from both ends:

1. **`tests/contentSecurityPolicy.test.js` (new).** Tests the generated header —
   run through the real middleware and read off a real HTTP response from the
   production `createApp()` — parsed into directives the way a user agent parses
   them, including the `default-src` fallback chain. It does not grep source
   text.
2. **A bridge test inside `vaultMediaPreview`.** Reads the URL scheme off the
   element the screen actually rendered, then asserts the real emitted policy
   permits *that* scheme for `img-src` / `media-src` — and still refuses it for
   `script-src`. The two halves that have to agree are now asserted together.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/server/middleware/securityHeaders.js` — `img-src` gains
  `blob:`; `media-src 'self' blob:` newly declared. Rationale comments added for
  both, and to the file docblock, recording that the grant is display-only and
  that `script-src`/`default-src` must never receive `blob:`. **No other
  directive and no other header changed.**
- `IDEA1-AEGIS_Drive_LC/tests/contentSecurityPolicy.test.js` — **new**, 8 tests.
  Asserts the generated policy and the served response header, the narrowness of
  both grants, the absence of `blob:` from every executing/fetching directive
  and from the fallback chain, the untouched surrounding policy, the unchanged
  non-CSP security headers, and that the CSP grant did not widen the preview
  allowlist.
- `IDEA1-AEGIS_Drive_LC/tests/vaultMediaPreview.test.js` — one test added
  (25 → 26) tying the object-URL scheme the screen really renders to the policy
  the middleware really emits. No existing test was modified or removed.

No other file in the repository was changed.

## Verification evidence

- `node --test --test-concurrency=1 tests/contentSecurityPolicy.test.js` — pass: 8/8.
- `node --test --test-concurrency=1 tests/vaultMediaPreview.test.js` —
  pass: 26/26 (25 pre-existing, all still passing, plus the new bridge test).
- `npm test` (IDEA1) — pass: 414 tests, 395 passed, **0 failed**, 19 skipped.
  `main` runs 405 / 386 / 0 / 19; the delta is exactly the 9 tests added here.
  The 19 skips are the pre-existing `TEST_DATABASE_URL`-gated Postgres vault
  tests, skipped exactly as they are on `main`. No destructive Vault PostgreSQL
  test was run against production.
  Named regression suites all green within that run: `vaultMediaPreview` 26/26,
  `vaultTileActions` 22/22, `vaultStateSync` 8/8, `vaultInventory` 13/13,
  `modalGlobalLayer` 14/14, `modalFocusStability` 12/12, `vaultSetupTyping` 4/4,
  `i18nCopyAudit` 7/7.
- `npm run build` (IDEA1) — pass: built in 9.42s.
- `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/collaborationPolicy.test.mjs tests/dockerBootstrap.test.mjs tests/endpointOnboarding.test.mjs`
  — pass: 53 tests, 53 passed, 0 failed.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge`
  — pass with the same two unchanged owner-review Canvas warnings recorded on
  `main` (`AEGIS_Architecture_Canvas.canvas`, `AEGIS_Knowledge_Network.canvas`).
- `node scripts/validate-collaboration-policy.mjs` over this branch's PR body and
  changed-file delta — pass.
- `git diff --check` — pass: no whitespace errors.
- Targeted secret scan over the changed delta — pass: no key material,
  credential assignment, token, password, or API-key value. The only matches are
  two clearly-labelled test-only session secrets
  (`'csp-test-session-secret-not-used-in-production'`, `'csp-test-secret'`,
  following the existing convention in `tests/vaultApi.test.js` and
  `tests/trustedProxy.test.js`) and the English word "token" appearing in
  comments.

### The regression proof: these tests fail against current `main`

The new suite was run with `securityHeaders.js` reverted to the `main` version
(`624732c`), to prove it fails for the right reason rather than passing
vacuously.

**3 of 8 failed, and exactly the right 3:**

| Test | Against `main` | Reason |
| --- | --- | --- |
| `img-src admits the local object URLs the vault preview creates` | ✖ fail | `blob:` absent from `img-src` |
| `media-src is declared and admits the vault video object URL` | ✖ fail | `media-src` undefined entirely |
| `the header a browser actually receives carries both grants` | ✖ fail | served response header lacks both |

The other 5 passed against `main`, which is correct — they assert what must
*not* change, and nothing had changed yet.

**The inverse revert was also run**, to prove those 5 are not decorative.
`blob:` was wrongly added to `script-src` *and* `default-src` on top of the
correct fix. **3 of 8 failed again, and a different 3:**

| Test | With `blob:` in script-src/default-src | Reason |
| --- | --- | --- |
| `blob: is not granted to any directive that can run or fetch code` | ✖ fail | the execution grant was caught |
| `no document-embedding element is given a CSP source it could use` | ✖ fail | `frame-src` inherited `blob:` via `default-src` |
| `the header a browser actually receives carries both grants` | ✖ fail | its `script-src` assertion caught it over HTTP |

Both directions of the contract are therefore load-bearing and independently
proven. All reverts were undone and the suites re-run green afterwards.

### Coverage recorded

Generated policy — `img-src` is exactly `'self' data: blob:` and `media-src` is
exactly `'self' blob:`, asserted as complete source sets rather than
`includes()` alone, so a later widening fails the test.

Served policy — the header is read off a live `createApp()` HTTP response on the
unauthenticated `/healthz` probe and asserted byte-identical to what the
middleware generates, proving the middleware is actually mounted and not merely
correct in isolation.

Execution boundary — `script-src` is asserted as the exact array
`["'self'", "'wasm-unsafe-eval'"]` and `default-src` as `["'self'"]`; `blob:` is
asserted absent from `style-src`, `font-src`, `connect-src`, `form-action`,
`base-uri`, `object-src`, and — through the `default-src` fallback chain a
browser applies — from `worker-src`, `child-src`, `script-src-elem` and
`frame-src`.

Policy hygiene — no directive is declared twice (a browser honours the first and
ignores repeats, so a duplicate must not be able to masquerade as a change); no
source is `*`, a bare `http:`/`https:` scheme, or a `*.` host wildcard; no
`'unsafe-inline'`; no bare `'unsafe-eval'`.

Preview security contract — re-asserted from the CSP suite that `image/svg+xml`
(and `image/svg+xml; charset=utf-8`), `text/html`, `application/pdf`,
`application/octet-stream`, `application/zip` and `text/plain` all remain
download-only, while `image/png` and `video/mp4` still resolve; `object-src`
stays `'none'` and `frame-src` resolves to `'self'` with neither `blob:` nor
`data:`, so no `<object>`, `<embed>` or `<iframe>` has a usable source for
decrypted content.

Non-CSP headers — `X-Frame-Options`, `X-Content-Type-Options`,
`Referrer-Policy`, `Strict-Transport-Security` and `Permissions-Policy` asserted
unchanged over HTTP, and `X-Powered-By` still absent.

## Canonical notes updated

- `None` — this task changes one response header to unblock a capability that is
  not yet accepted in production. No durable implemented, tested, deployed,
  blocked, or maturity fact in `idea1/idea1-status.md` changed. Recording vault
  media preview as a delivered production capability would be premature: the
  fix is unverified in a browser, because verifying it requires a Drive rebuild
  and deployment, which this task is explicitly scoped out of. The maturity fact
  becomes true after the acceptance named under Known limitations, and belongs
  to that task's receipt.

## Shared surfaces touched

- `None` — every changed path is inside `IDEA1-AEGIS_Drive_LC/`, the selected
  area. No server route, vault cryptography, PostgreSQL schema, migration,
  Docker, Compose, systemd, nginx, gateway, firewall, or Twingate file was
  changed, and no file belonging to IDEA2, IDEA3, HUB, or Infrastructure was
  touched.

## Integration requests

- **Kla, integration review — a Content-Security-Policy change is a security
  boundary change, even when it is one token wide.** `integration-review: yes`
  is set deliberately despite there being no cross-scope path, because the file
  changed is the application's own security policy and review should not depend
  on which directory it happens to live in. The decision to confirm is: *the
  Private Vault preview requires `blob:` in `img-src` and `media-src`, and that
  grant is acceptable precisely because `script-src` and `default-src` do not
  receive it.* If a future request asks for `blob:` in `script-src`,
  `default-src`, `worker-src` or `connect-src`, that is a different decision
  with a different risk profile and must come back through review rather than
  being appended to this precedent. Rollback is a revert of this Pull Request
  and returns the policy to the `main` string exactly; no migration, no
  artefact, and no production change is involved.
- **Kla, deployment decision — this source fix is not yet real.** The defect is
  in a header served by the Drive container, so nothing improves for a user
  until a Drive-only image is rebuilt and deployed. Requesting that build and a
  browser acceptance run is the next step, and is deliberately not performed
  here.

## Known limitations

- **Not verified in a browser.** No production deployment was performed, no
  Drive image was rebuilt, and the production image
  `sha256:1104fb8919d03dc0626d3a91923c1db0c71b1ceda1274eff7f79f5d3d056a66b`
  is unchanged and still carries the broken policy. The claim proven here is
  "the header now permits the scheme the preview mints", verified against the
  generated header and a live HTTP response. The claim **not** proven here is
  "a real browser renders the decrypted image and plays the decrypted video" —
  that requires a Drive-only rebuild, deployment, and one manual image and video
  Preview acceptance.
- **CSP is not executed by the test runner.** Node and jsdom neither enforce nor
  interpret a Content-Security-Policy. The suite parses the policy the way a user
  agent parses it — including the `default-src` fallback chain — and asserts
  against that model. The model is a faithful reading of the CSP Level 3 source
  algorithm, but it is a model, and only a browser is authoritative.
- **A second CSP could exist in front of the app.** These tests assert the header
  the Express application emits. If the reverse proxy or nginx ever adds its own
  `Content-Security-Policy`, a browser enforces the intersection of both, and
  this suite would not see the stricter one. No proxy CSP was found or changed
  in this task, and `securityHeaders.js` documents that app-level policy stays
  with the app deliberately, but the possibility is recorded rather than assumed
  away.
- **Whether `blob:` was the only remaining blocker is unproven.** It is the
  confirmed cause of the broken-image icon, and it is a genuine blocker. If the
  browser acceptance run still fails afterwards, the next cause is a separate
  defect, not a regression of this one.
- The committed `IDEA1-AEGIS_Drive_LC/dist/` build output was deliberately left
  unchanged. `npm run build` ran as verification only and the one regenerated
  artefact (`dist/index.html`) was reverted, so this task changes no build
  artefact.
- The 19 skipped IDEA1 tests require `TEST_DATABASE_URL` and a real Postgres
  instance. No destructive suite was run against the live production database.
- Everything PR #40 recorded under its own Known limitations — no focus trap on
  the shared `Modal`, whole-file decrypt before the first video frame, preview
  plaintext released by garbage collection rather than an explicit wipe, and the
  stubbed `vaultCrypto` in the screen suites — remains true and was not
  addressed here. This task is scoped to the CSP defect only.
