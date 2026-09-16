# AEGIS IDEA3 PR11 Phase 2 — runtime evidence closeout record — 2026-09-16

> Built from `IDEA3-AEGIS_Lockdown/deploy/pr11-phase2/PHASE2-CLOSEOUT-TEMPLATE.md`
> using existing evidence only. The reconciliation ran no new Production
> mutation and no new live test. Where a value did not reach this repository
> session, the field says so instead of predicting it.

## 0. Evidence classes

| Class | Meaning in this record |
|---|---|
| **OWNER-RUN LIVE EVIDENCE** | The owner ran the command against Production or on the physical Core. Its output reached this session either as a local file on the Core workstation (named below) or as an owner report in the PR #146 handoff. |
| **REPOSITORY VERIFIED** | This session re-derived the value from a file it could read: a local evidence file, public certificate/CRL copies, Git, or a test run. |
| **HARNESS DEFECT / HARNESS FIX** | A defect in the evidence scripts that caused a false result. The fix and its regression tests are on PR #146. |
| **NOT PROVEN / SKIP** | No evidence exists. Neither is ever converted to PASS. |

Evidence sources:

| Source | Where | Readable here |
|---|---|---|
| K8 authoritative rerun | Core `~/idea3-k8-core-phase2b-rerun.txt` (2026-09-16T15:41:13Z) | yes |
| K8 first run (harness false failure) | Core `~/idea3-k8-core-phase2b.txt` (2026-09-16T15:39:30Z) | yes |
| Phase 2B Core mTLS matrix | Core `~/idea3-p2b-core.txt` (2026-09-16T15:41:19Z) | yes |
| K10 public CA, CRL, Core certificate | Core `~/idea3-machine-client-ca.crt`, `~/idea3-machine-client-ca.crl`, `~/idea3-core-client.crt` | yes (public material only) |
| Server evidence | aegis-system `/home/admin-main/idea3-p2b-evidence/20260916T152635Z/` (`containers-before.txt`, `pre-mutation-hashes.txt`, `p2b-server-tests.txt`, `post2b-preflight.txt`, `diag-s1a-forged.txt`, `diag-s1b-noidentity.txt`, `diag-s2-wrong-cn.txt`, `diag-s3-browser-machine.txt`) | **no** — no non-interactive path from this workstation; values below are owner-reported |
| Phase 2A execution | owner report in the PR #146 handoff | **no** evidence file reached this session |

A read-only workstation check (`curl https://192.168.10.10/healthz` and the
`/security` routes over Twingate, 2026-09-16) timed out after 6 s. That proves
nothing either way and is not used as evidence.

## Window identity

```text
WINDOW_DATE_UTC            = 2026-09-16 (server evidence dir 20260916T152635Z; Core runs 15:39Z–15:41Z)
OPERATOR                   = music (owner-run); Kla = CA operational custodian for K10
AUTHORIZATION_PHRASE_GIVEN = Phase 2B: AUTHORIZE_IDEA3_PR11_PHASE2B_PRODUCTION_MUTATION=YES (consumed by the completed 2B activation; authorizes nothing further)
BRANCH                     = feat/idea3-pr11-phase2-runtime-completion (PR #146)
PR146_HEAD_AT_WINDOW       = 2cdb5ca7ba4b77372f09adb729ea008e2851ba0a (owner report; kraveerachat APPROVED that head)
SCRIPT_SHA256_*            = NOT RECORDED in the evidence that reached this session
```

## Pre-mutation gates

```text
FINAL_PREFLIGHT_SERVER (pre-2B)  = PASS (OWNER-RUN; owner-reported)
PRE_MUTATION_HASHES              = captured in pre-mutation-hashes.txt (server; not readable here)
P2A_OVERLAY_SHA256 (previous)    = 2feaad012d55d1bf2cccde403c487f4348bd3a47b561f8d5fd5aa706df28d591
PRE2B_RECONCILED_NGINX_SHA256    = 7ca8769e2abeb22a6e8af3d8a01b5d15bfe2abfb5c470ae7bf10d530a39e5ce2 (= the K1 artifact merged by PR #144)
K12                              = NOT_PROVEN
```

