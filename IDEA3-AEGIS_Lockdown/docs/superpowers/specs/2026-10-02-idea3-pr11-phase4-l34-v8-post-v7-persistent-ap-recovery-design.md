# AEGIS IDEA3 PR11 Phase 4 — L3/L4 Post-V7 Persistent AP Recovery Design (V8)

Date: 2026-10-02 (Asia/Bangkok). Owner: music. Decision: **OD-L34-V8-01 = APPROVED**. Status: **repository implementation only. Live execution NOT authorized.**

```text
V8_STAGE_NAME                    = l34-v8-post-v7-persistent-ap-recovery
V8_BASELINE_ID                   = POST_V7_RADIO_DISABLED_AP_DOWN_BROKER_CHURN
BASE_MAIN                        = a4b48cde2bc294927fa5b0c7da79aa358b374376
RECOVERY_EXECUTED                = NO
LIVE_RECOVERY_AUTHORIZED         = NO
PRODUCTION_MUTATION              = NO   (this document and its implementation)
A_L4_CREATED                     = NO
K3_L4_CREATED                    = NO
V7_AUTH / V7_MARKER / V7_RUNNER  = NEVER REUSED (V7 is historical and one-shot; its live result is immutable)
CORE_RESTARTED                   = NO
L7U_EXECUTED                     = NO
RECOVERY_R1_R8_PROVEN            = NO
L8_AUTHORIZED                    = NO
ESP32                            = NOT TOUCHED
K12_AUTOMATIC_REBOOT_PERSISTENCE = NOT_PROVEN (V8 does not prove it; reboot persistence acceptance is a separate later activity)
L3 / L4 / L6B_LIVE_ACCEPTANCE    = PROVEN historically (unchanged, not re-claimed; the L6b broker is NEVER mutated by this workflow)
```

## 0. Why this stage exists

V7 (`l34-v7-radio-disabled-broker-churn`) recovered the AP, dnsmasq and the L6b broker on 2026-10-01 19:33 and recorded, explicitly, `RUNTIME_ONLY`,
`PERSISTENT_FILES_REWRITTEN=NO` and `K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN`. The host was rebooted twice afterwards (2026-10-02 06:11 and 08:01) and,
read-only evidence from the journal shows, came back with the radio enabled by NetworkManager's state file but **the AP profile never activated**
(`aegis-idea3-ap` has `connection.autoconnect=no`), `aegis-idea3-dnsmasq` failed at 08:17:09 with `unknown interface wlp0s20f3` and hit its start limit, and
the broker crash-looped from 08:17:14 with `Error: Cannot assign requested address`. At 08:23:09 the operator's desktop session disabled the Wi-Fi radio
(`radio-control wireless-enabled:off uid=1000 pid=<plasmashell>`), which also rewrote the systemd rfkill state file to blocked. The host is therefore back in
the V7 class of baseline. V7 must NOT be replayed (its one-shot marker, authorization and frozen runner are spent); no other accepted stage supports a
radio-disabled host (V4–V6 need the radio enabled). V8 is the new governed stage, and it additionally persists the one policy whose absence made the
recovery runtime-only.

## 1. Frozen decisions

1. **New stage, new files only.** `reactivation/l34-v8-post-v7-persistent-ap-recovery/{apply,verify,rollback}.sh`, three allow files,
   `owner-run/run-l34-v8-post-v7-persistent-ap-recovery-owner.sh`, and a NEW gate library `p4-l34-v8-lib.sh`. **No V1–V7 file changes**
   (the shared `p4-l34-reactivation-lib.sh`, V7 handlers, allow files and runner, the stage gate, registry, comparator and capture are pinned byte-for-byte by
   `test_pr11_phase4_l34_v8_scope_contract.py`). V8 reuses the V7/V5/V3 gate functions by calling them, never by copying or editing them.
2. **Baseline = V7's baseline, plus the persistent precondition.** The V3 classifier (FRESH or RESIDUAL), the strict broker-churn contract with the
   current-boot / current-invocation journal correlation (`l34_v7_broker_journal_capture` + `l34_v7_broker_churn_gate`, unchanged), no `:8883` listener,
   healthy Core, and a management alternate default route are all retained. New: the persisted profile must be at `connection.autoconnect=no` (NetworkManager value
   `no` AND keyfile `autoconnect=false`). A profile that already autoconnects is **refused** (`L34_V8_AP_PROFILE_ALREADY_AUTOCONNECT`).
