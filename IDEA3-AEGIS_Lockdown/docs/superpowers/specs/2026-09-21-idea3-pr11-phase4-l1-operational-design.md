# IDEA3 PR11 Phase 4 L1 — Package Installation Operational Design

Date: 2026-09-21
Owner: Music (Kla reviewing)
Task: PR11 Phase 4 L1 package-installation repository handler
Branch: `feat/idea3-pr11-phase4-l1-handler`
Status: REPOSITORY DESIGN — IMPLEMENTATION IN PROGRESS — LIVE L1 NOT AUTHORIZED
Scope: PR11 Phase 4 L1 repository operational design
Binding authority (merged):
- `2026-09-17-idea3-pr11-phase4-runtime-prerequisites.md` §L1, §2.1 (E-14, E-15, E-16, E-20, E-21), §5.2 (OD-01, OD-04, OD-06, OD-13), §10, §11 (S-09), §12 (A-L1)
- `2026-09-18-idea3-pr11-phase4-t5-ap-network-design.md` §2 (OD-01 NetworkManager AP mode, OD-04 manual Core AP IPv4, OD-05 DHCP, OD-07 nftables, OD-16 dnsmasq)
- `2026-09-18-idea3-pr11-phase4-t6-local-ntp-design.md` §1 (OD-06 chrony server)
- `deploy/pr11-phase4/p4-lib.sh` rollback-handler contract (G-15)
Repository Implementation: fixture backend only
Live L1: NOT AUTHORIZED / NOT RUN
Production Mutation: NO

> [!IMPORTANT]
> **Repository design does NOT authorize live L1.** Every decision below
> authorizes repository design, acceptance tests, and a stage handler exercised
> against **fixture Core material only**. Nothing here authorizes invoking
> pacman/apt/dnf against the real host, installing real packages, enabling or
> starting host services, or modifying `/etc` or `/opt` on the Core.
> `LIVE_L1_PROOF_REQUIRED=YES` and that proof does not exist.

No decision in this document carries `OWNER_APPROVED` unless the owner
approved it in a merged authority listed above. New repository decisions are
marked `REPOSITORY_DESIGN — OWNER_REVIEW_PENDING`.

---

## 1. Canonical State & Authority Markers

```text
POST_L9_MAIN_SHA=b4670eb31a30e1e71075c8e6421134e5d9fae8e5
CURRENT_MAIN_SHA=15ccee1597e31529f266bee822125393f01a5e23
PR166_MERGED=YES (L9 repository handler)
PR157_MERGED=YES (IDEA1 private vault; zero overlap with IDEA3/Phase 4)

L2_HANDLER=REGISTERED
L3_HANDLER=REGISTERED
L4_HANDLER=REGISTERED
L5_HANDLER=REGISTERED
L6A_HANDLER=REGISTERED
L6B_HANDLER=REGISTERED
L7_HANDLER=REGISTERED
L8_HANDLER=REGISTERED
L9_HANDLER=REGISTERED
L1_HANDLER=REGISTERED (by this task, fixture backend only)

P4_STAGES=L0 L1 L2 L3 L4 L5 L6a L6b L7 L8 L9   (unchanged)
P4_STAGE_GAPS_L1=G-15                           (unchanged)
P4_STAGE_AUTH_EXTRA_L1=d6_notice                (unchanged)

STAGE_TARGET_PACKAGE=chrony
PREEXISTING_HOST_PACKAGES=dnsmasq nftables networkmanager mosquitto
EXCLUDED_PACKAGES=hostapd

L1..L9_LIVE=NOT_RUN
L1_LIVE_AUTHORIZED=NO
PRODUCTION_MUTATION=NO
PHASE4_RUNTIME_COMPLETE=NO
PHASE4_LIVE_READINESS=NOT_READY
```

---

## 2. Reconciliation of Package Requirements from Merged Authority

The exact package inventory for Stage L1 is reconciled directly from merged repository truth:

| Topic | Merged Authority | Fact / Decision | L1 Outcome |
|---|---|---|---|
| AP Mode | `2026-09-18-idea3-pr11-phase4-t5-ap-network-design.md` §2 | **OD-01**: NetworkManager AP mode selected | `hostapd` is **excluded**. No hostapd package is required or installed. |
| AP Addressing | `2026-09-18-idea3-pr11-phase4-t5-ap-network-design.md` §2 | **OD-04**: manual Core AP IPv4; never NM shared mode | Handled by NetworkManager (already present). |
| DHCP & Local DNS | `2026-09-18-idea3-pr11-phase4-t5-ap-network-design.md` §2 | **OD-05 / OD-16**: dnsmasq provides AP DHCP and broker DNS | `dnsmasq 2.93` is **already installed** on host (Prerequisites §2.1 E-15). Pre-existing; not stage-owned delta. |
| Firewall Isolation | `2026-09-18-idea3-pr11-phase4-t5-ap-network-design.md` §2 | **OD-07**: dedicated IDEA3 nftables table (`aegis_idea3`) | `nftables 1.1.7` is **already installed** on host (Prerequisites §2.1 E-16). Pre-existing; not stage-owned delta. |
| Local Trusted NTP | `2026-09-18-idea3-pr11-phase4-t6-local-ntp-design.md` §1 | **OD-06**: Core-local NTP server implementation: `chrony` | `chrony` is **absent** on host (Prerequisites §2.1 E-14). **Stage-owned target package.** |
| Disk Headroom | `2026-09-17-idea3-pr11-phase4-runtime-prerequisites.md` §2.1 | **E-21**: Root filesystem 59G, 53G used, 3.8G available (94%) | **OD-13**: Owner remediation required before live install. Stop if usage violates threshold. |

**Reconciliation Verdict:**
- Single stage-owned package to be installed by L1: **`chrony`**.
- Pre-existing packages to verify and preserve: **`dnsmasq`**, **`nftables`**, **`networkmanager`**, **`mosquitto`**.
- Explicitly excluded packages: **`hostapd`**.
- Rollback scope: remove **only** `chrony`, preserving all pre-existing packages.

---

## 3. Stage Scope and Registration Mechanics

### 3.1 Stage scope

- **Stage L1 (this scope):** Install ONLY packages required by the selected OD-01 / OD-06 implementation:
  - Verify disk headroom against owner threshold before any write;
  - Install strictly `chrony` in fixture mode (live mode fails closed);
  - Refuse unrelated upgrades (kernel, systemd, NetworkManager, Mosquitto);
  - Verify `chronyd.service` is NOT enabled and NOT started;
  - Verify zero new listeners;
  - Rollback removes ONLY stage-installed `chrony` delta and proves zero drift.
- **Out of scope:** configuring chrony (`/etc/chrony.conf` rendered in T6/L5), starting chronyd (L5), AP activation (L3), AP addressing (L4), broker TLS (L6a/L6b), Core start (L7), ESP32 flash (L8), authentication observation (L9), CUT/RESTORE (L10+).

### 3.2 Registration mechanics

`p4-lib.sh` already lists `L1` in `P4_STAGES`, reports `p4_stage_gaps L1 = G-15`, and requires `d6_notice` extra authorization.
`p4_stage_handler_status L1` becomes `REGISTERED` when all five files exist:
`stages/L1/apply.sh`, `verify.sh`, `rollback.sh`, `allow-keys.txt`, and `allow-listeners.txt`.

### 3.3 Shared harness fixture (shared surface)

Registering L1 means all mutating stages in `P4_STAGES` (`L1` through `L9`) have registered handlers.
To ensure `test_gate_live_mode_for_mutating_stage_fails_without_registered_handler` continues to verify that an unregistered mutating stage fails closed in live mode without inventing a fake production stage (such as L10):
- `p4-lib.sh` defines `readonly P4_HANDLER_DIR="${AEGIS_P4_HANDLER_DIR:-$P4_HERE/stages}"`, matching the established `AEGIS_P4_FS_ROOT` pattern.
- The harness test points `AEGIS_P4_HANDLER_DIR` to an isolated synthetic directory missing the handler, proving `p4-stage-gate.sh` fails closed with `ROLLBACK_HANDLER_NOT_REGISTERED` on a real mutating stage (`L1`).
- `test_only_reviewed_stage_handlers_are_registered` is updated to include `L1` in the reviewed-handler allowlist.

### 3.4 Host drift contract