## Phase 2A (completed before this reconciliation)

```text
PHASE2A                    = PASS (OWNER-RUN; owner-reported)
IDEA3_WEB_DEPLOYED         = YES
SECURITY_BROWSER_ROUTE     = LIVE
HUB_CONTROLLED_RECREATE    = DONE in Phase 2A (the only HUB recreate of Phase 2)
BROWSER_ACCEPTANCE         = PASS
PRESERVATION               = PASS — Drive, Monitor, Postgres, Public Share, Twingate
VERIFY_PHASE2A_RESULT      = PASS
S1…S8 per-step values      = NOT RECORDED in the evidence that reached this session (image id, snapshot path, per-step hashes)
```

The Phase 2A per-step template fields are left unrecorded rather than
reconstructed. This session did not rerun Phase 2A and does not claim its
per-step values.

## K8 / K9 / K10

```text
CORE_HOST_IDENTITY         = archlinux — Acer Nitro ANV15-51, Arch Linux (REPOSITORY VERIFIED from the rerun file)
CORE_WIRED_VLAN20_ADDRESS  = enp62s0 UP, carrier PASS, 192.168.20.254/24
TWINGATE_DURING_EVIDENCE   = not-running
CORE_ROUTE_TO_HUB          = 192.168.10.10 via 192.168.20.1 dev enp62s0 src 192.168.20.254 (default and forced-wired lookups identical)
CORE_HTTPS_443             = tcp443=open; browser_https=200 remote=192.168.10.10 verify=0
K9_DNS_RESOLUTION          = idea3-core.aegis.internal -> 192.168.10.10 (Core /etc/hosts line 9)
K8                         = PASS (OWNER-RUN LIVE, 2026-09-16T15:41:14Z; REPOSITORY VERIFIED from the file)

K9_SERVER_CERT             = /opt/aegis/runtime/certs/idea3-core.aegis.internal.crt
K9_SERVER_CERT_SUBJECT     = CN=idea3-core.aegis.internal (Core s_client: C=TH, O=AEGIS, CN=idea3-core.aegis.internal; notBefore Sep 16 13:10:04 2026 GMT, notAfter Dec 15 13:10:04 2026 GMT)
K9_SERVER_CERT_SAN         = DNS:idea3-core.aegis.internal (REPOSITORY VERIFIED from the Core matrix preconditions)
K9_SERVER_CERT_EKU         = TLS Web Server Authentication (owner-reported)
K9_SERVER_CERT_ISSUER      = AEGIS Internal Root CA (owner-reported)
K9_SSLSERVER_VERIFY        = OK (owner-reported: openssl verify -purpose sslserver)
K9_SNI_ISOLATION           = PASS — T7a machine path on the browser SNI 404; T7c machine SNI outside the machine route 404
K9                         = PASS

K10_CLIENT_CA              = C=TH, O=AEGIS, OU=IDEA3, CN=AEGIS IDEA3 Machine Client CA; CA:TRUE, pathlen:0 (critical); keyUsage Certificate Sign, CRL Sign (critical)
K10_CLIENT_CA_SHA256       = 0cd51d4e48297985bab805017ca817672e0d3d2d697f6c26c3a1f0f91e8bead3 (sha256 of the PEM file; REPOSITORY VERIFIED)
K10_CLIENT_CA_VALIDITY     = Sep 16 15:10:15 2026 GMT – Sep 15 15:10:15 2029 GMT
K10_CRL_VALIDITY           = lastUpdate Sep 16 15:10:17 2026 GMT; nextUpdate Oct 16 15:10:17 2026 GMT; No Revoked Certificates
K10_CORE_CERT              = CN=idea3-core; issuer AEGIS IDEA3 Machine Client CA; CA:FALSE; keyUsage Digital Signature; EKU TLS Web Client Authentication only; Sep 16 15:10:31 2026 GMT – Dec 15 15:10:31 2026 GMT
K10_CORE_CERT_VERIFY       = openssl verify -CAfile <client CA> -crl_check -CRLfile <CRL> -purpose sslclient -> OK (REPOSITORY VERIFIED; not revoked)
K10_CERT_KEY_MATCH         = PASS (owner-reported; this session never reads the Core key)
K10_SERVER_INIT/SIGN/VERIFY/PUBLISH = PASS (OWNER-RUN; owner-reported)
K10_CA_KEY_CUSTODY         = server-held, root-only, never copied to Git or the Core
K10                        = PASS
```

