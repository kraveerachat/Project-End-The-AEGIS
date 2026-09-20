# IDEA3 PR11 Phase 4 L6a — Isolated TLS / PKI Validation Operational Design

Date: 2026-09-20  
Owner: Music (Kla reviewing)  
Task: PR11 Phase 4 L6a Isolated TLS / PKI Validation Operational Design  
Branch: `feat/idea3-pr11-phase4-l6a-handler`  
Status: OWNER APPROVED FOR REPOSITORY IMPLEMENTATION  
Approval Date: 2026-09-20  
Scope: PR11 Phase 4 L6a repository operational design  
Repository Implementation: AUTHORIZED  
Live L6a: NOT AUTHORIZED / NOT RUN  
Production Mutation: NO  
Network Mutation: NO  
Systemd Mutation: NO  

> [!IMPORTANT]
> **Repository design approval does NOT constitute live L6a approval.**  
> Repository implementation authorizes development of handler scripts, tests, and validator enhancements using fixture data, throwaway PKI, and loopback sockets only. Live execution of L6a remains unauthorized and separately gated by maintenance window prerequisites.

---

## 1. Authority, Context, and Problem Statement

Phase 4 runtime architecture establishes strict separation between pre-flight isolated validation (**L6a**) and separate live broker deployment (**L6b**):
- **L6a**: Ephemeral, strictly loopback validation proving PKI profile adherence, TLS handshakes, client authentication, and access control matrix enforcement without network exposure.
- **L6b**: Separate live deployment of `aegis-idea3-mosquitto.service` bound to the AP interface (`<AEGIS_AP_ADDRESS>:8883`) while strictly preserving the legacy system broker (`mosquitto.service` on 1883).

Prior to this operational design, previous design iterations identified concrete operational gaps in existing tooling:
1. Input validation (`Path.stat()` / `Path.is_file()`) followed symlinks rather than rejecting them.
2. Port 1883 was not explicitly rejected during isolated validation.
3. Python TLS client hostname verification failed against pure DNS SAN certificates (`DNS:mqtt.aegis.home.arpa`) when connecting over loopback (`127.0.0.1`).
4. Negotiated runtime TLS version ($\ge$ TLS 1.2) was not dynamically verified on the connected socket.
5. Existing certificate linting did not reject extra IP SAN entries.
6. Runtime negative authentication proof for invalid passwords was absent.
7. Ambiguity existed regarding process lifecycle ownership between `apply.sh` and `p4-broker-validate.py`.
8. Rollback lacked a defense against PID reuse and a contract for preserving non-secret failure evidence.

Human owner review on 2026-09-20 approved all seven operational decisions (**OD-L6A-01 through OD-L6A-07**) for repository implementation.

---

## 2. Canonical Stage Context & Gap Contract

### 2.1 Repository Stage Alignment
The authoritative Phase 4 runtime stage ownership defined across the repository is:

| Stage ID | Canonical Stage Responsibility | Gaps Listed in `p4-lib.sh` | Repository Handler Status | Live Execution Status |
|---|---|---|---|---|
| `L2` | Firewall isolation / forwarding persistence | `G-06,G-15` | `REGISTERED` | `NOT RUN` |
| `L3` | AP radio / NetworkManager AP profile | `G-01,G-03,G-15` | `REGISTERED` | `NOT RUN` |
| `L4` | AP IPv4 addressing + DHCP + Core-local DNS | `G-02,G-04,G-15` | `REGISTERED` | `NOT RUN` |
| `L5` | Core-local trusted NTP / timesyncd $\rightarrow$ chronyd handoff | `G-05,G-15` | `REGISTERED` | `NOT RUN` |
| **`L6a`** | **Isolated TLS / PKI / broker validation** | **`G-07,G-08,G-09,G-10,G-14,G-15`** | **`NOT_REGISTERED`** | **`NOT RUN`** |
| `L6b` | Separate live IDEA3 TLS broker service | `G-07,G-15` | `REGISTERED` | `NOT RUN` |

