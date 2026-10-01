# IDEA1 Unified Preview — Master Rollout and Sequence Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement each phase plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This master plan contains no implementation tasks of its own; it fixes order, gates, and shared rules for the seven phase plans.

**Goal:** Deliver the approved unified file-capability and preview architecture for AEGIS IDEA1 (Normal Files + Private Vault) in seven independently reviewable phases, without regressing Normal Files, without weakening Zero-Knowledge, and without reopening GROUP B throughput work.

**Architecture:** A shared client capability resolver and provider registry (P0) feeds both contexts. Normal Files keeps its fast server derivative pipeline and gains audio/text inline preview (P1). The Vault gains a manifest v2 reader (P2a), then — only after the T-MAN-SIZE gate and Human approval — a v2 writer with client-generated, client-encrypted thumbnail/poster derivatives stored as ordinary V2 blobs (P2b), motion derivatives (P3), and a low-bitrate proxy (P4). PDF/Office providers (P5) are dependency-gated.

**Tech Stack:** React 19, Vite 7, WebCrypto AES-GCM, Service Worker range decryption, WebCodecs / MediaRecorder / OffscreenCanvas (capability-detected), Node.js/Express, PostgreSQL / in-memory store, `node:test`, jsdom.

**Approved spec:** `docs/superpowers/specs/2026-09-30-idea1-unified-preview-encrypted-derivatives-design.md` at `35e9486c0d386a91f3c16fcda3f6b9856edfe663` (Human final approval recorded 2026-09-30). All section references (`§n`) below point to that spec.

---

## 1. Phase plans

| Phase | Plan | Summary | Reversible |
|---|---|---|---|
| P0 | `2026-09-30-idea1-unified-preview-p0-capability-foundation.md` | detection, registry, env, modal shell, Vault signature gate, upload/download + neutrality regression | yes |
| P1 | `2026-09-30-idea1-unified-preview-p1-audio-text-normal-files.md` | audio (MP3 required) + text family in both contexts; Normal Files format table, `/preview` signature check, media-info `format` | yes |
| P2a | `2026-09-30-idea1-unified-preview-p2a-manifest-v2-reader.md` | manifest v2 **reader only**; v1 writer stays; fail-secure on unknown versions | yes |
| P2b | `2026-09-30-idea1-unified-preview-p2b-encrypted-thumb-poster.md` | T-MAN-SIZE gate → Human threshold approval → v2 writer + `setNodePreviews` + encrypted thumb/poster + lazy backfill, behind a default-off flag | **one-way once any v2 manifest is written** |
| P3 | `2026-09-30-idea1-unified-preview-p3-motion-derivatives.md` | encrypted motion derivatives; hover lifecycle; native MediaRecorder path | yes |
| P4 | `2026-09-30-idea1-unified-preview-p4-video-proxy.md` | playback policy/toggle/Build Preview (executable) + proxy generation (**BLOCKED_FOR_DEPENDENCY_APPROVAL**, D-6) | yes |
| P5 | `2026-09-30-idea1-unified-preview-p5-documents.md` | PDF/DOCX/XLSX/XLS/ODS/PPTX providers | yes — **execution blocked until D-6 approval** |

## 2. Dependency graph

```
            P0  capability foundation
           /  \
         P1    P2a  manifest v2 reader  ── must be DEPLOYED + ACCEPTED ──┐
                │                                                        │
                ▼                                                        │
     [GATE G-MAN]  T-MAN-SIZE evidence (1k/5k/10k, ± previews)           │
     [GATE G-THR]  Human Owner approves pass thresholds                  │
                │                                                        │
                ▼                                                        │
               P2b  v2 writer + encrypted thumb/poster (flag default OFF) ◄┘
                │   [GATE G-ENABLE] Human enables v1→v2 UPGRADE flag in Production
                ▼
               P3   motion derivatives
                │
                ▼
               P4   proxy — policy tasks executable; generation tasks
                    BLOCKED until [GATE G-D6-MUX] (D-6 mux/demux approval)

  P0 + P1 shared infrastructure ──► P5 documents — BLOCKED until [GATE G-D6-DOC]
```

Rules:

1. P1 and P2a both depend only on P0 and may be developed in parallel on separate branches; they share no files except the registry table (P1 appends providers; P2a touches none of it).
2. **P2a MUST be deployed and accepted in Production before any v1→v2 upgrade** (§38.2). P2b source (including server v2 revision compatibility, which accepts schema versions [1,2] independent of any flag) may be developed, merged, and deployed with `VAULT_MANIFEST_V2_UPGRADE` OFF after P2a is merged; enabling the upgrade flag requires P2a acceptance. Server v2 compatibility alone creates no v2 manifest.
3. **The P2b v1→v2 upgrade flag MUST remain OFF, and P2b writer tasks must not start, unless T-MAN-SIZE passes at 1,000, 5,000 and 10,000 nodes** against thresholds the Human Owner has approved in writing (G-THR). If it fails: `P2B_WRITER_ENABLE=BLOCKED`, and a separate encrypted preview index becomes a new architecture task (D-1).
4. P3 requires P2b merged (manifest `previews` entries and `setNodePreviews` exist). It does not require the upgrade flag to be enabled in Production for development, but its Production acceptance requires v2 Vaults (upgrade flag enabled per G-ENABLE).
5. P4 policy tasks require P3. P4 generation tasks additionally require G-D6-MUX.
6. P5 requires P0/P1 shared modal + registry and G-D6-DOC. P5 does not block P0–P4.

## 3. Non-negotiable constraints for every phase

Copy this block into every PR description.

```
GROUP_B_THROUGHPUT_SCOPE=DEFERRED            (no transport tuning, no chunk-size tuning)
VAULT_V2_MIN_PLAINTEXT_CHUNK=8 MiB           (D-3: vaultTransferLimits.js unchanged)
AUDIT_SEMANTICS=UNCHANGED                    (D-4: VAULT_V2_READ per chunk-0 read stays)
VAULT_CIPHERTEXT_HTTP_CACHE=OFF              (D-5: chunk reads stay Cache-Control: no-store)
DERIVATIVE_PADDING=NONE_IN_VP1               (D-2)
SERVER_VAULT_PLAINTEXT=FORBIDDEN
SERVER_GENERATED_VAULT_PLAINTEXT_DERIVATIVES=FORBIDDEN
PERSISTENT_DECRYPTED_VAULT_CACHE=FORBIDDEN
PERSISTED_VAULT_CIPHERTEXT_DERIVATIVES=ALLOWED   (D-10)
PRE_TREE_ROLLBACK=FORBIDDEN
VAULT_DESTRUCTIVE_PURGE_ENABLED=false
REMOTE_EQUALS_LAN=NO                         (throughput only selects proxy vs original)
ADMIN_PREVIEW_OVERRIDE=NONE                  (owner-only; cross-owner → 404)
ACCOUNT_BRANCHING=NONE                       (no role/username/user-id/account-age branch)
CROSS_ACCOUNT_DERIVATIVE_DEDUP=NONE
THIRD_PARTY_PARSER_RENDERER_MUXER=REQUIRES_D6_APPROVAL
NORMAL_FILES_POSTER_MOTION_PIPELINE=UNCHANGED
UPLOAD_ARBITRARY_BINARY=TRUE
DOWNLOAD_ARBITRARY_BINARY=TRUE
```

Governance (from `AGENTS.md`): one phase → one task branch → one PR → one Obsidian receipt at final handoff; never push `main`; no rebase/force-push/history rewrite; agents never merge; Human Owner is the only Production mutation authority.

## 4. Shared engineering conventions

### 4.1 Working tree

The main checkout is shared and often diverged. Every phase starts in its own worktree from current `origin/main` (or from the dependency branch for a stacked PR):

```bash
git fetch origin
git worktree add -b feat/idea1-preview-<phase-slug> ../aegis-wt-<phase-slug> origin/main
cd ../aegis-wt-<phase-slug>/IDEA1-AEGIS_Drive_LC
npm ci
```

### 4.2 Test commands (run from `IDEA1-AEGIS_Drive_LC/`)

| Purpose | Command |
|---|---|
| Focused file | `node --test --test-concurrency=1 tests/<name>.test.js` |
| Full suite | `npm test` (`node --test --test-concurrency=1 "tests/**/*.test.js"`) |
| PostgreSQL-gated suites | `bash scripts/pg-integration-env.sh node --test --test-concurrency=1 tests/<name>.test.js` (script at `IDEA1-AEGIS_Drive_LC/scripts/pg-integration-env.sh`; uses the non-superuser `drive_app` role; one database per test file; apply migrations with `psql -v ON_ERROR_STOP=1`) |
| Build | `npm run build` then **restore tracked `dist/`**: `git checkout -- dist` (dist is tracked but never rebuilt in a PR) |

Full-suite baseline rule: before the first RED of a phase, run `npm test` on the untouched worktree and save the failing test names to the scratchpad (`baseline-failures.txt`). A regression claim is only valid for a test that passes at baseline and fails after the change. Do not use `--test-force-exit` on Windows (phantom whole-file failures).

### 4.3 Governance commands (repository root)