The Core machine-block offer (`Acceptable client certificate CA names`) listed
exactly `C=TH, O=AEGIS, OU=IDEA3, CN=AEGIS IDEA3 Machine Client CA`, so the edge
trusts the dedicated client CA and not the AEGIS Internal Root CA.

## Phase 2B activation

```text
AUTHORIZATION               = AUTHORIZE_IDEA3_PR11_PHASE2B_PRODUCTION_MUTATION=YES (owner; consumed)
P2B_OVERLAY_PLACED_SHA      = 0be5e5b4db590923ea397b2063b4de216f74ebcdbf92f4fe7e8976db5c650812 (byte-identical to the PR #145 file)
COMPOSE_CONFIG_QUIET        = PASS
RENDERED_HUB_HASH           = b545835c17aa8840bebacbfa1d7c5caf9b1cad600e7e511ae3ebfd8d0fdf8ae9 (unchanged = EXPECT_P2A_HUB_HASH)
P2B_WEB_RECREATED           = YES — idea3-web only (--force-recreate); healthy
AEGIS_IDEA3_DISPATCH_ENABLED= true
IDEA3_WEB_HOST_PORT         = none published
HUB_RECREATED_IN_2B         = NO
HUB_CONTAINER               = id 743f3831cafd62dbdc627814cb12b44f50fd529905cf32e9e59eb68826b69744; started 2026-09-16T09:04:13.426080833Z; restarts 0; healthy (unchanged across 2B)
P2B_NGINX_CANDIDATE_SHA     = 0e349d4ddcb9b77fe8c24b36ef7295993e230a683fa21455325526d840ca7c74
P2B_NGINX_INODE             = 2493536 before = 2493536 after (written in place)
P2B_MACHINE_BLOCK_COUNT     = 1
P2B_NGINX_T                 = PASS (docker exec aegis-prod-hub-1 nginx -t)
P2B_RELOAD                  = PASS
FINAL_PREFLIGHT_SERVER (post-2B) = PASS
PRESERVED_RUNNING           = Drive, Monitor, Postgres, Public Share gateway, Public Share connector, Twingate connector, HUB
PUBLIC_SHARE_FIREWALL       = VALID
```

All values in this block are OWNER-RUN LIVE EVIDENCE reported by the owner; the
server evidence files were not readable from this workstation.

## Server-side controls (IDEA3 machine listener)

```text
SERVER_TEST_INITIAL_RESULT  = PHASE2B_SERVER_TESTS=FAIL — HARNESS FALSE FAILURE
  FAIL non-HUB peer .3 + forged SUCCESS identity   (actual 403)
  FAIL non-HUB peer .3 + no identity               (actual 403)
  FAIL HUB peer + wrong CN                         (actual 403)
  FAIL browser listener 8003 machine path          (actual 404)
  PASS HUB peer + SUCCESS + CN=idea3-core          (200)
SERVER_RAW_NEGATIVE_EVIDENCE (OWNER-RUN, BusyBox wget -S, status extracted by hand)
  diag-s1a-forged.txt         = 403
  diag-s1b-noidentity.txt     = 403
  diag-s2-wrong-cn.txt        = 403
  diag-s3-browser-machine.txt = 404
S1_NON_HUB_PEER_REJECTED    = PASS (from raw evidence)
S2_HUB_PEER_WRONG_CN        = PASS (from raw evidence); S2 positive = PASS (200)
S3_BROWSER_LISTENER_404     = PASS (from raw evidence)
S4/S5 script lines          = NOT RECONCILED — p2b-server-tests.txt not readable here
SERVER_TEST_AFTER_FIX       = NOT RERUN LIVE (fixed harness proven on stubbed BusyBox output only)
```

