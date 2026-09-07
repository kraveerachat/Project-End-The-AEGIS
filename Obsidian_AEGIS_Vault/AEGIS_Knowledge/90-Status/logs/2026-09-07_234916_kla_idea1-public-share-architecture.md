---
title: Task Receipt — IDEA1 PUBLIC-SHARE-1 public share gateway architecture
date: 2026-09-07T23:49:16+07:00
owner: kla
area: idea1
branch: docs/idea1-public-share-architecture
status: complete
integration-review: yes
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 PUBLIC-SHARE-1 public share gateway architecture

```text
PUBLIC-SHARE-1 is architecture/security-contract work only.
Public Internet Share is still NOT IMPLEMENTED and NOT DEPLOYED.
```

Status is `complete` for the **PUBLIC-SHARE-1 scope only** — the architecture,
threat model, and implementation contract asked for. It is not a claim that any
part of the feature exists. No source file, configuration file, test, container,
port, DNS record, NAT rule, tunnel, firewall rule, VLAN, Twingate policy, or
certificate was created or changed by this task.

## What changed

One new durable IDEA1 architecture note, plus the canonical facts it introduces.

**The document.** `idea1/idea1-public-share-architecture.md` defines the future
share-only Public Share Gateway across all eighteen required sections: purpose,
current verified state, non-goals, architecture, trust boundaries, public route
contract, share scope contract, configuration contract, threat model, ingress
decision matrix, security invariants, streaming/large-file considerations, audit
requirements, rollout sequence, rollback strategy, verification plan, required
future PRs, production decision gates, and known limitations.

The design in one line: a **separate, stateless nginx server** — its own
container, config, certificate and two-member Docker network — that default-denies
every path except `GET /s/:token` and `POST /s/:token`, sanitises every forwarding
header, and forwards to the **existing** `shareRouter` in Drive. It holds no
secret, no database handle, and no Data Lake mount, and it makes no authorization
decision: Drive keeps all of them, preserving Server-Side Enforcement.

**Three findings came from reading current source, not from the brief**, and they
are the substance of this task:

1. **`server/config/trustedProxy.js` is a hard, code-level blocker for a second
   proxy.** `APPROVED_PRODUCTION_PROXY_CIDRS` contains exactly one value and
   production requires `cidrs.length === 1`, so adding a public gateway as a
   second trusted peer makes Drive **refuse to boot**. This is not a config
   change to make in passing; it modifies a control that the B4.3 production
   acceptance of spoof resistance depends on. The note takes the position that
   the approved *set* is widened to a second explicitly pinned /32 identity — the
   "exactly N named identities" rule survives — and routes it to gate G2 for an
   explicit owner decision.

2. **The in-memory rate limiter creates a public-path self-DoS.** If the gateway
   does not attribute real client addresses, every public recipient collapses to
   one source IP, and the `share|<ip>` axis then locks after any five failures
   anywhere — one attacker, or one recipient mistyping a password, denies public
   redemption to everyone. This is the same defect class already found and fixed
   once in this codebase, where share guessing used to lock the login page for a
   whole NAT'd office. The note requires both a distinct limiter scope for the
   public path and overwrite-not-append header handling at the gateway.

3. **`scope=public` must be a third explicit value.** Overloading `scope=any`
   would retroactively make every existing `any` share Internet-redeemable the
   moment a gateway was deployed, without its creator agreeing to that. The note
   also declines to widen `users.share_default_scope`: publishing to the Internet
   must be a per-share choice every time, never something a saved preference does
   on the sharer's behalf.

The threat model covers all 28 required threats, each with Threat / Asset /
Attack path / Existing control / Required additional control / Verification test
/ Residual risk. Two entries are called out as the dominant risks: **T-08
(accidental exposure of the full Drive)**, which is a configuration risk rather
than a code risk and is why the gates are procedural; and **T-14 (the share token
is in the URL, and nginx access logs record URLs)**, which has no existing
counterpart anywhere in this repository because no current route serves a URL
that is itself a credential.

The ingress decision matrix presents Option A (public IP + NAT) and Option B
(managed tunnel) with a genuine, unresolved conflict — A is strictly better for
token-in-URL exposure and client attribution, B is strictly better for keeping
the firewall's no-inbound posture — and **does not pretend the choice is made**.

**Existing behaviour was verified, not assumed.** The current UI already tells
the truth: `strings.js` carries `publicShareUnavailable: 'NOT AVAILABLE'` in
English, Thai and Chinese, rendered by `PublicInternetNotice` in `Shares.jsx`.
Nothing was changed to make that more or less true.