### 2.2 Registration Mechanics
In `deploy/pr11-phase4/p4-lib.sh`, `p4_stage_handler_status()` evaluates stage registration solely by checking the physical existence of five files in `stages/<STAGE>/`:
- `apply.sh`
- `verify.sh`
- `rollback.sh`
- `allow-keys.txt`
- `allow-listeners.txt`

**No code edit to `p4-lib.sh` is required merely to register L6a.** Registration occurs automatically when all five handler files are added to `deploy/pr11-phase4/stages/L6a/`.

---

## 3. Decision OD-L6A-01 — Material Authority, File Types, and Permissions

### 3.1 Input Directory Contract
L6a requires an explicit operator-supplied directory:
- Environment variable: `AEGIS_L6A_INPUT_DIR`
- Properties: **REQUIRED**, owner/operator supplied, **NO default value**.
- Must be a non-symlink directory with mode `0700` or `0755`.

### 3.2 Expected Input Materials
Inside `AEGIS_L6A_INPUT_DIR`, exactly five files are expected:
1. `ca.crt`: Dedicated MQTT CA certificate (public trust anchor).
2. `broker.crt`: Pre-signed broker leaf certificate.
3. `broker.key`: Broker private key.
4. `core.pass`: Plaintext password for `idea3-core`.
5. `device.pass`: Plaintext password for `idea3-dev-aegis-relay-01`.

### 3.3 Custody and Identity Invariants
- **No CA Private Key**: Under no circumstances is the dedicated MQTT CA private key supplied to L6a or present on the Core host. CA custody remains strictly offline in owner control (`docs/operations/idea3-mqtt-pki.md`).
- **No Client Certificates**: Authentication is strictly username/password ACL authentication. Client certificates are not part of this authentication authority.
- **Identities**: Exactly `idea3-core` and `idea3-dev-aegis-relay-01`.

### 3.4 File-Type & Permission Enforcement
Existing tooling relies on `Path.stat()` and `Path.is_file()`, both of which follow symlinks (`stat(2)`), creating a vulnerability where symlinked secrets or non-regular files could be ingested. L6a establishes a strict fail-closed contract:
- **Symlink Check**: Every input file must be tested with `os.lstat()` / `path.is_symlink()` / `[ -L "$path" ]`. Any symlink input must trigger immediate fatal abort.
- **Non-Regular File Check**: Must verify `stat.S_ISREG(lstat.st_mode)`. FIFOs, Unix domain sockets, directories, block devices, and character devices are strictly rejected.
- **Permission Modes**:
  - `broker.key`: Regular file, non-symlink, exact permission `0600` or `0400`.
  - `core.pass`: Regular file, non-symlink, exact permission `0600` or `0400`.
  - `device.pass`: Regular file, non-symlink, exact permission `0600` or `0400`.
  - `ca.crt`, `broker.crt`: Regular files, non-symlinks, readable (`0644` or `0400`), strictly non-writable by group or others.

### 3.5 Material Disposal
Upon completion or rollback, **temporary plaintext material is unlinked/removed**. The documentation explicitly notes that unlinking (`unlink(2)`) removes the filesystem directory entry and inode reference; it does not guarantee physical forensic secure erasure of underlying flash storage.

*Status: APPROVED by Owner on 2026-09-20.*

---

## 4. Decision OD-L6A-02 — Single Broker Owner, Port Contract, and Process Ownership

### 4.1 Single Lifecycle Owner
To eliminate architectural contradictions, **`p4-broker-validate.py` is the sole lifecycle owner of the temporary Mosquitto process**:
- `stages/L6a/apply.sh` prepares temporary configuration and materials in `$AEGIS_L6A_WORK_DIR`, invokes `p4-broker-validate.py` once, and verifies clean exit.
- `apply.sh` **never starts a Mosquitto process directly**.