### HARNESS DEFECT 1 — BusyBox wget status parser

BusyBox `wget -S` prints the response status indented (`  HTTP/1.1 403
Forbidden`). For a non-2xx response it then prints `wget: server returned
error: HTTP/1.1 403 Forbidden`. The script took awk field `$2` from the **last**
line that matched `HTTP/`. On the error line that field is `server`, and
`c+0` turned it into `0`, so every correct 403/404 refusal became `0 != 403` →
FAIL. The 200 case has no error line, so it passed.

**HARNESS FIX:** `p2_http_status` (`deploy/pr11-phase2/p2-portable.sh`) takes the
three-digit code that follows `HTTP/x.y` on the last status line. It prints
`000` and returns non-zero when no status is present. `p2b-tests-server.sh`
uses it for every S1–S3 request, and the expected security statuses stay exactly
403, 403, 200, 403, 404.

### HARNESS DEFECT 2 — optional `hostname` executable

The Arch Core has `hostnamectl --static = archlinux` and `/etc/hostname =
archlinux`, but no `hostname` binary. `p2-k8-core-evidence.sh` failed its
identity check (`hostname: command not found`, first run 15:39:30Z), and
`p2b-tests-core.sh` stopped with `STOP: not the declared Core`. For the
authoritative runs only, the owner used a temporary `/tmp/aegis-pr11-bin/hostname`
wrapper that ran `/usr/bin/hostnamectl --static`. That wrapper returns the same
value the fixed helper reads, and the system itself was unchanged.

**HARNESS FIX:** `p2_host_identity` (`p2-portable.sh`) reads `hostnamectl --static`,
then the first non-comment line of `/etc/hostname`. It requires a plain host
name and returns nothing and non-zero otherwise. Both Core scripts compare it
exactly with `CORE_DECLARED`, and an empty or mismatched name fails.

Regression tests: `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase2_harness.py`
(39 tests, RED at `fd871a07`, GREEN at `fc64be49`).

## Phase 2B Core mTLS matrix (OWNER-RUN LIVE, REPOSITORY VERIFIED from `~/idea3-p2b-core.txt`)

Run on the physical Core over VLAN 20 with Twingate not running, using
`--interface enp62s0`. Certificate validation was on (`--cacert`, no `-k`), with
the real K9 server certificate and the real K10 Core client certificate.

```text
T1_VALID_CERT              = PASS (200)
T2_NO_CERT                 = PASS (400)
T3_WRONG_CA                = SKIP — no ephemeral wrong-CA pair supplied
T4_REVOKED                 = SKIP — no Kla-revoked test certificate supplied
T5_EXPIRED                 = SKIP — no Kla-issued expired test certificate supplied
T6a_FORGED_HEADERS_VALID_CERT   = PASS (200) — the edge overwrote client-supplied identity with the certificate identity
T6b_FORGED_HEADERS_NO_CERT      = PASS (400)
T6c_COOKIE_ORIGIN_VALID_CERT    = PASS (200) — the HUB stripped browser identity headers
T7a_MACHINE_PATH_BROWSER_SNI    = PASS (404)
T7b_BROWSER_SECURITY_ROUTE      = PASS (200)
T7c_MACHINE_SNI_OUTSIDE_ROUTE   = PASS (404)
PHASE2B_CORE_TESTS         = PASS (script verdict; SKIP lines do not fail the script)
```

### Are T3/T4/T5 mandatory? — decided from repository evidence

- The authoritative Phase 2 design,
  `2026-09-15-idea3-pr11-phase2-server-integration-design.md` §6.2 step 16
  (*Phase 2B only: verify mTLS*), requires: "a valid client certificate gets
  200; **no certificate, a wrong-CA certificate, or a revoked certificate is
  rejected**; the browser SNI with the machine path returns 404."
  **T3 (wrong CA) and T4 (revoked) are therefore mandatory Phase 2B acceptance
  gates.**