## Source files changed

**None.** No file under `IDEA1-AEGIS_Drive_LC/`, `gateway/`, `HUB-AEGIS_Entry/`,
`shared/`, `postgres/`, `docker-compose.yml`, or `.env.example` was created,
modified, or deleted. This is a documentation-only change, and
`git diff --name-status origin/main...HEAD` is the evidence.

Knowledge files changed:

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md`
  — **new**; the PUBLIC-SHARE-1 deliverable.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — canonical note;
  new "Public Share Gateway architecture accepted as a contract (2026-09-07)"
  section.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-moc.md` — the existing
  "Public External Internet Share remains NOT IMPLEMENTED / FUTURE ARCHITECTURE"
  bullet now points at the design contract.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/index.md` — catalog entry for the new
  canonical note, per the `AGENTS.md` §7 rule that `index.md` is updated only
  when a genuinely new canonical note is introduced.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-07_234916_kla_idea1-public-share-architecture.md`
  — this receipt.

Source surfaces **inspected** on `origin/main` at `478059949d` (read-only):
`server/routes/share.js`, `server/routes/api.js`, `server/db/store.js`,
`server/db/schema.sql`, `server/request/sourceIp.js`, `server/auth/rateLimit.js`,
`server/config/trustedProxy.js`, `server/app.js`, `src/screens/Shares.jsx`,
`src/lib/strings.js`, `tests/shareRedemption.test.js`,
`tests/trustedProxy.test.js`, `HUB-AEGIS_Entry/nginx.conf`, `gateway/nginx.conf`,
and `docker-compose.yml`.

## Verification evidence

- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — **pass**, 0 errors. The 2 `WARNING` lines about the two owner-data canvases are pre-existing and unrelated.
- `node scripts/validate-collaboration-policy.mjs --event … --changed-files …` —
  **pass**, run locally against a synthesised event carrying this PR's body and
  this branch's real `git diff --name-status origin/main...HEAD`.
- `git status --short` — **pass**: only the five intended knowledge paths.
- `git diff --check` — **clean**; no whitespace or conflict-marker error.
- `git diff --name-status origin/main...HEAD` — **pass**: five paths, all under
  `Obsidian_AEGIS_Vault/AEGIS_Knowledge/`, **zero** application, test,
  configuration, or deployment paths. This is the evidence for the documentation-
  only claim.
- Secret scan over the branch diff — **pass (clean)**: searched case-insensitively
  for `password`, `passwd`, `secret`, `token`, `api[-_]?key`, `private[-_]?key`,
  `BEGIN .*PRIVATE KEY`, `authorization`, `bearer`, `AKIA[0-9A-Z]{16}` and `.env`.
  Matches are prose only — the words appear as security vocabulary in the threat
  model and contract text. **No credential, key, certificate, real public domain,
  token, or `.env` value is added.**
- **No IDEA1 test suite or build was run, and none is claimed.** `AGENTS.md`
  requires affected tests when a source or test path changes; no such path
  changed. Running the suite would prove nothing about a diff that contains no
  code, and reporting it would misrepresent the evidence this task actually has.
- **No production access of any kind**: no SSH, no deployment, no container
  action, no `docker compose`, no network or firewall command, no DNS change, no
  certificate operation. None is claimed.

Base: `origin/main` at `478059949dd80ab5c0abb8451f783fcfd844a32b`, in a clean
dedicated worktree. Open PRs were checked before starting: **none open**;
PR #96 merged at 2026-09-07T08:52Z and became this base, so there is no unmerged
dependency and no stacked PR is required.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — records that the
  Public Share Gateway design contract now exists and where; records the three
  durable facts established by reading current source (the `scope=public`
  separation requirement, the `trustedProxy.js` single-approved-identity blocker,
  and the public-path limiter self-DoS risk); and restates that Public Internet
  Share remains NOT IMPLEMENTED and NOT DEPLOYED, that HTTP Range is unsupported,
  that the limiter and session store are single-process, and that 20–30 GB /
  Production 32 GiB scale remains NOT TESTED / NOT ACCEPTED.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-moc.md` — the open-work bullet
  for Public External Internet Share now links the design contract while keeping
  its NOT IMPLEMENTED wording intact.

## Shared surfaces touched

`Obsidian_AEGIS_Vault/AEGIS_Knowledge/index.md` is the only path outside the
`idea1` boundary, so this PR carries `integration-review: yes`.

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/index.md` — shared/Core catalog note,
  `owner-only`. One line added to the "Owned workstreams" section for the new
  canonical note, plus the frontmatter `updated` date. Required by `AGENTS.md`
  §7: `index.md` is updated when a genuinely new canonical note is introduced.
  No existing entry was reworded, reordered, or removed.

