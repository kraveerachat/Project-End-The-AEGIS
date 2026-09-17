# AEGIS IDEA3 PR11 Phase 4 Batch T2 + T3 + T7 + T8 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development. Execute task-by-task with TDD and review checkpoints.

**Goal:** Complete repository-safe T2, T3, T7, and the repository-safe portion of T8 in one PR without Production mutation.

**Architecture:** Finish isolated broker validation first, then add fixed-profile MQTT PKI validation, make ESP32 Wi-Fi/NTP bootstrap non-blocking while preserving fail-secure behavior, and add repository-only NVS provisioning material. Each task is independently testable and committed before final batch regression.

**Tech Stack:** Python 3.14, pytest, paho-mqtt 2.1, Mosquitto 2.x, OpenSSL, ESP32 Arduino/PlatformIO.

**Spec:** `docs/superpowers/specs/2026-09-17-idea3-pr11-phase4-batch-t2-t3-t7-t8-design.md`

## Global Constraints

- Production mutation: NO.
- Live Phase 4 rollout: NOT AUTHORIZED.
- Broker hostname: `mqtt.aegis.home.arpa`.
- Broker SAN: `DNS:mqtt.aegis.home.arpa`.
- Device ID: `aegis-relay-01`.
- Core MQTT identity: `idea3-core`.
- Device MQTT identity: `idea3-dev-aegis-relay-01`.
- MQTT CA subject: `AEGIS IDEA3 MQTT CA`; validity target: 1825 days; CA private key remains owner-controlled/offline.
- DHCP remains selected.
- Firmware NVS namespace/schema: `aegis-p1` / `1`.
- Real passwords, PSKs, HMAC keys, PINs, and private keys must never be committed.
- Secret values must not be passed through subprocess argv.
- No Production `systemctl`, `/etc/mosquitto` write, ESP32 flash, serial provisioning, relay actuation, D4 action, or K12 claim.
- T4/T5/T6/T9 remain out of this batch.
- Human review / human merge only.

---

### Task 1: Finish T2 G-10/G-14 Negative Broker Validation

**Files:**
- Modify: `deploy/pr11-phase4/p4-broker-validate.py`
- Existing: `deploy/pr11-phase4/p4-broker-material.py`
- Modify: `tests/test_pr11_phase4_broker_validate.py`
- Existing: `tests/test_pr11_phase4_broker_material.py`

**Interfaces:**
- Consumes rendered isolated Mosquitto config plus Core/device password files.
- Produces `ANONYMOUS_REJECTED=PASS`, `RETAINED_REJECTED=PASS`, `NEGATIVE_SECURITY=PASS`, and existing `BROKER_RESIDUE=NO` only after real checks.

- [ ] **Step 1: Re-run established RED-15**

```bash
~/.venvs/aegis-idea3-core/bin/python -m pytest -p no:cacheprovider -q \
  tests/test_pr11_phase4_broker_validate.py::test_validator_reports_negative_security_checks
```

Expected: FAIL because the negative-security probes are absent.

- [ ] **Step 2: Implement anonymous rejection**

Add:

```python
def validate_anonymous_rejected(address: str, port: int, ca_file: Path) -> None:
    """Connect with TLS and no username/password; success is a validation failure."""
```

Use paho in-process. Wait for CONNACK. Non-success authentication result prints `ANONYMOUS_REJECTED=PASS`; successful anonymous connection raises `RuntimeError`.

- [ ] **Step 3: Implement retained rejection**

Add:

```python
def validate_retained_rejected(
    address: str,
    port: int,
    ca_file: Path,
    username: str,
    password_file: Path,
    topic: str,
) -> None:
    """Publish retain=True against retain_available=false and require broker rejection."""
```

Read the password from the file using the existing safe reader. Do not place it in argv. Print `RETAINED_REJECTED=PASS` only after rejection.

- [ ] **Step 4: Aggregate negative checks**

Add:

```python
def validate_negative_security(...):
    validate_anonymous_rejected(...)
    validate_retained_rejected(...)
    print("NEGATIVE_SECURITY=PASS")
```

Invoke it while the isolated broker child process is running.

- [ ] **Step 5: Verify T2**