### 4.2 Port Contract: Required Explicit Port
Rather than relying on TOCTOU-vulnerable socket-probing helpers (`bind 127.0.0.1:0`), L6a requires an explicit port:
- Environment variable: `AEGIS_L6A_PORT`
- Properties: **REQUIRED**, non-secret, **NO default value**.
- Allowed Range: Valid unprivileged TCP port (`1025..65535`).
- Forbidden Ports:
  - `1883`: Plaintext MQTT port (strictly forbidden: `S-12`).
  - `8883`: Live production TLS port (strictly forbidden).
- Binding Interface: Strictly loopback (`127.0.0.1`). Binding to `0.0.0.0`, external IPs, or AP addresses is rejected.
- Preflight vs. Authoritative Binding: An initial check confirming `127.0.0.1:$AEGIS_L6A_PORT` is currently free serves only as an early safety check. The **authoritative success condition** is Mosquitto successfully binding and opening the listener. If Mosquitto fails to bind or start, the stage **fails closed immediately**. It will not guess, retry, or select another port.

### 4.3 Process Ownership Tracking & PID Reuse Defense
To allow safe, deterministic cleanup if `p4-broker-validate.py` is interrupted:
1. Upon invoking `subprocess.Popen(["mosquitto", "-c", str(config)])`, the validator captures and writes process metadata to `$AEGIS_L6A_WORK_DIR/broker-process.json`:
   - `pid`: Process ID (integer).
   - `start_time`: Process start time ticks from `/proc/$PID/stat` (field 22).
   - `boot_id`: Kernel boot UUID from `/proc/sys/kernel/random/boot_id`.
   - `config_path`: Absolute canonical path to the ephemeral config file.
   - `executable`: Canonical path to the Mosquitto binary (`/usr/bin/mosquitto`).
2. Python signal handlers (`SIGINT`, `SIGTERM`) intercept aborts, terminate the child process (`SIGTERM`, wait 3s, `SIGKILL`), confirm listener closure, and update metadata.
3. **Rollback Ownership Guard**:
   `stages/L6a/rollback.sh` will terminate a process **only** if:
   - PID is active (`kill -0 $PID`).
   - `/proc/$PID/stat` field 22 matches `start_time` AND `/proc/sys/kernel/random/boot_id` matches `boot_id` (**defending against PID recycling and reuse**).
   - `/proc/$PID/cmdline` exactly matches the recorded executable and config file path.
   - `/proc/$PID/exe` resolves to the recorded Mosquitto binary.
   If any check fails or is unverifiable: **DO NOT KILL. Trigger `S-11 HOLD / ESCALATE`.**
   Generic commands (`pkill mosquitto`, `killall`, `pgrep`) are strictly prohibited. The legacy broker (`mosquitto.service`) and L6b broker (`aegis-idea3-mosquitto.service`) must never be touched.

*Status: APPROVED by Owner on 2026-09-20.*

---

## 5. Decision OD-L6A-03 — TLS $\ge$ 1.2, Exact DNS-Only SAN, and Hostname Verification

### 5.1 Canonical PKI Profile
- **CA Subject**: `AEGIS IDEA3 MQTT CA`
- **Hostname**: `mqtt.aegis.home.arpa`
- **Broker Leaf SAN**: Exactly `DNS:mqtt.aegis.home.arpa`. The IP-literal G-09 branch was not selected.
- **EKU**: `serverAuth` (`TLS Web Server Authentication`).
- **Profile Hardening (Extra IP SAN Rejection)**: Existing `p4-mqtt-pki.py` checks for the presence of `DNS:mqtt.aegis.home.arpa` as a substring, which does not reject certificates that also include unapproved IP SANs (`IP:127.0.0.1`). Future L6a PKI validation must parse SAN extensions and enforce an exact DNS-only set: `DNS:mqtt.aegis.home.arpa` present, zero IP SANs, zero extra DNS SANs (`EXTRA_IP_SAN_REJECTION_CURRENT=NO`).

### 5.2 Scoped Resolver Override for Runtime Loopback Verification
Connecting to `127.0.0.1` causes TLS hostname verification to fail against pure DNS SAN certs. Modifying `/etc/hosts` or relying on external DNS is forbidden.