The architecture note itself describes future changes to shared surfaces
(`gateway/`, `docker-compose.yml`, `.env.example`, `HUB-AEGIS_Entry/`) but
**changes none of them**. Describing a future change is not touching a shared
surface, and this receipt does not list paths that this branch does not modify.

## Integration requests

- **Kla, as the shared/Core knowledge owner, must accept the one-line
  `index.md` catalog addition.** It is an `owner-only` note outside the `idea1`
  boundary. Downstream impact: a new catalog row. Rollback: delete the line.

- **Kla, as IDEA1 and infrastructure owner, must decide gate G1 (contract
  acceptance) before PUBLIC-SHARE-2 is written.** The route contract, the
  `scope=public` separation, and the `PUBLIC_SHARE_BASE_URL` configuration
  contract are the inputs every later PR builds on; accepting them late means
  rewriting backend work.

- **Kla, as infrastructure owner, must decide gate G2 — the trusted-proxy
  change — before any gateway work starts.** Adding a second approved proxy
  identity to `server/config/trustedProxy.js` modifies a control whose current
  single-identity form is what made B4.3's spoof resistance provable in
  production. This decision is a prerequisite for PUBLIC-SHARE-2 and
  PUBLIC-SHARE-3 and must not be taken implicitly inside an implementation PR.
  Rollback: revert the approved set to the single HUB identity, which restores
  exactly today's production configuration.

- **Owner must decide gate G3 — public-path audit personal data.** Once real
  client attribution works, audit rows will contain recipients' real Internet
  addresses, which is more personal data than the private path records. Store in
  full, truncate, or hash: an owner decision, deliberately not made here.

- **Owner must decide gate G4 — the ingress option — before any ingress work.**
  Option A and Option B trade off in opposite directions on token-in-URL exposure
  (T-14) and client attribution (T-27) versus perimeter posture. No MikroTik,
  UFW, VLAN, Twingate, NAT, DNS, tunnel, or certificate work may begin before
  this gate.

- **No integration is complete and none is claimed.** Gates G5 (Internet
  exposure) and G6 (completion) are explicitly out of reach of this PR.

## Known limitations

- **Nothing in this note is implemented, and Public Internet Share remains NOT
  IMPLEMENTED and NOT DEPLOYED.** Every "required additional control" in the
  threat model is unbuilt. The document is a contract to be honoured by later
  PRs, not evidence of behaviour.
- **No ingress method is chosen**, so the residual risk for the ingress-dependent
  threats (T-13 caching, T-14 token-in-logs, T-25 TLS, T-26 DNS, T-27
  attribution) cannot be finalised until gate G4.
- **The proposed trusted-proxy change is a real modification to a
  production-verified control**, not a purely additive one. B4.3 was accepted
  with exactly one approved identity.
- **No IDEA1 test, build, or runtime verification was performed**, because no
  source or test path changed. This receipt therefore carries no application
  evidence and claims none.
- **The owner-supplied VLAN30 and remote-PC acceptance figures in the task brief
  were not reproduced.** They are recorded in the architecture note as
  owner-supplied and kept separate from the repository's own B4.3 evidence, which
  uses different addresses. The two were not merged into a single claim.
- **HTTP Range remains unsupported** on the redemption path, so a public
  recipient on an unreliable connection would restart a large download from zero.
  Adding it is deliberately deferred to its own PR after PUBLIC-SHARE-7.
- **The in-memory rate limiter and `MemoryStore` sessions remain single-process.**
  No Redis or shared store is introduced, deliberately. This caps how far T-04
  and T-05 can be mitigated, and the note says so rather than implying the
  limiter is a complete defence.
- **`gateway/nginx.conf` still carries the case-sensitive `/monitor/internal/`
  guard** that `HUB-AEGIS_Entry/nginx.conf` already fixed. It is pre-existing,
  already tracked as open in `summaries/08_Outstanding_Items_Consolidated`, out of
  scope here, and left untouched — but it is cited in the note as the exact defect
  class the public route-matching rules exist to avoid repeating.
- **This note does not decide whether a `public` share should be allowed without
  a link password.** It requires the UI to stop that from happening silently and
  routes the policy itself to the owner.
