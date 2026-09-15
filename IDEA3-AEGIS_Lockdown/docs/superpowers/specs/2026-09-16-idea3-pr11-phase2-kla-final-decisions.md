# AEGIS IDEA3 PR11 — Phase 2 Final Owner-Decision Package (K1, K3, K7)

> **Status:** documentation only, reviewed approve-only. Music, the IDEA3
> owner, records the complete proposed K1, K3, and K7 decisions here. Kla
> (`kraveerachat`) accepts or rejects the package as a whole. This record
> performs no Production mutation, and approving it authorizes none.

```text
MUSIC_DECISION_PACKAGE         = COMPLETE
KLA_ACCEPTANCE                 = PENDING (an APPROVED review by kraveerachat on this package's PR; the body may be empty)
BASE_MAIN                      = 3fd8d4d1026b345f84d03b7294b9c9017f54bf55 (merge of PR #138, 2026-09-15T19:31:02Z, human merge)

K1_OWNER_DECISION              = ACCEPT_LIVE_AS_NEW_CANONICAL_AND_RECONCILE_GIT
K3_OWNER_DECISION              = NON_OVERLAP_CONFIRMED (bound to the §4 execution-time rule)
K7_CURRENT_HUB_MODEL           = /opt/aegis/runtime/docker-compose.production.yml
K7_PHASE2A_HUB_COMPOSE_LIST    = 1. /opt/aegis/runtime/docker-compose.production.yml
                                 2. /opt/aegis/runtime/idea3/idea3-phase2.yml
K7_MONITOR_OVERLAY             = NOT_INCLUDED
K7_PUBLIC_SHARE_OVERLAYS       = NOT_INCLUDED_FOR_HUB_RECREATE
K7_ROLLBACK_OWNER              = kraveerachat

K8                             = BLOCKED
K9                             = BLOCKED
K10                            = BLOCKED
K12                            = NOT_PROVEN

D4_REPOSITORY_IMPLEMENTATION   = COMPLETE
D4_LOCAL_VERIFICATION          = PASS
D4_LIVE_VERIFIED               = NO

PHASE2_RUNTIME_COMPLETE        = NO
PHASE3_RUNTIME_COMPLETE        = NO
PHASE4_RUNTIME_COMPLETE        = NO
PRODUCTION_MUTATION_AUTHORIZED = NO
PR11_COMPLETE                  = NO
```

## 1. Review contract (approve-only)

| Kla's review | Meaning |
|---|---|
| APPROVE | Accepts the whole K1, K3, and K7 package exactly as written at the approved head commit. The review body may be empty |
| REQUEST_CHANGES | Rejects the package or asks for corrections. No value in it is accepted |

- Kla does not type decision lines or fill anything in. An empty-body APPROVED
  review from `kraveerachat` is formal acceptance.
- Only a review by `kraveerachat` counts. A review from any other account,
  including Pub, does not accept the package.
- An approval covers the head commit it was given on. A later change to the
  package needs a new approval.
- For this package, this contract replaces the §2 rule of the PR #137 record,
  under which an approval without decision lines left each value
  `PENDING_KLA`. That rule still describes PR #137's own outcome: K1, K3, and
  K7 were not decided there.

## 2. Evidence and provenance

| Label | Meaning |
|---|---|
| **OWNER-RUN (P2-E1)** | Read-only commands the owner ran on the Production host on 2026-09-15, recorded in the PR #136 package |
| **OWNER-RUN (K7-E2)** | Read-only commands the owner ran on the Production host and reported for this package on 2026-09-16. No Production mutation occurred |
| **AGENT-VERIFIED (REPO)** | Verified by the agent against Git at `3fd8d4d1` |

The agent had no server path and observed no server value directly. The PR #136
package
(`IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-15-idea3-pr11-phase2-live-evidence-reconciliation.md`)
and its receipt remain the P2-E1 record and are not edited.

## 3. K1 — live HUB NGINX artifact