```bash
~/.venvs/aegis-idea3-core/bin/python -m pytest -p no:cacheprovider -q \
  tests/test_pr11_phase4_broker_material.py \
  tests/test_pr11_phase4_broker_validate.py \
  tests/test_broker_config.py \
  tests/test_broker_loopback.py
```

Expected: all PASS.

- [ ] **Step 6: Safety scan and commit**

```bash
rg -n 'systemctl|service[[:space:]]+mosquitto|/etc/mosquitto|mosquitto_passwd[[:space:]]+-b' \
  deploy/pr11-phase4/p4-broker-material.py \
  deploy/pr11-phase4/p4-broker-validate.py

git add deploy/pr11-phase4/p4-broker-material.py \
        deploy/pr11-phase4/p4-broker-validate.py \
        tests/test_pr11_phase4_broker_material.py \
        tests/test_pr11_phase4_broker_validate.py
git commit -m "feat(idea3): add safe Phase 4 broker material validation"
```

---

### Task 2: T3 Dedicated MQTT PKI Profile and Lifecycle

**Files:**
- Create: `deploy/pr11-phase4/p4-mqtt-pki.py`
- Create: `tests/test_pr11_phase4_mqtt_pki.py`
- Create: `docs/operations/idea3-mqtt-pki.md`

**Interfaces:**
- `render-broker-ext --output PATH`
- `validate-broker-cert --ca-file PATH --cert-file PATH`
- Fixed hostname profile: `mqtt.aegis.home.arpa`.

- [ ] **Step 1: Write RED profile tests**

Tests require:

```python
BROKER_HOSTNAME = "mqtt.aegis.home.arpa"
CA_COMMON_NAME = "AEGIS IDEA3 MQTT CA"
CA_VALIDITY_DAYS = 1825
```

`render-broker-ext` must output exactly one DNS SAN for `mqtt.aegis.home.arpa` and no IP SAN. Expected: FAIL because the tool is absent.

- [ ] **Step 2: Implement extension rendering**

Create:

```python
def render_broker_extensions(output: Path) -> None:
    """Refuse overwrite and render the fixed server certificate profile."""
```

Render:

```text
subjectAltName=DNS:mqtt.aegis.home.arpa
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
```

- [ ] **Step 3: Write RED certificate tests**

Generate throwaway `tmp_path` CA/leaf certificates with OpenSSL. Test exact SAN success, wrong SAN rejection, and broken-chain rejection.

- [ ] **Step 4: Implement certificate validation**

Add:

```python
def validate_broker_certificate(ca_file: Path, cert_file: Path) -> None:
    """Verify chain, exact hostname, current validity, and leaf/server profile."""
```

Use file paths only with OpenSSL commands such as `openssl verify -CAfile ... -verify_hostname mqtt.aegis.home.arpa ...`. Never accept or print a private key.

- [ ] **Step 5: Document lifecycle**

`docs/operations/idea3-mqtt-pki.md` records offline CA custody, subject `AEGIS IDEA3 MQTT CA`, 1825-day target, exact DNS SAN, hostname verification, IP-literal profile not selected, rotation before expiry, compromise/revocation replacement, and separately authorized L6 deployment.

- [ ] **Step 6: Verify and commit**

```bash
~/.venvs/aegis-idea3-core/bin/python -m pytest -p no:cacheprovider -q \
  tests/test_pr11_phase4_mqtt_pki.py \
  tests/test_broker_config.py \
  tests/test_broker_loopback.py

rg -n 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY' \
  deploy/pr11-phase4 docs/operations tests

git add deploy/pr11-phase4/p4-mqtt-pki.py \
        tests/test_pr11_phase4_mqtt_pki.py \
        docs/operations/idea3-mqtt-pki.md
git commit -m "feat(idea3): add MQTT PKI profile and lifecycle validation"
```

---

### Task 3: T7 Non-Blocking Fail-Secure Wi-Fi Bootstrap

**Files:**
- Modify: `firmware/src/main.cpp`
- Modify: `tests/test_firmware_contract.py`

**Interfaces:**
- `startWiFi()` starts STA/DHCP association and returns immediately.
- `startNTP()` configures NTP once and returns immediately.
- `serviceNetworkBootstrap()` runs from `loop()`.
- `connectMQTT()` remains gated by Wi-Fi and trusted time.