**Approved Mechanism**: In `p4-broker-validate.py`, wrap connection establishment in a strictly scoped, process-local resolver hook:
```python
@contextlib.contextmanager
def scoped_dns_override(hostname: str, target_ip: str):
    orig_getaddrinfo = socket.getaddrinfo

    def patched_getaddrinfo(host, port, *args, **kwargs):
        if host == hostname:
            return orig_getaddrinfo(target_ip, port, *args, **kwargs)
        raise socket.gaierror(f"External DNS resolution forbidden during L6a: {host}")

    socket.getaddrinfo = patched_getaddrinfo
    try:
        yield
    finally:
        socket.getaddrinfo = orig_getaddrinfo
```
- **Execution Flow**: Wrap the call `client.connect("mqtt.aegis.home.arpa", port)` within this context.
- **Invariants**:
  1. TCP route goes strictly to `127.0.0.1:$AEGIS_L6A_PORT`.
  2. TLS SNI and hostname verification evaluate `mqtt.aegis.home.arpa` against the server cert.
  3. No external DNS queries occur (unrelated lookups raise `socket.gaierror`).
  4. `/etc/hosts` is never touched.
  5. Original `getaddrinfo` is restored in `finally`.
  6. Client is configured with `reconnect_on_failure=False` to prevent background reconnections outside the scoped resolver lifetime.
  *(This mechanism is design-approved; implementation will be proven by tests).*

### 5.3 Runtime Negotiated TLS Version Verification
Static config requires `tls_version tlsv1.2`. In addition, runtime L6a must dynamically query the active socket:
```python
ssl_sock = client.socket()
version = ssl_sock.version() if ssl_sock else None
if version not in ("TLSv1.2", "TLSv1.3"):
    raise RuntimeError(f"Forbidden negotiated TLS version: {version}")
```
Only after observing version `TLSv1.2` or `TLSv1.3` on the active socket may the validator record `TLS_RUNTIME_VERSION=PASS`. No new cipher allowlists are introduced.

*Status: APPROVED by Owner on 2026-09-20.*

---

## 6. Decision OD-L6A-04 — Authentication and Exact ACL Matrix

### 6.1 Identities & Topics
- **Core Identity**: `idea3-core`
- **Device Identity**: `idea3-dev-aegis-relay-01`
- **Topics**:
  1. `aegis/idea3/v1/aegis-relay-01/command`
  2. `aegis/idea3/v1/aegis-relay-01/heartbeat`
  3. `aegis/idea3/v1/aegis-relay-01/ack`
  4. `aegis/idea3/v1/aegis-relay-01/status`

### 6.2 Exact ACL Matrix Enforcement
`p4-broker-validate.py` already implements the exact T2 ACL matrix through positive delivery and forbidden delivery checks:
- **`idea3-core`**:
  - `command`: WRITE only
  - `heartbeat`: WRITE only
  - `ack`: READ only
  - `status`: READ only
- **`idea3-dev-aegis-relay-01`**:
  - `command`: READ only
  - `heartbeat`: READ only
  - `ack`: WRITE only
  - `status`: WRITE only

The 16 directional permutations (4 topics $\times$ 2 users $\times$ 2 operations: 8 positive allowed, 8 negative denied) are preserved.

### 6.3 Negative Authentication Hardening
Existing tooling verifies anonymous connection rejection and retained message rejection, but lacks runtime wrong-password probes (`WRONG_PASSWORD_RUNTIME_PROOF_CURRENT=NO`). L6a adds:
1. `validate_wrong_password_rejected()` for `idea3-core`.
2. `validate_wrong_password_rejected()` for `idea3-dev-aegis-relay-01`.
Both must be rejected with connection failure (`CONNACK_REFUSED_NOT_AUTHORIZED`).

*Status: APPROVED by Owner on 2026-09-20.*

---

## 7. Decision OD-L6A-05 — Secret Hygiene: No Secret Output by Construction