| Artifact | SHA-256 | Source |
|---|---|---|
| Running HUB container `/etc/nginx/conf.d/default.conf` | `16cee16232f5636eb11dd434d43ba42c6314d75a2b306265ee62032b84fb3722` | OWNER-RUN (P2-E1), restated by the owner for this package |
| Host `/opt/aegis/runtime/nginx/nginx.production.conf` | `16cee16232f5636eb11dd434d43ba42c6314d75a2b306265ee62032b84fb3722` | OWNER-RUN (P2-E1), restated by the owner for this package |
| Reviewed Git `HUB-AEGIS_Entry/nginx.conf` (blob `5028b6af`, last changed `cafa4e61`) | `ac70bfbaf2254b3a878924635e8c76cb97961f8c464ae1de3ba61325c94668c6` | AGENT-VERIFIED (REPO) at `3fd8d4d1` |

The running HUB and the host artifact agree with each other. Neither matches
the reviewed Git artifact. PR #136 found that no committed `nginx*.conf`
version hashes to `16cee162…`.

```text
K1_OWNER_DECISION = ACCEPT_LIVE_AS_NEW_CANONICAL_AND_RECONCILE_GIT
```

Meaning:

- Production is not rolled back merely to recover the stale Git hash
  `ac70bfba…`.
- The running live artifact `16cee162…` is preserved and becomes the reviewed
  baseline.
- A separately reviewed, Kla-owned integration change reconciles the
  repository artifact `HUB-AEGIS_Entry/nginx.conf` with the live artifact
  before Phase 2A. IR-1 is re-based on the reconciled artifact.
- The reconciled artifact is re-validated before any Production mutation, with
  `nginx -t` on an isolated HUB image and a SAME_ARTIFACT_HASH check against the
  live artifact.

This PR does not perform that reconciliation, and it mutates neither artifact.
The content difference between `16cee162…` and `ac70bfba…` is still NOT PROVEN.
The reconciliation change is where that content is first read and reviewed.

## 4. K3 — future IDEA3 Phase 2 execution window

```text
K3_OWNER_DECISION = NON_OVERLAP_CONFIRMED
```

The decision is bound to these rules:

- It confirms the scheduling policy for IDEA3 Phase 2: the IDEA3 Phase 2
  Production window must not overlap an IDEA1 Production window.
- Immediately before any Production mutation, the active IDEA1 Production
  window is checked again.
- If a conflicting IDEA1 window exists at execution time, IDEA3 stops. No
  Phase 2 step runs.
- This approval does not itself authorize Production mutation.

```text
Architecture/scheduling approval != Production mutation authorization
```

Recorded for the execution-time check (§5.1): the Drive container's Compose
label includes a fifth file, `docker-compose.s5-11-ui.yml` (SHA-256
`a5e536e9…`; its directory was not reported). IDEA1's canonical status at
`3fd8d4d1` records S5.11 as NOT STARTED. No file of that name exists at
`3fd8d4d1` or on `origin/feat/idea1-public-share-s5-8-external-client-acceptance`.
This package does not interpret that IDEA1 state. The execution-time check
resolves it with the IDEA1 owner.

## 5. K7 — canonical Compose model for the HUB

### 5.1 Compose labels (OWNER-RUN (K7-E2))

Abbreviations: **base** = `/opt/aegis/runtime/docker-compose.production.yml`;
**Monitor overlay** =
`/opt/aegis/runtime/monitor-single-camera-ui-20260906-204814/compose.active.yml`;
the S5.3, S5.4, and S5.5 files are under `/opt/aegis/runtime/public-share/`.

| Container | `config_files` label, in order |
|---|---|
| HUB (project `aegis-prod`, service `hub`) | base |
| PostgreSQL | base |
| Monitor | base, Monitor overlay |
| Public Share Gateway | base, `drive-s5-3.yml`, `drive-gateway-s5-4.yml` |
| Public Share Connector | base, `drive-s5-3.yml`, `drive-gateway-s5-4.yml`, `connector-s5-5.yml` |
| Drive | base, `drive-s5-3.yml`, `drive-gateway-s5-4.yml`, `connector-s5-5.yml`, `docker-compose.s5-11-ui.yml` |