- [ ] **Step 1: Write RED firmware contract**

Add a test requiring:

```python
wifi = _function("startWiFi")
loop = _function("loop")
connect = _function("connectMQTT")
assert "WiFi.begin(" in wifi
assert "while (" not in wifi
assert "delay(" not in wifi
assert "serviceNetworkBootstrap();" in loop
assert "WiFi.status() != WL_CONNECTED" in connect
assert "RELAY_RELEASE" not in wifi
```

Expected: FAIL because the new functions do not exist.

- [ ] **Step 2: Implement non-blocking Wi-Fi/NTP bootstrap**

Implement:

```cpp
void startWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());
}
```

Add one-shot `startNTP()` and `serviceNetworkBootstrap()`. Remove the blocking Wi-Fi and NTP wait loops from setup flow.

- [ ] **Step 3: Gate MQTT on Wi-Fi**

At the beginning of `connectMQTT()` after `mqttBufferReady`:

```cpp
if (WiFi.status() != WL_CONNECTED) return;
```

Keep existing `timeTrust() == TimeTrust::UNTRUSTED` rejection.

- [ ] **Step 4: Update setup/loop and preserve fail-secure behavior**

`setup()` starts Wi-Fi and configures TLS/MQTT without waiting. `loop()` services network bootstrap before MQTT reconnect. Boot, Wi-Fi loss, MQTT loss, and reconnect must never release the relay.

- [ ] **Step 5: Verify tests and compile**

```bash
~/.venvs/aegis-idea3-core/bin/python -m pytest -p no:cacheprovider -q \
  tests/test_firmware_contract.py \
  tests/test_firmware_protocol_parity.py

cd firmware
platformio run
cd ..
```

No upload target.

- [ ] **Step 6: Commit**

```bash
git add firmware/src/main.cpp tests/test_firmware_contract.py
git commit -m "fix(idea3): make ESP32 Wi-Fi bootstrap non-blocking"
```

---

### Task 4: T8 Repository-Safe NVS Provisioning Material

**Files:**
- Create: `deploy/pr11-phase4/p4-nvs-provision.py`
- Create: `tests/test_pr11_phase4_nvs_provision.py`
- Modify: `deploy/pr11-phase4/README.md`

**Interfaces:**
- Namespace/schema: `aegis-p1` / `1`.
- Secret inputs are file paths only.
- Output is an explicit mode-0600 NVS CSV; no physical write command exists.

- [ ] **Step 1: Write RED parity tests**

Require exact firmware keys: `schema`, `device_id`, `wifi_ssid`, `wifi_psk`, `broker`, `mqtt_user`, `mqtt_pass`, `ntp`, `k_c2d`, `k_d2c`, `seq_hi`.

Require constants:

```python
NVS_NAMESPACE = "aegis-p1"
NVS_SCHEMA = 1
BROKER_HOSTNAME = "mqtt.aegis.home.arpa"
DEVICE_ID = "aegis-relay-01"
DEVICE_MQTT_USER = "idea3-dev-aegis-relay-01"
```

Expected: FAIL because the tool is absent.

- [ ] **Step 2: Implement safe secret/key reading**

Add safe regular-file/mode/single-line secret reading. Protocol keys must be exactly 64 lowercase hex characters, decode to 32 bytes, be non-zero, and `C2D != D2C`. Preserve rejection of existing known demo/test digests.

- [ ] **Step 3: Implement fixed provisioning validation**

Require schema 1, device `aegis-relay-01`, broker `mqtt.aegis.home.arpa`, MQTT user `idea3-dev-aegis-relay-01`, non-empty SSID/NTP, secret files for Wi-Fi/MQTT/key material, and `seq_hi=0` for new material.

- [ ] **Step 4: Implement explicit NVS CSV rendering**

Refuse overwrite, create mode 0600, never print contents. Emit only non-secret markers:

```text
NVS_SCHEMA=PASS
NVS_PROFILE=PASS
NVS_MATERIAL_WRITTEN=YES
```

- [ ] **Step 5: Add negative tests and README boundary**

