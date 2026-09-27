# AEGIS IDEA3 PR11 Phase 4 — L6b Live Broker Operational Design

Date: 2026-09-27 (Asia/Bangkok). Owner: music. Status: **L6b live accepted (Attempt 2, 2026-09-27); see §13**. The flags below record the state when the design was written.

```text
L6B_LIVE_EXECUTED        = NO   (at design time; Attempt 1 failed, Attempt 2 PROVEN — see §13)
L6B_LIVE_AUTHORIZED      = NO   (at design time; both attempt authorizations are now CONSUMED)
PRODUCTION_MUTATION      = NO   (this document and its implementation)
L6A                      = COMPLETE / PROVEN (PR #221, immutable receipt)
PHASE4_RUNTIME_COMPLETE  = NO
PHASE4_LIVE_READINESS    = NOT READY  (predecessor runtime is not currently applied; see §7)
```

This document records the owner decisions OD-L6B-01 … OD-L6B-09 and the exact contract the repository now implements. It
extends, and does not replace, the merged T4/G-07 design
(`2026-09-19-idea3-pr11-phase4-t4-broker-migration-design.md`, §7 migration contract, §8 PF-01, §10 rollback) and the
Phase 4 runtime-prerequisites L6b section. Repository merge is **not** live acceptance and does not authorize L6b.

## 1. Owner decisions (binding, 2026-09-27)

| ID | Decision |
|---|---|
| OD-L6B-01 | `MATERIAL_STAGING_MODEL = STAGE_OWNED`. L6b apply installs its own Production broker material; rollback removes exactly that. There is **no** separate pre-PRE staging step. |
| OD-L6B-02 | `PLAINTEXT_PASSWORD_CUSTODY = TRANSIENT_JIT_ONLY`. `core.pass`/`device.pass` exist only in the private JIT input directory and are never installed. Only the hashed Mosquitto password database is persisted. |
| OD-L6B-03 | `PREDECESSOR_RUNTIME = FRESH_PROOF_THEN_REACTIVATE_ONLY_IF_REQUIRED`. Historical `LIVE_ACCEPTANCE=PROVEN` never implies currently applied runtime. |
| OD-L6B-04 / 05 | AP interface `wlp0s20f3`; AP address `10.77.30.1`, freshly proven present before apply. |
| OD-L6B-06 | Uplink address is a FRESH runtime value, frozen at preflight; expectation `enp62s0` / `192.168.1.144` is reported, not silently replaced. |
| OD-L6B-07 | `SUCCESS_MODEL = PERSISTENT`. Rollback is the failure/abort path only. |
| OD-L6B-08 | One live attempt per same-day authorization; no automatic retry. |
| OD-L6B-09 | A-L6b covers the whole stage-owned mutation boundary (§3). No separate pre-PRE material-staging mutation is permitted. |

## 2. Target state after a successful L6b (persistent)

```text
legacy (UNCHANGED, byte/state boundary):
  mosquitto.service, wildcard :1883, /etc/mosquitto tree, user aegis
IDEA3 (installed by L6b, left in place):
  aegis-idea3-mosquitto.service   enabled + active
  127.0.0.1:8883 and 10.77.30.1:8883   TLS 1.2+, TLS only
  no IDEA3 1883, no wildcard 8883, no uplink 8883
  allow_anonymous false, persistence false, retain_available false
  IDEA3-only hashed passwd, IDEA3-only ACL
  PF-01: AP TCP/1883 explicit drop present in table inet aegis_idea3
  CA_PRIVATE_KEY_ON_CORE = FORBIDDEN     CA_PRIVATE_KEY_ON_ARCH = FORBIDDEN
```

No ESP32 is required or touched for L6b acceptance; verification uses local MQTT clients only.

## 3. Stage-owned mutation boundary (A-L6b scope)

`stages/L6b/apply.sh` performs, in this order, after a PRE capture and only after every validation passed:

1. create `/etc/aegis-idea3/mqtt` (`root:mosquitto 0750`);
2. install (all root-owned; **amended 2026-09-27 after the first live attempt, see §13**): `aegis-idea3-mosquitto.conf`, `acl`,
   `passwd` (hashed) and `broker.key` as `root:mosquitto 0640`; `ca.crt` and `broker.crt` as `root:root 0644`; the unit is
   `root:root 0644`. Nothing is group- or world-writable and secrets are never world-readable. Live pre-state additionally
   requires the `mosquitto` group and user to exist and the user's primary GID to equal the group's GID (supplementary groups are not judged; no account or group is created or modified);
3. install `/etc/systemd/system/aegis-idea3-mosquitto.service` (0644);
4. `systemctl daemon-reload`;
5. `systemctl enable --now aegis-idea3-mosquitto.service`.

