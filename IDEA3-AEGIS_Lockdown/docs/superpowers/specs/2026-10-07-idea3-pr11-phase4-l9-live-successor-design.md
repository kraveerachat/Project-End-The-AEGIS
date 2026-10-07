# IDEA3 PR11 Phase 4 L9 — Live-Capable Governed Successor (read-only observation)

Date: 2026-10-07
Owner: Music (Kla integration review)
Branch: `feat/idea3-l9-governed-live-successor` (STACKED — DO NOT MERGE until its dependencies merge)
Status: REPOSITORY IMPLEMENTATION — `L9_LIVE_EXECUTED=NO`, `L8_LIVE_EXECUTED=NO`, `PRODUCTION_MUTATION=NO`
Amends: `2026-09-21-idea3-pr11-phase4-l9-operational-design.md` (OD-L9-01, OD-L9-08; the rest is unchanged)

> [!IMPORTANT]
> This task implements and tests a live-capable L9 path. It does **not** run L8 or L9, consume any marker, restart
> the Core or Detector, touch the ESP32 or NTP, or create a LIVE receipt. `LIVE_STAGE_AUTHORIZED` stays `NO` in the
> stage gate; the only thing that can ever authorize a run is a fresh exact-main Authorization/K3, a frozen runner and
> a canonical L8 PASS.

## 1. What L9 actually is (derived from the merged design, not from the label)

```text
L9_PURPOSE=Observe that Protocol-v1 authentication works end to end between the real device and the real Core, with L9 itself doing nothing to the device (authentication without actuation; no COMMAND, no CUT, no RESTORE).
L9_REQUIRED_PREDECESSOR=a canonical L8 PASS (L8 provisioned and flashed the device and verified its signed BOOT STATUS), which in the registered order follows Recovery (CTu -> Recovery -> L8 -> L9).
L9_REQUIRED_RUNTIME_STATE=Core active/running with TrustedClock SYNCED, broker CONNECTED, device ONLINE, detector active; device already in the state L8/Recovery left it (L9 asserts it does not change).
L9_MUTATION_SCOPE=NONE (observation only: writes only its own stage-local evidence bundle and one root-owned attempt marker/closeout in the governance directory; zero host drift; no service, device, broker or network action).
L9_EXPECTED_FINAL_EVIDENCE=l9-live-evidence.json (class LIVE_CORE_OBSERVATION) + host closeout L9-GLOBAL-CLOSEOUT-PASS + one immutable receipt bound to exact Git history.
```

### OD-L9-01a — live mechanism (resolves the open question of OD-L9-01)

The original design left "an owner-run MQTT client using the Core identity, or a Core-side observation of the running
service" open. This task chooses **Core-side observation**, because the other option needs the Core's broker
credential and publishes frames (injection and heartbeats) into a live system. Observation uses only what the Core
already wrote itself:

| Evidence | Source | Why it is trustworthy |
|---|---|---|
| authenticated device STATUS | `protocol_seen_d2c` rows after the boundary | a row exists only after TRANSPORT, SCHEMA, AUTH, SKEW and REPLAY all passed in the Core |
| status reason / output state | `audit_logs` `DEVICE_STATUS` rows (`"<state> (<reason>)"`) | written per accepted STATUS by `MQTTManager` |
| zero COMMAND / CUT / RESTORE | `protocol_commands`, `protocol_sequence`, audit `COMMAND_SENT` | any command would change them |
| Core and detector health, no restart | `systemctl show` (verb `show` only), the Core's `status.json` via `/proc/<pid>/root` | root-owned runtime state |

Invariants (first violated one is the `failure_boundary`): Core `active/running/success`, same PID/invocation/
`NRestarts`; detector unchanged and `active/running`; `status.json` refreshed by that PID with `time_trust=SYNCED`,
`broker=CONNECTED`, `device=ONLINE` and `uplink` unchanged from PRE; window ≥ 120 s (two dead-man periods) and ≤ 900 s;
≥ 3 PERIODIC accepted STATUS rows with no gap above 45 s (firmware cadence 30 s plus margin); **zero** `DEADMAN`,
`BOOT`, `BOOT_GRACE`, `COMMAND`, `SEQUENCE_REJECTED` rows; one constant output state; zero new command rows, allocator
unchanged, zero `COMMAND_SENT`, zero correlation anomalies; open incident and open episode counts unchanged.

**Honest limits, recorded in every bundle and receipt.** (1) Negative probes (replay, wrong key, tamper, stale/future,
malformed) are **not injected live** (`negative_probes_injected_live=NO`, `negative_probe_coverage=REPOSITORY_FIXTURE_ONLY`);
their evidence remains the fixture exercise. (2) A heartbeat accepted by the device has no outward signal by design
(OD-L9-02), so its live evidence is indirect: no `DEADMAN` status over a window longer than two dead-man periods
(`heartbeat_acceptance_basis=NO_DEADMAN_OVER_WINDOW`). (3) The Core's `status.json` `uplink` value is recorded, not
dictated: L9 asserts it does not change, not what it is. Wider live injection would need a separate owner decision.

### OD-L9-08a — live rollback

