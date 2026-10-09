# AEGIS IDEA3 — Governed dnsmasq Unit Boot-Order Live Repair Package (post-PR #305)

Date: 2026-10-03 (Asia/Bangkok). Owner: music. Status: **repository implementation only. Live execution NOT authorized, NOT executed.**

```text
PACKAGE_NAME                     = dnsmasq-unit-boot-order-repair   (task-specific; NOT an L-stage, NOT a V-retry, no new L-number)
BASE_MAIN                        = 1579712866ef0e83c5b949b0afed7a7969e0f80f   (origin/main when this package was written; the runner is pinned to the MERGE commit of this PR)
PR305_MERGE                      = 827251f2478f03822c42ab43eadb50f73005d432   (an ancestor of BASE_MAIN; checked, not assumed)
PR305_REPOSITORY_FIX=MERGED
LIVE_REPAIR_EXECUTED=NO
REBOOT_VERIFICATION_EXECUTED=NO
K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN
L8P_LIVE_EXECUTED=NO
RECOVERY_R1_R8=NOT_RUN
LVR=NOT_RUN
L8=NOT_RUN
ESP32_TOUCHED=NO
AUTHORIZATION_L4 / K3_L4         = NOT CREATED   (no authorization or K3 record is created or reused by this task)
PRODUCTION_MUTATION              = NO            (this document and its implementation)
```

## 0. Why this package exists

PR #305 fixed the canonical `deploy/network/aegis-idea3-dnsmasq.service.example` in the repository: a bounded, read-only AP-readiness gate (`ExecStartPre`)
makes dnsmasq wait for the exact approved interface, IPv4/prefix, AP mode and channel instead of burning its five starts in one second and hitting
`start-limit-hit` at boot. It also changed `l34_dnsmasq_unit_gate` so the L34 authority is "the canonical template rendered with the fixed approved values".

The live host still has the OLD pre-PR305 unit (the exact text `stages/L4/apply.sh` used to print; sha256 `a684746d…10036`). The corrected authority therefore
REFUSES it, so every L34/V5–V8 reactivation is refused until the repaired unit is installed and qualified. The AP itself is up (`wlp0s20f3` AP, SSID
`AEGIS-IDEA3`, channel 6, `10.77.30.1/28`); only dnsmasq's unit is stale. This package is that qualified installation, and nothing more.

## 1. Existing governance, discovered first

| Existing mechanism | Why it cannot do ONLY this repair |
|---|---|
| `stages/L4/apply.sh` | Renders the whole AP network (config, dnsmasq conf, profile IPv4, NetworkManager reload/up). Far wider than one unit file; L4 live acceptance is historical and consumed. |
| `reactivation/l34` (V1–V3) | Requires the radio-disabled/AP-down baseline and the unit to ALREADY match the authority. |
| V4, V5, V6, V7 | Each assumes a different broker/AP/radio baseline and requires the unit to already match the authority; V7 is historical and one-shot. |
| V8 (`l34-v8-post-v7-persistent-ap-recovery`) | Radio-disabled/AP-down/broker-churn baseline; refuses the old unit at its own `l34_dnsmasq_unit_gate`; its live PASS is historical and immutable. Replaying it is forbidden. |
| `p4-stage-gate.sh` | Reused (necessary, never sufficient) — but it only knows L0…L9, so the authorization/K3 records carry `stage=L4` and the exact scope string below is what binds them to this repair. No L-number is invented. |

No current governed mechanism performs only this repair, so a task-specific package follows the existing repository conventions (owner-run frozen runner, one-shot
marker, PRE → APPLY → VERIFY → POST → exact compare → journal-owned rollback, immutable evidence directory). Unchanged and reused read-only: `p4-l34-reactivation-lib.sh`,
`p4-l34-v8-lib.sh` (profile record only), `p4-stage-gate.sh`, `p4-lib.sh`, `p4-l0-capture.sh`, `p4-compare.sh`, `stages/L4`, the canonical template, every V1–V8 handler,
runner and allow file. All are pinned byte-for-byte by `test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope.py`.

## 2. New files (nothing historical edited)