Rather than claiming generic log "scrubbing", L6a enforces **no secret output by construction**:
1. **No Passwords in `argv`**: `p4-broker-material.py` writes temporary mode `0600` files and runs `mosquitto_passwd -U <file>` (batch mode). Passwords never appear in process arguments or `/proc`.
2. **No Secret Output in Streams**:
   - `mosquitto` subprocess launched with `stdout=subprocess.DEVNULL`, `stderr=subprocess.DEVNULL`.
   - `mosquitto_passwd` stdout/stderr captured internally in-memory.
   - Validator prints only high-level status tokens (`CORE_AUTH=PASS`, `WRONG_PASSWORD_REJECTED=PASS`).
3. **No Environment Dumps**: System environment variables are never dumped or written to artifacts.
4. **Sentinel Verification**: Tests must use canary fixture passwords and prove their complete absence from validator stdout, stderr, evidence TSV files, temporary configs, ACLs, and process command lines.

*Status: APPROVED by Owner on 2026-09-20.*

---

## 8. Decision OD-L6A-06 — Option B / G-15 Zero-Drift Work & Evidence Model

### 8.1 Work Directory Contract
- Environment variable: `AEGIS_L6A_WORK_DIR`
- Properties: **REQUIRED**, owner/operator supplied, **NO default value**. No hardcoded `/run` paths.
- Safety: Must be absent at entry or verified empty; mode `0700`; non-symlink; safe parent directory; must not be under `/etc/mosquitto` or `/etc/aegis-idea3/mqtt`; must not overlap `AEGIS_L6A_INPUT_DIR` or live L6b paths.

### 8.2 Lifecycle: Option B Zero-Drift Selection
`p4-compare.sh` allow-listener syntax does not support dynamic wildcard ports. Therefore, Option B is mandatory:
```text
apply.sh
  ├── Prepare temporary materials in $AEGIS_L6A_WORK_DIR
  ├── Invoke p4-broker-validate.py (sole broker lifecycle owner)
  │     ├── Spawn Mosquitto on 127.0.0.1:$AEGIS_L6A_PORT
  │     ├── Record broker-process.json
  │     ├── Run TLS, auth, ACL, and negative tests
  │     ├── Terminate Mosquitto (SIGTERM -> SIGKILL)
  │     └── Assert zero listener residue
  ├── Unlink temporary sensitive/runtime files
  ├── Atomically write $AEGIS_L6A_WORK_DIR/validation-evidence.tsv
  └── Exit 0
```
- **POST L0 Capture**: `p4-l0-capture.sh` runs after `apply.sh`. It observes **zero active listener additions** and **zero persistent service/config drift**.
- **Allowlist Invariance**:
  - `stages/L6a/allow-keys.txt`: **Zero active entries** (empty).
  - `stages/L6a/allow-listeners.txt`: **Zero active entries** (empty).

### 8.3 Deterministic Evidence Contract: `validation-evidence.tsv`
Atomic creation (`.tmp` renamed via `os.replace` / `mv`). Never overwritten once finalized. Strict tab-separated key-value schema:

```tsv
schema	1
stage	L6a
result	PASS
listener_address	127.0.0.1
listener_port	18884
pki_profile	PASS
pki_chain	PASS
pki_hostname	PASS
tls_runtime_version	PASS
core_auth	PASS
device_auth	PASS
anonymous_rejected	PASS
wrong_core_password_rejected	PASS
wrong_device_password_rejected	PASS
acl_matrix	PASS
retained_rejected	PASS
broker_residue	NO
secret_output_scan	PASS
started_at	2026-09-20T21:00:00Z
finished_at	2026-09-20T21:00:05Z
```

- **Validation Rules**:
  - Duplicate keys $\rightarrow$ `verify.sh` FAILS.
  - Unknown keys $\rightarrow$ `verify.sh` FAILS.
  - Missing keys or malformed lines $\rightarrow$ `verify.sh` FAILS.
  - Secret values present $\rightarrow$ `verify.sh` FAILS.
  - `result` is `PASS` only if all individual check keys evaluate to `PASS` and `broker_residue` is `NO`.

