# AEGIS IDEA3 PR11 — Phase 2 Pre-Mutation Owner Package (K3 execution window, K7 HUB model)

> **Status:** documentation only, reviewed approve-only. Music, the IDEA3
> owner, records the proposed K7 HUB-model decision and the evidence-based K3
> execution-window state. Kla (`kraveerachat`) accepts or rejects the package
> as a whole. This record performs no Production mutation, and approving it
> authorizes none.

```text
MUSIC_PACKAGE                  = COMPLETE
KLA_ACCEPTANCE                 = PENDING (an APPROVED review by kraveerachat on this package's PR; the body may be empty)
BASE_MAIN                      = 8cf917bfab6ca9dc321839d08255562741374603 (merge of PR #139, 2026-09-15T20:15:00Z, human merge)

K7_OWNER_PROPOSAL              = ACCEPT_CURRENT_BASE_SEMANTICS_FOR_NEXT_HUB_RECREATE
K7_RECONCILIATION_STATUS       = DRIFT_EXPLAINED — no unexplained drift; accepted only by Kla's APPROVED review
K3_EXECUTION_WINDOW            = OWNER_CONFIRMATION_REQUIRED

K1_DECISION                    = ACCEPTED (PR #139); Git-side reconciliation of HUB-AEGIS_Entry/nginx.conf still PENDING (Kla PR)
K4                             = PASS (fresh owner-run recheck)
K8                             = BLOCKED
K9                             = FAIL
K10                            = BLOCKED
K12                            = NOT_PROVEN

STAGE_B_ALLOWED                = NO
PRODUCTION_MUTATION_AUTHORIZED = NO
PHASE2_RUNTIME_COMPLETE        = NO
PHASE3_RUNTIME_COMPLETE        = NO
PHASE4_RUNTIME_COMPLETE        = NO
D4_LIVE_VERIFIED               = NO
PR11_COMPLETE                  = NO
```

## 1. Review contract (approve-only)

| Kla's review | Meaning |
|---|---|
| APPROVE | Accepts the whole K7 proposal (§4) exactly as written at the approved head commit. The review body may be empty |
| REQUEST_CHANGES | The package must be corrected. No value in it is accepted |

- K3 is recorded as `OWNER_CONFIRMATION_REQUIRED`, not as proven clear (§5).
  An APPROVED review therefore does **not** change K3.
- K3 becomes `CLEAR` only through a written statement by `kraveerachat` on this
  package's PR, in a comment or in the review body, that the IDEA1 Production
  mutation/verification window described in §5 is closed. The PR asks Kla for
  that statement before approving.
- Even with K3 `CLEAR`, the PR #139 K3 rule still applies: the IDEA1 window is
  checked again immediately before any Production mutation, and a conflict
  stops IDEA3.
- Only a review by `kraveerachat` counts. A review from any other account does
  not accept the package. An approval covers the head commit it was given on.

## 2. Evidence and provenance

| Label | Meaning |
|---|---|
| **OWNER-RUN (S2A)** | The owner ran the read-only Stage A server script (`idea3-p2-stage-a-server.sh`, SHA-256 `8fd6b13ea1456380e90703255f9c443f2a3474189fdfdde66e046c26c8d7d0c1`) on `aegis-system` at 2026-09-15T20:42:32Z |
| **OWNER-RUN (K7-E3)** | The owner ran the read-only K7 comparison (`idea3-p2-k7-compare.py`, SHA-256 `3a002690e4f14627158ca4da50f2c494d701410aeb0787c2bf06e27a8dc3954f`) on `aegis-system` at 2026-09-15T21:08:53Z |
| **AGENT-RUN (WORKSTATION)** | Unprivileged HTTPS/TLS probes by the agent from the owner's workstation over Twingate, with certificate validation on, 2026-09-16 |
| **AGENT-VERIFIED (REPO)** | Verified by the agent against Git at `8cf917bf` and the `origin` refs fetched at 2026-09-15T21:16Z |

- The agent read both owner-run outputs in full. The scripts print hashes,
  labels, states, and certificate metadata only; K7-E3 compares environment
  values in memory and prints names only. No secret, key, or environment value
  was printed or is recorded here.
- The scripts ran read-only. K7-E3 passes every subprocess call through an
  allowlist (`docker inspect`, `docker image inspect`, `docker compose version`,
  `docker compose … config`). The scripts are not committed; their SHA-256 values
  above identify the exact versions.
- The agent had no server shell: SSH from the workstation was refused
  (`publickey`). Every server fact is OWNER-RUN.

## 3. K7 — running HUB versus the current base model

### 3.1 Hashes (OWNER-RUN (K7-E3))

