---
title: Task Receipt — IDEA1 Public Share Managed-Tunnel Edge Adapter + Pre-Exposure Acceptance
date: 2026-09-09T07:39:58+00:00
owner: kla
area: idea1
branch: feat/idea1-public-share-external-acceptance
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 Public Share Managed-Tunnel Edge Adapter + Pre-Exposure Acceptance

> [!warning] This closes ONE task, not PUBLIC-SHARE-7
> **Managed-Tunnel Edge Adapter + Pre-Exposure Acceptance = COMPLETE / PASS.**
> **PUBLIC-SHARE-7 overall = IN PROGRESS.** Real Internet acceptance = **NOT
> RUN**. Real Cloudflare tunnel = **NOT RUN**. Public DNS = **NOT RUN**. External
> TLS = **NOT RUN**. Twingate-OFF 4G/5G acceptance = **NOT RUN**. **G5 = OPEN.
> G6 = OPEN. Public Internet Share = NOT IMPLEMENTED.**

## Task

| | |
| :--- | :--- |
| Task | Managed-Tunnel Edge Adapter + Pre-Exposure Acceptance |
| Sessions | S1 survey · S2 implementation · S3 preflight · **S4 Docker runtime acceptance (CLOSED / PASS)** |
| Branch | `feat/idea1-public-share-external-acceptance` |
| Base `main` | `f2d39bf2e45f0729a7650f1cfbc147ac00435b12` |
| Interim checkpoint | `a07687c26a9812339c02ec056699b0fe569b0f81` |
| Fix checkpoint | `994579590b10b06c3e0cde0e63331bb38fbd1051` |

## Plan and scope

G4's practical direction is **Managed Tunnel (§13 Option B)**: PS7-01 measured
the site behind upstream NAT/CGNAT, so an inbound port-forward is unavailable on
the current topology. ⚠️ **The G4 gate itself remains the owner's to record; this
task does not take that decision.**

PUBLIC-SHARE-3 shipped a gateway that assumes it is the immediate
recipient-facing HTTP peer, and both PS3 and PS6 stated explicitly that a managed
tunnel invalidates that: `$remote_addr` becomes the connector, collapsing G3
attribution and re-creating the T-05 rate-limit self-DoS. Scope was the code-only
half — the trust adapter plus one integrated pre-exposure harness — with **no
Internet exposure and no Production change**.

## What changed

- The Public Share Gateway image gained a **second fail-closed startup gate**.
  `PUBLIC_SHARE_EDGE_MODE` (`direct` default, or `cloudflare`) and
  `PUBLIC_SHARE_EDGE_PROXY_CIDR` (one pinned connector `/32`, required *iff*
  managed mode) are validated character by character and then **generate**
  `/tmp/aegis-edge/http.conf`, which the template includes at an exact path.
  `NGINX_ENVSUBST_FILTER=^PUBLIC_SHARE_HOST$` is **unchanged** — no new operator
  value reaches nginx directive context through substitution.
- Managed mode canonicalises `$remote_addr`/`$binary_remote_addr` with nginx's
  own `realip` module **behind the pinned peer only**, so the PUBLIC-SHARE-3
  header and edge-limit directives keep their spelling and become per-recipient.
- **Four independent controls** gate the share route, all of which must pass:
  peer is the pinned connector; provider header present; provider identity not
  ambiguous; canonicalisation actually happened. The gate returns **403 in the
  rewrite phase**, before `limit_req` and before `proxy_pass`.
- Provider identity headers are consumed at the gateway and never relayed, in
  **both** modes: `CF-Connecting-IP`, `CF-Connecting-IPv6`, `CF-Pseudo-IPv4`,
  `True-Client-IP`, `CF-Visitor`, `CF-IPCountry`, `CF-Ray`, `CF-Worker`,
  `CDN-Loop`.
- **Direct mode is preserved.** With the variables unset the generated file
  defines `$aegis_edge_deny` as a constant `0`, so PUBLIC-SHARE-3/6 behaviour is
  unchanged and the shared gate is inert.
- A new isolated six-service harness (`managed-tunnel/`) and a Production-safe
  runner, plus the integrated acceptance suite.

⚠️ **Drive was deliberately not modified.** `server/request/sourceIp.js`,
`server/request/ingress.js` and `server/config/trustedProxy.js` are byte-identical
to `main`. `TRUSTED_PROXY_CIDRS` is **not** widened — no Cloudflare range, RFC1918
subnet, Docker bridge range or `0.0.0.0/0` anywhere. `requestSourceIp(req) →
req.ip` remains the sole client-source accessor and `requestIngressKind(req)`
still classifies the gateway peer, not the connector and not the recipient.