- An expired certificate is not in §6.2 step 16. It appears only in the
  README §9 "Expected" list and as optional material in the script header. T5
  is **not a design acceptance gate**, and it stays SKIP / NOT PROVEN.
- The script header calls all three fixtures "optional". That label decides
  when the script skips, not what Phase 2 acceptance requires. Where they
  disagree, the design wins.

```text
PHASE2B_MANDATORY_GATES_MET = NO — T3 and T4 are required by design §6.2 step 16 and are SKIP
```

## Outcome

```text
ROLLBACK_USED              = none reported (the owner report describes a completed activation with no rollback step)
PHASE2A                    = PASS (OWNER-RUN)
PHASE2B                    = ACTIVATED — LIVE; ACCEPTANCE PARTIAL (T1/T2/T6/T7 + server S1–S3 PASS; T3/T4 required and NOT PROVEN)
K8 = PASS    K9 = PASS    K10 = PASS    K12 = NOT_PROVEN
PHASE2_RUNTIME_COMPLETE    = NO
PHASE3_RUNTIME_COMPLETE    = NO
PHASE4_RUNTIME_COMPLETE    = NO
D4_LIVE_VERIFIED           = NO
PR11_COMPLETE              = NO
RECEIPT_PATH               = none — Phase 2 runtime is not complete, so no final PR #146 receipt is created
RECEIPT_COUNT              = 0
PR_NUMBER                  = 146
PR_STATE                   = Draft
PRODUCTION_MUTATION_DURING_RECONCILIATION = NO
```

## Known limitations

- **Cable removed after capture.** The owner unplugged the Acer/Core from
  TP-Link Port 3 **after** the authoritative K8 rerun (15:41:14Z) and the Core
  matrix (15:41:19Z). That does not invalidate those results. Every later live
  Core step (the T3/T4 residual gates and all Phase 3+ work) needs VLAN 20 again,
  or an explicitly accepted equivalent.
- The server evidence files and the Phase 2A per-step values did not reach this
  repository session. Their values here are owner-reported.
- The fixed server harness has not been rerun live. The four raw diagnostics are
  the authoritative server-side status evidence.
- The authoritative Core runs used the temporary `hostname` wrapper. The fixed
  scripts need no wrapper, and neither has been rerun live yet.
- K12 reboot persistence is a separate future verification.
- The Twingate workstation path to `192.168.10.10` timed out during
  reconciliation. That is unexplained and is not investigated here.
- Neither a CRL renewal before `nextUpdate` (Oct 16 15:10:17 2026 GMT) nor Core
  certificate renewal (expires Dec 15 2026) is scheduled in this record.

## Residual Phase 2 gates (owner-run; nothing here is authorized by this record)

**T3 — wrong CA** (no Production mutation; a read-only GET; needs the Core back on VLAN 20).
On the Core, with a throwaway pair that is never trusted anywhere:

```bash
umask 077; d=$(mktemp -d)
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 \
  -subj "/CN=idea3-core" -keyout "$d/wrong.key" -out "$d/wrong.crt"
CORE_DECLARED=archlinux WIRED_IF=enp62s0 WRONG_CA_CERT="$d/wrong.crt" WRONG_CA_KEY="$d/wrong.key" \
  bash p2b-tests-core.sh 2>&1 | tee ~/idea3-p2b-core-t3.txt     # expect PASS T3 (got 400)
rm -rf "$d"
```

**T4 — revoked certificate** (a **Production CA mutation**, so it needs its own
explicit authorization and Kla as CA custodian). Sign a second `CN=idea3-core`
test certificate from a separate Core test CSR, `MODE=revoke` it, `MODE=publish`
the CRL, write NGINX in place and reload, then run `p2b-tests-core.sh` with
`REVOKED_CERT/REVOKED_KEY` and expect T4 400 while T1 stays 200. The owner/reviewer
decides whether to authorize that step. This record does not.

**Optional:** T5 (expired) and a live rerun of the fixed `p2b-tests-server.sh`
(read-only on the server: `sudo bash p2b-tests-server.sh 2>&1 | tee ~/idea3-p2b-server-rerun.txt`).
