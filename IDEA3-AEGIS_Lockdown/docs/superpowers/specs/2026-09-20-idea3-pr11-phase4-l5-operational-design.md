# IDEA3 PR11 Phase 4 L5 — Core-Local Trusted NTP Operational Design

Date: 2026-09-20
Owner: Music
Task: PR11 Phase 4 L5 Runtime Handler Operational Design
Branch: `feat/idea3-pr11-phase4-l5-handler`
Status: OWNER APPROVED — repository L5 handler implementation authorized; live L5 execution not authorized

---

## 1. Authority, Context, and Problem Statement

PR #156 (T6 / G-05) closed the repository contract for Core-local trusted NTP by implementing `deploy/pr11-phase4/p4-ntp.py` (renderer and validator) and `deploy/chrony/aegis-idea3-chrony.conf.example`. However, the T6 design specification (`2026-09-18-idea3-pr11-phase4-t6-local-ntp-design.md`, §7, lines 130–131) explicitly established:

> *"Exact live `systemctl` ordering is intentionally not encoded by this repository task; it is reviewed at the authorized L5 execution window."*

An authority audit against merged Phase 4 specifications identified five concrete operational gaps that block implementing the L5 runtime stage handler (`stages/L5/`):
1. **Service Handoff Sequencing:** The exact operational ordering between `chronyd.service` and `systemd-timesyncd.service` during apply and rollback.
2. **Persistence Semantics:** Whether L5 alters persistent service enablement (`UnitFileState`) or runtime state (`ActiveState`) only.
3. **Configuration Destination and Ownership:** The live destination for rendered chrony configuration, verification of the installed unit's config path, and atomic replacement/rollback lifecycle.
4. **Live Verification Query Procedure:** How live AP-side acceptance and non-AP denial queries are executed and captured as stage evidence without confusing service isolation with routing failure.
5. **Chrony Control Port Listener Contract:** The exact listener specification for chronyd's loopback command port as an optional, permitted-if-observed local listener rather than a required listener.

This design document establishes the explicit operational architecture resolving all five authority gaps. **All five decisions (OD-L5-01 through OD-L5-05) were explicitly approved by the human owner in the project session on 2026-09-20, authorizing repository L5 handler implementation while live execution remains unauthorized.**

---

## 2. Decision OD-L5-01 — Service Handoff Sequencing

### Preconditions
Before initiating the service handoff, future live apply must verify read-only:
1. `chrony` package and `chronyd.service` unit are installed (L1 responsibility; E-14 shows chrony was absent on baseline Core).
2. `chronyd.service` is inactive prior to L5.
3. Read-only config-path inspection: `chronyd.service` effective unit / `ExecStart` uses default `/etc/chrony.conf` behavior (see OD-L5-03).
4. **Mandatory Live Entry Precondition:**
   - `systemd-timesyncd.service ActiveState = active`
   - `systemd-timesyncd.service SubState = running`
   - Core `TrustedClock` state evaluates to `SYNCED`
   - Kernel `maxerror` <= 1,000,000 µs (`MAX_ERROR_US`)
   *(An inactive `systemd-timesyncd` on a real host before L5 is NOT admissible for live apply. If timesyncd is inactive on the live host, the operator must synchronize Core first before entering L5.)*
5. Rendered chrony configuration passes `p4-ntp.py validate`.
6. L4 AP state is PASS (`wlp0s20f3` active with approved IPv4 address and dedicated dnsmasq running).
7. L2 firewall preconditions remain valid (dedicated table `inet aegis_idea3` present, AP UDP/123 accept present, zero forwarding, zero NAT).

### Proposed Handoff Sequence
The recommended handoff sequence minimizes synchronization disruption while preventing concurrent system clock adjustments:

```text
[ Pre-L5: systemd-timesyncd active/running, SYNCED ]
                 |
                 v
1. Validate rendered chrony material (p4-ntp.py validate)
2. Read-only verify chronyd.service uses default /etc/chrony.conf
3. Snapshot pre-L5 service and config state (capture ActiveState, metadata)
4. Atomically place chrony configuration to /etc/chrony.conf
                 |
                 v
5. systemctl stop systemd-timesyncd.service
                 |
                 v (Kernel enters bounded TrustedClock HOLDOVER <= 300s)
                 |
                 v
6. systemctl start chronyd.service
                 |
                 v
7. chronyd polls owner-supplied trusted upstream
                 |
                 v
8. Require kernel adjtimex returns to STA_UNSYNC clear
9. Require final TrustedClock = SYNCED
10. Require final maxerror <= 1,000,000 us
                 |
                 v
[ Post-L5: chronyd SYNCED on AP address ]
```