Stage L1 installs package files only. It enables no services and opens no listeners.
- `allow-keys.txt`: Permitted drift keys are strictly limited to the minimal passive package registration keys:
  `svc.chronyd.service.LoadState`, `svc.chronyd.service.UnitFileState`, `time.chrony.leap`,
  `time.file./etc/chrony.conf.class`, `time.file./etc/chrony.conf.meta`, `time.file./etc/chrony.conf.sha256`.
  Zero service `ActiveState` drift is permitted (`chronyd` remains inactive).
- `allow-listeners.txt`: Strictly **zero active entries** (no listening ports opened).
- Rollback: Reverts all stage-added files, restoring PRE state with `HOST_PRE_TO_RB_ZERO_DRIFT=YES`.

---

## 4. Operational Decisions (OD-L1-01 … OD-L1-10)

### OD-L1-01 — Package requirement source of truth

- **DECISION**: The stage-owned package target for Stage L1 is strictly and solely `chrony`.
  Under merged owner decisions:
  - OD-01 selected NetworkManager AP mode (`hostapd` is excluded).
  - OD-04 selected manual Core AP IPv4.
  - OD-05 / OD-16 selected DHCP and local DNS via `dnsmasq` (already installed per E-15).
  - OD-06 selected `chrony` as the local NTP server (absent per E-14).
  - OD-07 selected dedicated nftables table (`nftables` already installed per E-16).
  No package other than `chrony` is stage-owned. Extra or unknown package requests are refused fail-closed.
- **BASIS**: Prerequisites §L1, §2.1 (E-14, E-15, E-16); `2026-09-18-idea3-pr11-phase4-t5-ap-network-design.md` §2; `2026-09-18-idea3-pr11-phase4-t6-local-ntp-design.md` §1.
- **OWNER_STATUS**: `OWNER_APPROVED` for OD-01, OD-04, OD-05, OD-06, OD-07, OD-16. L1 reconciliation is `REPOSITORY_DESIGN — OWNER_REVIEW_PENDING`.
- **CURRENTLY_PROVEN**: Core evidence E-14, E-15, E-16 recorded in merged prerequisite specification.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: Strict package target allowlist (`['chrony']`) enforced in `apply.sh` and helper.
- **LIVE_PROOF_REQUIRED**: Core host package audit proves `chrony` is absent prior to L1 and present after L1.
- **SECURITY_SAFETY_EFFECT**: Prevents installation of extraneous or unreviewed software on the Core host.
- **TEST_IMPLICATION**: Acceptance tests verify that requesting unapproved packages (e.g. `hostapd`, `nginx`, `gcc`) is rejected fail-closed.
- **OPEN_QUESTION**: None.

### OD-L1-02 — Package manager simulation and dual-layer backend guard

- **DECISION**: Dual-layer backend architecture. The repository handler supports only `fixture` backend; `live` backend is refused with `fail LIVE_BACKEND_NOT_IMPLEMENTED_IN_REPOSITORY (LIVE_L1=NOT_AUTHORIZED)` at both the shell layer (`apply.sh`) and Python helper layer (`p4-l1-packages.py`). In fixture mode, installation mutates only an isolated test filesystem root (`AEGIS_P4_FS_ROOT`), creating simulated binaries `/usr/bin/chronyd`, `/usr/bin/chronyc`, unit `/usr/lib/systemd/system/chronyd.service`, and default `/etc/chrony.conf`. Real package managers (`pacman`, `yay`, `paru`, `apt`, `dnf`) are never invoked.
- **BASIS**: Prerequisites §L1, §11 (S-09); L8/L9 two-layer refusal precedent.
- **OWNER_STATUS**: `REPOSITORY_DESIGN — OWNER_REVIEW_PENDING`.
- **CURRENTLY_PROVEN**: Fixture filesystem isolation proven across L2–L7 test suites.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: Two-layer backend check; static code scan proving no prohibited package manager invocation.
- **LIVE_PROOF_REQUIRED**: Separately authorized live A-L1 execution window using reviewed pacman wrapper with owner confirmation.
- **SECURITY_SAFETY_EFFECT**: Eliminates possibility of modifying host OS, dependencies, or running services during CI or development.
- **TEST_IMPLICATION**: Tests verify rejection of `AEGIS_L1_BACKEND=live` in `apply.sh`, in `p4-l1-packages.py`, and when called directly. Static scans verify 0 occurrences of real package-manager commands in execution paths.
- **OPEN_QUESTION**: Live pacman invocation flags to be reviewed by owner prior to live A-L1.