### 5.2 File hashes

| File | SHA-256 | Source |
|---|---|---|
| base | `61528b8636b560021d15fb9dd98316533447adfc348210b4da4cf5b7ea021869` | OWNER-RUN (K7-E2); same value as P2-E1 |
| Monitor overlay | `cf90ac99fc93e48ab4bc7a88117a0317d1bdcfae40471660dab9a3445dc5037b` | OWNER-RUN (K7-E2) |
| `public-share/drive-s5-3.yml` | `324fb5126b2f13f7b1c529ef1391131ef37f81acc8c3921b9b50f649b179de62` | OWNER-RUN (P2-E1) |
| `public-share/drive-gateway-s5-4.yml` | `cc36d08c16731f888f64cb2dcd84f1c9a41b11e9b447aa16ad67405bcdc12819` | OWNER-RUN (P2-E1); equal to `gateway/public-share/production/docker-compose.s5-4.yml`, AGENT-VERIFIED (REPO) |
| `public-share/connector-s5-5.yml` | `83ad5e15e0182b794f4dd036146e19a3521b4ea298fc5f7a3df6e461c5cc962f` | OWNER-RUN (P2-E1); equal to `gateway/public-share/production/docker-compose.s5-5.yml`, AGENT-VERIFIED (REPO) |
| `docker-compose.s5-11-ui.yml` (directory not reported) | `a5e536e9fbb1df9bfc406ce1af0dc39dd118f7119ee30c872d0afa40b02086ca` | OWNER-RUN (K7-E2); not in Git |

### 5.3 Rendered HUB service hash (OWNER-RUN (K7-E2))

| File list | Rendered `hub` config hash |
|---|---|
| base | `2656d5a8bd86494f579264017c7023ffce744d6427e8cf8eab26cf4921b89f25` |
| base + Monitor overlay | `2656d5a8bd86494f579264017c7023ffce744d6427e8cf8eab26cf4921b89f25` |
| base + S5.3 + S5.4 + S5.5 | `2656d5a8bd86494f579264017c7023ffce744d6427e8cf8eab26cf4921b89f25` |
| base + S5.3 + S5.4 + S5.5 + S5.11 UI | `2656d5a8bd86494f579264017c7023ffce744d6427e8cf8eab26cf4921b89f25` |

All four lists render the same HUB service. The Monitor, Public Share, and
S5.11 UI overlays therefore do not change the rendered HUB, and the base file
alone is the HUB's model. This agrees with the running HUB's single-file label.
The repository copies of the S5.4 and S5.5 overlays, which are byte-identical
to the live files, name no `hub` service (AGENT-VERIFIED (REPO)).

### 5.4 Decision

```text
K7_CURRENT_HUB_MODEL        = /opt/aegis/runtime/docker-compose.production.yml
K7_PHASE2A_HUB_COMPOSE_LIST = 1. /opt/aegis/runtime/docker-compose.production.yml
                              2. /opt/aegis/runtime/idea3/idea3-phase2.yml
K7_MONITOR_OVERLAY          = NOT_INCLUDED
K7_PUBLIC_SHARE_OVERLAYS    = NOT_INCLUDED_FOR_HUB_RECREATE
K7_ROLLBACK_OWNER           = kraveerachat
```

- The Phase 2A list is the current HUB model followed by the future IDEA3
  overlay (Phase 2 design §4.8). That overlay file does not exist on Production
  yet. With it, the rendered HUB differs by design: the overlay adds the
  `aegis_idea3_internal` membership.
- **The overlays stay service-scoped.** They are not globally unnecessary. The
  Monitor, Public Share, and S5.11 UI overlays remain in the Compose lists of
  the Monitor, Drive, Public Share Gateway, and Public Share Connector
  services. Every operation on those services keeps using that service's own
  recorded list. K7 leaves them out only of HUB recreation, where they render
  no difference.