### 8.4 Evidence Lifecycle
- **Temporary Sensitive Material** (`mosquitto.conf`, `passwd`, `acl`, `broker-process.json`): Unlinked upon apply return or rollback.
- **Non-Secret Evidence** (`validation-evidence.tsv`, `rollback-evidence.tsv`): Retained across success, failure, and rollback to enable post-flight auditing. Rollback must never blindly delete the entire `$WORK` directory.

*Status: APPROVED by Owner on 2026-09-20.*

---

## 9. Decision OD-L6A-07 — Exact Ownership Rollback and S-11 Hold

### 9.1 Rollback Contract
`stages/L6a/rollback.sh` restores pre-stage state without disturbing live services:
1. Checks `$AEGIS_L6A_WORK_DIR/broker-process.json`.
2. If process metadata exists:
   - Verifies PID is running.
   - Verifies `/proc/$PID/stat` start time and `/proc/sys/kernel/random/boot_id` match recorded metadata (defending against PID recycling).
   - Verifies `/proc/$PID/cmdline` matches recorded executable and config path.
   - If verified: terminates process (`kill -TERM`, wait 3s, `kill -KILL`), asserts listener closed.
   - If unverified or mismatched: **DO NOT KILL. Log warning and invoke `S-11 HOLD / ESCALATE`.**
3. Unlinks temporary plaintext materials (`passwd`, `acl`, `mosquitto.conf`, `broker-process.json`).
4. Preserves non-secret `validation-evidence.tsv` and writes `rollback-evidence.tsv`.
5. Confirms zero listener residue on `127.0.0.1:$AEGIS_L6A_PORT`.
6. Proves idempotency: executing rollback multiple times exits 0.

### 9.2 Inviolable Boundaries
Rollback must never:
- Touch `mosquitto.service` or `/etc/mosquitto/**`.
- Touch `aegis-idea3-mosquitto.service` or `/etc/aegis-idea3/mqtt/**`.
- Open port 1883.
- Mutate L2 (nftables), L3 (NetworkManager), L4 (addressing/dnsmasq), or L5 (chronyd/timesyncd).
- Mutate IDEA1 (`IDEA1-AEGIS_Drive_LC/`) or IDEA2 (`IDEA2-AEGIS_CCTV-Operator/`, `IDEA2-AEGIS_Monitor/`).

*Status: APPROVED by Owner on 2026-09-20.*

---

## 10. Current Repository Gap Inventory

The following markers formally record the baseline state of the repository prior to L6a handler implementation:

```text
WRONG_PASSWORD_RUNTIME_PROOF_CURRENT=NO
ISOLATED_1883_REJECTION_CURRENT=NO
RUNTIME_DNS_SAN_VERIFICATION_CURRENT=NO
RUNTIME_TLS_VERSION_PROOF_CURRENT=NO
EXTRA_IP_SAN_REJECTION_CURRENT=NO

SECRET_INPUT_SYMLINK_REJECTION_CURRENT=NO
BROKER_KEY_SYMLINK_REJECTION_CURRENT=NO
PKI_CERT_SYMLINK_REJECTION_CURRENT=NO

L6A_DYNAMIC_PORT_MECHANISM_CURRENT=NO
L6A_RESULT_EVIDENCE_CONTRACT_CURRENT=NO
L6A_EXACT_PROCESS_OWNERSHIP_ROLLBACK_CURRENT=NO
```

*(Note: `L6A_DYNAMIC_PORT_MECHANISM_CURRENT=NO` records historical tool absence. Under approved OD-L6A-02, the implementation adopts required explicit `AEGIS_L6A_PORT` rather than automatic dynamic allocation).*

---

## 11. Proposed Handler Architecture & Shape