### OD-L1-03 — Unrelated-upgrade refusal

- **DECISION**: L1 must refuse any package manager request that attempts a system upgrade (`-Syu`, `-Su`), or that would modify, upgrade, or reinstall unrelated packages—especially the Linux kernel (`linux`, `linux-firmware`), `systemd`, `NetworkManager`, or `mosquitto`. Any operation that causes a version bump or replacement of any package outside `chrony` must fail closed immediately with `UNRELATED_UPGRADE_REFUSED`.
- **BASIS**: Prerequisites §L1: "Stop if: the package manager wants to upgrade unrelated packages (for example the kernel, systemd, NetworkManager, or Mosquitto)".
- OWNER_STATUS: `OWNER_APPROVED` (Prerequisites §L1 stop condition).
- **CURRENTLY_PROVEN**: Policy asserted by prerequisite spec.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: Simulation rejects any upgrade transactions; helper enforces that transaction delta consists exclusively of `chrony`.
- **LIVE_PROOF_REQUIRED**: Live dry-run (`pacman -Sp` or `--print`) parsed to ensure transaction contains only `chrony` before execution.
- **SECURITY_SAFETY_EFFECT**: Guarantees host kernel, systemd 261, NetworkManager, and Mosquitto stability; prevents breaking co-resident IDEA2 or network routing.
- **TEST_IMPLICATION**: Tests simulate package manager output containing kernel/systemd/NetworkManager/Mosquitto upgrade proposals and assert immediate failure.
- **OPEN_QUESTION**: None.

### OD-L1-04 — Service enable and start refusal

- **DECISION**: Installing packages must strictly NOT enable and NOT start any service. Specifically, `chronyd.service` must remain in `ActiveState=inactive` and `UnitFileState=disabled` (or `static`). Any post-install script, systemd preset, or package hook that attempts to activate, start, or enable a service causes immediate fail-closed abort with `SERVICE_MUTATION_REFUSED`. L1 apply and verify handlers explicitly verify `chronyd.service` is inactive and disabled.
- **BASIS**: Prerequisites §L1: "Action: install only the selected packages. Do not enable or start any service. Stop if: installation pulls in, enables, or starts a service."
- **OWNER_STATUS**: `OWNER_APPROVED` (Prerequisites §L1 action and stop condition).
- **CURRENTLY_PROVEN**: Arch Linux default pacman packaging policy does not auto-start services on install.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: In fixture mode, verify mock unit file is placed in `/usr/lib/systemd/system/` without enabling symlinks in `/etc/systemd/system/` and without running processes.
- **LIVE_PROOF_REQUIRED**: Post-install verification on live host proves `systemctl is-active chronyd` returns inactive and `systemctl is-enabled chronyd` returns disabled.
- **SECURITY_SAFETY_EFFECT**: Prevents premature NTP daemon startup before configuration and upstream time binding are rendered in L5; prevents rogue network listeners.
- **TEST_IMPLICATION**: Tests verify that if `chronyd.service` is enabled or active after apply, verification fails.
- **OPEN_QUESTION**: None.

### OD-L1-05 — Disk-headroom gate

- **DECISION**: Preflight disk headroom verification is mandatory before executing package operations. The available disk space on the root filesystem `/` must not violate the owner threshold `DISK_THRESHOLD_PCT` (default threshold 90%, or user-specified 1-99). E-21 observed 94% usage (3.8 GB available of 59 GB). Because E-21 is above 90%, owner remediation (OD-13) or explicit approved threshold setting is required before live execution. In repository tests, disk usage is checked against the threshold and fails closed if usage >= threshold or headroom is insufficient.
- **BASIS**: Prerequisites §2.1 (E-21), §5.2 (OD-13, M-30), §L1: "Stop if: disk headroom falls below the owner threshold"; `p4-compare.sh` `DISK_THRESHOLD_PCT` semantics.
- **OWNER_STATUS**: `OWNER_APPROVED` (Prerequisites §L1 stop condition, OD-13).
- **CURRENTLY_PROVEN**: `df` parsing and threshold enforcement proven in `p4-l0-capture.sh` and `p4-compare.sh`.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: `p4-l1-packages.py` `check-headroom` subcommand and `apply.sh` gate; checks `df -P -k /` against `DISK_THRESHOLD_PCT`.
- **LIVE_PROOF_REQUIRED**: Owner must remediate root filesystem disk space (OD-13) so that live usage is below approved threshold before live A-L1.
- **SECURITY_SAFETY_EFFECT**: Prevents package installation from filling root filesystem and causing system lockup or database corruption.
- **TEST_IMPLICATION**: Tests verify fail-closed exit when simulated disk usage meets or exceeds `DISK_THRESHOLD_PCT`, and pass when usage is below threshold.
- **OPEN_QUESTION**: Remediation steps for live host root filesystem (OD-13) remain an owner responsibility.