### Invariants and Prohibitions
- **No Concurrent NTP Daemons:** `systemd-timesyncd` must be stopped before `chronyd` is started. Two concurrent daemons disciplining the kernel clock cause race conditions and undefined adjtimex status.
- **No `timedatectl set-ntp`:** Direct `systemctl` calls must be used; `timedatectl set-ntp` invokes systemd-timedated D-Bus logic that may alter global systemd state outside stage boundaries.
- **Bounded HOLDOVER Only:** The gap between stopping timesyncd and chronyd achieving sync is governed strictly by the existing 300-second `HOLDOVER_SEC` limit. If `chronyd` does not recover `SYNCED` within this window, the handoff fails immediately.
- **No Shortcuts:** `makestep` must not be added to force instantaneous sync; local stratum fallback (`local stratum`) is strictly forbidden.
- **Immediate Rollback:** If `systemctl start chronyd` fails, or if `chronyd` fails to reach `SYNCED` within the holdover window, the handler immediately executes rollback.
- **Defensive Rollback Restoration:** Rollback restores captured pre-L5 ActiveState. For a normal live L5 apply that started from active timesyncd, rollback will re-start `systemd-timesyncd.service`. However, keeping the design general enough to restore captured state preserves automated fixture and idempotency safety if tested in an environment where timesyncd was already stopped. `UnitFileState` remains untouched in all cases.

*Status: APPROVED by Owner on 2026-09-20.*

---

## 3. Decision OD-L5-02 — Persistence Semantics

### Evaluation
The repository handler framework distinguishes between persistent configuration (which survives a host reboot) and runtime state. In L5:
- Enabling `chronyd.service` persistently (`systemctl enable`) and disabling `systemd-timesyncd.service` (`systemctl disable`) modifies `UnitFileState` on disk in `/etc/systemd/system/`.
- However, live reboot / boot-time persistence acceptance is not part of this runtime stage handler.
- If `UnitFileState` is altered, L0 compare would record persistent service drift (`svc.systemd-timesyncd.UnitFileState = disabled`, `svc.chronyd.UnitFileState = enabled`), requiring broad service allowlist entries.
- If L5 mutates runtime state only (`ActiveState`), `UnitFileState` remains completely protected and unchanged.

### Proposed Decision
**L5 mutates runtime `ActiveState` only.**
- Apply runs:
  ```bash
  systemctl stop systemd-timesyncd.service
  systemctl start chronyd.service
  ```
- Apply does **NOT** run `systemctl enable` or `systemctl disable` for either service.
- Rollback does **NOT** run `systemctl enable` or `systemctl disable` for either service.
- Neither apply nor rollback mutates `UnitFileState`.
- Successful post-L5 state:
  ```text
  chronyd.service ActiveState          = active
  chronyd.service UnitFileState        = <pre-L5 state unchanged>
  systemd-timesyncd.service ActiveState   = inactive
  systemd-timesyncd.service UnitFileState = <pre-L5 state unchanged>
  ```
- Rollback strictly restores runtime state:
  ```bash
  systemctl stop chronyd.service
  # If systemd-timesyncd was active pre-L5:
  systemctl start systemd-timesyncd.service
  ```
  If `systemd-timesyncd` was inactive pre-L5, rollback leaves/restores it inactive.
- Rollback verifies that `UnitFileState` for both services exactly matches the pre-L5 baseline.

*Status: APPROVED by Owner on 2026-09-20.*

---

## 4. Decision OD-L5-03 — Chrony Configuration Ownership and Path Verification