3. **The ONE persistent change** is `nmcli connection modify aegis-idea3-ap connection.autoconnect yes` (OD-L34-V8-01), performed exactly once by NetworkManager
   itself. V8 never edits `/var/lib/systemd/rfkill/*`, any NetworkManager state file, dnsmasq or broker configuration, or any unit file.
4. **The readiness wait precedes the persistent modify** and device autoconnect is off while it happens, so nothing can grab the device between the modify and
   the single ifname-bound activation (the 2026-10-01 live race remains the load-bearing control).
5. **No broker or Core command, ever.** The broker recovers through its own `Restart=on-failure` once 10.77.30.1 exists.
6. **Rollback is journal-owned and restores the persistent value FIRST.**

## 2. Apply order (every mutation is journaled BEFORE it is made)

```text
 1 exact-id rfkill unblock                          RFKILL_UNBLOCK <id>
 2 device autoconnect off                           NM_DEVICE_AUTOCONNECT_DISABLE <PRE value>
 3 ONE `nmcli radio wifi on` (only if still off)    NM_WIFI_RADIO_ENABLE disabled
 4 bounded wait: wlp0s20f3 == disconnected          (read-only)
 5 PERSIST  nmcli connection modify aegis-idea3-ap connection.autoconnect yes      NM_PROFILE_AUTOCONNECT_ENABLE no
   then: NM value == yes; keyfile autoconnect != false; every OTHER non-secret profile record semantically identical (order/uuid ignored); l34_profile_gate + effective gate still pass
 6 ONE nmcli connection up aegis-idea3-ap ifname wlp0s20f3                          NM_UP aegis-idea3-ap
 7 restore device autoconnect to its exact PRE value                                NM_DEVICE_AUTOCONNECT_RESTORED
 8 verify AP / interface / address / regulatory / default-route invariants
 9 systemctl reset-failed aegis-idea3-dnsmasq.service                               DNSMASQ_RESET_FAILED
10 ONE systemctl start aegis-idea3-dnsmasq.service                                  DNSMASQ_START
11 bounded READ-ONLY wait for the broker's OWN auto-restart; 12 exact 8883 pair; 13 ONE handshake-only TLS probe; 14 broker tuple stable
15 Core (MainPID, NRestarts, InvocationID) == PRE tuple
16 persistent invariants: every artifact identical to PRE (the profile: semantically identical, key order and daemon uuid ignored) except the one authorized autoconnect field
```

`journal.tsv` is the ownership record. The preflight (`AEGIS_L34_PREFLIGHT_ONLY=YES`) runs every read-only gate and mutates nothing.

## 3. The persistent-change proof (`p4-l34-v8-lib.sh`)

NetworkManager serializes a default `autoconnect=true` by **omitting** the line, so the persisted `yes` state normally looks like "no autoconnect line".
`l34_v8_profile_file_autoconnect` therefore reports `false | true | absent`; PRE must be exactly `false`, POST must be `absent` or `true`.

The profile is PSK-bearing, so it is snapshotted without ever printing or digesting a secret. `l34_v8_profile_record` stores `mode:uid:gid` (no size/mtime/ctime, which
the one approved rewrite legitimately changes), the sha256 of the **canonical record set**, and the **count** of secret lines (`psk_lines=N`).