It never restarts, stops, reloads or edits `mosquitto.service`, never touches `/etc/mosquitto`, and never installs a plaintext
password. Modes are the least privilege that lets the root-started broker read its files at startup; they are not widened
for convenience. `/etc/aegis-idea3` itself must already exist (created by L2); otherwise apply fails with
`IDEA3_ETC_MISSING_OR_SYMLINK` (a missing predecessor, not something L6b creates).

Pre-state is strict: `/etc/aegis-idea3/mqtt`, the six files and the unit must be **absent**, `LoadState` of the IDEA3 unit
must be `not-found` and no 8883 listener may exist. Anything else fails with `PRESTATE_UNEXPECTED:<path>` and nothing is
written. L6b therefore never adopts, overwrites or "restores" pre-existing IDEA3 broker material; a leftover requires a
separate owner-authorized cleanup.

## 4. Input contract (`AEGIS_L6B_INPUT_DIR`)

Private owner JIT directory, real (not symlink), mode `0700`, owned by the invoking owner (`SUDO_UID` when run through
sudo), containing **exactly**:

```text
ca.crt  broker.crt  broker.key  core.pass  device.pass
```

`ca.key` is forbidden (checked before the entry list so the reason is explicit). `broker.key`, `core.pass`, `device.pass`
must be regular, non-symlink, `0600` or `0400` (the same policy as `p4-broker-material.py` and L6a). Certificates must be
regular and not group/world writable. The PKI is validated with `p4-mqtt-pki.py validate-broker-cert --key-file`
(key match, chain, hostname, profile). Contents are never printed.

The device identity is **not** an input: it is the pinned Production identity `aegis-relay-01`
(`p4-nvs-provision.py`, README, T2/T3/T7/T8 design; MQTT user `idea3-dev-aegis-relay-01`). No second identity is introduced.
The AP address, uplink address and AP interface are explicit environment values
(`AEGIS_AP_ADDRESS`, `AEGIS_UPLINK_ADDRESS`, `AEGIS_AP_INTERFACE`); the work directory is `AEGIS_L6B_WORK_DIR`.

## 5. Plaintext custody and hashed database

`p4-broker-material.py build-password-db` reads the plaintext from the two private files (never argv), writes the DB into a
`0700` stage directory, and hashes it with `mosquitto_passwd -U`. Apply then requires: exactly the identities
`idea3-core` and `idea3-dev-aegis-relay-01`, every credential hashed (`$N$…`), neither plaintext present in the DB. The
staged copy is deleted on every exit path; hashes are not copied into the work directory, manifest, stdout or evidence.
The runner's secret scan fails the run if any plaintext password, private-key block/body line or `$7$` hash appears anywhere
in the evidence (including root-owned captures, scanned through sudo). After a successful, mandatory-validated L6b the JIT
plaintext input is logically deleted by a **separately authorized** owner workflow (no physical secure-erase claim); the
runner itself never deletes it, because the owner needs it for that workflow's authorization and evidence.

## 6. Stage-owned rollback (failure / abort path only)

`apply.sh` writes `$WORK/journal.tsv` (`DIR`, `FILE`, `UNIT`, `SERVICE` lines) **before** creating each path, so a crash at
any point is rollback-able. `rollback.sh`:

- accepts only journal entries that equal the fixed L6b-owned paths (anything else fails `JOURNAL_ENTRY_NOT_OWNED`);
- stops/disables only `aegis-idea3-mosquitto.service`, and only if this stage started it (`SERVICE` journaled);
- removes the unit, then each journaled file by exact path (`rm -f`, regular non-symlink only), then the mqtt directory only
  if journaled and empty (`MQTT_DIR_HAS_UNOWNED_ENTRIES` otherwise — never recursive);