| Model | `hub` config hash |
|---|---|
| Running HUB label `com.docker.compose.config-hash` | `ed4f24db58201ad219fc4fe7d9fc11e4a3814c9d57ceb66ea8057355e52e79cd` |
| Current base `/opt/aegis/runtime/docker-compose.production.yml` (SHA-256 `61528b86…`) | `2656d5a8bd86494f579264017c7023ffce744d6427e8cf8eab26cf4921b89f25` |
| Accepted Phase 2A list (base + byte-identical overlay `2feaad01…`, temporary copy only) | `b545835c17aa8840bebacbfa1d7c5caf9b1cad600e7e511ae3ebfd8d0fdf8ae9` |

- Compose version: `5.4.0` when the HUB was created and `5.4.0` now, so the
  hash algorithm is not the cause.
- HUB created 2026-08-28T09:47:10Z; last started 2026-09-12T17:32:46Z.
- The base file was last modified at 2026-09-12T17:21:15Z. The env file named
  by the HUB label was last modified on 2026-08-14.

### 3.2 Field comparison (OWNER-RUN (K7-E3))

| Field | Running | Current base | Phase 2A |
|---|---|---|---|
| image / image ID | `aegis-prod-hub` / `sha256:8c365f8c…` | same (the tag resolves to the running image) | same |
| container name, restart | `aegis-prod-hub-1`, `unless-stopped` | same | same |
| ports | `192.168.10.10:443->443/tcp`, `192.168.10.10:80->80/tcp` | same | same |
| mounts | `/opt/aegis/runtime/certs` → `/etc/nginx/certs` (ro); `nginx.production.conf` → `/etc/nginx/conf.d/default.conf` (ro) | same | same |
| user, read_only, privileged, init, tmpfs | default | same | same |
| cap_add, cap_drop, security_opt | none | same | same |
| healthcheck, entrypoint, command, working_dir, stop signal, logging | identical values | same | same |
| extra_hosts, dns, sysctls | none | same | same |
| user labels / environment variable names | 0 / 0 (values compared in memory) | same | same |
| networks | `aegis_drive_proxy` 172.19.255.2; `aegis_internal` 172.18.0.4 | same | adds `aegis_idea3_internal` 172.31.243.2 |
| depends_on | label empty | `drive`, `monitor` | `drive`, `monitor` |
| model keys not compared | — | none | none |

```text
FIELDS_RUNNING_NE_BASE              = depends_on
FIELDS_BASE_TO_PHASE2A              = networks
PHASE2A_DELTA_IS_ONLY_IDEA3_NETWORK = YES
UNCOMPARED_MODEL_KEYS               = NONE
```

### 3.3 Where the hash difference comes from (OWNER-RUN (K7-E3))

Seven earlier copies of the base file under `/opt/aegis` render the running
hash `ed4f24db…`:

| Copy | SHA-256 | Renders running hash |
|---|---|---|
| `/opt/aegis/backups/lft-v2-d/20260829_104420/docker-compose.production.yml.before-lft-v2-d` | `5146da4e…` | yes |
| `/opt/aegis/backups/lft-v2-e/20260829_165128/docker-compose.production.yml.before-e-deploy` | `5146da4e…` | yes |
| `/opt/aegis/backups/rollback/monitor-baseline-20260907T062957Z/docker-compose.production.yml` | `5aae5cd7…` | yes |
| `/opt/aegis/runtime/backups/b3-20260824T072533Z/docker-compose.production.candidate.yml` | `f0e5743b…` | yes |
| `/opt/aegis/runtime/backups/docker-compose.production.yml.before-telemetry-20260826_201509` | `f0e5743b…` | yes |
| `/opt/aegis/runtime/docker-compose.production.yml.pre-backup-agent-20260904-201845` | `4aa5cec2…` | yes |
| `/opt/aegis/runtime/docker-compose.production.yml.pre-s55g-ipam-20260912T172115Z` | `5aae5cd7…` | yes |
| `/opt/aegis/runtime/backups/b3-20260824T072533Z/docker-compose.production.yml` | `2f2f932b…` | no (`f0fe4e73…`, older) |

- The running-era copy differs from the current base in one compared field:
  `aegis_internal` has no pinned HUB address in the copy, and the base pins
  `172.18.0.4`. `depends_on` (`drive`, `monitor`) is the same in both.
- The base changed at 2026-09-12T17:21:15Z, the time in the backup name
  `pre-s55g-ipam-20260912T172115Z` and the base file's modification time. That
  IPAM edit is the source of the hash difference. No Git record documents it.