## Source files changed

- `gateway/public-share/validate-public-share-edge.sh` — **new.** Fail-closed
  validation of the two edge variables; generates the nginx trust include.
- `gateway/public-share/entrypoint.sh` — runs the edge validator after the host
  validator and before the nginx handover.
- `gateway/public-share/Dockerfile` — installs the edge validator `0555`.
- `gateway/public-share/.dockerignore` — allowlists the new script.
- `gateway/public-share/nginx.conf.template` — includes the generated trust file
  at an exact path; adds the managed-proxy gate; strips provider headers.
- `gateway/public-share/README.md` — documents the managed mode and its limits.
- `gateway/public-share/managed-tunnel/docker-compose.yml` — **new.** Four
  networks, six services, no host port.
- `gateway/public-share/managed-tunnel/db-init/00-aegis-drive.sh` — **new.**
- `gateway/public-share/managed-tunnel/run-pre-exposure.sh` — **new.**
  Production-safe runner with pre/post inventory and teardown verification.
- `gateway/public-share/managed-tunnel/README.md` — **new.**
- `IDEA1-AEGIS_Drive_LC/tests/publicShareManagedTunnelIntegration.test.js` —
  **new.** PS7-STRUCT-1..5 (always run) and PS7-PRE-01..14 (Docker-gated).
- `IDEA1-AEGIS_Drive_LC/tests/publicShareGatewayStructure.test.js` — PS3-STRUCT-6
  extended for the stripped provider headers; the authored set is still pinned.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — canonical note.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md`
  — canonical note.
- This receipt.

## Defects found and fixed

**1 · Ambiguous provider identity was accepted (implementation defect).**
Measured on the real pinned gateway image: a request carrying **two**
`CF-Connecting-IP` headers was accepted with HTTP 200 and attributed to whichever
arrived first, because nginx's `realip` reads the FIRST matching header and
ignores the rest — a caller-influenced choice of identity. A fourth control,
`$aegis_edge_recipient_ambiguous`, now refuses any value containing a comma.
Re-measured: duplicated header **403**, comma-joined value **403**, single
recipient **200** with the correct `X-Forwarded-For`. Proven load-bearing by
runtime negative control **NC7**.

**2 · `PS7-PRE-11` asserted a platform's wording, not the property (harness
defect).** The first Docker run failed with
`172.31.240.1 answered at L3: wget: download timed out`. The assertion required
the literal word `unreachable`. PUBLIC-SHARE-3 measured `Host is unreachable` on
**Docker Desktop 28.3.2**; on **native Linux Docker 29.7.1** an isolated bridge
drops the packet with no ICMP reply, so the client times out. Both mean nothing
answered. ⚠️ **The isolation property held and was not taken on trust**: the `nc`
probes to *both* bridge addresses returned **closed**, and **`Connection
refused` — the answer that would prove a live address — appears zero times in the
entire run.** The fix **strengthens** the control: `Connection refused` is
asserted first as the discriminator, a timeout is accepted alongside
`unreachable`, **any HTTP response is explicitly rejected**, and PUBLIC-SHARE-3's
ARP corroboration is added so a *completed* ARP entry fails the test regardless
of how the client words its failure.

**3 · A test expectation was wrong rather than the adapter.**
`CF-Connecting-IP: 203.0.113.10:443` **is** accepted by nginx and canonicalised
to `203.0.113.10`. Attribution is therefore still the correct recipient with the
port dropped, so this is **not** an attribution defect. The suite previously
expected 403; it now asserts the correct canonicalisation.

⚠️ No security assertion was weakened to obtain a pass, and no Production object
was touched to make a test succeed.

## Verification evidence

- `PUBLIC_SHARE_MANAGED_TUNNEL_RUNTIME=1 node --test tests/publicShareManagedTunnelIntegration.test.js` (via `sh gateway/public-share/managed-tunnel/run-pre-exposure.sh`) — **PASS**: 20 tests, 20 passed, 0 failed, 0 skipped; acceptance exit code 0; post-run check failures 0; Production pre/post IDENTICAL; teardown clean. Log: `/tmp/ps7-evidence/05-normal-postfix.log`.

### Source and preflight

- `node --test tests/publicShareManagedTunnelIntegration.test.js` — PASS, PS7-STRUCT-1..5, 5 pass / 0 fail.
- `node --test tests/publicShareGatewayStructure.test.js` — PASS, 12 pass / 0 fail.
- `node --test tests/publicShareSecurityRegression.test.js` — PASS, 16 pass / 0 fail.
- `node --test tests/publicShareConfig.test.js` — PASS, 24 pass / 0 fail.
- `node --test tests/publicShareBackend.test.js` — PASS, 21 pass / 0 fail / 2 skipped.
- `node --test tests/shareScopeTruthUi.test.js` — PASS, 19 pass / 0 fail.
- `node --test tests/shareRedemption.test.js` — PASS, 14 pass / 0 fail / 3 skipped.
- `node --test tests/publicShareStageBCredentialPlumbing.test.js` — PASS, 9 pass / 0 fail.
- `npm test` (full IDEA1 baseline) — 1186 tests. Run 1: 1113 pass / **1 fail**;
  runs 2 and 3: **1114 pass / 0 fail** / 72 skipped. One flaky failure whose
  identity was not captured; `AUTOLOCK-5` passes in isolation. **Not attributable
  to this task**, whose IDEA1 changes are two deterministic test files.
- `node --test tests/collaborationPolicy.test.mjs` — PASS, 18 pass / 0 fail.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge`
  — PASS with the same **two pre-existing** owner-review canvas warnings.
