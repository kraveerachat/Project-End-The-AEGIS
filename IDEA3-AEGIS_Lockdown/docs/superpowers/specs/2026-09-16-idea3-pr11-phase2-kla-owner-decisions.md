# AEGIS IDEA3 PR11 — Phase 2 Kla Owner Decision Record (K1, K3, K7)

> **Status:** documentation only. This record exists only to obtain Kla's
> formal GitHub owner decision on K1, K3, and K7. PR #136 requested these
> decisions but merged without them. This record adds no evidence. It performs
> no Production mutation, and approving it authorizes none.

```text
SOURCE_EVIDENCE_PR             = 136
SOURCE_EVIDENCE_MERGED         = YES (human merge at 1dc786353dd4dcea0a5959a926667470dd394ffe, 2026-09-15T16:46:47Z)
K1_OWNER_DECISION              = PENDING_KLA
K3_OWNER_DECISION              = PENDING_KLA
K7_OWNER_DECISION              = PENDING_KLA
K8                             = BLOCKED
K9                             = BLOCKED
K10                            = BLOCKED
K12                            = NOT_PROVEN
PHASE2_RUNTIME_COMPLETE        = NO
PHASE3_RUNTIME_COMPLETE        = NO
PHASE4_RUNTIME_COMPLETE        = NO
PRODUCTION_MUTATION_AUTHORIZED = NO
IDEA3_PRODUCTION_DEPLOYED      = NO
```

## 1. Source evidence (referenced, not repeated)

- **Evidence package:**
  `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-15-idea3-pr11-phase2-live-evidence-reconciliation.md`.
  Its §3 has the evidence and its §5 has the original decision request.
- **Evidence receipt:**
  `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-15_223136_music_idea3-pr11-phase2-live-evidence-reconciliation.md`.
  It is immutable, and this task does not edit it.
- **PR #136 review state at merge:**
  - Pub (`pubpup2006p-design`) APPROVED head `5bea776b`.
  - Kla (`kraveerachat`) was requested and submitted no review.
  - The K1, K3, and K7 answers were therefore never recorded. Pub's approval
    does not stand in for Kla's owner decision.

This record repeats only the K1 hash set, so the K1 choice can be read in one
place. Those server values are carried forward from PR #136, where they are
OWNER-RUN. They were not re-observed in this task.

## 2. How Kla answers

1. Submit one GitHub review on this PR as `kraveerachat`.
2. In the review body, write one line per decision, using the exact keys from
   §3, §4, and §5.
3. An APPROVED review certifies the decision lines in its body as Kla's owner
   decision. An APPROVED review with no decision line leaves that value
   `PENDING_KLA`. Approval alone does not choose an option.
4. `REQUEST_CHANGES` is a valid value for K1, K3, and K7. It needs a one-line
   explanation.
5. Kla's review is the authoritative decision record. The next IDEA3 task
   transcribes the answers into `idea3-status.md` and cites the review. Kla
   may instead ask for the answers to be transcribed on this branch before
   merge. The new head commit then needs Kla's approval again.

Only a review by `kraveerachat` satisfies this record. A review from any other
account, including Pub, does not.

## 3. K1 — reconciliation path for the live HUB NGINX artifact

Evidence: PR #136 package §3.1.

| Artifact | SHA-256 | Source |
|---|---|---|
| Running HUB container `/etc/nginx/conf.d/default.conf` | `16cee16232f5636eb11dd434d43ba42c6314d75a2b306265ee62032b84fb3722` | OWNER-RUN, carried forward from PR #136 |
| Host `/opt/aegis/runtime/nginx/nginx.production.conf` | `16cee16232f5636eb11dd434d43ba42c6314d75a2b306265ee62032b84fb3722` | OWNER-RUN, carried forward from PR #136 |
| Reviewed Git artifact `HUB-AEGIS_Entry/nginx.conf` | `ac70bfbaf2254b3a878924635e8c76cb97961f8c464ae1de3ba61325c94668c6` | AGENT-VERIFIED (REPO), re-checked at `1dc78635` in this task |

PR #136 proved a hash difference only. It did not take a content diff. Kla may
require a diff before either path starts.