- runs `daemon-reload`, then `systemctl reset-failed aegis-idea3-mosquitto.service` (that name only; never bare/`--all`) as the
  **last** lifecycle step, and proves the unit's runtime state is back to `LoadState=not-found ActiveState=inactive
  SubState=dead Result=success` (`IDEA3_SERVICE_RUNTIME_STATE_RESIDUE` otherwise). A failed unit keeps not-found/failed
  metadata in the manager after its file is removed and reloaded (observed live), so without this PRE→RB drifts on
  `svc.aegis-idea3-mosquitto.*`. It runs after removal+reload so nothing later (stop, reload, `Restart=on-failure`) can
  re-create the residue; a non-zero exit is tolerated only because the proven end state decides (second run: unit unknown);
- re-proves the legacy tree/users/service/1883 listeners equal the apply-time baseline, and proves no
  8883 listener and no material residue;
- is idempotent and never touches the owner input.

**Runner clean-prestate gate.** `LoadState=not-found` alone is not a clean pre-state: a previously failed unit keeps
`ActiveState=failed SubState=failed Result=exit-code` metadata with no unit file. Before the authorization is consumed the
runner (`l6b_broker_prestate_gate`) requires exactly `LoadState=not-found ActiveState=inactive SubState=dead Result=success
MainPID=0 NRestarts=0`, no unit file, no mqtt directory and no 8883 listener, using read-only `systemctl show` only. Residue is
rejected with `L6B_RESIDUAL_FAILED_STATE_CLEANUP_REQUIRED=YES`; the runner never runs `reset-failed` and never repairs the host.
That separately authorized bounded cleanup has since run once (`systemctl reset-failed aegis-idea3-mosquitto.service`, evidence `2026-09-27-l6b-residual-cleanup-20260927-113759`): the real host is back to the exact clean prestate (`not-found/inactive/dead/success`), PRE→POST comparison PASS with exactly four approved `svc.aegis-idea3-mosquitto.service` changes. Its authorization is consumed and never reusable; L6b Attempt 2 is not yet authorized.

Because apply requires an absent pre-state, "restore a pre-existing path" cannot occur and is deliberately unsupported.
The runner then captures `rb-root` and requires **PRE → RB with no allow files** to be PASS (zero drift, zero approved
changes): rollback must return exactly to PRE.

## 7. Predecessor gates: historical acceptance vs current runtime

Historical acceptance is read from **receipts at the pinned commit** (`git grep HEAD`, never the working tree, never an
unmerged file), and the runner requires `HEAD == origin/main == EXPECTED_MAIN` with a clean pinned worktree:

- L2–L5: `Ln_LIVE_ACCEPTANCE = PROVEN` present in a committed receipt;
- L6A: exactly one committed `*_music_idea3-pr11-l6a-live-acceptance.md` receipt containing the lines
  `L6A_LIVE_ACCEPTANCE=PROVEN`, `L6A_COMPLETE=YES` and `L6B_STARTED=NO`.

Current runtime is proven fresh, read-only, immediately before apply, and is **never repaired by L6b**:

| Predecessor | Fresh proof required |
|---|---|
| L2 | `nft list table inet aegis_idea3` exists; PF-01 `iifname "wlp0s20f3" … tcp dport 1883 … drop` present; no NAT in the table |
| L3 | `wlp0s20f3` exists, type AP, SSID `AEGIS-IDEA3`, active NetworkManager profile `aegis-idea3-ap` |
| L4 | `10.77.30.1` present on `wlp0s20f3`; `aegis-idea3-dnsmasq.service` active/running |
| L5 | historical PROVEN **plus** fresh `p4-l5-clock.py probe` `state=SYNCED reason=OK`; `chronyd` is **not** required |
| L6A | merged receipt above |

Any missing item fails closed with `PREDECESSOR_RUNTIME_REACTIVATION_REQUIRED=YES`; L2/L3/L4 reactivation is a separate
owner-authorized action and is never performed by the L6b runner. Additional fresh gates: forwarding sysctls all `0`; one
default route; legacy `mosquitto.service` active with `0.0.0.0:1883`; engine, detection tunnel, Twingate active;
`aegis-idea3-mosquitto.service` `not-found`; no unit file, no `/etc/aegis-idea3/mqtt`, no 8883 listener; disk `< 90 %`.

**Uplink (OD-L6B-06).** The runner resolves the single default route's interface and its single global IPv4, and fails
closed if missing, ambiguous, loopback/non-routable, on the AP interface or equal to the AP address. A difference from the
expected `enp62s0` / `192.168.1.144` fails with `L6B_UPLINK_EXPECTATION_MISMATCH observed=… expected=…` for owner review; it
is accepted only when the owner names exactly the observed pair in `AEGIS_L6B_ACCEPT_UPLINK=<if>:<addr>`. The frozen value
is recorded in `frozen-inputs.txt` and passed to the handlers.

## 8. Verification (live, bounded, no ESP32)

`verify.sh` (read-only; client probes only) proves, against the actual running separate broker:

- installed material is exactly the six files with exact modes/owners, no `ca.key`, no plaintext password files, hashed DB,
  digests equal to the apply manifest, unit byte-equal to the reviewed example;
- config scope (exactly two 8883 listeners, no uplink, no 1883, security directives);
- service active, enabled, running, `NRestarts=0`; legacy tree/users/service (`MainPID`/`NRestarts`/start timestamp) and
  wildcard 1883 listener set unchanged;
- exactly `127.0.0.1:8883` and `10.77.30.1:8883` listening; no wildcard; no uplink 8883; PF-01 present;
- via `p4-broker-validate.py validate-live` on **both** listeners: TLS ≥ 1.2 with CA + hostname verification
  (`mqtt.aegis.home.arpa`), core and device authentication, exact ACL matrix, anonymous rejected, wrong core/device password
  rejected, retained publish rejected. `validate-live` never starts or stops a broker and never prints a secret.

Non-secret `validation-evidence.tsv` is retained. A failed verify triggers rollback.

## 9. Capture / comparator contract

PRE is captured before any L6b-owned change. The capture now additionally records the directory
`host.path./etc/aegis-idea3/mqtt` and the unit file `host.unit_file./etc/systemd/system/aegis-idea3-mosquitto.service`
(class/sha256/meta, exactly like the Core unit); the six material files are already recorded by metadata only
(`host.aegis_idea3.file.<path>.class|.meta`, never content or digest for secrets).

`stages/L6b/allow-keys.txt` approves **exactly** (no wildcard, no broad `/etc/aegis-idea3` allowance): the eight
`svc.aegis-idea3-mosquitto.service.*` keys, the unit's three keys, the mqtt directory key and the twelve material keys
(`.class`, `.meta` × six). `allow-listeners.txt` approves exactly `127.0.0.1:8883` and `<AEGIS_AP_ADDRESS>:8883`. Any other
file added under `/etc/aegis-idea3`, any file added under `/etc/aegis-idea3/mqtt`, or any change to the Core unit, legacy
Mosquitto, Twingate, routes, forwarding, boot id, kernel, host identity or other listeners remains default-deny drift.
Allowed keys approve only that an item changes, so the verify handler independently pins exact modes, owners and digests.

- **PRE → POST**: approved deltas allowed → `FINDINGS_NEW_OR_WORSENED_DRIFT=0`, `PRESERVATION_S10=PASS`.
- **PRE → RB**: no allow files → must equal PRE.

## 10. Frozen-style owner runner

`deploy/pr11-phase4/owner-run/run-l6b-owner.sh` is committed as an **unpinned template** (`EXPECTED_MAIN=PIN_MAIN_SHA`,
refuses to run). The freeze workflow (owner action, after this work merges):

1. create a clean execution worktree at the merged main SHA
   (`…/worktrees/Project-End-The-AEGIS-L6BLIVE`);
2. copy the template outside the repository, replace `PIN_MAIN_SHA` with that 40-hex SHA, `chmod 500`, record its SHA-256;
3. supply the private JIT input at `~/Workspace/idea3-p4-evidence/l6b-owner-input`;
4. write fresh same-day A-L6b and K3 records (§11) in an `AUTH_DIR`;
5. run `bash run-l6b-owner.sh <AUTH_DIR>` once as the normal user.

Runner sequence: normal user only → `sudo -v` → pinned-main / clean-worktree / origin-main checks → same-day records +
`p4-stage-gate.sh --stage L6b --mode live` → receipt gate → tools/pinned Python → JIT input gate (+ PKI key match) →
fresh runtime gates → uplink freeze → host safety → **consume the one-attempt marker** (`AUTH_DIR/L6B-ATTEMPT-CONSUMED`,
atomic; a second run for the same authorization is refused even after a failure) → PRE capture → apply (once) → verify →
evidence secret scan → POST capture → PRE→POST compare (approved deltas) → S10 preservation → closeout check
(active + enabled). On any failure after the marker the runner runs rollback, RB capture and PRE→RB compare (no allowances)
and stops without retry. If apply fails before the first mutation, no rollback handler is run; zero drift is proven instead.
Handlers run through `sudo env …`; the work directory is chowned back to the owner after each handler (non-secret only).
It never reactivates L2/L3/L4, never touches NetworkManager, nftables, chrony/timesyncd, forwarding, Twingate, legacy
mosquitto, any ESP32/serial device, and never starts L7.

## 11. Authorization contract (confirmed, nothing created here)

```text
AEGIS_P4_AUTHORIZATION_V1
stage=L6b
date=<same-day Asia/Bangkok>
authorizer=music
scope=<one line: L6b stage-owned persistent TLS broker deployment ... one attempt, no ESP32>
reference=<real written owner authorization>
```

L6b has **no** extra stage-specific fields (`p4_stage_auth_extra L6b` is empty). L6b mutates Production, so a fresh same-day
K3 is required: V1 (independent IDEA1-owner confirmation, `confirmed_by=kraveerachat`, `idea1_window_overlap=NONE`) or V2
(`confirmed_by=music`, `confirmation_mode=IDEA3_OWNER_SELF_ATTESTATION`, `idea1_window_overlap=NONE_KNOWN`; a self-attestation
that does not prove IDEA1 inactivity). The A-L6b scope must cover the whole §3 boundary.

## 12. Security invariants

```text
LEGACY_MOSQUITTO_SERVICE / LEGACY_1883 / LEGACY_USER_AEGIS / LEGACY_CONFIG_TREE = UNCHANGED
IDEA3_1883 = FORBIDDEN      IDEA3_8883_LOOPBACK = REQUIRED    IDEA3_8883_AP = REQUIRED
IDEA3_8883_WILDCARD = FORBIDDEN     IDEA3_8883_UPLINK = FORBIDDEN
PF01_AP_TO_1883_DROP = REQUIRED
ANONYMOUS_ACCESS = FORBIDDEN    PERSISTENCE = FALSE    RETAIN_AVAILABLE = FALSE
CA_PRIVATE_KEY_ON_CORE / ON_ARCH = FORBIDDEN
ESP32_TOUCHED = NO      L7_STARTED = NO
```

## 13. Live finding from the first L6b attempt (resolved in the repository; live re-run needs a NEW authorization)

The first live attempt (`2026-09-27-l6b-20260927-100548`, authorization consumed, never reusable) applied PASS and failed
verify with `IDEA3_SERVICE_NOT_ACTIVE`: Mosquitto 2.1.2 loaded its config, dropped privileges to `mosquitto` (uid/gid 958), then
failed `password-file: Error: Unable to open pwfile "/etc/aegis-idea3/mqtt/passwd"` (installed `root:root 0600`; `broker.key`
was `0600` as well). Rollback removed every L6b path and listener and left legacy Mosquitto unchanged, but PRE→RB failed
because systemd retained `LoadState=not-found ActiveState=failed SubState=failed Result=exit-code` for the IDEA3 unit.

Remediation: the `root:mosquitto 0640` model of §3 step 2 (root ownership preserved, group read only for the one group the
broker runs as, no widening to 0660/0666/0770/0777, no account/group mutation) and the rollback `reset-failed` step of §6.
The PRE→RB comparator stays strict (zero drift, zero approved change, no allow files). What tests cannot prove offline is that
the real `mosquitto` 2.1.2 process on the host reads these files after its privilege drop; the live verify remains that proof.

**Live outcome (Attempt 2, evidence `2026-09-27-l6b-20260927-115928`, runner sha256 `7801d663…e06a`, authorization CONSUMED):** after the residual cleanup restored the exact clean prestate, apply and verify passed on the real host. Mosquitto 2.1.2 reads the `root:mosquitto` material after its privilege drop, live TLS/auth/ACL/negative verification passes, and the persistent state is proven: `aegis-idea3-mosquitto.service` active/running/enabled with `NRestarts=0`, listeners `127.0.0.1:8883` and `10.77.30.1:8883` only, legacy Mosquitto preserved. PRE→POST: 0 new drift, 24 approved changes (the persistent L6b footprint), 3 disk INFO, `PRESERVATION_S10=PASS`. Rollback was not triggered. The JIT plaintext input was afterwards removed by the separately authorized cleanup workflow (authorization consumed, runner sha256 `c778451c…a1c5bc`): `/home/kittipat/Workspace/idea3-p4-evidence/l6b-owner-input` is absent. This is logical deletion only (no physical secure-erase claim) and the persistent broker stayed active/running/enabled with both 8883 listeners. L7 has not started.

## 14. Test map

`tests/test_pr11_phase4_l6b_handler.py` (fixture root + throwaway loopback brokers + a stateful fake `systemctl` that models
the dropped-privilege broker and failed-metadata retention): input contract, prestate, exact install
set/modes/bytes, no plaintext/hash leakage, hashed identities, config scope, journal, manifest, legacy untouched, verify
drift matrix, rollback exactness/idempotence/partial/tampered journal, capture/compare contract (PRE→POST exact, PRE→RB
zero), live probe pass and fail cases (anonymous allowed, permissive ACL, wrong passwords, no broker).
`tests/test_pr11_phase4_l6b_runner.py`: unpinned refusal, ordering/one-attempt/no-forbidden-command static contract, attempt
marker, receipt gate (including real repository history), uplink resolution, AP/nft/TrustedClock gates, input gate, secret
scan.

## 15. Boundary

This design and its implementation authorize nothing. `L6B_LIVE_EXECUTION = NOT_AUTHORIZED` until the owner freezes the
runner, supplies fresh input and predecessor runtime, and writes same-day A-L6b and K3 records.