| Purpose | Command |
|---|---|
| PR policy | `node scripts/validate-collaboration-policy.mjs --event <pr-event.json> --changed-files <name-status.txt>` |
| Vault notes | `node scripts/validate-vault.mjs` (requires a clean worktree) |
| Whitespace | `git diff --check` |

Any change under root `docs/superpowers/**` is cross-scope for an `idea1` PR: set `integration-review: yes`, list the exact path under `## Shared surfaces touched`, and write a real `## Integration requests` entry.

### 4.4 Account classes (all phases that touch authorization or capability)

| Class | How to obtain in tests |
|---|---|
| `ADMIN` | `loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)` (`tests/helpers/testClient.mjs`) |
| `EXISTING_USER` | `loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)` |
| `NEWLY_CREATED_USER` | Admin `POST /api/users` (route `server/routes/api.js` ~L1388) with a fresh username, then `loginClient` — `performLogin` already completes the forced first-login password reset |

Shared helper introduced in P0: `tests/helpers/accountClasses.mjs` exporting `withAccountClasses(baseUrl, fn)`; every later phase reuses it.

### 4.5 Commits

Conventional commits, one RED/GREEN cycle per commit where practical, e.g. `test(idea1): …` + `feat(idea1): …` squashed only when the cycle is tiny. Never combine two phases in one commit. End every commit message with the attribution line required by the session.

## 5. Gates

| Gate | Owner | Evidence | Unblocks |
|---|---|---|---|
| G-P0 | Human review | P0 PR checks + H1/H2/H13 manual | P1, P2a |
| G-P2a-ACCEPT | Human Owner | P2a deployed; Vault opens for ADMIN/EXISTING/NEW; no v2 written | P2b upgrade-flag enable |
| G-MAN | Agent | T-MAN-SIZE evidence table (P2b Task 1) | G-THR |
| G-THR | Human Owner | Written approval of thresholds for each metric at 1k/5k/10k | P2b writer tasks + flag |
| G-ENABLE | Human Owner | P2b merged, P2a accepted, G-THR passed, T-MAN-SIZE post-implementation PASS | Production `VAULT_MANIFEST_V2_UPGRADE` ON |
| G-D6-MUX | Human Owner | Dependency table in P4 plan §D6 | P4 generation tasks |
| G-D6-DOC | Human Owner | Dependency table in P5 plan §D6 | all P5 execution |

## 6. Rollback boundary (restated, binding)

- P0, P1, P2a, P3, P4, P5: code revert.
- P2b: **once any v2 manifest has been written, rollback may only go to a build that can READ v2** (i.e. contains P2a). **Preferred target:** a P2b-capable build with `VAULT_MANIFEST_V2_UPGRADE` OFF — it stops upgrading untouched v1 manifests and stops new v1→v2 preview-writer activation, but keeps reading v2 and keeps mutating existing v2 heads as v2 (its server accepts schema versions [1,2] regardless of the flag), preserving preview references. **Conservative fallback:** a P2a build (Decision P2A-W, approved) — reads v2, treats v2 Vaults as read-only, never writes v2. **v2→v1 downgrade is forbidden** in every build.
- No phase may delete blobs, rewrite manifests, purge, or roll back to a pre-tree Vault (`PRE_TREE_ROLLBACK=FORBIDDEN`, `VAULT_DESTRUCTIVE_PURGE_ENABLED=false`).

## 7. Requirement → phase traceability