- The running HUB already reports `aegis_internal` 172.18.0.4 as its configured
  address, so the live address equals the base pin. How the live container
  acquired that setting is NOT PROVEN.
- The running label's empty `depends_on`, against a creation model that
  declares `drive` and `monitor`, is consistent with a `--no-deps` creation
  (INFERRED). `depends_on` is Compose orchestration metadata; the Docker engine
  does not use it at runtime.

### 3.4 Classification

| Item | Class |
|---|---|
| Every field in §3.2 other than networks and depends_on; the live addresses of `aegis_drive_proxy` and `aegis_internal` | MATCH |
| `aegis_idea3_internal` 172.31.243.2 on the HUB (and IDEA3 Web at .3, no ports) | EXPECTED_PHASE2_CHANGE |
| `depends_on` label empty on the running HUB; `drive`, `monitor` in the model | PREEXISTING_LIVE_DRIFT |
| `aegis_internal` declaration unpinned in the creation model, pinned in the base since 2026-09-12 (sole cause of `ed4f24db…` ≠ `2656d5a8…`) | PREEXISTING_LIVE_DRIFT |
| Anything else | UNEXPLAINED_DRIFT — none |
| The config-hash mismatch under the PR #139 §5.5 stop rule | BLOCKING until Kla approves §4 |

## 4. K7 owner proposal

```text
K7_OWNER_PROPOSAL = ACCEPT_CURRENT_BASE_SEMANTICS_FOR_NEXT_HUB_RECREATE
```

Meaning:

- the current base HUB definition is retained;
- `aegis_internal` 172.18.0.4 is retained;
- the current Compose `depends_on` definition (`drive`, `monitor`) is accepted;
- Phase 2A adds only `aegis_idea3_internal` 172.31.243.2;
- the Monitor and Public Share overlays are not added to HUB recreation;
- those overlays stay service-scoped: every Monitor, Drive, Public Share Gateway,
  and Public Share Connector operation keeps using that service's own Compose
  list;
- the rollback owner remains `kraveerachat`.

The PR #139 K7 lists are unchanged: the Phase 2A HUB list is
`/opt/aegis/runtime/docker-compose.production.yml`, then
`/opt/aegis/runtime/idea3/idea3-phase2.yml`. No base-file edit is proposed.

**Effect on the PR #139 §5.5 stop rule.** That rule stops IDEA3 when the running
HUB hash differs from the base render until Kla reconciles the base. With Kla's
approval, this package is that reconciliation: the difference is explained
(§3.3) and the current base is accepted as the HUB model. The next HUB recreate,
the Phase 2A one, is also the HUB's first recreate under the post-2026-09-12 base.

**Stage B checks this proposal depends on (not run by this package):**

1. Immediately before the recreate, the running HUB still reports `ed4f24db…`,
   the base still hashes to `61528b86…` and renders `2656d5a8…`, and
   `PHASE2A_DELTA_IS_ONLY_IDEA3_NETWORK=YES` is re-confirmed. Any change stops
   IDEA3 and the K7 comparison is re-run.
2. No container other than the HUB holds 172.18.0.4 on `aegis_internal`.
3. The HUB is recreated alone (`--no-deps`), so Drive and Monitor are untouched.
4. Afterwards: the HUB is on exactly three networks (`aegis_drive_proxy` .2,
   `aegis_internal` .4, `aegis_idea3_internal` .2); the image ID is still
   `sha256:8c365f8c…`; the new config-hash is expected to be `b545835c…`
   (a prediction, NOT PROVEN); `/healthz`, `/drive/healthz`, `/monitor/healthz`,
   and the Public Share baseline are unchanged.

Recommended for the later IDEA3 design-alignment task, not decided here: add
`--no-build` to the Phase 2A HUB recreate, so a missing image tag can never
trigger a build.

## 5. K3 — is an IDEA1 window currently active?

| Category | Evidence | Source |
|---|---|---|
| Future or open authorization gate | IDEA1's status on `main` records G6 OPEN and Public Share UI mutation not allowed. A gate is not a window | AGENT-VERIFIED (REPO) |
| Stale documentation | The same status records S5.8 as next and S5.11 as NOT STARTED, with Public Share UI OFF. Live Drive runs `docker-compose.s5-11-ui.yml` (`a5e536e9…`, byte-identical to IDEA1 commit `22c00ff7`, which sets `PUBLIC_SHARE_UI_ENABLED: "true"` and says "apply LAST, only after G6 approval") | OWNER-RUN (S2A); AGENT-VERIFIED (REPO) |
| Completed runtime mutation | On 2026-09-15: Public Share Gateway created 18:59:46Z; Connector created 19:02:15Z, started 19:05:56Z; Drive created 19:34:39Z with the S5.11 overlay. All were running at 20:42Z (Drive and Gateway healthy), the connector service and drift timer active, and the four Public Share Compose hashes unchanged from P2-E1 | OWNER-RUN (S2A) |
| Currently active window | NOT PROVEN either way. The last `sudo docker` commands before the owner's own runs were at 19:54:58Z (arguments redacted; attribution unknown). There is no IDEA1 PR, receipt, or status update for this work. `22c00ff7` (2026-09-15T19:29:11Z) is the newest IDEA1 commit, its branch has no PR, and no PR is open. No login session was listed at 20:42Z, which does not prove closure | OWNER-RUN (S2A); AGENT-VERIFIED (REPO) |