- Phase 2 design §6.2 and §6.3 still use the four-file `F4` and five-file `F5`
  lists. A later IDEA3 task aligns them with these values before any Phase 2A
  step. This package does not edit the design. Because all four lists in §5.3
  render the same HUB, the design's `F4` rollback and a base-only rollback
  recreate the same HUB service.

### 5.5 K7 limitations

- **Running-container equality is NOT PROVEN.** The evidence does not include
  the running HUB's `com.docker.compose.config-hash` label. It proves that the
  overlays do not change the rendered HUB. It does not prove that the base
  file, as it is now, renders the HUB container that is running. Before any
  Phase 2A mutation, the owner compares the base-only rendered `hub` hash with
  that label. If they differ, IDEA3 stops and Kla reconciles the base file
  first.
- **Base-file provenance is NOT PROVEN.** The live base file measured
  `5aae5cd7ded537f9124d2af8733d076f177871e0d3757208bf0c4a61fc635193` in IDEA1's
  frozen S5.1 baseline (2026-09-09), and `61528b86…` in P2-E1 (2026-09-15) and
  K7-E2 (2026-09-16). The Production checkout `/opt/aegis/Project-End-The-AEGIS`
  (HEAD `2806373bb300728a0babb953a63f98bcd714ffef`) does not contain
  `docker-compose.production.yml`. No record identifies the change between the
  two values. `5aae5cd7…` stays frozen historical evidence; `61528b86…` is the
  current owner-run measurement. This limitation does not affect the §5.3
  equivalence, which was measured against the current file.
- **The HUB identity capture is still missing.** The HUB's image, restart
  policy, mounts, and networks (the first P2-E1 K7 line) are not recorded, so
  P2-E1 stays PARTIAL_COMPLETE. Phase 2A step 1 captures them.
- **The rendering command was not restated.** The report gives the hashes but
  not the exact command flags, such as the env file.

## 6. K8, K9, K10, and K12 — unchanged, not decided here

- **K8 = BLOCKED.** The Core is not on VLAN 20, and Core/VLAN 20 → HUB:443 is
  untested.
- **K9 = BLOCKED.** It needs the `idea3-core.aegis.internal` name and a server
  certificate with that SAN.
- **K10 = BLOCKED.** It needs the dedicated IDEA3 machine-client CA, its CRL,
  and a Core client certificate.
- **K12 = NOT_PROVEN.** It is verified at the next planned reboot.

Nothing is generated, installed, or implemented.

## 7. What Kla's approval does and does not do

Approval accepts K1, K3, and K7 exactly as written above. It does not:

- authorize any Production mutation (`PRODUCTION_MUTATION_AUTHORIZED` stays
  `NO`);
- perform the K1 reconciliation, or change either NGINX artifact;
- open or schedule a Phase 2 window;
- accept IR-1 through IR-6;
- decide K8, K9, K10, or K12;
- replace Music's Production authorization;
- change the Phase 2 design, HUB, infrastructure, IDEA1, IDEA2, shared, or
  `.github` files, or any historical receipt.

## 8. After acceptance

Each step is a separate task with its own owner and review:

1. **Kla** makes the K1 reconciliation integration change for
   `HUB-AEGIS_Entry/nginx.conf`, with `nginx -t`, and re-bases IR-1 on it.
2. **IDEA3** aligns Phase 2 design §6.2 and §6.3 and IR-5 with the K7 lists. It
   adds these pre-mutation stops:
   - the running-HUB `config-hash` comparison (§5.5);
   - the IDEA1 window recheck (§4).

   It also records Kla's acceptance in `idea3-status.md`.
3. **The owner** captures the HUB identity read-only in Phase 2A step 1.
4. **The remaining P2-A blockers stay:**
   - IR-1, IR-3, IR-4, and IR-5 acceptance;
   - the K4 recheck before network creation;
   - Music's Production authorization.