- `git diff --check` — PASS, no whitespace errors.

Five **static negative controls**, each applied in a disposable copy and
reverted: drop provider-header stripping → `PS7-STRUCT-3`; remove the gate →
`PS7-STRUCT-2`; widen `TRUSTED_PROXY_CIDRS` with a Cloudflare range →
`PS7-STRUCT-5`; connector as a `/24` → `PS7-STRUCT-5`; validator accepts a prefix
shorter than `/32` → `PS7-STRUCT-4`.

A rootless **Podman preflight** against the real pinned image confirmed
`--with-http_realip_module`, `nginx -t` success in both modes, untrusted-peer
denial, forged-header resistance, IPv6 preservation and per-recipient limiting.
⚠️ **Podman is configuration evidence only and is NOT Docker acceptance**: it
cannot reproduce `internal: true` with `gateway_mode_ipv4: isolated`, and
involved no Drive, PostgreSQL, audit, isolation or teardown. Every Podman object
was removed and the rootless store verified empty, as it was before.

### Docker runtime acceptance — Session S4

Ten full harness runs on the AEGIS server host, **Docker Engine 29.7.1**, native
Linux. Evidence: `/tmp/ps7-evidence/` — `01-normal.log`, `nc1..nc7.log`,
`04-normal.log`, `05-normal-postfix.log`, `summary.txt`.

**Final result — `05-normal-postfix.log`, 2026-09-09 07:35, executed from the
real checkout at `994579590b10b06c3e0cde0e63331bb38fbd1051` with a clean
worktree: 20 tests, 20 passed, 0 failed, 0 skipped; acceptance exit code 0;
post-run check failures 0.**

| Subtest | Result |
| :--- | :--- |
| PS7-PRE-01 explicit managed mode, realip module present, fail-closed config | PASS |
| PS7-PRE-02 only the pinned connector may assert recipient identity | PASS |
| PS7-PRE-03 public share minted; two recipients keep their own identity | PASS |
| PS7-PRE-04 forged forwarding/provider headers cannot move attribution | PASS |
| PS7-PRE-05 missing/unusable/ambiguous provider identity fails closed | PASS |
| PS7-PRE-06 edge rate limit is per recipient, not per connector | PASS |
| PS7-PRE-07 route allowlist; no AEGIS surface but `/s/:token` | PASS |
| PS7-PRE-08 non-public scope still out of scope on the managed ingress | PASS |
| PS7-PRE-09 audit attribution survives the managed hop, including IPv6 | PASS |
| PS7-PRE-10 no token, password, recipient or provider identity in gateway logs | PASS |
| PS7-PRE-11 B5: gateway reaches its upstream and nothing else | PASS |
| PS7-PRE-12 tunnel connector cannot bypass the gateway | PASS |
| PS7-PRE-13 revocation propagates through the managed path | PASS |
| PS7-PRE-14 the harness removes everything it created | PASS |

### Runtime negative controls — all seven load-bearing