### OD-L1-06 — Package-presence verification

- **DECISION**: Post-install verification proves the exact presence of the required package artifacts:
  1. `/usr/bin/chronyd` (regular executable file)
  2. `/usr/bin/chronyc` (regular executable file)
  3. `/usr/lib/systemd/system/chronyd.service` (regular unit file)
  4. Package database entry confirming `chrony` installed.
  Verification also confirms that pre-existing packages `dnsmasq` and `nftables` remain present and undamaged.
- **BASIS**: Prerequisites §L1 ("Verify: packages present, units disabled/inactive").
- **OWNER_STATUS**: `REPOSITORY_DESIGN — OWNER_REVIEW_PENDING`.
- **CURRENTLY_PROVEN**: Binary paths verified in Arch Linux package database and L5 handler unit config tests.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: Read-only verification helper checking files under `AEGIS_P4_FS_ROOT`.
- **LIVE_PROOF_REQUIRED**: Live `pacman -Q chrony` and `which chronyd chronyc`.
- **SECURITY_SAFETY_EFFECT**: Ensures that required binaries are in place for subsequent Stage L5 without partial or corrupted installs.
- **TEST_IMPLICATION**: Tests verify verification passes when all expected files exist, and fails if any expected binary or unit is missing.
- **OPEN_QUESTION**: None.

### OD-L1-07 — Listener and unit preservation

- **DECISION**: L1 must open ZERO network listeners. `allow-listeners.txt` carries exactly 0 active entries. No sockets may be opened on UDP 123, UDP 323, TCP 8883, TCP 1883, TCP 8077, TCP 18002, or any other port. All pre-existing services (`systemd-timesyncd`, `NetworkManager`, `mosquitto`, IDEA2 engine/tunnel) must retain their exact `ActiveState` and `SubState`.
- **BASIS**: Prerequisites §L1 ("Verify: no new listener, §10 preservation checks").
- **OWNER_STATUS**: `OWNER_APPROVED` (Prerequisites §L1 verification).
- **CURRENTLY_PROVEN**: Zero-listener contract verified across L2, L3, L6a, L7, L8, L9.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: `allow-listeners.txt` with zero active lines; verification checks `ss` or fixture listeners.
- **LIVE_PROOF_REQUIRED**: Live `p4-compare.sh` PRE to POST comparison proves zero listener additions.
- **SECURITY_SAFETY_EFFECT**: Guarantees L1 does not expose network services or interfere with active time synchronization (`systemd-timesyncd`).
- **TEST_IMPLICATION**: Tests assert `allow-listeners.txt` has 0 active entries and that any added listener causes verify failure.
- **OPEN_QUESTION**: None.

### OD-L1-08 — Rollback removes only stage-owned package delta

- **DECISION**: Stage L1 rollback removes ONLY the packages installed by Stage L1 (`chrony`). It must NEVER remove pre-existing packages (`dnsmasq`, `nftables`, `NetworkManager`, `mosquitto`), even if they are part of the broader Phase 4 topology. Rollback verifies that `chronyd.service` is not left enabled or active, and deletes the installed binaries, unit, and default config files. Rollback is idempotent: repeated execution exits 0 and produces no additional drift.
- **BASIS**: Prerequisites §L1 ("Rollback: remove the installed packages; verify no leftover enabled units or listeners. Stop if: ...").
- **OWNER_STATUS**: `OWNER_APPROVED` (Prerequisites §L1 rollback contract).
- **CURRENTLY_PROVEN**: Idempotent rollback pattern proven across L2–L9 handlers.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: `rollback.sh` and helper remove strictly `chrony` artifacts; preserve pre-existing files; idempotent execution.
- **LIVE_PROOF_REQUIRED**: Live rollback removes `chrony` via `pacman -Rns chrony` and confirms host PRE to RB comparison has zero drift.
- **SECURITY_SAFETY_EFFECT**: Guarantees clean rollback to pre-stage state without breaking base system networking or services.
- **TEST_IMPLICATION**: Tests prove rollback removes `chrony`, preserves pre-existing `dnsmasq`/`nftables`, is idempotent, and leaves zero leftover files.
- **OPEN_QUESTION**: None.