```text
K3_EXECUTION_WINDOW = OWNER_CONFIRMATION_REQUIRED
```

- Closure cannot be proven from accepted evidence, so it is not recorded.
- **Request to Kla, as IDEA1 owner:** before approving, state on this PR that
  the IDEA1 Production mutation/verification window that recreated the Public
  Share Gateway, Connector, and Drive on 2026-09-15 is closed, and that no IDEA1
  window is planned to overlap IDEA3 Phase 2A.
- Reconciling IDEA1's own status (S5.8, S5.11, G6, UI state) is IDEA1's task.
  This package does not interpret or edit it.

## 6. Other gates (fresh evidence, not decided here)

| Gate | State | Evidence |
|---|---|---|
| K1 | decision ACCEPTED; Git reconciliation PENDING | the running HUB `default.conf` and host `nginx.production.conf` both hash to `16cee162…` (OWNER-RUN (S2A)). Git `HUB-AEGIS_Entry/nginx.conf` is still `ac70bfba…` (AGENT-VERIFIED (REPO)). The Kla-owned reconciliation PR is still required |
| K4 | PASS | no `172.31.243.x` Docker network, route, or address; `aegis_idea3_internal` absent (OWNER-RUN (S2A)) |
| K8 | BLOCKED | the Core Stage A output has not been received. The workstation used for the probes is not proven to be the Core, and its path to the server runs over Twingate, not VLAN 20 |
| K9 | FAIL | no `idea3-core.aegis.internal` server block, no DNS answer on the server, and no machine server certificate (OWNER-RUN (S2A)). The machine SNI gets the browser certificate (CN `aegis.internal`; the SAN lacks the name) and no client-certificate request (AGENT-RUN (WORKSTATION)) |
| K10 | BLOCKED | IDEA3 client CA, CRL, and `/opt/aegis/runtime/idea3` absent (OWNER-RUN (S2A)) |
| K12 | NOT_PROVEN | unchanged |

Also observed (AGENT-RUN (WORKSTATION)): `/healthz`, `/drive/healthz`, and
`/monitor/healthz` return 200. Every `/security*` path returns the HUB landing
page through the HUB's fallback, so no IDEA3 route exists yet.

## 7. Limitations

- How the running HUB acquired its configured `aegis_internal` address is NOT
  PROVEN, and the cause of its empty `depends_on` label is INFERRED.
- The post-recreate config-hash `b545835c…` is a prediction.
- No Git record documents the 2026-09-12 `pre-s55g-ipam` base edit.
- Kla-owned infrastructure notes (`infrastructure/network/VLAN-IP-Plan.md`,
  `infrastructure/deployment/Docker-Stack-Plan.md`) still list 172.18.0.4 as
  the Monitor address; the live HUB holds it. This package does not edit them.
- The owner-run scripts are identified by SHA-256 and are not committed.

## 8. What Kla's approval does and does not do

Approval accepts the §4 K7 proposal exactly as written. It does not:

- authorize any Production mutation or Stage B;
- recreate the HUB or change any Compose file;
- change K3, unless Kla also writes the §5 confirmation;
- perform the K1 reconciliation;
- decide K8, K9, K10, or K12, or accept IR-1 through IR-6;
- change the Phase 2 design, HUB, infrastructure, IDEA1, IDEA2, shared, or
  `.github` files, or any historical receipt.

## 9. Still required before Stage B

- K1: the Kla-owned `HUB-AEGIS_Entry/nginx.conf` reconciliation PR, merged and
  re-validated with `nginx -t`, with IR-1 re-based on it.
- K3: `CLEAR` by Kla's written confirmation, plus the execution-time recheck.
- K7: Kla's APPROVED review of this package.
- IR-1, IR-3, IR-4, and IR-5 acceptance.
- The exact Production authorization phrase from the owner in the executing
  session.
- Phase 2B additionally needs K8, K9, K10, IR-2, and IR-6.