Each mutation broke exactly one invariant in a disposable copy, produced the
named failure, and was reverted.

| # | Mutation | Caught by | What the failure showed |
| :--- | :--- | :--- | :--- |
| NC1 | pinned connector peer check disabled | `PS7-PRE-02`, `PS7-PRE-06` | an untrusted caller was admitted |
| NC2 | trust `X-Forwarded-For` instead of the provider header | `PS7-PRE-03/04/05/06/07/08/09/13`, `PS7-STRUCT-4` | 11 failures |
| NC3 | `set_real_ip_from 0.0.0.0/0` instead of the pinned `/32` | `PS7-PRE-01`, `PS7-STRUCT-4` | ⚠️ `PS7-PRE-02` did **not** fail — the peer pin denies independently, so this is genuine defence in depth |
| NC4 | edge limit keyed on `$server_name` | `PS7-PRE-06`, `PS7-STRUCT-2` | recipient buckets collapsed into one |
| NC5 | `X-Forwarded-For` authored from `$realip_remote_addr` | `PS7-PRE-03/04/05/09`, `PS7-STRUCT-3` | audit recorded `172.31.240.3` (connector) instead of `203.0.113.10` (recipient) — the exact G3/T-05 collapse |
| NC6 | connector given a direct route to Drive | `PS7-PRE-12` | `drive-upstream: open` |
| NC7 | ambiguity control removed | `PS7-PRE-05` | comma-joined identity accepted, `200 !== 403` |

⚠️ **`summary.txt` in the evidence directory reads `NOT-CAUGHT-BY` for every
control, and that text is wrong.** The driver's matcher used `^not ok` while
`node:test` indents subtests, so it only ever matched the parent. The per-log
detail above is authoritative; the matcher was corrected afterwards. The driver
is a scratchpad tool and is not part of the repository.

### Production safety

Measured **before and after every full run**, read-only:

- Stable inventory **IDENTICAL** — container names, container IDs, image IDs,
  Compose project, running state, health state and network attachments, plus
  every network, volume and image outside the harness project.
- `aegis_postgres_data` **PRESENT**; `aegis_drive_storage` **PRESENT**.
- **50 `aegis-prod` rows unchanged.**
- Every production container still healthy.
- **post-run check failures: 0** in each run.

Nothing was installed, pulled, pruned, restarted, recreated or exec'd on any
Production object. No connection to Production PostgreSQL, no Production
migration, no Production Compose or `.env` edit, no host port, and no ingress,
DNS, TLS, NAT, tunnel, firewall, VLAN or Twingate change.

### Teardown and mutation residue

- **Teardown CLEAN** across all ten runs: no harness container, network, volume
  or image survived; each built image verified gone **by ID**; the three base
  images (`postgres:15-alpine`, `node:20-alpine`, `nginx:alpine`) **preserved**;
  the Compose env file and temporary workdir removed.