When implemented, `deploy/pr11-phase4/stages/L6a/` will contain:
- `apply.sh`: Validates inputs, prepares temporary runtime directory, invokes `p4-broker-validate.py`, unlinks temporary secrets, writes `validation-evidence.tsv`.
- `verify.sh`: Validates `validation-evidence.tsv`, asserts zero broker residue, executes offline certificate check via `p4-mqtt-pki.py`.
- `rollback.sh`: Validates process ownership metadata, terminates verified broker, unlinks temporary runtime files, preserves evidence, writes `rollback-evidence.tsv`.
- `allow-keys.txt`: Empty (zero persistent keys modified).
- `allow-listeners.txt`: Empty (zero active listeners remain at POST capture).

---

## 12. Verification & Test Requirements for Implementation

Future implementation must add a dedicated test suite (`tests/test_pr11_phase4_l6a_handler.py`) proving:
1. **Handler Registration & Syntax**: All 5 handler files exist; `p4-lib.sh` reports `L6a: REGISTERED`; bash syntax (`bash -n`) passes; allowlists are empty.
2. **Port Invariants**: Rejects 1883; rejects 8883; enforces `127.0.0.1`; fails closed if `AEGIS_L6A_PORT` is occupied.
3. **PKI & TLS Runtime Profile**: Pure DNS SAN accepted; extra IP SAN rejected; wrong SAN rejected; wrong CA rejected; runtime negotiated TLS $\ge$ 1.2 verified; zero `/etc/hosts` changes; zero external DNS queries.
4. **Authentication & ACLs**: Valid Core and Device auth; anonymous connection rejected; wrong Core password rejected; wrong Device password rejected; retained publish rejected; all 16 ACL permutations pass.
5. **Secret Hygiene**: Symlink input rejected; loose permissions rejected; canary passwords absent from stdout, stderr, evidence TSV, argv, and configs.
6. **Lifecycle & Rollback**: Single Mosquitto process; zero residue on apply return; signal trap cleanup on SIGINT/SIGTERM; rollback terminates verified process; rollback refuses unverified PID (PID reuse defense); legacy broker untouched; L6b service untouched; rollback idempotent; evidence preserved.
7. **Capture & Regressions**: `p4-compare.sh` PRE $\rightarrow$ POST zero drift; PRE $\rightarrow$ RB zero drift; full Phase 4 regression passes (`pytest -q`).

---

## 13. Repository vs. Live Prerequisites

- **REPOSITORY IMPLEMENTATION (AUTHORIZED)**:
  - May proceed immediately under this approved operational design.
  - Restricted strictly to fixture roots, mock data, throwaway test PKI, and loopback sockets.
  - Zero host mutation.
- **FUTURE LIVE L6A EXECUTION (BLOCKED / NOT AUTHORIZED)**:
  - Remains strictly gated and requires all of the following:
    1. Documented, audited L5 live PASS.
    2. Fresh same-day written A-L6a authorization.
    3. Fresh same-day K3 window authorization.
    4. Gaps G-07, G-08, G-09, G-10, G-14, G-15 merged.
    5. Operational decisions OD-08 and OD-09 satisfied.
    6. Owner-supplied real CA certificate and pre-signed broker leaf credentials.
    7. IDEA2 §10 preservation PASS or written IDEA2-owner-accepted narrowed criterion.
    8. All applicable stop conditions clear.

---

## 14. Document Final Safety Markers

```text
OD_L6A_01_APPROVED=YES
OD_L6A_02_APPROVED=YES
OD_L6A_03_APPROVED=YES
OD_L6A_04_APPROVED=YES
OD_L6A_05_APPROVED=YES
OD_L6A_06_APPROVED=YES
OD_L6A_07_APPROVED=YES

L6A_OWNER_APPROVED=YES
L6A_REPOSITORY_DESIGN_AUTHORIZED=YES

L6A_HANDLER_REGISTERED=NO
L6A_IMPLEMENTATION_STARTED=NO

L6A_LIVE_AUTHORIZED=NO
LIVE_L6A=NOT_RUN

PRODUCTION_MUTATION=NO
NETWORK_MUTATION=NO
SYSTEMD_MUTATION=NO
ETC_MUTATION=NO

PHASE4_RUNTIME_COMPLETE=NO
PHASE4_LIVE_READINESS=NOT_READY
```
