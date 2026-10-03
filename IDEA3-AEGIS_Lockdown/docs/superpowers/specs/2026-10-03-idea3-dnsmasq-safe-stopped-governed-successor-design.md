# IDEA3 — dnsmasq repair: SAFE_STOPPED governed successor and pre-consume S10 guard (design amendment)

Date: 2026-10-03 · Owner: music · Status: **repository implementation only — nothing executed live**
Amends: `2026-10-03-idea3-dnsmasq-unit-boot-order-governed-repair-design.md` (PR #308). That document stays as written.

## 1. What happened (historical, immutable)

The first governed live attempt of the `dnsmasq-unit-boot-order-repair` package was **consumed** and must never be replayed.

| Fact | Value |
| --- | --- |
| `FIRST_ATTEMPT` | `CONSUMED_FAILED_S10` |
| `DNSMASQ_APPLY_VERIFY_IN_FIRST_ATTEMPT` | `PASS` (`DNSMASQ_REPAIR_APPLY=PASS`, `DNSMASQ_REPAIR_VERIFY=PASS`, unit authority PASS, dnsmasq active/running, no start-limit-hit, Core health PASS, broker unchanged PASS, ESP32 not touched) |
| Failure point | the PRE→POST S10 comparator: IDEA2 was **already unhealthy before the mutation** (`tunnel_healthy=NO`, `runtime_healthy=NO`, `127.0.0.1:18002` absent) |
| `FIRST_ATTEMPT_ROLLBACK_HANDLER` | `PASS` (`DNSMASQ_REPAIR_ROLLBACK=PASS`, `SAFE_STATE_RESTORED=YES`, `UNIT_RESTORED=YES`, AP / broker / Core / ESP32 untouched) |
| `FIRST_ATTEMPT_FINAL_VERDICT` | `ROLLBACK_FAILED_ESCALATE` — the final PRE→RB comparator failed only because the same IDEA2 unhealthy baseline persisted |
| `ROOT_CAUSE` | `IDEA2_TUNNEL_RESOURCE_AUTH_SESSION_NOT_ACTIVE` — the Twingate daemon was active, but the interactive Twingate **Resource authorization** was not active; after the owner ran `twingate start` the existing IDEA2 `Restart=always` tunnel recovered by itself |
| `S10_RECOVERY_PROOF` | `PASS` — fresh read-only evidence (local, not committed): `FINDINGS_NEW_OR_WORSENED_DRIFT=0`, `FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0`, `FINDINGS_INCOMPARABLE=0`, `PRESERVATION_S10=PASS`, `COMPARE_RESULT=PASS` |
| `SAFE_STOPPED_BASELINE` | `OBSERVED` — dnsmasq `loaded / enabled / inactive / dead / Result=success / MainPID=0`, produced by the governed rollback |

Local evidence (raw, private, **not committed**): first attempt `…/idea3-p4-evidence/2026-10-03-dnsmasq-unit-repair-20261003-032626`; recovery `…/idea3-p4-evidence/2026-10-03-s10-recovery-20261003-034414`.

The evidence proves only that the Twingate user/Resource authorization path was restored by `twingate start`. It does **not** show a Twingate daemon defect or a remote Connector defect, and none is claimed.

## 2. Governed-successor model (`OLD_ATTEMPT_RETRY_ALLOWED=NO`)

A successor is a **new one-shot governed attempt**, not an automatic retry and not a replay. It may exist only when **all** hold:

1. the root cause of the failed attempt is understood;
2. the host is restored to an explicitly accepted baseline;
3. fresh read-only S10 proof passes;
4. the successor implementation (this PR) is merged;
5. a **new** exact-main runner is frozen from that merge;
6. a **brand-new** same-day AUTH_DIR / Authorization / K3 exists;
7. the owner explicitly authorizes **one** successor attempt.

The first attempt's AUTH_DIR, Authorization, K3, marker, frozen runner and evidence directory are never reused. The runner enforces this twice: any AUTH_DIR already carrying `DNSMASQ-UNIT-REPAIR-ATTEMPT-CONSUMED` (or any other governed run's marker) is refused, and the historical consumed AUTH_DIR path is on a hard denylist (`DNSREPAIR_HISTORICAL_CONSUMED_AUTH_DIRS`) so it is refused even if its marker were lost. This PR creates no Authorization, no K3, no frozen runner and no marker.

## 3. SAFE_STOPPED baseline

`dnsrepair_baseline_classify` admits a third baseline, `SAFE_STOPPED`, **only** for exactly:

```text
LoadState=loaded  UnitFileState=enabled  ActiveState=inactive  SubState=dead  Result=success  MainPID=0
```

plus the existing exact OLD pre-PR305 unit digest, no dnsmasq DNS/DHCP listener on the AP (`l34_v6_no_ap_dns_dhcp_gate`, as for FAILED), no pending `daemon-reload`, the exact approved AP and every existing profile / L2 / forwarding / Core / broker / persistent gate. Every other inactive shape (wrong `Result`, `UnitFileState`, `LoadState`, `SubState`, non-zero `MainPID`) and every other `ActiveState` still refuses. FAILED and RUNNING are unchanged.

## 4. Apply and rollback semantics

| Baseline | Mutation sequence (plus only the owned unit-file install) |
| --- | --- |
| FAILED (unchanged) | `daemon-reload` → `reset-failed` → `start` |
| RUNNING (unchanged) | `daemon-reload` → `restart` |
| **SAFE_STOPPED** | `daemon-reload` → `start aegis-idea3-dnsmasq.service` — **no** `reset-failed` (Result is already success), **no** `restart` |

Rollback of a SAFE_STOPPED attempt stays journal-owned and fail-closed: restore the digest-proven old unit bytes, `daemon-reload`, and `stop` only `aegis-idea3-dnsmasq.service` **if this attempt journaled its `start`**, then prove the exact SAFE_STOPPED state (`inactive/dead/success/MainPID 0`). It never manufactures a start-limit-hit and never touches the AP, NetworkManager, nftables, forwarding, Core, broker, Twingate, IDEA2 or any ESP32.

## 5. Comparator window

A new, task-specific `p4-compare.sh` dynamic operation **`DNSMASQ_SAFE_STOPPED_POST`** (PRE→POST only) with exactly two members:

```text
svc.aegis-idea3-dnsmasq.service.ActiveState inactive active
svc.aegis-idea3-dnsmasq.service.SubState    dead     running
```

`Result success → success` is unchanged and needs no rule. No existing catalog (`L34_RUNTIME_REACTIVATION*`, V3) was changed, and `allow-keys*.txt` still approve only dnsmasq's own `MainPID` / `NRestarts` / `ExecMainStartTimestamp`. The SAFE_STOPPED PRE→RB state is identical to PRE (inactive/dead/success), so rollback needs **no** dynamic window. The operation file is `allow-dynamic-transitions-safe-stopped-post.txt`. `p4-compare.sh` is therefore intentionally re-pinned in the three tests that pin it (additive catalog only).

## 6. Pre-consume S10 stability guard

The first attempt's handler preflight only checked that the IDEA2 *units* were active/running; the SSH tunnel unit can be active while restart-looping with `:18002` absent. The runner now runs, **after** the handler preflight and the PRE capture and **before** the attempt marker is created:

1. wait a frozen window (`S10_WINDOW_SEC=30`, no operator knob);
2. take a second fresh read-only capture with the canonical `p4-l0-capture.sh` (label `s10`);
3. compare PRE→S10 with the canonical `p4-compare.sh` and **no allowance file of any kind**;
4. require exactly `FINDINGS_NEW_OR_WORSENED_DRIFT=0`, `FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0`, `FINDINGS_INCOMPARABLE=0`, `PRESERVATION_S10=PASS`, `COMPARE_RESULT=PASS`.

Any failure ends with `NOT_STARTED_NO_MUTATION`: **no marker, no Production mutation, the authorization stays unconsumed.** An unhealthy IDEA2 baseline (reported as baseline-unhealthy-but-unchanged) is therefore caught before consumption. The guard does not demand `runtime_healthy=YES` itself; it demands that the canonical S10 contract and comparator pass. The marker is still created exactly once, immediately before the first mutation, after the guard. There is no retry loop.

## 7. What this does not do

No LIVE Authorization or K3, no frozen runner, no marker, no evidence directory, no `dnsmasq` start/stop/restart/reset-failed, no real `daemon-reload`, no NetworkManager / AP / nftables / forwarding change, no Core / broker / Twingate / IDEA2 restart, no Recovery / L8p, no ESP32 / serial / firmware / NVS / relay, no reboot. `SUCCESSOR_IMPLEMENTATION=REPOSITORY_ONLY`, `SUCCESSOR_LIVE_EXECUTED=NO`. `K12_AUTOMATIC_REBOOT_PERSISTENCE` stays `NOT_PROVEN`.