| Spec requirement | Phase / task |
|---|---|
| G-UP arbitrary upload (§3.1, U-1) | P0 T8 (re-run in every phase regression list) |
| G-DOWN arbitrary download byte-exact (§3.2, DL-1) | P0 T8 |
| Capability contract, `download:true` always (§2) | P0 T3, T6 |
| Registry & providers (§4) | P0 T3; P1 T5–T8; P4 T4; P5 T4–T7 |
| Detection policy, case-insensitive, MIME hint only (§5) | P0 T1, T2, T5; P1 T1–T3; P5 T3 (OOXML confirmation) |
| Normal Files preserved + extended (§6) | P0 T4 (wiring only); P1 T1–T4; P5 T1 |
| Vault tile pipeline (§7) incl. derivative-first lane | P0 T5; P2b T8 |
| Hover never streams the original (§7.3) | P3 T4 |
| Manifest v2 reader (§8.2, §38 P2a) | P2a T1–T5 |
| Manifest v2 writer, `setNodePreviews` (§8.2–§8.3) | P2b T2–T4 (after G-THR) |
| Derivatives as V2 blobs, random DEK, 8 MiB chunk (§8.1, §9.1, D-3) | P2b T5, T14 |
| contentId + sourceBlobRef binding (§9.2) | P2a T2; P2b T8 |
| Ownership / no dedup (§9.3, §29) | P2b T13 |
| Profiles vp1 (§10) | P2a T2 (bounds); P2b T6; P3 T2; P4 T1 |
| Thumb / image / poster lifecycles (§11, §12, §14) | P2b T6–T8 |
| Animated image + motion (§13, §15) | P3 T2–T4 |
| Proxy lifecycle + playback policy (§16) | P4 T1–T4 (policy); P4 T7–T9 (generation, D-6 gated) |
| Audio incl. MP3 (§17) | P1 T5 (Files), P1 T6 (Vault), P1 T9 (cap measurement) |
| Text family (§18.2) | P1 T7–T8 |
| PDF / Office (§18.1, §18.3) | P5 T1–T7 (D-6 gated) |
| SW non-media response hardening (§18.1) | P1 T6; P5 T2 |
| Unsupported fallback (§19) | P0 T6; P5 T7 (DOC/PPT) |
| Cache policy (§20, D-5) | P2b T8 (page-memory ciphertext LRU), P2b T14 (no-store pinned) |
| Object URL lifecycle / lock cleanup (§21–§22) | P0 T5; P1 T6; P2b T12; P3 T5; P4 T5; P5 T8 |
| Storage/quota, bounds, cancellation, recovery (§23–§26) | P2b T6–T7, T9, T11; P3 T2–T3; P4 T7–T8 |
| Corrupted derivative / regeneration (§27–§28) | P2b T10; P4 T4 (proxy fallback, no auto regeneration) |
| Account neutrality (§30) | P0 T9; P1 T3; P2b T13; P3 T7; P5 T8 |
| Migration/backfill incl. D-8 (§31) | P2b T9 (thumb/poster auto); P3 T6 (motion); P4 T6, T9 (proxy explicit) |
| V1/V2 compatibility (§32) | P2a T3–T4; P2b T9 (V1 legacy via existing path) |
| LAN/Remote, throughput only selects proxy (§33) | P4 T2–T3, T11 (source scan) |
| Observability (§34), audit volume (D-4) | P2b T14 (T-AUDIT-VOL), P2b T15 (diagnostics) |
| T-MAN-SIZE gate (D-1) | P2b T1 (pre-implementation), P2b T17 (pre-enable) |
| Threats (§35) | per-phase security tests (storage guards, source scans, sanitizer, contentId checks) |
| Tests §36 | mapped inside each phase plan |
| Human acceptance §37 | each phase's final Human gate lists its H-rows |
| Rollout/rollback §38 | this plan §2, §5, §6; P2a Decision P2A-W; P2b rollback section |

## 8. Self-review (planning)

| Check | Result |
|---|---|
| Every binding spec requirement mapped (§7 above) | yes |
| GROUP B not reopened; no transport/chunk tuning task | yes |
| P2a precedes P2b writer; writer gated by T-MAN-SIZE + Human thresholds | yes (§2 rules 2–3, §5) |
| Server v2 revision acceptance ([1,2], 3+ rejected) independent of the upgrade flag; flag controls only v1→v2 upgrade; truth table v1/OFF→v1, v1/ON→v2, v2/OFF→v2, v2/ON→v2, v3+→fail-secure; no v2→v1 downgrade (amendment 2026-09-30) | yes (P2b "Manifest version semantics", Tasks 2–3; P2a P2A-W approved as conservative fallback) |
| 8 MiB global minimum unchanged in all plans | yes (P2b T5 + T14, P3 T3, P4 T4 assert it) |
| Audit semantics unchanged; only measured | yes (P2b T14) |
| Vault ciphertext HTTP cache stays off | yes (P2b T8 + T14 assert `no-store`) |
| No server plaintext Vault processing anywhere | yes |
| Normal Files poster/motion pipeline untouched | yes (P1 T1–T3 are additive; regression suites listed) |
| MP3 preview explicit | yes (P1 T4–T5) |
| Upload/download regression protected | yes (P0 T8, re-run in every phase's regression list) |
| ADMIN / EXISTING / NEW parity tested | yes (P0 T9 helper; reused in P1, P2b) |
| Unsupported never disables Download | yes (P0 T3, T6) |
| Third-party libraries gated | P3 uses native MediaRecorder only; P4 generation and all P5 blocked on D-6 |
| Plans contain guidance and signatures, not pasted product code | yes |

## 9. Human review gate

Stop after committing the plan set. Next action: `HUMAN_REVIEW_IMPLEMENTATION_PLANS`. No phase execution begins until the Human Owner approves the plans (and, for P4 generation and P5, the D-6 dependency tables).