```text
deploy/pr11-phase4/p4-dnsmasq-repair-lib.sh
deploy/pr11-phase4/reactivation/dnsmasq-unit-boot-order-repair/{apply,verify,rollback,reboot-verify}.sh
deploy/pr11-phase4/reactivation/dnsmasq-unit-boot-order-repair/{allow-keys,allow-keys-rollback,allow-listeners}.txt
deploy/pr11-phase4/reactivation/dnsmasq-unit-boot-order-repair/allow-dynamic-transitions-failed-{post,rollback}.txt
deploy/pr11-phase4/owner-run/run-dnsmasq-unit-boot-order-repair-owner.sh
deploy/pr11-phase4/owner-run/verify-dnsmasq-boot-order-after-reboot.sh
tests/dnsmasq_repair_sim.py   tests/test_pr11_phase4_dnsmasq_unit_repair*.py
```

## 3. The live mutation scope (the whole of it)

When — in a future, separately authorized run — `apply.sh` mutates, it does exactly, in order, journaling each step BEFORE making it:

1. back up the installed old unit (digest-checked) into the evidence directory;
2. atomically install (same-directory temp + `mv -T`, mode 0644) the canonical template RENDERED by `l34_render_dnsmasq_unit` with the fixed approved values
   (`wlp0s20f3`, `10.77.30.1`, `28`, `6`) — there is no second copy of the unit text anywhere in this package;
3. `systemctl daemon-reload`;
4. baseline FAILED (failed / `start-limit-hit` / MainPID 0): `systemctl reset-failed aegis-idea3-dnsmasq.service`, then `systemctl start aegis-idea3-dnsmasq.service`;
   baseline RUNNING (active/running under the old unit): one `systemctl restart aegis-idea3-dnsmasq.service`;
5. bounded read-only wait for active/running, the exact three dnsmasq listeners, and proof that nothing else moved.

It never touches the AP interface, NetworkManager or its profile (SSID, channel, IPv4/prefix), the DHCP pool or DNS mapping, nftables or forwarding, the broker,
Twingate, Core, Recovery, the F1 detector, L8p, any ESP32, serial port, firmware, NVS, or relay/CUT/RESTORE. Static tests pin the exact command set
(`systemctl` mutating verbs only against `aegis-idea3-dnsmasq.service`, plus `daemon-reload`; the single file writer is `dnsrepair_install_unit`).

## 4. Pre-live fail-closed gates (all read-only, all repeated inside the root handler)

Runner (normal user, `sudo -v`): exact pinned main (`HEAD == EXPECTED_MAIN`, clean worktree, `origin/main == EXPECTED_MAIN`, never silently re-pinned), PR #305 merge is an
ancestor, same-day `stage=L4` authorization with the exact scope string and same-day K3 (`p4-stage-gate.sh --mode live`), no own or foreign attempt marker, required
commands present, disk < 90 %, engine/tunnel/Twingate/legacy mosquitto/Core/broker active.

Handler preflight (root; writes only into the evidence directory): the accepted persistent AP profile, dnsmasq config (+ `dnsmasq --test`), nft file and broker config are intact;
the AP is exactly the approved one (AP mode, SSID `AEGIS-IDEA3`, channel 6, `10.77.30.1/28`, no default route, served by the approved profile, no other Wi-Fi active);
the installed unit is the OLD refused authority — a regular 0644 file whose sha256 equals the recorded pre-PR305 digest (already-canonical, any local edit, the raw
placeholder template or a symlink are refused, never overwritten); the canonical template renders without any unresolved placeholder into a unit the corrected L34
authority accepts and `systemd-analyze verify` parses; no unit `daemon-reload` would re-read (dnsmasq, broker, Core, Twingate, legacy mosquitto) has a pending
unreviewed on-disk change; the dnsmasq baseline is exactly FAILED (no DNS/DHCP listener) or RUNNING (exact three listeners); Core healthy; broker active with its exact
8883 pair and a stable tuple (4 × 5 s); forwarding all zero; no NAT; the L2 nft table intact; Twingate is only observed. No ESP32 or serial access exists in any script.

## 5. Governance model

- **Authorization / K3:** fresh same-day records created by the owner for THIS run only — `authorization-L4.txt` (`stage=L4`, `authorizer=music`, scope exactly
  `DNSMASQ_UNIT_BOOT_ORDER_REPAIR: install canonical rendered dnsmasq unit, daemon-reload, dnsmasq reset-failed/start or restart only; no AP, network, broker, Core or ESP32 change`,
  ≤ 200 printable ASCII) and `k3-L4.txt` (V1 independent or V2 owner self-attestation, exactly as `p4-stage-gate.sh` defines). `stage=L4` is the nearest existing gate stage for the AP/dnsmasq network
  layer; it is not an L4 acceptance claim, and V7/V8/L34 scopes do not satisfy this runner. A historical or widened scope is refused.