### OD-L1-09 — G-15 host-preservation interaction and allow-keys

- **DECISION**: `allow-keys.txt` for Stage L1 contains only the minimal, exact keys permitted to drift in `p4-l0-capture.sh` when `chrony` is installed in an inactive, disabled state:
  ```text
  svc.chronyd.service.LoadState
  svc.chronyd.service.UnitFileState
  time.chrony.leap
  time.file./etc/chrony.conf.class
  time.file./etc/chrony.conf.meta
  time.file./etc/chrony.conf.sha256
  ```
  Protected keys (sysctl, idea2, net.route, cap, listen, disk) are strictly forbidden in `allow-keys.txt`.
  On rollback, all these changes are reverted, resulting in `HOST_PRE_TO_RB_ZERO_DRIFT=YES`.
- **BASIS**: `deploy/pr11-phase4/p4-compare.sh` §G-15; Prerequisites §10, §L1.
- **OWNER_STATUS**: `REPOSITORY_DESIGN — OWNER_REVIEW_PENDING`.
- **CURRENTLY_PROVEN**: Capture format for chronyd and chrony.conf proven in `p4-l0-capture.sh` and L5 handler tests.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: Stage L1 `allow-keys.txt` with exact 6 lines; `allow-listeners.txt` with 0 active lines.
- **LIVE_PROOF_REQUIRED**: Live L0 capture PRE vs POST compared with `allow-keys.txt` produces `COMPARE_RESULT=PASS`. PRE vs RB with empty allow files produces `COMPARE_RESULT=PASS`.
- **SECURITY_SAFETY_EFFECT**: Enforces strict change control; any unexpected host drift (e.g. service activation, route change, listener change) fails the stage.
- **TEST_IMPLICATION**: Tests verify that `p4-compare.sh` passes PRE vs POST with L1 `allow-keys.txt`, and passes PRE vs RB with zero drift.
- **OPEN_QUESTION**: None.

### OD-L1-10 — Live-proof boundary and authorization gates

- **DECISION**: Live execution of Stage L1 is strictly BLOCKED and NOT AUTHORIZED in this repository task (`LIVE_L1=NOT_AUTHORIZED`, `PRODUCTION_MUTATION_ALLOWED=NO`). Live execution requires all of:
  1. Merged G-15 capture harness (merged in PR #146).
  2. Fresh same-day K3 written confirmation from IDEA1 owner (`kraveerachat`).
  3. Same-day A-L1 authorization signed by Music.
  4. D6 notice to Pub for detector co-residence.
  5. Owner remediation of disk headroom (OD-13) meeting approved threshold.
  6. Dedicated owner-supervised production window.
  The repository handler provides the deterministic implementation, test fixtures, and verification gates only.
- **BASIS**: Prerequisites §4, §8, §12 (Table of gates: A-L1 authorizer = Music, D6 notice to Pub); S-01, S-09, S-10.
- **OWNER_STATUS**: `OWNER_APPROVED` (Prerequisites §12).
- **CURRENTLY_PROVEN**: Preconditions recorded and enforced in `p4-stage-gate.sh`.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: Fail-closed live gate in `apply.sh` and `p4-l1-packages.py`.
- **LIVE_PROOF_REQUIRED**: Live execution authorized only after human review and formal gates.
- **SECURITY_SAFETY_EFFECT**: Protects the production Core host and co-resident IDEA2 detector from uncoordinated mutation.
- **TEST_IMPLICATION**: Gate tests prove that live mode fails without required authorizations and handlers.
- **OPEN_QUESTION**: Scheduling of live Phase 4 execution window with Pub and Kla.