Reject wrong schema/device/broker/user, empty SSID, unsafe secret-file mode, malformed/uppercase/wrong-length/zero/identical keys, and existing output. Assert secrets do not appear in stdout/stderr.

README states: NO ESP32 flash, NO serial write, NO Production NVS mutation, NO NVS encryption claim, NO G-11 live closure.

- [ ] **Step 6: Verify and commit**

```bash
~/.venvs/aegis-idea3-core/bin/python -m pytest -p no:cacheprovider -q \
  tests/test_pr11_phase4_nvs_provision.py \
  tests/test_firmware_contract.py \
  tests/test_firmware_protocol_parity.py

git add deploy/pr11-phase4/p4-nvs-provision.py \
        deploy/pr11-phase4/README.md \
        tests/test_pr11_phase4_nvs_provision.py
git commit -m "feat(idea3): add repository-safe ESP32 NVS provisioning material"
```

---

### Task 5: Batch Regression, Evidence, and PR Preparation

**Files:**
- Add the approved spec/plan and one final IDEA3 status receipt using the existing receipt convention.
- Do not modify live runtime state.

- [ ] **Step 1: Focused regression**

```bash
~/.venvs/aegis-idea3-core/bin/python -m pytest -p no:cacheprovider -q \
  tests/test_pr11_phase4_broker_material.py \
  tests/test_pr11_phase4_broker_validate.py \
  tests/test_pr11_phase4_mqtt_pki.py \
  tests/test_pr11_phase4_nvs_provision.py \
  tests/test_broker_config.py \
  tests/test_broker_loopback.py \
  tests/test_firmware_contract.py \
  tests/test_firmware_protocol_parity.py
```

Expected: PASS.

- [ ] **Step 2: T1 regression**

```bash
~/.venvs/aegis-idea3-core/bin/python -m pytest -p no:cacheprovider -q \
  tests/test_pr11_phase4_harness.py
```

Historical baseline: 159 PASS.

- [ ] **Step 3: Compile checks**

```bash
~/.venvs/aegis-idea3-core/bin/python -m py_compile \
  deploy/pr11-phase4/p4-broker-material.py \
  deploy/pr11-phase4/p4-broker-validate.py \
  deploy/pr11-phase4/p4-mqtt-pki.py \
  deploy/pr11-phase4/p4-nvs-provision.py

cd firmware
platformio run
cd ..
```

No upload command.

- [ ] **Step 4: Full IDEA3 suite and leakage scan**

```bash
~/.venvs/aegis-idea3-core/bin/python -m pytest -p no:cacheprovider -q
rg -n 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|mosquitto_passwd[[:space:]]+-b' \
  deploy/pr11-phase4 docs/operations tests firmware
git diff --check
```

Record exact counts and review every scan hit.

- [ ] **Step 5: Record non-live evidence**

Receipt must contain:

```text
PRODUCTION_MUTATION=NO
LIVE_STAGE_AUTHORIZED=NO
CORE_MUTATION=NO
SERVER_MUTATION=NO
IDEA2_MUTATION=NO
ESP32_FLASH=NO
PHYSICAL_RELAY_ACTUATION=NO
D4_LIVE_VERIFIED=NO
K12=NOT_PROVEN
PHASE4_RUNTIME_COMPLETE=NO
```

- [ ] **Step 6: Review diff, commit docs, push one PR**

```bash
git status --short
git diff --check
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
```

Add the approved spec, this plan, and receipt. Push one feature branch and create one PR covering T2 + T3 + T7 + repository-safe T8.

PR body must state:

```text
Production mutation: NO
Phase 4 runtime complete: NO
D4 live verified: NO
K12: NOT_PROVEN
T4/T5/T6/T9: out of scope
Human merge required
```

Agent does not merge.

---

## Plan Self-Review

- Spec coverage: T2/T3/T7/T8 repository scope mapped to Tasks 1-4; batch regression/evidence mapped to Task 5.
- Placeholder scan completed successfully; no undefined implementation step remains.
- Interface consistency: file inputs use `Path`; fixed hostname/identity values match the approved spec; firmware NVS keys match current source.
- Live gates remain excluded and cannot be bypassed by this plan.