### Proposed Destination and Ownership Contract
The proposed project configuration destination and ownership for an L5-created or replaced configuration is:
```text
Destination: /etc/chrony.conf
Owner:       root
Group:       root
Mode:        0640
```
Key properties and rationale for this configuration:
- **No Committed Secrets:** The rendered configuration contains no committed secret value.
- **Owner-Supplied Upstream:** The trusted upstream NTP server remains owner-supplied at render/live time.
- **Deterministic Permission Contract:** Setting `root:root` with mode `0640` prevents world readability and establishes a single, deterministic file-permission contract.
- **No Chrony Group Requirement:** The design does not invent a chrony group requirement; ownership is strictly `root:root`.
- **Config Path Inspection:** Live use still requires read-only verification that the installed `chronyd.service` and its effective `ExecStart` rely on this expected configuration path before any apply action is attempted.

External Arch Linux documentation motivates this destination: the official distribution package defaults to `/etc/chrony.conf`, and L0 capture already tracks `time.file./etc/chrony.conf`. However, this becomes project authority only after owner approval.

### Mandatory Read-Only Precondition: Config Path Verification
Before any configuration write or service mutation occurs, the handler must perform a mandatory read-only inspection:
- Inspect the installed `chronyd.service` unit definition and effective `ExecStart` (e.g. via `systemctl cat chronyd.service` or `systemctl show -p ExecStart chronyd.service`).
- Verify that it relies on the standard default `/etc/chrony.conf` location.
- Explicitly detect any alternate config argument such as `-f <path>` or unexpected drop-in overrides.
- **Fail-Closed Rule:** If an alternate configuration path or unexpected unit override is present:
  ```text
  FAIL CLOSED reason=CONFIG_PATH_AUTHORITY_MISMATCH
  ```
  Do not write `/etc/chrony.conf` or proceed with apply in that case.

### Behavioral Requirements for Capture and Atomic Replacement
Rather than prescribing a specific utility like `install -D` (which does not by itself guarantee atomic filesystem replacement across all conditions), the implementation must satisfy these behavioral requirements:
1. **Pre-Existing File Safety and Non-Regular File Rejection:**
   - Check `/etc/chrony.conf`.
   - If `/etc/chrony.conf` exists as a symlink, FIFO, directory, socket, or special device, fail closed immediately (`CHRONY_CONF_NOT_REGULAR_FILE`).
   - If `/etc/chrony.conf` has unsupported file attributes, ACLs, or extended attributes: fail closed rather than claiming safe restoration capability (`CHRONY_CONF_UNSUPPORTED_ATTRIBUTES`).
2. **Pre-L5 Snapshot:**
   - If `/etc/chrony.conf` exists as a regular file, capture MUST record:
     * exact pre-existing regular file bytes (to `$WORK/chrony.conf.orig`)
     * original `uid`
     * original `gid`
     * original `mode`
     Record `PRE_CHRONY_CONF_EXISTS=YES`.
   - If absent pre-L5, record `PRE_CHRONY_CONF_EXISTS=NO`.
3. **Same-Filesystem Staging:** Create the rendered replacement file as a temporary regular file in the **same directory / filesystem** as the destination (e.g. `/etc/chrony.conf.tmp.XXXXXX`).
4. **Permissions & Ownership on Created File:** Set required restrictive ownership and mode on the temporary file (`owner = root`, `group = root`, `mode = 0640`) prior to replacement.
5. **Pre-Activation Validation:** Validate the temporary file content (via `p4-ntp.py validate`) before moving it into place.
6. **Atomic Replacement:** Atomically rename/replace the temporary file into `/etc/chrony.conf` (e.g. using `rename(2)` / `mv` on the same filesystem).
7. **Durable Write:** Ensure write durability (e.g. filesystem sync) before starting the service.
8. **No timesyncd file mutation:** `/etc/systemd/timesyncd.conf` and `/etc/systemd/timesyncd.conf.d/` are **NOT** modified.

### Rollback Restoration
- If `PRE_CHRONY_CONF_EXISTS=YES`:
  - Restore exact bytes from `$WORK/chrony.conf.orig` to `/etc/chrony.conf`.
  - Restore original `uid`, original `gid`, and original `mode`.
  - **Do NOT normalize** pre-existing file back to `root:root`/`0640` if original metadata differed.
- If `PRE_CHRONY_CONF_EXISTS=NO`:
  - Remove `/etc/chrony.conf`.
- No unrelated chrony or timesyncd files are touched.