L9 live changes nothing, so there is nothing to undo. `rollback.sh` in live mode is the idempotent no-op that keeps the
evidence and never stops the Core (`L9_LIVE_OBSERVATION_MUTATED_NOTHING=YES`). The original fail-secure hold
(stop the Core) was designed for a mutating probe and would itself be an unreviewed mutation here, so it is **not**
automated; it remains an owner decision if the device becomes unreachable.

## 2. L8 -> L9 mechanical gate (`p4-l9-gates.py l8-predecessor`)

The gate reads Git objects of the **pinned main** (replacement objects disabled), never the working tree. The L8 work
must emit **exactly** this closeout contract (this section is the cross-PR dependency):

One receipt whose name ends `_music_idea3-l8-live-closeout.md`, carrying each whole-line field exactly once:

- `L8_LIVE=CLOSED_PASS`
- `L8_LIVE_EXECUTED=YES`
- `L8_RESULT=PASS`
- `L8_ATTEMPT_CONSUMED=YES`
- `L8_RERUN_ALLOWED=NO`
- `L8_STAGE=L8`
- `L8_FAILURE_RESULT=NONE`
- `L9_LIVE_EXECUTED=NO`
- `L9_ATTEMPT_CONSUMED=NO`
- `L8_EXECUTION_MAIN=<40-hex commit L8 executed on>`
- `L8_EVIDENCE_CLASS=LIVE_<NAME>` (any `LIVE_*`; `REPOSITORY_FIXTURE` is refused)

Refused: L8 never executed; a repository-only receipt; an L8 FAIL (any L8-owned field with another value anywhere);
duplicate or split L8 evidence (an L8-owned field in a second receipt); a misnamed receipt; a receipt edited after its
introducing commit; any L9-owned result field already recorded (replay prevention). **Ancestry:** the closeout merge
moves main, so `L8_EXECUTION_MAIN` must be a **strict** ancestor of the pinned main and the closeout must not exist at
it. Unrelated historical fields (`L8_ACCEPTANCE=NO`, `L8P_*`, `L9_PROVEN=NO`, `L8=NOT_RUN`) are ignored.

## 3. Owner runner, freeze, Authorization, K3

`owner-run/run-l9-owner.sh` is an unpinned template that refuses to run. `p4-l9-freeze.py` derives the frozen runner
from the exact reviewed template Git object with only seven pin substitutions (`EXPECTED_MAIN`, `OPERATOR_USER`,
`OPERATOR_UID`, `DEVICE_ID`, `WINDOW_SECONDS`, `MERGED_MAIN_WORKTREE`, `EVIDENCE_ROOT`), exclusive creation, mode 0555,
root-owned chain to `/`, and — for a production freeze and every production verify — the L8 predecessor gate at that
main. The runner then: refuses test seams and caller environment; proves HEAD == origin main == pin and a clean tree;
re-verifies the frozen runner and the L8 predecessor; requires an Authorization with **exactly** the five base fields
(`stage=L9`, today, `authorizer=music`, `scope`, `reference`; no other stage's extra field) whose `scope` contains the
whole tokens `main=<sha>`, `runner=<sha256>` and `l8=<sha>`; requires a V1/V2 K3 for `stage=L9` today and runs the stage
gate; checks the marker is unconsumed and sudo is non-interactive; builds a root-owned byte-exact bundle (every file
equal to its exact-main object, verified before anything is installed); PRE capture; **consumes the one-shot marker**
(with the PRE boundary taken from the Core's own sources); observation; POST capture; zero-drift preservation (S10);
secret scan; stage verify; host closeout. Every failure after consumption is terminal (`FAIL_IMMUTABLE`, never rerun).

## 4. Final closeout contract

Host: `L9-GLOBAL-CLOSEOUT-PASS` (root-owned, exact key set, written only after verify, preservation and secret scan).
Repository: one immutable receipt `..._music_idea3-l9-live-closeout.md` whose fields are `gates.L9_CONTRACT` plus
`L9_EXECUTION_MAIN`, `L8_EXECUTION_MAIN`, `L9_EVIDENCE_BUNDLE_SHA256`
(template: `deploy/pr11-phase4/templates/l9-live-closeout-receipt.template.md`, which is not a receipt and must never be
placed under `90-Status/logs`). `p4-l9-gates.py final-closeout` accepts only: one unique receipt, introduced by exactly
one commit, `L9_EXECUTION_MAIN` a strict ancestor, the same L8 closeout evaluated at that main, and no contradictory L9
record anywhere. Claim vocabulary: `LIVE_CORE_OBSERVATION`, `NO_DEADMAN_OVER_WINDOW`, `REPOSITORY_FIXTURE_ONLY`.
Final project acceptance beyond these facts (a physical CUT/RESTORE test, L10+) is outside L9 and is not claimed.

## 5. Dependencies and status

```text
PR #375 (CTu)  ->  LVR work  ->  L8 work  ->  this L9 work
STACK_BASE=74b3295909e2c679f763c87d1680d6d0bf29d2dc   (PR #375 head at branch creation)
L9_REPOSITORY_IMPLEMENTED=YES   L9_LIVE_EXECUTED=NO   L8_LIVE_EXECUTED=NO   PRODUCTION_MUTATION=NO
LIVE_STAGE_AUTHORIZED=NO        PR375_MODIFIED=NO     MERGE=HUMAN_ONLY
```

The L8 closeout field names in §2 must be reconciled with the L8 work before this PR is retargeted at `main`.