- **Exact-main frozen runner:** `owner-run/run-dnsmasq-unit-boot-order-repair-owner.sh` is inert as committed (`EXPECTED_MAIN=PIN_MAIN_SHA` → exit 2). The owner freeze
  workflow copies it outside the repository, pins the merged SHA, records its SHA-256, and only then authorizes a run. This task does not do that.
- **One-shot attempt marker:** `DNSMASQ-UNIT-REPAIR-ATTEMPT-CONSUMED` in the authorization directory, created with `noclobber` only AFTER the handler preflight and the PRE
  capture succeeded, immediately before the first mutation. A refused preflight or failed PRE capture leaves the authorization usable; after consumption (even on failure) there is **no
  automatic retry** and a replay is refused before any work. An authorization directory carrying ANY other run's `*ATTEMPT-CONSUMED*` marker (V7, V8, L34, …) is refused.
- **Evidence:** `$EVID` = `…/idea3-p4-evidence/<date>-dnsmasq-unit-repair-<stamp>/` (0700): copies of the records, `frozen-inputs.txt` (main, PR305, runner SHA-256, non-claims),
  `owner-run.log`, handler work directories (journal, unit backup, tuples, snapshots), `pre-root`/`post-root`/`rb-root` L0 captures with `SHA256SUMS`, `compare-pre-post.txt`,
  `compare-pre-rb.txt`, and `terminal-verdict.txt`.
- **Comparator exactness:** `p4-compare.sh` (unchanged) runs PRE → POST with `allow-keys.txt`: exactly the dnsmasq service's own `MainPID`, `NRestarts` and
  `ExecMainStartTimestamp`; the three new dnsmasq listeners; and, FAILED baseline only, exact members of the existing `L34_RUNTIME_REACTIVATION` catalog
  (`failed → active`, `failed → running`, `start-limit-hit → success`). Every AP, profile, configuration, nftables, rfkill, broker, Core or other-service key is drift. The
  dnsmasq unit file is not part of the L0 capture; its exact bytes are proven by the handlers (corrected L34 authority).
- **Verify (must all hold):** `DNSMASQ_REPAIR_APPLIED=YES`, `DNSMASQ_UNIT_AUTHORITY=PASS`, `DNSMASQ_ACTIVE=YES`, `DNSMASQ_RUNNING=YES`, `DNSMASQ_START_LIMIT_HIT=NO`, `AP_MODE=PASS`,
  `AP_SSID=PASS`, `AP_CHANNEL=PASS`, `AP_IPV4_PREFIX=PASS`, `CORE_HEALTH=PASS`, `BROKER_UNCHANGED=PASS`, `FORWARDING_POLICY=PASS`, `UNEXPECTED_DRIFT=NONE` (only after the
  comparator passed), `ESP32_TOUCHED=NO`. The terminal verdict is exactly one of `PASS`, `ROLLED_BACK`, `ROLLBACK_FAILED_ESCALATE`, `NOT_STARTED_NO_MUTATION`.
  A run claims no reboot persistence.

## 6. Rollback model

`rollback.sh` is journal-owned and idempotent; ownership that cannot be proven from the journal (unknown kind, a value that is not the exact unit/digest) fails closed and
escalates (`exit 3`, S-11 hold, no retry).

- **Failure before the unit replacement** (no `UNIT_INSTALL` journaled, including after the backup): nothing is restored, reloaded, reset or stopped — it only proves the unit is
  still the old one, dnsmasq is exactly as before, and nothing else moved.
- **Failure after the unit replacement:** the digest-checked backup is restored byte-for-byte (atomic rename), then `daemon-reload`. FAILED baseline and dnsmasq was reset/started:
  `systemctl stop` the exact unit (safe stopped state; the stale `start-limit-hit` artifact is never recreated, nothing is started). RUNNING baseline: only if dnsmasq is no longer
  active/running, `reset-failed` (when failed) and one `restart` under the restored old unit; a running dnsmasq is left alone.
- After rollback: the unit equals the old one, no pending `NeedDaemonReload`, persistent files, AP, L2, forwarding and every Core/broker/legacy identity are proven unchanged, then
  the runner takes an RB capture and `PRE → RB` must pass the rollback catalogs.