*Status: APPROVED by Owner on 2026-09-20.*

---

## 5. Decision OD-L5-04 — Live NTP Query Verification

### Requirement
Prerequisites spec §5.3 requires:
> *"an AP-side NTP query is accepted and a non-AP query is not served"*

### Evaluation of Approaches
- **Option A: External Client Query Probes (Recommended).**
  An external client connected to the IDEA3 Wi-Fi AP (`wlp0s20f3`) sends an NTP query to `UDP <AEGIS_AP_ADDRESS>:123`, and an external client connected to the uplink/management network (`enp62s0`) attempts to query `UDP <AEGIS_UPLINK_ADDRESS>:123` and `UDP <AEGIS_AP_ADDRESS>:123`.
  - *Pros:* Tests real end-to-end service reachability and isolation across physical network boundaries without mutating Core network configuration.
  - *Cons:* Requires an external test station or client.
- **Option B: Temporary Network Namespace / Veth Pair on Core.**
  Create a temporary netns with veth pair routed to the AP interface.
  - *Rejected:* Creating veth pairs and netns mutates host network topology, violating L5's non-network-mutation boundary.
- **Option C: Infer from Bind and Firewall Rules Only.**
  Assert that chronyd is bound strictly to `<AEGIS_AP_ADDRESS>` and nftables permits only AP UDP/123.
  - *Rejected:* Fails to satisfy the literal requirement for an actual query verification.

### Proposed Decision
**Option A is the preferred operational approach.**

### Proof & Evidence Requirements
L2 firewall already verified accept on AP UDP/123 and zero forward / zero NAT. L5 must prove actual NTP service reachability on the AP path and absence of service exposure on non-AP paths without conflating L5 proof with L2 packet drop mechanics:

1. **AP-Side Reachability:** An AP-side client query to `UDP <AEGIS_AP_ADDRESS>:123` must receive a valid NTP packet (stratum > 0, leap != 3, valid timestamp). This proves actual service reachability.
2. **Non-AP Service Denial vs Routing Failure:**
   The non-AP query must prove that the service is **not exposed** to non-AP paths:
   ```text
   SERVICE_NOT_EXPOSED_TO_NON_AP
   ```
   rather than merely observing a network routing failure:
   ```text
   NO_ROUTE_TO_TARGET
   ```
3. **Criteria to Prove SERVICE_NOT_EXPOSED_TO_NON_AP:**
   - The non-AP client must have a route to Core's non-AP address (or the packet reaches Core on a non-AP path).
   - The non-AP client targets UDP/123 on the non-AP address/path.
   - No valid NTP response is returned to the non-AP client.
   - Core listener evidence (e.g. `ss -uln` or `/proc/net/udp`) proves `chronyd` is not bound to any non-AP or uplink address.
   - Core listener evidence proves no wildcard (`0.0.0.0:123` or `[::]:123`) UDP/123 listener exists.
4. **Firewall Drop Independence:**
   - L5 does **NOT** inspect iptables/nftables packet counters.
   - L5 does **NOT** observe or require kernel packet drop logs.
   - L5 does **NOT** claim or require proving that non-AP denial was specifically caused by an nftables rule versus socket bind rejection.
   - **Honest Evidence Statement:** L5 verifies that on a reachable non-AP path to Core, NTP service is NOT returned, and host socket evidence confirms Core is not serving non-AP NTP.
5. **Tooling Boundary:** The exact owner-run client tooling (e.g. specialized test script or utility) remains outside this design specification and is not invented here.
6. **Fixture Mode:** In automated fixture mode (`AEGIS_P4_FS_ROOT`), simulated query responses are provided via fixture stubs. No Production addresses or secrets are committed.

*Status: APPROVED by Owner on 2026-09-20.*

---

## 6. Decision OD-L5-05 — Chronyd Control Port Listener Contract

### Context and Analysis
Prerequisites spec §5.3 notes:
> *"NTP listens only on the AP address, plus the loopback control port if applicable"*

On Arch Linux, `chronyd` by default binds a command/control port on UDP 323 on loopback interfaces (`127.0.0.1:323` and `[::1]:323`) to allow `chronyc` local management.
- Setting `cmdport 0` in configuration would disable UDP 323 entirely. However, `p4-ntp.py validate` strictly enforces the 3-line configuration template (`server`, `bindaddress`, `allow`) and rejects `cmdport 0`. Modifying `p4-ntp.py` would invalidate the merged T6 contract.
- Therefore, retaining default chronyd loopback control access is the narrower and safer design.