**Canonicalization (`l34_v8_profile_canonical`).** A real libnm rewrite of the hand-rendered AP keyfile re-orders keys inside sections (verified offline with libnm's
own writer: `[wifi]` becomes band/channel/mode/ssid, `[ipv4]` address1/method/never-default) and the NetworkManager daemon assigns a connection `uuid`. A
file-order digest would therefore flag a legitimate rewrite as drift (the blocker found in the PR #291 review). The proof is instead computed on canonical
records: the file is parsed with section context, each non-secret key becomes one `[section]/key=value` line (whitespace around `=` trimmed; comments, blank
lines and empty sections ignored), the lines are `LC_ALL=C sort`ed and hashed. Excluded, and ONLY these: `[connection]/autoconnect` (the one approved transition,
verified separately), `[connection]/uuid` (daemon-assigned), `[connection]/timestamp` **only when its value is a non-negative decimal integer** (the
last-activation epoch that libnm's own keyfile writer persists when the daemon rewrites an already-activated profile; see the 2026-10-02 live S-11 hold below),
and secret keys in any section (`psk`, `wep-key*`, `leap-password`, `password`,
`private-key-password`, `pin`; values never printed or hashed). Everything else is still detected: an added or removed non-secret key, a changed value
(SSID, channel, `address1`, IPv4 `method`, ...), a key moved to a different section, a `timestamp` in any other section or with a non-numeric value, or any
other unknown key.

**Amendment — live S-11 hold, 2026-10-02 (timestamp false positive).** The first live V8 attempt (main `9f5a0114`) applied the one `nmcli connection modify`,
then `l34_v8_persistent_verify … yes` failed with `L34_V8_PROFILE_CHANGED_BEYOND_AUTOCONNECT:aegis-idea3-ap.nmconnection`; the rollback restored the runtime
state but its own proof failed with the same invariant (S-11 HOLD). A read-only canonical diff by the human owner proved the ONLY difference was
`[connection]/timestamp=1790896283` (profile mode `600 root:root` and `psk_lines=1` unchanged). The previous offline libnm check had covered key re-ordering and
the uuid but not the `timestamp` property, which libnm's writer emits once the connection has been activated. The fix excludes exactly that numeric
`[connection]/timestamp` record; the committed `profile-libnm-autoconnect-{yes,no}-timestamp` fixtures are libnm-writer output (regenerated and compared byte
for byte by a `gi`-conditional test). The consumed attempt, its authorization and its evidence are historical and are not reused; any later attempt is a
governed successor attempt under §5.1 (fresh runner freeze, fresh preflight, fresh same-day authorization and a brand-new `AUTH_DIR`), never a retry. The same function backs post-apply verification and rollback verification
(`l34_v8_persistent_verify`), so the claim is **semantically identical except for the explicitly approved autoconnect transition, with ordering and the
daemon-assigned uuid ignored** (not byte or order identity). Every other persistent file (dnsmasq conf, unit, nft, broker conf) keeps the exact V1–V7 record
(mode, owner, size, mtime, ctime, sha256).

If a real NetworkManager rewrite ever changes a non-secret VALUE, adds or removes a non-secret key, or moves a key between sections, the proof fails closed
(`L34_V8_PROFILE_CHANGED_BEYOND_AUTOCONNECT`); V8 never "repairs" a drifted profile. Regression coverage uses real libnm-serialized fixtures
(`tests/fixtures/l34_v8/`). The first live run is still the first time the real daemon performs this rewrite on the real file (see Limitations).

## 4. Rollback (failure/abort path only)

Journal-owned, idempotent, never touches the broker or Core. Order:

```text
0 restore connection.autoconnect=no          only if NM_PROFILE_AUTOCONNECT_ENABLE is journaled AND the profile is not already `no`
                                             (the entry is written BEFORE the modify, so a modify that failed without effect issues no second modify)
1 stop aegis-idea3-dnsmasq.service           only if DNSMASQ_START journaled
2 device autoconnect off                     only while the AP comes down / radio goes off
3 nmcli connection down aegis-idea3-ap       only while it is the active connection of wlp0s20f3
3b escalate: a DIFFERENT Wi-Fi profile active → fail closed, never touched
4 nmcli radio wifi off                       only if this run enabled it
5 restore device autoconnect to its PRE value
6 re-block exactly the journaled rfkill id   only if it was soft-blocked before this run
```

Proofs: the profile is semantically identical to PRE (canonical records; key order and daemon uuid ignored), `autoconnect=false` restored, and `connection.autoconnect` reports `no`; every other
persistent file identical; L2/forwarding/identities unchanged; Core tuple unchanged; the V3 safe-equivalent boundary (p2p pseudo-device, wpa_supplicant
running, phy TH|00 are the only tolerated residuals). A journal entry that is not exactly owned, an unknown kind, or a missing rfkill id fails closed. After a
failed rollback the runner prints `S-11 HOLD — ESCALATE; do NOT retry`.

## 5. One-shot governance

- Marker `L34-V8-REACTIVATION-ATTEMPT-CONSUMED` in the authorization directory; a `L34-V7-REACTIVATION-ATTEMPT-CONSUMED` marker in that directory **refuses**
  the run; V7 authorization/K3 records carry the V7 scope and fail the V8 scope check.
- Authorization: `AEGIS_P4_AUTHORIZATION_V1`, `stage=L4`, same-day (Asia/Bangkok), `authorizer=music`, `scope=` exactly the frozen V8 scope (<=200 ASCII);
  K3: V1 (`kraveerachat`) or V2 (`music` self-attestation) per the existing stage gate. **None is created by this change.**
- Runner order: pre-gates (read-only) → handler preflight → PRE capture → **consume marker** → apply (once) → verify → PSK leak scan → POST capture →
  PRE→POST compare → identity check. No rollback path exists before the marker is consumed; after consume a failure rolls back once and the attempt is spent.
- The runner is an inert repository template (`EXPECTED_MAIN=PIN_MAIN_SHA`); the owner freeze copies it OUTSIDE the repository and pins the merged main.
  Its `REPO` constant points at the future clean execution worktree `...-L34V8LIVE`.
- Comparator: `allow-keys.txt` approves the V7 runtime keys plus exactly ONE persistent key, the AP profile `.meta` record (a keyfile rewrite changes
  size/mtime); the profile `.class` key, `net.idea3_dnsmasq_conf.*`, `fw.idea3_nft` and every broker/rfkill/NetworkManager-state path are never approved.
  The value-level radio/p2p/wpa/regulatory windows come only from the existing V3 catalogs, selected by the reported baseline.

### 5.1 Governed successor attempt (clarification, 2026-10-02)

**A failed or consumed V8 attempt is NEVER retryable.** Its `AUTH_DIR`, authorization, K3, attempt marker, frozen runner and mutable evidence directory are
historical and MUST NOT be reused, resumed, edited or re-consumed. `V8_RETRY_ALLOWED=NO` means exactly this: the consumed attempt itself cannot be rerun.

It does NOT prohibit a separately authorized **governed successor attempt** under the SAME canonical stage `l34-v8-post-v7-persistent-ap-recovery`
(the stage ID, handlers, runner template, scope string and marker filename are not renamed or duplicated). A successor attempt is not a retry of the consumed
attempt; it is a new, independently authorized one-shot attempt, and it may be authorized by the owner only when ALL of the following hold:

1. the root cause of the earlier failure is fixed on `main` (merged), and the fix did not widen the V8 scope or forbidden list;
2. the host has been restored to an accepted V8 baseline (FRESH or RESIDUAL per the V3 classifier, plus the V8 preconditions of §1.2), by an owner-governed
   action, and a read-only check on the day of the attempt still finds it;
3. a NEW runner freeze exists, copied outside the repository, pinned to the exact then-current `origin/main` with a new SHA-256 (a frozen runner whose pin is
   no longer `origin/main` is stale and is never repinned in place);
4. a NEW root read-only preflight, pinned to that same SHA, passes;
5. a fresh same-day (Asia/Bangkok) `stage=L4` authorization and K3 with the exact V8 scope are created for this attempt;
6. a brand-new `AUTH_DIR` is used, which carries no marker; and
7. the per-`AUTH_DIR` marker `L34-V8-REACTIVATION-ATTEMPT-CONSUMED` is unconsumed. The successor uses that same filename only inside its own new
   `AUTH_DIR`; it is consumed once, immediately before the first mutation, exactly as in §5, after which that successor attempt is also spent.

Each successor attempt is itself one-shot: if it fails after consuming its marker, it too is never retryable and a further successor needs a new run of all
seven conditions. Nothing in this section creates, freezes, authorizes or runs anything; it changes no runner, handler, marker, classifier or NetworkManager
logic. The successor attempt is NOT RUN as of this clarification.

## 6. Forbidden (statically enforced by tests)

Broker `start|stop|restart|reset-failed|kill|enable|disable|mask`; Core control; `rfkill unblock all`; direct edits of `/var/lib/systemd/rfkill`,
`/var/lib/NetworkManager`, `NetworkManager.state`; any `nmcli connection` verb other than the one exact `modify … connection.autoconnect`; `nft`,
`sysctl -w`, `iw reg set`; `tee`/`cp`/`mv`/`rm` in handlers; Twingate, IDEA1/IDEA2, ESP32, MQTT, Recovery R1–R8, L7u, L8.

## 7. Limitations (honest)

- Simulator-tested only. The real `nmcli connection modify` keyfile rewrite, the real `sudo env` environment reset and the real comparator behaviour on the
  profile `.meta` key are verified only by the first live attempt, which fails closed and rolls back.
- V8 does not make the AP survive a reboot by itself: `autoconnect=yes` plus a free device is the intended mechanism, but dnsmasq (`Requires=NetworkManager`,
  no `BindsTo` the device) may still lose its race with the interface at boot, and the rfkill state file records whatever state the radio had at the last
  shutdown. **K12 automatic reboot persistence is NOT proven and is a separate later activity.**
- Radio disablement from a desktop session (as at 08:23:09) is an operator action; V8 neither prevents nor detects it.
- The wired management path is assumed present (`l34_ap_pre_gate` requires an alternate default route); the owner remains responsible for out-of-band access.