| Option | Meaning | Follow-on (each separately owned and authorized) |
|---|---|---|
| `ACCEPT_LIVE_AS_NEW_CANONICAL_AND_RECONCILE_GIT` | The live artifact `16cee162…` becomes the reviewed baseline | A Kla-owned change brings `HUB-AEGIS_Entry/nginx.conf` to the live content, and IR-1 is re-based on it. There is no Production change for K1 itself |
| `RESTORE_LIVE_TO_REVIEWED_GIT_ARTIFACT` | The Git artifact `ac70bfba…` is restored to Production | A Kla-run, separately authorized Production window, with `nginx -t`, rollback, and the `/drive/` and `/monitor/` checks. It is never combined with the IDEA3 Phase 2A window |
| `REQUEST_CHANGES` | Neither, with an explanation | as Kla states |

```text
K1_OWNER_DECISION = ACCEPT_LIVE_AS_NEW_CANONICAL_AND_RECONCILE_GIT
                  | RESTORE_LIVE_TO_REVIEWED_GIT_ARTIFACT
                  | REQUEST_CHANGES: <explanation>
```

## 4. K3 — non-overlap of the future IDEA3 Phase 2 execution window

Evidence: PR #136 package §3.3. The Public Share baseline is PASS. The
non-overlap window is NOT_PROVEN, because repository silence is not a written
confirmation.

Kla is asked to confirm whether any IDEA1 (including S5.8) or other Production
verification or mutation window will overlap the future IDEA3 Phase 2 execution
window.

```text
K3_OWNER_DECISION = NON_OVERLAP_CONFIRMED
                  | WINDOW_CONFLICT: <which window>
                  | REQUEST_CHANGES: <explanation>
```

This is a scheduling decision for a future window only. `NON_OVERLAP_CONFIRMED`
does not open a window, fix a date, or authorize Production mutation. Any Phase 2
window still needs Music's Production authorization and the other P2-A
blockers listed in the PR #136 package §4.

## 5. K7 — canonical Production Compose model

Evidence: PR #136 package §3.4. The running HUB's Compose labels are:

- project: `aegis-prod`
- service: `hub`
- `config_files`: `/opt/aegis/runtime/docker-compose.production.yml` only

The Public Share connector service runs from four Compose files.

```text
K7_CANONICAL_HUB_COMPOSE_FILE_LIST = <ordered absolute paths for future IDEA3 Phase 2A>
K7_SINGLE_FILE_LABEL_EXPLANATION   = <why the running HUB label records only
                                      /opt/aegis/runtime/docker-compose.production.yml>
K7_MONITOR_OVERLAY_INCLUDED        = YES | NO
                                     (/opt/aegis/runtime/monitor-single-camera-ui-20260906-204814/compose.active.yml)
K7_ROLLBACK_OWNER                  = CONFIRMED kraveerachat | <other owner>
K7_OWNER_DECISION                  = CONFIRMED (all four lines above answered)
                                   | REQUEST_CHANGES: <explanation>
```

If the confirmed list differs from the Phase 2 design's `F4`/`F5` lists, a
later IDEA3 task must update Phase 2 design §6.2 and §6.3 before any Phase 2A
step. This record does not edit them. After the K7 answer, the owner re-runs the
missing P2-E1 K7 identity capture (image, restart policy, mounts, and networks)
as read-only evidence.

## 6. K8, K9, K10, and K12 — unchanged, not decided here

- **K8 = BLOCKED.** The Core is not on VLAN 20.
- **K9 = BLOCKED.** This is a later Phase 2B runtime/infrastructure
  prerequisite: the `idea3-core.aegis.internal` DNS record and a machine server
  certificate with that SAN.
- **K10 = BLOCKED.** This is a later Phase 2B/Phase 3 runtime/infrastructure
  prerequisite: the dedicated IDEA3 machine-client CA with its key held
  offline, the CRL, and a client certificate issued from a CSR generated on the
  Core.
- **K12 = NOT_PROVEN.** It is verified at the next planned reboot.

> **Forward reference (added 2026-09-16):** for future execution, the K10 CA key custody recorded here is superseded by `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-16-idea3-pr11-k10-server-held-ca-amendment.md` (server-held dedicated client CA), **subject to Kla review**. This record is unchanged and remains accurate for its date.

K9 and K10 remain exactly as the PR #136 package §5.4 lists them. This record
requests no decision on them, and nothing is generated, installed, or
implemented.

## 7. What Kla's approval does not do

- It does not authorize any Production mutation.
  `PRODUCTION_MUTATION_AUTHORIZED` stays `NO`.
- It does not execute K1 in either direction.
- It does not open or schedule a Phase 2 window.
- It does not accept IR-1 through IR-6.
- It does not decide K9 or K10.
- It does not replace Music's Production authorization.
- It does not change the Phase 2 design, the overlay, HUB, infrastructure,
  IDEA1, IDEA2, shared, or `.github` files, or the PR #136 receipt.