### Proposed Listener Distinction
The listener contract distinguishes between the required data service and permitted-if-observed local command listeners:

1. **Required Data Listener:**
   ```text
   udp <AEGIS_AP_ADDRESS>:123
   ```
   Must be present and bound strictly to the AP address.
2. **Permitted-If-Observed Local Command Listeners (Optional):**
   ```text
   udp 127.0.0.1:323
   udp [::1]:323
   ```
   - Either or both loopback UDP/323 listeners may be present depending on installed chronyd package defaults.
   - The absence of UDP/323 is **NOT** a verification failure.
   - If present, they must be **strictly loopback-only**.
   - Any non-loopback or wildcard command binding (`0.0.0.0:323`, `[::]:323`, or uplink address) is an immediate **FAIL**.
3. **Local Unix-Domain Socket:**
   The Unix-domain control socket (`/run/chrony/chronyd.sock`) is local filesystem IPC and not a network listener drift.
4. **Strict Prohibitions:**
   - No `cmdallow` directives.
   - No wildcard NTP data serving (`0.0.0.0:123` or `[::]:123` forbidden).
   - No uplink NTP serving.

*Status: APPROVED by Owner on 2026-09-20.*

---

## 7. Rollback Design

Rollback must be stage-local, idempotent, and restore pre-L5 runtime time ownership without mutating `UnitFileState`, L4 AP addressing, or L2 firewall rules:

```text
1. Stop chronyd.service if L5 started it (systemctl stop chronyd.service)
2. Restore /etc/chrony.conf to exact pre-L5 state:
   - If pre-existing regular file: restore captured original bytes, original uid, original gid, and original mode (do NOT normalize to root:root/0640 if original metadata differed)
   - If absent pre-L5: remove /etc/chrony.conf
3. Restore systemd-timesyncd.service to captured pre-L5 ActiveState:
   - If active pre-L5 (standard live L5 baseline): systemctl start systemd-timesyncd.service
   - If inactive pre-L5 (e.g. test fixture or staged run): leave/restore inactive (do not start)
4. Do not mutate UnitFileState for either service; verify UnitFileState matches pre-L5 baseline
5. Wait for and prove TrustedClock returns to SYNCED
6. Require maxerror <= 1,000,000 us
7. Verify L4 AP profile, IP address, and dnsmasq remain active and unchanged
8. Verify L2 firewall rules and routing table remain active and unchanged
9. Idempotency: repeated rollback invocation executes safely without state mutation
```

### Rollback Invariants
- **No Persistence Mutation in Rollback:** Rollback does **NOT** run `systemctl disable` or `systemctl enable` for either service.
- **Metadata Fidelity on Rollback:** Rollback restores pre-existing configuration using its exact captured metadata (`bytes`, `uid`, `gid`, `mode`) without normalizing to `root:root`/`0640`.
- **Captured ActiveState Restoration:** Rollback restores the captured pre-L5 runtime ActiveState of `systemd-timesyncd.service` without touching `UnitFileState`.
- **Fail Closed on Sync Failure:** If the restored pre-L5 state fails to produce `TrustedClock = SYNCED` within the holdover bound, rollback is incomplete and must be reported as **FAILED** rather than inventing an unverified persistent state.
- Rollback finishing in `HOLDOVER`, `UNTRUSTED`, or `UNKNOWN` is **FAIL**.
- Rollback must not invoke L4 rollback or stop the AP radio.

---

## 8. Stop and Fail Conditions