- **Mutation residue NONE** — `residue-gateway.txt` and `residue-idea1.txt` are
  both **0 bytes**, i.e. the disposable copy was byte-identical to the real
  checkout after every mutation was reverted; the copy was removed;
  `git-status.txt` empty; no `/tmp/aegis-ps7-*` or `/tmp/ps7-nc-work` remained.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — PS7 section with
  Session S4 CLOSED/PASS, the session register, the task status dashboard, and
  planned/completed/remaining.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md`
  — §10.2 records the delivered adapter, the four controls, the two measured
  nginx behaviours, and the engine-dependent unreachability finding.

## Shared surfaces touched

Every path below is under `gateway/**`, an infrastructure/shared boundary, and
requires integration review:

- `gateway/public-share/validate-public-share-edge.sh` — new fail-closed edge trust validator/generator.
- `gateway/public-share/entrypoint.sh` — second startup gate before the nginx handover.
- `gateway/public-share/Dockerfile` — installs the new validator `0555`.
- `gateway/public-share/.dockerignore` — allowlists the new script into the build context.
- `gateway/public-share/nginx.conf.template` — trust include, managed-proxy gate, provider-header stripping.
- `gateway/public-share/README.md` — gateway contract documentation.
- `gateway/public-share/managed-tunnel/docker-compose.yml` — new isolated harness topology.
- `gateway/public-share/managed-tunnel/db-init/00-aegis-drive.sh` — new harness database provisioning.
- `gateway/public-share/managed-tunnel/run-pre-exposure.sh` — new Production-safe runner.
- `gateway/public-share/managed-tunnel/README.md` — new harness documentation.

## Integration requests

- **Kla, as infrastructure owner, must review the gateway trust-boundary change.**
  The gateway image gains a second startup gate and a generated nginx include.
  The decision to review: managed mode is **off by default**, so a deployed
  gateway with neither variable set behaves exactly as PUBLIC-SHARE-3/6 measured;
  the reviewable question is whether one pinned connector `/32` plus the four
  fail-closed controls is the accepted provider-trust boundary for G4 Option B.
- **Downstream effect:** none today. No gateway is deployed, and Drive is
  unchanged, so nothing in Production observes this.
- **Rollout:** the adapter only activates when both variables are set on a
  deployed gateway, which cannot happen before G5.
- **Rollback:** unset `PUBLIC_SHARE_EDGE_MODE`/`PUBLIC_SHARE_EDGE_PROXY_CIDR` and
  the image returns to the direct-peer model with no code change.
- **A deployment gate is recorded rather than faked:** in the harness the
  connector has no route to Drive, PostgreSQL or a private surface because the
  networks are internal and isolated. A real `cloudflared` connector needs an
  outbound Internet path, so reproducing that property in Production is
  host-firewall and/or VLAN work. It must be designed and reviewed **before G5**.
- **G4's gate is not taken by this task** and still requires an explicit owner
  decision with the T-14/T-27 trade-off acknowledged.

## Known limitations

- **This is pre-exposure evidence only.** A recipient here is a header value
  asserted by a stand-in container on an isolated Docker network, not someone on
  ordinary Internet access. `tunnel-connector` is a stock `node:20-alpine`
  container, **not** `cloudflared`; there is no Cloudflare account, tunnel,
  credential, domain, DNS record, TLS certificate or public URL.
- **The isolation claims are Docker-network claims.** MikroTik, UFW, VLAN and
  Twingate were not configured or measured.
- **Nothing about Production changed or was proven.** No Production gateway
  exists, migration 009 has not been applied to Production, and
  `PUBLIC_SHARE_UI_ENABLED` remains off.
- **`ipAllowed()` is still IPv4-only** for `zones` shares. IPv6 recipients are
  attributable end to end on the public path because `audit_log.source_ip` is
  `INET`, and a `zones` share can never be redeemed through the public ingress —
  so no lossy conversion was invented.
- **`CF-Connecting-IP: <address>:<port>` is accepted** and canonicalised to the
  address. Correct behaviour, recorded because it was measured.
- **The full IDEA1 baseline showed one unidentified flaky failure** in one of
  three runs. Not reproduced in the other two and not attributable to this task.
- **The runtime harness cannot be executed from an agent session on this host.**
  `sudo` is sudo-rs with tty/session-scoped tickets and an agent shell has no
  tty, so the owner runs it from a normal terminal. No sudoers, `tty_tickets`,
  docker-group or daemon change was made to work around this.

## Remaining external phase

**NOT RUN and out of scope here:** installing and running `cloudflared` in an
approved isolated deployment; preliminary tunnel connectivity; obtaining a stable
public domain; real DNS and TLS; **G5**; the external 4G/5G matrix with Twingate
off; real-Internet resilience testing; ingress rollback acceptance; post-rollback
private-system verification; and **G6**. PS7 matrix rows PS7-04, 05, 06, 07,
10..17, 25, 27, 28, 29 and 30 remain **NOT RUN**.

## Final task state

```text
Managed-Tunnel Edge Adapter + Pre-Exposure Acceptance = COMPLETE / PASS
Pre-exposure Docker runtime acceptance                = PASS (20/20, exit 0)
Runtime negative controls                             = PASS (7 of 7)
Production mutation                                   = NOT PERFORMED
Real Cloudflare tunnel                                = NOT RUN
Public DNS                                            = NOT RUN
External TLS                                          = NOT RUN
Twingate-OFF 4G/5G acceptance                         = NOT RUN
G4 gate (ingress choice)                              = OPEN
G5                                                    = OPEN
G6                                                    = OPEN
PUBLIC-SHARE-7 overall                                = IN PROGRESS
Public Internet Share                                 = NOT IMPLEMENTED
```

⚠️ **Real Internet exposure was NOT performed by this task.** No tunnel, domain,
DNS record, TLS certificate, NAT rule, port forward, firewall change, VLAN
change, Twingate change or Production change of any kind was created.