## 7. Separate reboot verification (not part of the repair run)

`owner-run/verify-dnsmasq-boot-order-after-reboot.sh` (same freeze/pin model) wraps the strictly read-only `reboot-verify.sh`. It never reboots, never starts/stops/reloads anything.

1. After a **PASSED** repair run: `record <REBOOT_DIR> <REPAIR_EVIDENCE_DIR> <WRITTEN_REBOOT_APPROVAL_REFERENCE>` — proves the repair verdict was `PASS`, the host is in the repaired good state (canonical unit
   loaded, AP exact and its profile autoconnecting, dnsmasq active, Core/broker healthy, forwarding zero, L2 intact), and records the boot id, the approval reference and a persistent-file snapshot.
2. The owner performs **one orderly reboot** (not done by any script here) and does not touch the AP, NetworkManager or dnsmasq afterwards.
3. `verify <REBOOT_DIR> [--attest-no-manual-intervention]` — proves the boot id changed; after a bounded read-only convergence wait, that the AP came back with the exact mode/SSID/channel/IPv4,
   dnsmasq is active/running with the canonical unit loaded, has no start-limit hit, **zero** unknown-interface / bind-failure / start-limit journal lines this boot and a bounded restart count
   (`DNSMASQ_WAITED_FOR_AP=OBSERVED`, or `OBSERVED_WITH_BOUNDED_RETRIES` when < 5 retries), Core and the broker are healthy, forwarding is zero, L2 is intact and no persistent file drifted across the reboot.
   Drift is reported as `UNEXPECTED_DRIFT=NONE_OBSERVED_IN_CHECKED_SCOPE`; it is not a comparator result.

It records **`K12_PERSISTENCE_OBSERVED`** (YES only when every check passed, the host converged, and the owner attested no manual intervention after boot) and, separately,
**`K12_FORMALLY_PROVEN=NO`** — always. The repository holds no canonical K12 acceptance contract that would let a script conclude formal proof, so `K12_AUTOMATIC_REBOOT_PERSISTENCE` stays
`NOT_PROVEN` until the owner/integration reviewer records the acceptance decision.

## 8. Tests (written first, RED, then GREEN)

`test_pr11_phase4_dnsmasq_unit_repair.py` (handlers: exact allowed mutation scope, preflight refusals for every gate, exact unit installation, only dnsmasq daemon-reload/reset-failed/start/restart/stop,
no Core/broker/network/ESP32 command, rollback before/after the replacement, idempotence), `…_owner_run_flow.py` (wrong main, moved origin, dirty tree, PR305 not an ancestor, stale Auth/K3, wrong stage/scope,
consumed or foreign marker, consume ordering, rollback, escalation, no retry), `…_reboot_and_scope.py` (real-comparator exactness, separate read-only reboot procedure, K12 observed vs formally proven, byte-identity pins for
every reused file and historical receipt, exact file set, no invented L-number, real stage gate, receipt and status statements). The PR #305 / L34 overlap suites are re-run.

## 9. What this does not do

No live run, authorization, K3, frozen runner, marker, evidence directory or reboot exists. `LIVE_REPAIR_EXECUTED=NO`, `REBOOT_VERIFICATION_EXECUTED=NO`, `K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN`,
`L8P_LIVE_EXECUTED=NO`, `RECOVERY_R1_R8=NOT_RUN`, `LVR=NOT_RUN`, `L8=NOT_RUN`, `ESP32_TOUCHED=NO`. After a PASSED repair, L34 reactivation is still not run and needs its own fresh authorization.
IMPLEMENTED != DEPLOYED.

## 10. Known limitations (honest)

- Simulated-host proof only. The real comparator was exercised on synthetic captures built from the key families V8's live run produced; a live PRE/POST that records an unforeseen dnsmasq key would fail the compare
  and trigger the (tested) rollback — fail-secure, not silent.
- The first live `systemd-analyze verify` and `daemon-reload` are untested on the real host; `NeedDaemonReload` is gated for the five relevant units before and after.
- `stage=L4` in the records is a gate-name compromise (documented above), not a claim.
- A failed same-directory rename could leave `aegis-idea3-dnsmasq.service.aegis-repair-new` beside the unit (systemd ignores the suffix; the next preflight refuses until the owner inspects it).