Future L5 apply and verify must fail closed and stop immediately if any of the following occurs:
1. `AEGIS_L5_LIVE_AUTHORIZED != YES` in live mode.
2. User is not root in live mode.
3. Pre-handoff `systemd-timesyncd.service` is not `active` or not `running` in live mode (mandatory live entry precondition).
4. Pre-handoff Core `TrustedClock` is not `SYNCED`.
5. Pre-handoff kernel `maxerror` exceeds 1,000,000 µs.
6. Rendered chrony configuration fails `p4-ntp.py validate`.
7. `chronyd.service` unit or binary is absent on host.
8. Read-only config-path inspection detects alternate configuration argument (e.g. `-f`) or unexpected unit override (`CONFIG_PATH_AUTHORITY_MISMATCH`).
9. Target AP interface `wlp0s20f3` does not have an active IPv4 address.
10. AP address does not match owner-supplied `AEGIS_AP_ADDRESS`.
11. Table `inet aegis_idea3` is missing from nftables.
12. AP UDP/123 permit rule is missing from nftables.
13. Forwarding sysctl (`net.ipv4.ip_forward`) is non-zero.
14. Any NAT, SNAT, DNAT, or masquerade rule is detected.
15. `/etc/chrony.conf` exists as a symlink, FIFO, directory, socket, or special device (`CHRONY_CONF_NOT_REGULAR_FILE`).
16. `/etc/chrony.conf` possesses unsupported attributes or ACLs (`CHRONY_CONF_UNSUPPORTED_ATTRIBUTES`).
17. `systemctl stop systemd-timesyncd` returns non-zero.
18. `systemctl start chronyd` returns non-zero.
19. Kernel synchronization is not achieved by `chronyd` within `HOLDOVER_SEC` (300 s).
20. Final `TrustedClock` state is `HOLDOVER`, `UNTRUSTED`, or `UNKNOWN`.
21. Final kernel `maxerror` exceeds 1,000,000 µs.
22. UDP/123 is observed listening on `0.0.0.0`, `[::]`, or uplink address.
23. UDP/323 is observed listening on any non-loopback address.
24. External AP-side NTP query fails to receive valid NTP response.
25. External non-AP NTP query receives valid NTP response (service isolation failure: `SERVICE_EXPOSED_TO_NON_AP`).
26. Host socket evidence indicates non-AP NTP binding or wildcard NTP listener.
27. §10 IDEA2 preservation checks fail (engine or tunnel restarts, listener loss, or health failure).

---

## 9. External Reference Note (Background Context Only)

The following facts are noted from distribution inspection and standard documentation as background evidence only:
- On Arch Linux, the official `chrony` package compiles default configuration search path to `/etc/chrony.conf` and installs unit `chronyd.service`.
- `systemd-timesyncd` and `chronyd` both adjust the system clock via `adjtimex(2)` / `clock_adjtime(2)`. Running both concurrently leads to competing clock discipline.
- Chrony's command port defaults to UDP 323 on loopback (`127.0.0.1` and `::1`).
- `chronyc` can also administer `chronyd` via Unix domain socket `/run/chrony/chronyd.sock`.

*Note: External documentation provides context only and does not substitute for project owner approval.*

---

## 10. Owner Decision Record

The human owner explicitly reviewed and approved all five operational decisions in the project session on 2026-09-20. Repository L5 handler implementation is authorized; live execution remains strictly unauthorized.

- [x] OD-L5-01 service handoff sequence approved
- [x] OD-L5-02 runtime-only service state semantics approved
- [x] OD-L5-03 /etc/chrony.conf ownership/rollback approved
- [x] OD-L5-04 external AP/non-AP query evidence approach approved
- [x] OD-L5-05 loopback-only optional chronyd control-port contract approved

```text
OD_L5_01 = APPROVED
OD_L5_02 = APPROVED
OD_L5_03 = APPROVED
OD_L5_04 = APPROVED
OD_L5_05 = APPROVED

L5_OWNER_APPROVED = YES
L5_RUNTIME_IMPLEMENTATION_AUTHORIZED = YES
L5_IMPLEMENTATION_BLOCKED = NO

L5_LIVE_AUTHORIZED = NO
LIVE_L5 = NOT_RUN
PRODUCTION_MUTATION = NO
NETWORK_MUTATION = NO
REAL_NTP_MUTATION = NO
REAL_TIMESYNCD_MUTATION = NO
REAL_CHRONYD_MUTATION = NO
```

*Approval Note: The human owner explicitly approved all five OD-L5 decisions in the project session on 2026-09-20. This authorization permits beginning repository implementation and unit/fixture verification of the L5 handler in `stages/L5/`. It does not authorize live execution on the real host, and no live host mutation has been performed.*
