"""AEGIS IDEA3 PR11 Phase 4 — L8p owner runner (run-l8p-owner.sh) and its gate library (p4-l8p-run-lib.sh): HERMETIC control-flow tests.

The real runner template is executed, unmodified apart from its frozen constants, inside a sandbox: `sudo`, `systemctl`, `sysctl` and `df` are stubs, the REAL
p4-lib.sh / p4-stage-gate.sh and the REAL run libraries are used, and only p4-l0-capture.sh / p4-compare.sh and the three L8p handlers are stand-ins that
log what they were called with. No test starts a flashing tool, opens a serial port, contacts a broker or touches a device or the host.
The committed template is INERT: it refuses while any PIN_ value is unpinned, and a run against the current project state fails closed because no FINAL
L7u live acceptance receipt exists.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
RUNNER = DEPLOY / "owner-run" / "run-l8p-owner.sh"
LIB = DEPLOY / "p4-l8p-run-lib.sh"
REAL_LIBS = ("p4-l6b-run-lib.sh", "p4-l7-run-lib.sh", "p4-l7u-run-lib.sh", "p4-l8p-run-lib.sh", "p4-lib.sh", "p4-stage-gate.sh", "p4-ntp-reactivation-lib.sh")
LOGS = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
REAL_USER = subprocess.run(["id", "-un"], text=True, capture_output=True, check=True).stdout.strip()
REAL_UID = subprocess.run(["id", "-u"], text=True, capture_output=True, check=True).stdout.strip()
TODAY = subprocess.run(["date", "+%F"], text=True, capture_output=True, env=dict(os.environ, TZ="Asia/Bangkok"), check=True).stdout.strip()
SECRET = {"wifi.psk": "CANARY-wifi-psk-9f2c41ab", "mqtt.pass": "CANARY-mqtt-pass-77de09c3", "k_c2d": "CANARY" + "a1" * 29, "k_d2c": "CANARY" + "b2" * 29}
FIRMWARE = b"\xe9AEGIS-REVIEWED-FIRMWARE-IMAGE" * 8
TABLE = b"nvs,data,nvs,0xb000,0x5000,\napp0,app,ota_0,0x20000,0x180000,\n"
HANDLER_STUB = r'''#!/usr/bin/env bash
name=$(basename "$0" .sh)
echo "$name" >> "$SIM_DIR/calls.log"
echo "env:$name:backend=${AEGIS_L8P_BACKEND-<unset>} live=${AEGIS_L8P_LIVE_AUTHORIZED-<unset>} pre_ok=$([ -f "$AEGIS_L8P_PRE_EVIDENCE_DIR/capture.log" ] && echo yes || echo no)" >> "$SIM_DIR/calls.log"
echo "marker@$name:$([ -e "$(cat "$SIM_DIR/marker-path")" ] && echo yes || echo no)" >> "$SIM_DIR/calls.log"
echo "py:$name:control=${AEGIS_PYTHON_BIN-<unset>} esptool=${AEGIS_L8P_ESPTOOL_PYTHON-<unset>}" >> "$SIM_DIR/calls.log"
mkdir -p "$AEGIS_L8P_WORK_DIR" "$AEGIS_L8P_EVIDENCE_DIR"
case "$name" in
  apply)
    [ ! -e "$SIM_DIR/fail-before-write" ] || { echo "L8P_APPLY=FAIL reason=SIM_BEFORE_WRITE" >&2; exit 1; }
    echo started > "$AEGIS_L8P_WORK_DIR/first-write.marker"
    [ ! -e "$SIM_DIR/leak-secret" ] || cat "$(dirname "$AEGIS_L8P_INPUT_DIR")/leak-source" > "$AEGIS_L8P_EVIDENCE_DIR/leak.txt"
    [ ! -e "$SIM_DIR/fail-apply" ] || { echo "L8P_APPLY=FAIL reason=SIM" >&2; exit 1; }
    echo "L8P_APPLY=COMPLETE" ;;
  verify)
    [ ! -e "$SIM_DIR/fail-verify" ] || { echo "L8P_VERIFY=FAIL reason=SIM" >&2; exit 1; }
    echo "L8P_VERIFY=PASS" ;;
  rollback)
    if [ -e "$SIM_DIR/bad-rollback" ]; then echo "L8P_DEVICE_ACTION_TAKEN=REFLASH"; echo "L8P_ROLLBACK=COMPLETE"; exit 0; fi
    echo "L8P_DEVICE_ACTION_TAKEN=NONE"
    if [ -f "$AEGIS_L8P_WORK_DIR/first-write.marker" ]; then echo "L8P_ROLLBACK=FAIL_SECURE_HOLD_AND_EVIDENCE"; else echo "L8P_ROLLBACK=COMPLETE"; fi ;;
esac
'''
CAPTURE_STUB = ('#!/usr/bin/env bash\necho "capture:$CAPTURE_LABEL" >> "$SIM_DIR/calls.log"\n[ ! -e "$SIM_DIR/fail-capture-$CAPTURE_LABEL" ] || exit 1\n'
                'mkdir -p "$EVID_DIR"\n'
                'T=$(date -u +%FT%TZ)\nprintf \'%s L0 capture start label=%s evidence=%s (read-only)\\n%s L0_CAPTURE=COMPLETE evidence=%s\\n\' "$T" "$CAPTURE_LABEL" "$EVID_DIR" "$T" "$EVID_DIR" > "$EVID_DIR/capture.log"\n'
                '[ ! -e "$SIM_DIR/ntp-lost-by-pre-capture" ] || [ "$CAPTURE_LABEL" != pre ] || echo inactive > "$SIM_DIR/props/chronyd.service.ActiveState"\n'
                '(cd "$EVID_DIR" && sha256sum capture.log > SHA256SUMS)\n[ ! -e "$SIM_DIR/bad-sums-$CAPTURE_LABEL" ] || echo "0  capture.log" > "$EVID_DIR/SHA256SUMS"\n')
COMPARE_STUB = ('#!/usr/bin/env bash\n'
                'echo "argc:$#" >> "$SIM_DIR/calls.log"\n'
                '# the REAL p4-compare.sh contract: exactly <BEFORE_DIR> <AFTER_DIR>; anything else stops at its usage gate (exit 2)\n'
                '[ "$#" = 2 ] || { echo "STOP: usage: p4-compare.sh <BEFORE_DIR> <AFTER_DIR>"; exit 2; }\n'
                'echo "compare:$1:$2:$(env | grep -E \'^ALLOW_\' | sort | tr \'\\n\' \' \')" >> "$SIM_DIR/calls.log"\n'
                'label=$(basename "$2" | sed s/-root//)\n[ ! -e "$SIM_DIR/fail-compare-$label" ] || { echo COMPARE_RESULT=FAIL; exit 1; }\n'
                "printf 'FINDINGS_NEW_OR_WORSENED_DRIFT=0\\nFINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0\\nFINDINGS_INCOMPARABLE=0\\nPRESERVATION_S10=PASS\\nCOMPARE_RESULT=PASS\\n'\n")
SYSTEMCTL_STUB = r'''#!/usr/bin/env bash
shift
keys=(); value=0; unit=""
while [ $# -gt 0 ]; do case "$1" in -p) keys+=("$2"); shift 2 ;; --value) value=1; shift ;; *) unit=$1; shift ;; esac; done
default() { case "$1" in LoadState) echo loaded ;; ActiveState) echo active ;; SubState) echo running ;; UnitFileState) echo enabled ;; Result) echo success ;; NRestarts) echo 0 ;; MainPID) echo 883 ;; esac; }
for k in "${keys[@]}"; do
  v=$(cat "$SIM_DIR/props/$unit.$k" 2>/dev/null || default "$k")
  if [ "$value" = 1 ]; then printf '%s\n' "$v"; else printf '%s=%s\n' "$k" "$v"; fi
done
'''


class Sim:
    def __init__(self, tmp: Path, *, l7u: bool = True, l8p_done: bool = False, auth_over: dict | None = None, k3: str | None = "v2",
                 authorization: str | None = None, operator_user: str | None = None, operator_uid: str | None = None,
                 l8p_receipts: dict[str, str] | None = None, esptool_python: str | None = None) -> None:
        self.l8p_receipts = l8p_receipts or {}
        self.esptool_python = esptool_python if esptool_python is not None else sys.executable
        self.dir = tmp / "sim"
        self.repo = self.dir / "repo"
        self.p4 = self.repo / "IDEA3-AEGIS_Lockdown" / "deploy" / "pr11-phase4"
        self.auth = self.dir / "auth"
        self.inputs = self.dir / "inputs"
        self.bin = self.dir / "bin"
        self.evid_base = self.dir / "evidence"
        for d in (self.auth, self.bin, self.evid_base, self.dir / "props"):
            d.mkdir(parents=True)
        self.l7u, self.l8p_done, self.auth_over, self.k3_kind, self.authorization = l7u, l8p_done, auth_over or {}, k3, authorization
        self.operator_user = operator_user if operator_user is not None else REAL_USER
        self.operator_uid = operator_uid if operator_uid is not None else REAL_UID
        self.build()

    def _git(self, *args: str) -> str:
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True, text=True, env=env).stdout.strip()

    def build(self) -> None:
        logs = self.repo / LOGS
        logs.mkdir(parents=True)
        for n in (2, 3, 4, 5):
            (logs / f"2026-09-2{n}_000000_music_idea3-pr11-l{n}-live-acceptance.md").write_text(f"`L{n}_LIVE_ACCEPTANCE = PROVEN`\n")
        (logs / "2026-09-26_000000_music_idea3-pr11-l6a-live-acceptance.md").write_text("L6A_LIVE_ACCEPTANCE=PROVEN\nL6A_COMPLETE=YES\nL6B_STARTED=NO\n")
        (logs / "2026-09-30_000000_music_idea3-l7-live-acceptance.md").write_text("`L7_LIVE_ACCEPTANCE = PROVEN`\n")
        if self.l7u:
            (logs / "2026-10-05_000000_music_idea3-l7u-live-acceptance.md").write_text("`L7U_LIVE_ACCEPTANCE = PROVEN`\n")
        if self.l8p_done:
            # an authoritative LIVE result receipt: BOTH result fields, each on its own whole line, in the SAME receipt
            (logs / "2026-10-06_000000_music_idea3-l8p-live.md").write_text("`L8P_LIVE_EXECUTED = YES`\n`L8P_PROVISIONING = PASS`\n")
        for name, text in self.l8p_receipts.items():
            (logs / name).write_text(text)
        stg = self.p4 / "stages" / "L8p"
        stg.mkdir(parents=True)
        for name in ("apply.sh", "verify.sh", "rollback.sh"):
            (stg / name).write_text(HANDLER_STUB)
        for name in ("allow-keys.txt", "allow-listeners.txt"):
            (stg / name).write_text("# empty by contract\n")
        (self.p4 / "p4-l8p-device.py").write_text("# stand-in\n")
        (self.p4 / "p4-l0-capture.sh").write_text(CAPTURE_STUB)
        (self.p4 / "p4-compare.sh").write_text(COMPARE_STUB)
        for name in REAL_LIBS:
            shutil.copy(DEPLOY / name, self.p4 / name)
        self.build_ntp_sandbox()
        self._git("init", "-q")
        self._git("checkout", "-q", "-B", "main")
        self._git("add", "-A")
        self._git("commit", "-q", "-m", "sim")
        self._git("remote", "add", "origin", str(self.repo))
        self._git("fetch", "-q", "origin")
        self.head = self._git("rev-parse", "HEAD")

        self.inputs.mkdir(mode=0o700)
        for name in ("device.identity", "provisioning.pins", "physical-recovery.attestation", "k_c2d", "k_d2c", "wifi.psk", "mqtt.pass"):
            (self.inputs / name).write_text(SECRET.get(name, f"content-of-{name}") + "\n")
            (self.inputs / name).chmod(0o600)
        self.inputs.chmod(0o700)
        (self.dir / "leak-source").write_text(SECRET["wifi.psk"] + "\n")
        self.firmware, self.table = self.dir / "firmware.bin", self.dir / "partitions.csv"
        self.firmware.write_bytes(FIRMWARE)
        self.table.write_bytes(TABLE)
        for name in ("secrets.h", "ca.pem", "broker.cred"):
            (self.dir / name).write_text("x\n")
        # the pinned esptool stand-in: `--help` exercises the same import path the real launcher uses (the gate runs it under the frozen esptool Python)
        (self.dir / "tool.py").write_text(
            "import os, sys\n"
            f"if os.path.exists({str(self.dir / 'esptool-dep-missing')!r}):\n    import intelhex_dependency_is_not_installed\n"
            f"print(open({str(self.dir / 'esptool-banner')!r}).read().strip())\nprint('usage: esptool [-h] ...')\n")
        (self.dir / "esptool-banner").write_text("esptool.py v4.11.0 - ESP8266 & ESP32 ROM Bootloader Utility\n")
        (self.dir / "nvs-gen").write_text("#!/bin/sh\n")
        (self.dir / "nvs-gen").chmod(0o755)

        (self.bin / "sudo").write_text('#!/usr/bin/env bash\n[ "$1" = -v ] && exit 0\nexec "$@"\n')
        (self.bin / "systemctl").write_text(SYSTEMCTL_STUB)
        (self.bin / "ss").write_text('#!/usr/bin/env bash\n[ "$*" = "-H -ltnu" ] || exit 1\ncat "$SIM_DIR/ss-lines"\n')
        (self.bin / "sysctl").write_text("#!/usr/bin/env bash\necho 0\n")
        (self.bin / "id").write_text('#!/usr/bin/env bash\nif [ "$1" = -u ] && [ -n "${2:-}" ] && [ -e "$SIM_DIR/resolved-uid" ]; then cat "$SIM_DIR/resolved-uid"; exit 0; fi\nexec /usr/bin/id "$@"\n')
        (self.bin / "df").write_text("#!/usr/bin/env bash\necho 'Filesystem 1K-blocks Used Available Use% Mounted'\necho '/dev/x 100 10 90 10% /'\n")
        for f in self.bin.iterdir():
            f.chmod(0o755)

        fields = {"stage": "L8p", "date": TODAY, "authorizer": "music", "scope": "L8P_DEVICE_PROVISIONING_ONLY (sim)", "reference": "sim/ref",
                  "physical_recovery_attestation": "sim/physical-recovery", **self.auth_over}
        auth = self.authorization if self.authorization is not None else "AEGIS_P4_AUTHORIZATION_V1\n" + "".join(f"{k}={v}\n" for k, v in fields.items() if v is not None)
        (self.auth / "authorization-L8p.txt").write_text(auth)
        if self.k3_kind == "v2":
            (self.auth / "k3-L8p.txt").write_text(f"AEGIS_P4_K3_CONFIRMATION_V2\nstage=L8p\ndate={TODAY}\nconfirmed_by=music\n"
                                                   "confirmation_mode=IDEA3_OWNER_SELF_ATTESTATION\nidea1_window_overlap=NONE_KNOWN\nreference=sim/ref\n")
        elif self.k3_kind == "bad":
            (self.auth / "k3-L8p.txt").write_text("not a k3 record\n")

        text = RUNNER.read_text()
        pins = {
            "EXPECTED_MAIN=PIN_MAIN_SHA": f"EXPECTED_MAIN={self.head}",
            "OPERATOR_USER=PIN_OPERATOR_USER": f"OPERATOR_USER={self.operator_user}", "OPERATOR_UID=PIN_OPERATOR_UID": f"OPERATOR_UID={self.operator_uid}",
            "FIRMWARE_SHA256=PIN_FIRMWARE_SHA256": f"FIRMWARE_SHA256={self.sha(self.firmware)}",
            "PARTITION_TABLE_SHA256=PIN_PARTITION_TABLE_SHA256": f"PARTITION_TABLE_SHA256={self.sha(self.table)}",
            "INPUT_DIR=PIN_INPUT_DIR": f"INPUT_DIR={self.inputs}", "FIRMWARE_IMAGE=PIN_FIRMWARE_IMAGE": f"FIRMWARE_IMAGE={self.firmware}",
            "PARTITION_TABLE=PIN_PARTITION_TABLE": f"PARTITION_TABLE={self.table}", "SECRETS_HEADER=PIN_SECRETS_HEADER": f"SECRETS_HEADER={self.dir / 'secrets.h'}",
            "NVS_GENERATOR=PIN_NVS_GENERATOR": f"NVS_GENERATOR={self.dir / 'nvs-gen'}", "FLASH_TOOL_SCRIPT=PIN_FLASH_TOOL_SCRIPT": f"FLASH_TOOL_SCRIPT={self.dir / 'tool.py'}",
            "MQTT_CA_FILE=PIN_MQTT_CA_FILE": f"MQTT_CA_FILE={self.dir / 'ca.pem'}", "BROKER_CREDENTIAL_FILE=PIN_BROKER_CREDENTIAL_FILE": f"BROKER_CREDENTIAL_FILE={self.dir / 'broker.cred'}",
            "BROKER_ADDRESS=PIN_BROKER_ADDRESS": "BROKER_ADDRESS=10.77.30.1", "BROKER_TLS_NAME=PIN_BROKER_TLS_NAME": "BROKER_TLS_NAME=mqtt.aegis.home.arpa",
            "WIFI_SSID=PIN_WIFI_SSID": "WIFI_SSID=SIM-AP", "NTP_SERVER=PIN_NTP_SERVER": "NTP_SERVER=203.0.113.9",
            "FIRMWARE_BUILD_CMD=PIN_FIRMWARE_BUILD_CMD": "FIRMWARE_BUILD_CMD='pio run -e esp32dev'",
            "ESPTOOL_PYTHON=PIN_ESPTOOL_PYTHON": f"ESPTOOL_PYTHON={self.esptool_python}",
        }
        for a, b in pins.items():
            assert a in text, a
            text = text.replace(a, b)
        text = text.replace("REPO=/home/kittipat/Workspace/IDEA3-Cyber-Last/worktrees/Project-End-The-AEGIS-L8PLIVE   # clean pinned execution worktree at merged main", f"REPO={self.repo}")
        text = text.replace("PY=/home/kittipat/.venvs/aegis-idea3-core/bin/python", "PY=python3")
        text = text.replace("EVID=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-l8p-$STAMP", f"EVID={self.evid_base}/$TODAY-l8p-$STAMP")
        self.runner = self.dir / "run-l8p-owner.sh"
        self.runner.write_text(text)
        (self.dir / "marker-path").write_text(str(self.auth / "L8p-ATTEMPT-CONSUMED"))

    def build_ntp_sandbox(self) -> None:
        """The REAL ntpreact_runtime_ready_gate runs against a sandbox host: the config path/hash/mode constants of the COPIED lib point at a sandbox file, `ss` and the
        clock probe are stand-ins, and the unit states come from the systemctl stub's props directory (healthy PRE-L8p NTP runtime by default)."""
        conf = self.dir / "chrony.conf"
        conf.write_text("# approved L5 runtime configuration (sandbox)\nserver 2.arch.pool.ntp.org iburst\nbindaddress 10.77.30.1\nallow 10.77.30.0/28\nrtcsync\n")
        conf.chmod(0o640)
        lib = self.p4 / "p4-ntp-reactivation-lib.sh"
        text = lib.read_text()
        for pattern, repl in ((r'^NTPREACT_CHRONY_CONF="[^"]*"$', f'NTPREACT_CHRONY_CONF="{conf}"'),
                              (r'^NTPREACT_CHRONY_CONF_SHA256="[0-9a-f]{64}"$', f'NTPREACT_CHRONY_CONF_SHA256="{self.sha(conf)}"'),
                              (r'^NTPREACT_CHRONY_CONF_MODE_OWNER="[^"]*"', f'NTPREACT_CHRONY_CONF_MODE_OWNER="640:{os.getuid()}:{os.getgid()}"')):
            text, n = re.subn(pattern, lambda _m, r=repl: r, text, count=1, flags=re.MULTILINE)
            assert n == 1, pattern
        lib.write_text(text)
        (self.p4 / "p4-l5-clock.py").write_text(
            "import os, sys\nsim = os.environ['SIM_DIR']\n"
            "if os.path.exists(os.path.join(sim, 'clock-unsynced')):\n    print('state=UNSYNCED reason=KERNEL_UNSYNCED maxerror_us=16000000 sim=1'); sys.exit(1)\n"
            "print('state=SYNCED reason=OK maxerror_us=' + open(os.path.join(sim, 'clock-maxerror')).read().strip() + ' sim=1')\n")
        (self.dir / "clock-maxerror").write_text("1000\n")
        for unit, state in (("chronyd.service", ("active", "running", "disabled")), ("systemd-timesyncd.service", ("inactive", "dead", "enabled"))):
            for key, value in zip(("ActiveState", "SubState", "UnitFileState"), state):
                self.prop(unit, key, value + "\n")
        self.ss_lines("udp UNCONN 0 0 10.77.30.1:123 0.0.0.0:*", "udp UNCONN 0 0 127.0.0.1:323 0.0.0.0:*")

    def ss_lines(self, *lines: str) -> None:
        (self.dir / "ss-lines").write_text("".join(f"{line}\n" for line in lines))

    @staticmethod
    def sha(path: Path) -> str:
        import hashlib
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def run(self, runner: Path | None = None) -> subprocess.CompletedProcess[str]:
        env = dict(os.environ, SIM_DIR=str(self.dir), PATH=f"{self.bin}:{os.environ['PATH']}", TZ="Asia/Bangkok")
        return subprocess.run(["bash", str(runner or self.runner), str(self.auth)], text=True, capture_output=True, env=env, check=False)

    def inject(self, name: str) -> None:
        (self.dir / name).write_text("1\n")

    def prop(self, unit: str, key: str, value: str) -> None:
        (self.dir / "props" / f"{unit}.{key}").write_text(value)

    def marker(self) -> bool:
        return (self.auth / "L8p-ATTEMPT-CONSUMED").exists()

    def calls(self) -> list[str]:
        p = self.dir / "calls.log"
        return p.read_text().splitlines() if p.exists() else []

    def steps(self) -> list[str]:
        return [c for c in self.calls() if re.fullmatch(r"apply|verify|rollback|capture:\w+|compare:.*", c)]


def code_only(path: Path) -> str:
    return "\n".join(l for l in path.read_text().splitlines() if not l.lstrip().startswith("#"))


# ═══════════════════════════════════════ 1. the committed template is inert ═══════════════════════════════════════════════


def test_runner_and_lib_exist_are_executable_and_syntactically_valid() -> None:
    for path in (RUNNER, LIB):
        assert path.is_file()
        assert subprocess.run(["bash", "-n", str(path)], capture_output=True, check=False).returncode == 0
    assert os.access(RUNNER, os.X_OK) or RUNNER.read_text().startswith("#!/usr/bin/env bash")


def test_repository_runner_refuses_while_unpinned(tmp_path: Path) -> None:
    res = subprocess.run(["bash", str(RUNNER), str(tmp_path)], text=True, capture_output=True, check=False)
    assert res.returncode == 2 and "runner is not pinned (EXPECTED_MAIN)" in res.stdout
    assert "PIN_MAIN_SHA" in RUNNER.read_text()


@pytest.mark.parametrize("pin", ["OPERATOR_USER", "OPERATOR_UID", "FIRMWARE_SHA256", "PARTITION_TABLE_SHA256", "INPUT_DIR", "FIRMWARE_IMAGE", "PARTITION_TABLE", "SECRETS_HEADER", "NVS_GENERATOR",
                                 "FLASH_TOOL_SCRIPT", "ESPTOOL_PYTHON", "MQTT_CA_FILE", "BROKER_CREDENTIAL_FILE", "BROKER_ADDRESS", "BROKER_TLS_NAME", "WIFI_SSID", "NTP_SERVER",
                                 "FIRMWARE_BUILD_CMD"])
def test_runner_refuses_each_unpinned_value_even_with_main_pinned(tmp_path: Path, pin: str) -> None:
    sim = Sim(tmp_path)
    text = sim.runner.read_text()
    text = re.sub(rf"^{pin}=.*$", f"{pin}=PIN_{pin}", text, count=1, flags=re.MULTILINE)
    sim.runner.write_text(text)
    res = sim.run()
    assert res.returncode == 2 and f"runner is not pinned ({pin})" in res.stdout
    assert not sim.marker() and sim.calls() == []


@pytest.mark.parametrize("pin,bad", [("EXPECTED_MAIN", "abc"), ("FIRMWARE_SHA256", "xyz"), ("PARTITION_TABLE_SHA256", "12"), ("OPERATOR_UID", "0"),
                                     ("OPERATOR_UID", "abc"), ("OPERATOR_UID", "-5"), ("OPERATOR_USER", "Bad User"), ("OPERATOR_USER", "root;id"), ("OPERATOR_USER", "A")])
def test_runner_refuses_malformed_pins(tmp_path: Path, pin: str, bad: str) -> None:
    sim = Sim(tmp_path)
    sim.runner.write_text(re.sub(rf"^{pin}=.*$", lambda _m: f"{pin}='{bad}'", sim.runner.read_text(), count=1, flags=re.MULTILINE))
    res = sim.run()
    assert res.returncode == 2 and "is not a" in res.stdout and sim.calls() == [] and not sim.marker()


def test_the_committed_template_is_not_pinned_to_the_current_main() -> None:
    text = RUNNER.read_text()
    assert not re.search(r"^EXPECTED_MAIN=[0-9a-f]{40}", text, re.MULTILINE)
    assert len(re.findall(r"=PIN_[A-Z_0-9]+$", text, re.MULTILINE)) == 19
    assert "OPERATOR_USER=PIN_OPERATOR_USER" in text and "OPERATOR_UID=PIN_OPERATOR_UID" in text


def test_the_runner_never_runs_as_root_and_needs_sudo_before_any_mutation() -> None:
    text = RUNNER.read_text()
    assert '[ "$(id -u)" != 0 ]' in text
    assert text.index("sudo -v") < text.index("mkdir -m 700")


# ═══════════════════════════════════════ 2. hermetic full flow ═════════════════════════════════════════════════════════════


def test_full_flow_succeeds_in_the_exact_order_and_claims_only_provisioning(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    res = sim.run()
    assert res.returncode == 0, res.stdout + res.stderr
    steps = sim.steps()
    assert [s.split(":")[0] if s.startswith("compare") else s for s in steps] == ["capture:pre", "apply", "verify", "capture:post", "compare"]
    assert sim.marker()
    for line in ("L8P_LIVE_EXECUTED=YES", "L8P_PROVISIONING=PASS"):
        assert line in res.stdout
    for no in ("RECOVERY_R1_R8_PROVEN=NO", "LVR_PROVEN=NO", "L8_ACCEPTANCE=NO", "ELECTRICAL_RELAY_PROOF=NO", "L8_STARTED=NO", "RECOVERY_LIVE_EXECUTED=NO", "CORE_RESTARTED=NO"):
        assert no in res.stdout
    assert not re.search(r"(RECOVERY_R1_R8_PROVEN|LVR_PROVEN|L8_ACCEPTANCE|ELECTRICAL_RELAY_PROOF)=(YES|PASS|PROVEN)", res.stdout)
    assert "not electrical relay proof" in res.stdout


def test_pre_capture_precedes_the_marker_and_the_marker_precedes_every_device_handler(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    assert sim.run().returncode == 0
    calls = sim.calls()
    assert calls[0] == "capture:pre"
    assert "marker@apply:yes" in calls and "marker@verify:yes" in calls, "the attempt is consumed before the first handler"
    for line in calls:
        if line.startswith("env:apply"):
            assert "backend=hardware live=YES pre_ok=yes" in line, "the PRE directory reaches the handler and the hardware backend is requested only here"


def test_the_pre_directory_is_passed_to_the_canonical_handler_and_apply_runs_exactly_once(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    assert sim.run().returncode == 0
    assert sim.calls().count("apply") == 1 and sim.calls().count("verify") == 1 and "rollback" not in sim.calls()
    assert "AEGIS_L8P_PRE_EVIDENCE_DIR=\"$PRE\"" in RUNNER.read_text()


def test_compare_is_mandatory_uses_the_empty_stage_allow_files_and_covers_pre_to_post(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    assert sim.run().returncode == 0
    cmp = next(c for c in sim.calls() if c.startswith("compare:"))
    assert f"ALLOW_KEYS_FILE={sim.p4}/stages/L8p/allow-keys.txt" in cmp and f"ALLOW_LISTENERS_FILE={sim.p4}/stages/L8p/allow-listeners.txt" in cmp
    assert "/pre-root:" in cmp and "post-root" in cmp
    sim2 = Sim(tmp_path / "b")
    sim2.inject("fail-compare-post")
    res = sim2.run()
    assert res.returncode == 1 and "L8P_PROVISIONING=PASS" not in res.stdout and "rollback" in sim2.calls()


@pytest.mark.parametrize("inj,needle", [("fail-capture-post", "POST capture failed"), ("fail-verify", "L8P_VERIFY failed"), ("fail-compare-post", "PRE->POST compare failed")])
def test_each_post_apply_failure_calls_the_canonical_rollback_and_never_succeeds(tmp_path: Path, inj: str, needle: str) -> None:
    sim = Sim(tmp_path)
    sim.inject(inj)
    res = sim.run()
    assert res.returncode == 1 and needle in res.stdout and "L8P_PROVISIONING=PASS" not in res.stdout
    assert "rollback" in sim.calls() and "capture:rb" in sim.calls()
    assert any(c.startswith("compare:") and "rb-root" in c for c in sim.calls()), "PRE->RB compare is mandatory"
    assert sim.calls().count("apply") == 1, "no automatic second attempt"
    assert "HARDWARE_PRE_TO_RB_ZERO_DRIFT=NOT_APPLICABLE" in res.stdout, "hardware zero drift is not claimed after the first write"
    assert "L8P_PROVISIONING=NOT_PROVEN" in res.stdout and "NOT retrying" in res.stdout


def test_an_apply_failure_after_the_first_write_calls_rollback_with_fail_secure_semantics(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.inject("fail-apply")
    res = sim.run()
    assert res.returncode == 1
    assert "L8P_DEVICE_ACTION_TAKEN=NONE" in res.stdout and "L8P_ROLLBACK=FAIL_SECURE_HOLD_AND_EVIDENCE" in res.stdout
    assert [s for s in sim.steps() if s in ("apply", "verify", "rollback")] == ["apply", "rollback"]
    assert sim.marker()


def test_an_apply_failure_before_the_first_write_is_a_stage_local_rollback_only(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.inject("fail-before-write")
    res = sim.run()
    assert res.returncode == 1 and "L8P_ROLLBACK=COMPLETE" in res.stdout and "HARDWARE_PRE_TO_RB_ZERO_DRIFT=NOT_APPLICABLE" not in res.stdout
    assert sim.marker() and "rollback" in sim.calls()


def test_a_rollback_that_breaks_its_fail_secure_contract_is_escalated_not_accepted(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.inject("fail-apply")
    sim.inject("bad-rollback")
    res = sim.run()
    assert res.returncode == 3 and "ESCALATE" in res.stdout and "capture:rb" not in sim.calls()


@pytest.mark.parametrize("inj", ["fail-capture-rb", "bad-sums-rb", "fail-compare-rb"])
def test_a_missing_or_failed_rb_capture_or_compare_after_failure_is_escalated(tmp_path: Path, inj: str) -> None:
    sim = Sim(tmp_path)
    sim.inject("fail-apply")
    sim.inject(inj)
    res = sim.run()
    assert res.returncode == 3 and "ESCALATE" in res.stdout and "do NOT retry" in res.stdout
    assert sim.calls().count("apply") == 1


def test_a_secret_in_the_evidence_blocks_success_and_the_value_is_never_printed(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.inject("leak-secret")
    res = sim.run()
    assert res.returncode == 1 and "SECRET_OUTPUT_SCAN failed" in res.stdout
    assert "L8P_PROVISIONING=PASS" not in res.stdout
    assert SECRET["wifi.psk"] not in res.stdout + res.stderr


def test_no_secret_value_appears_in_a_successful_run_output(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    res = sim.run()
    assert res.returncode == 0
    for value in SECRET.values():
        assert value not in res.stdout + res.stderr
        for f in sim.evid_base.rglob("*"):
            if f.is_file():
                assert value.encode() not in f.read_bytes()


# ═══════════════════════════════════════ 3. one attempt ═══════════════════════════════════════════════════════════════════


def test_a_consumed_authorization_cannot_rerun_even_after_success_or_failure(tmp_path: Path) -> None:
    for i, inject in enumerate((None, "fail-apply")):
        sim = Sim(tmp_path / str(i))
        if inject:
            sim.inject(inject)
        first = sim.run()
        assert sim.marker()
        applies = sim.calls().count("apply")
        second = sim.run()
        assert second.returncode == 1 and "already consumed its one live attempt" in second.stderr
        assert sim.calls().count("apply") == applies, "no second attempt"
        assert first.returncode in (0, 1)


def test_the_marker_is_distinct_from_l7u_and_an_l7u_marker_never_satisfies_l8p(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    (sim.auth / "L7u-ATTEMPT-CONSUMED").write_text("consumed_at=x\n")
    (sim.auth / "L7-ATTEMPT-CONSUMED").write_text("consumed_at=x\n")
    res = sim.run()
    assert res.returncode == 0 and sim.marker() and "L8p-ATTEMPT-CONSUMED" in RUNNER.read_text() + LIB.read_text()


def test_the_attempt_marker_is_atomic_under_concurrent_consumption(tmp_path: Path) -> None:
    auth = tmp_path / "auth"
    auth.mkdir()
    results: list[int] = []

    def consume() -> None:
        r = subprocess.run(["bash", "-c", f". '{LIB}'; l8p_consume_attempt '{auth}'"], capture_output=True, text=True, check=False)
        results.append(r.returncode)

    threads = [threading.Thread(target=consume) for _ in range(12)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results) == [0] + [1] * 11
    assert (auth / "L8p-ATTEMPT-CONSUMED").read_text().startswith("consumed_at=")


def test_the_marker_rejects_symlinked_missing_or_pre_existing_targets(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    for target in (str(link), str(tmp_path / "missing")):
        r = subprocess.run(["bash", "-c", f". '{LIB}'; l8p_consume_attempt '{target}'"], capture_output=True, text=True, check=False)
        assert r.returncode == 1 and "L8P_ATTEMPT_AUTH_DIR_INVALID" in r.stderr
    (real / "L8p-ATTEMPT-CONSUMED").write_text("x")
    r = subprocess.run(["bash", "-c", f". '{LIB}'; l8p_consume_attempt '{real}'"], capture_output=True, text=True, check=False)
    assert r.returncode == 1 and "ALREADY_CONSUMED" in r.stderr


# ═══════════════════════════════════════ 4. every pre-gate refuses BEFORE any mutation, consumption or device access ═══════


def refuses(sim: Sim, needle: str, code: int = 1) -> None:
    res = sim.run()
    assert res.returncode == code, res.stdout + res.stderr
    assert needle in res.stdout + res.stderr, res.stdout + res.stderr
    assert not sim.marker() and sim.calls() == [], "nothing created, consumed or called; the hardware backend was never reachable"
    assert not list(sim.evid_base.iterdir()), "no evidence directory before the gates pass"


def test_wrong_main_refuses_before_mutation(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.runner.write_text(sim.runner.read_text().replace(f"EXPECTED_MAIN={sim.head}", "EXPECTED_MAIN=" + "a" * 40))
    refuses(sim, "worktree HEAD is not")


def test_a_dirty_pinned_worktree_refuses(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    (sim.repo / "stray.txt").write_text("dirty\n")
    refuses(sim, "worktree is not clean")


def test_origin_main_that_moved_refuses_without_silent_repinning(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
    other = tmp_path / "other"
    subprocess.run(["git", "clone", "-q", str(sim.repo), str(other)], check=True, capture_output=True, env=env)
    (other / "n.txt").write_text("n\n")
    subprocess.run(["git", "-C", str(other), "add", "-A"], check=True, env=env, capture_output=True)
    subprocess.run(["git", "-C", str(other), "commit", "-q", "-m", "n"], check=True, env=env, capture_output=True)
    subprocess.run(["git", "-C", str(sim.repo), "remote", "set-url", "origin", str(other)], check=True, capture_output=True)
    refuses(sim, "origin/main is not")


def test_a_missing_authorization_refuses(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    (sim.auth / "authorization-L8p.txt").unlink()
    refuses(sim, "authorization-L8p.txt missing")


@pytest.mark.parametrize("over,needle", [({"date": "2020-01-01"}, "date is not today"), ({"stage": "L8"}, "is not stage=L8p"), ({"stage": "L7u"}, "is not stage=L8p")])
def test_a_stale_or_wrong_stage_authorization_refuses(tmp_path: Path, over: dict, needle: str) -> None:
    refuses(Sim(tmp_path, auth_over=over), needle)


def test_an_authorization_without_the_physical_recovery_attestation_refuses(tmp_path: Path) -> None:
    refuses(Sim(tmp_path, auth_over={"physical_recovery_attestation": None}), "lacks physical_recovery_attestation")


@pytest.mark.parametrize("extra", ["recovery_authorization=sim/r", "d6_notice=pub", "integration_review=kla"])
def test_an_l8_only_or_other_stage_field_refuses(tmp_path: Path, extra: str) -> None:
    key, value = extra.split("=")
    sim = Sim(tmp_path, auth_over={key: value})
    res = sim.run()
    assert res.returncode == 1 and ("recovery_authorization" in res.stderr or "stage gate failed" in res.stderr)
    assert not sim.marker() and sim.calls() == []


def test_missing_or_invalid_k3_refuses(tmp_path: Path) -> None:
    for i, kind in enumerate((None, "bad")):
        sim = Sim(tmp_path / str(i), k3=kind)
        res = sim.run()
        assert res.returncode == 1 and ("k3-L8p.txt missing" in res.stderr or "stage gate failed" in res.stderr)
        assert not sim.marker() and sim.calls() == []


def test_missing_l7u_live_acceptance_refuses_and_is_never_invented(tmp_path: Path) -> None:
    sim = Sim(tmp_path, l7u=False)
    refuses(sim, "L8P_L7U_ACCEPTANCE_RECEIPT_MISSING")


def test_an_already_recorded_l8p_result_refuses_a_new_attempt(tmp_path: Path) -> None:
    refuses(Sim(tmp_path, l8p_done=True), "L8P_ALREADY_PROVISIONED")


def _gate_passes(sim: Sim) -> None:
    res = sim.run()
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L8P_ALREADY_PROVISIONED" not in res.stdout + res.stderr


def test_prose_mentioning_the_future_success_claim_does_not_block(tmp_path: Path) -> None:
    prose = "- Success claims only `L8P_LIVE_EXECUTED=YES` and `L8P_PROVISIONING=PASS`, retaining `L8_ACCEPTANCE=NO`.\nThe run will record L8P_PROVISIONING=PASS when it passes.\n"
    _gate_passes(Sim(tmp_path, l8p_receipts={"2026-10-02_041051_music_idea3-l8p-owner-runner.md": prose}))


def test_provisioning_pass_alone_does_not_block(tmp_path: Path) -> None:
    _gate_passes(Sim(tmp_path, l8p_receipts={"2026-10-06_000000_music_idea3-x.md": "L8P_PROVISIONING=PASS\nL8P_LIVE_EXECUTED=NO\n"}))


def test_live_executed_alone_does_not_block(tmp_path: Path) -> None:
    _gate_passes(Sim(tmp_path, l8p_receipts={"2026-10-06_000000_music_idea3-x.md": "L8P_LIVE_EXECUTED=YES\nL8P_PROVISIONING=NOT_PROVEN\n"}))


def test_both_exact_fields_in_the_same_receipt_refuse(tmp_path: Path) -> None:
    for i, body in enumerate(("L8P_LIVE_EXECUTED=YES\nL8P_PROVISIONING=PASS\n", "`L8P_LIVE_EXECUTED = YES`\n`L8P_PROVISIONING = PASS`\n",
                              "- L8P_LIVE_EXECUTED=YES\n- `L8P_PROVISIONING=PASS`\nother text\n", "  L8P_PROVISIONING = PASS  \n\n  L8P_LIVE_EXECUTED=YES\n")):
        refuses(Sim(tmp_path / str(i), l8p_receipts={"2026-10-06_000000_music_idea3-live.md": body}), "L8P_ALREADY_PROVISIONED")


def test_the_two_fields_in_two_different_receipts_do_not_combine(tmp_path: Path) -> None:
    _gate_passes(Sim(tmp_path, l8p_receipts={"2026-10-06_000000_music_idea3-a.md": "L8P_LIVE_EXECUTED=YES\n", "2026-10-06_000001_music_idea3-b.md": "L8P_PROVISIONING=PASS\n"}))


@pytest.mark.parametrize("line", ["Result: L8P_PROVISIONING=PASS (expected)", "not L8P_LIVE_EXECUTED=YES yet", "XL8P_PROVISIONING=PASS", "L8P_PROVISIONING=PASSED", "L8P_LIVE_EXECUTED=YES, L8P_PROVISIONING=PASS"])
def test_unanchored_or_embedded_mentions_do_not_count(tmp_path: Path, line: str) -> None:
    _gate_passes(Sim(tmp_path, l8p_receipts={"2026-10-06_000000_music_idea3-m.md": f"{line}\nL8P_LIVE_EXECUTED=YES\n" if "LIVE" not in line else f"{line}\nL8P_PROVISIONING=PASS\n"}))


def test_only_the_canonical_status_log_path_is_searched() -> None:
    lib = LIB.read_text() if hasattr(LIB, "read_text") else Path(LIB).read_text()
    block = lib[lib.index("l8p_result_field_files()"):lib.index("l8p_input_gate")]
    assert '"$L6B_LOGS_REL"' in block and "tests/" not in block and "docs/" not in block and "deploy/" not in block


def test_the_receipt_gate_change_adds_no_hardware_or_production_command() -> None:
    lib = Path(LIB).read_text()
    block = lib[lib.index("l8p_result_field_files()"):lib.index("l8p_input_gate")]
    for forbidden in ("esptool", "/dev/tty", "systemctl", "sudo", "nmcli", "serial", "mosquitto"):
        assert forbidden not in block, forbidden


def test_missing_l8p_handlers_refuse(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    (sim.p4 / "stages" / "L8p" / "apply.sh").unlink()
    sim._git("add", "-A")
    sim._git("commit", "-q", "-m", "rm")
    sim.runner.write_text(sim.runner.read_text().replace(f"EXPECTED_MAIN={sim.head}", f"EXPECTED_MAIN={sim._git('rev-parse', 'HEAD')}"))
    refuses(sim, "handler file apply.sh missing")


@pytest.mark.parametrize("unit,key,value,needle", [
    ("aegis-idea3-core.service", "ActiveState", "inactive", "L7U_CORE_NOT_RUNNING_BASELINE"),
    ("aegis-idea3-core.service", "NRestarts", "1", "L7U_CORE_NOT_RUNNING_BASELINE"),
    ("aegis-idea3-mosquitto.service", "SubState", "dead", "L8P_SERVICE_NOT_ACTIVE"),
    ("twingate.service", "ActiveState", "failed", "L8P_SERVICE_NOT_ACTIVE"),
    ("aegis-detection-engine.service", "ActiveState", "failed", "L7_IDEA2_S10_NOT_PRESERVABLE"),
])
def test_a_runtime_gate_failure_refuses_without_repairing_anything(tmp_path: Path, unit: str, key: str, value: str, needle: str) -> None:
    sim = Sim(tmp_path)
    sim.prop(unit, key, value)
    refuses(sim, needle)


def test_a_wrong_reviewed_artifact_digest_refuses(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.firmware.write_bytes(FIRMWARE + b"tampered")
    refuses(sim, "L8P_ARTIFACT_DIGEST_MISMATCH:firmware")
    sim2 = Sim(tmp_path / "t")
    sim2.table.write_bytes(TABLE + b"x")
    refuses(sim2, "L8P_ARTIFACT_DIGEST_MISMATCH:partition-table")


@pytest.mark.parametrize("mutate,needle", [
    (lambda s: (s.inputs / "k_c2d").unlink(), "L8P_INPUT_ENTRIES_NOT_EXACT"),
    (lambda s: (s.inputs / "extra").write_text("x"), "L8P_INPUT_ENTRIES_NOT_EXACT"),
    (lambda s: s.inputs.chmod(0o755), "L8P_INPUT_DIR_MODE_NOT_0700"),
    (lambda s: ((s.inputs / "wifi.psk").unlink(), (s.inputs / "wifi.psk").symlink_to(s.dir / "firmware.bin")), "L8P_INPUT_NOT_A_REGULAR_FILE:wifi.psk"),
    (lambda s: (s.dir / "nvs-gen").chmod(0o644), "L8P_FILE_NOT_EXECUTABLE:nvs-generator"),
    (lambda s: (s.dir / "ca.pem").unlink(), "L8P_FILE_MISSING:mqtt-ca"),
])
def test_the_owner_input_and_support_file_contracts_refuse(tmp_path: Path, mutate, needle: str) -> None:
    sim = Sim(tmp_path)
    mutate(sim)
    refuses(sim, needle)


def test_a_pre_capture_failure_refuses_before_the_attempt_is_consumed(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.inject("fail-capture-pre")
    res = sim.run()
    assert res.returncode == 1 and "PRE capture failed; nothing changed and nothing consumed" in res.stdout + res.stderr
    assert not sim.marker() and sim.calls() == ["capture:pre"], "no handler, no rollback, no device"


def test_a_pre_checksum_failure_refuses_before_the_attempt_is_consumed(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.inject("bad-sums-pre")
    res = sim.run()
    assert res.returncode == 1 and not sim.marker() and sim.calls() == ["capture:pre"]


def test_the_receipt_gate_passes_on_the_current_repository_state(tmp_path: Path) -> None:
    """Repository-only gate (it reads the pinned commit's status-log receipts, never the host): the final L7 and FINAL L7u acceptances are merged and PROVEN, and no
    actual L8p LIVE result receipt exists — the prose in the repository-only owner-runner receipt that merely mentions the future success claim is not a result."""
    res = subprocess.run(["bash", "-c", f". '{LIB}'; l8p_receipt_gate '{ROOT.parent}'"], capture_output=True, text=True, check=False)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L8P_ALREADY_PROVISIONED" not in res.stderr


def test_the_repository_only_owner_runner_receipt_prose_is_not_an_l8p_result() -> None:
    """Root cause of the former false positive: a bullet sentence listing the future success claims. It carries both strings but not as whole-line result fields."""
    receipt = ROOT.parent / LOGS / "2026-10-02_041051_music_idea3-l8p-owner-runner.md"
    text = receipt.read_text()
    assert "L8P_LIVE_EXECUTED=YES" in text and "L8P_PROVISIONING=PASS" in text, "the prose that used to be misread is still there (history is not rewritten)"
    whole = re.compile(r"^\s*([-*]\s+)?`?(L8P_LIVE_EXECUTED\s*=\s*YES|L8P_PROVISIONING\s*=\s*PASS)`?\s*$", re.M)
    assert not whole.search(text)


# ═══════════════════════════════════════ 4b. frozen operator identity (the L7u identity gate, reused) ═══════════════════════


def test_the_correct_frozen_operator_passes_the_identity_gate(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    res = sim.run()
    assert res.returncode == 0, res.stdout + res.stderr
    assert "operator identity is not the frozen" not in res.stdout + res.stderr


def test_the_runner_reuses_the_l7u_identity_gate_without_a_second_parser() -> None:
    code = code_only(RUNNER)
    assert code.count('l7u_identity_gate "$OPERATOR_USER" "$OPERATOR_UID"') == 1
    assert "id -un" not in code and "id -u" not in code.replace("$(id -u)", ""), "no duplicated identity parsing in the runner"


def test_root_remains_refused() -> None:
    code = code_only(RUNNER)
    assert '[ "$(id -u)" != 0 ]' in code and "[1-9][0-9]*" in code, "root is refused and a root uid pin is malformed"


def test_a_wrong_current_username_refuses_before_anything_happens(tmp_path: Path) -> None:
    sim = Sim(tmp_path, operator_user="someoneelse")
    refuses(sim, "L7U_OPERATOR_IDENTITY_MISMATCH")


def test_a_wrong_current_uid_refuses_before_anything_happens(tmp_path: Path) -> None:
    sim = Sim(tmp_path, operator_uid=str(int(REAL_UID) + 1))
    refuses(sim, "L7U_OPERATOR_IDENTITY_MISMATCH")


def test_a_frozen_username_that_resolves_to_a_different_uid_refuses(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    (sim.dir / "resolved-uid").write_text(str(int(REAL_UID) + 7) + "\n")
    refuses(sim, "L7U_OPERATOR_IDENTITY_MISMATCH")


def test_identity_refusal_precedes_pre_capture_the_attempt_and_every_handler_or_device_path(tmp_path: Path) -> None:
    sim = Sim(tmp_path, operator_user="someoneelse")
    res = sim.run()
    assert res.returncode == 1 and sim.calls() == [], "no PRE capture, no handler, no rollback"
    assert not sim.marker() and not list(sim.evid_base.iterdir()), "no attempt consumed and no evidence directory"
    assert "capture:pre" not in sim.calls() and "env:apply" not in "\n".join(sim.calls())


def test_the_identity_gate_precedes_sudo_the_evidence_directory_the_marker_and_the_handlers_in_the_source() -> None:
    text = code_only(RUNNER)
    gate = text.index('l7u_identity_gate "$OPERATOR_USER" "$OPERATOR_UID"')
    for later in ("sudo -v", "mkdir -m 700", "capture PRE", "l8p_consume_attempt", "handler apply.sh", "l8p_input_gate"):
        assert gate < text.index(later), later


def test_input_ownership_is_checked_against_the_frozen_operator_uid(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    assert 'l8p_input_gate "$INPUT_DIR" "$OPERATOR_UID"' in code_only(RUNNER), "the runner passes the FROZEN uid, not merely the current caller"
    for uid_arg, expect in ((REAL_UID, 0), (str(int(REAL_UID) + 1), 1)):
        r = subprocess.run(["bash", "-c", f". '{LIB}'; l8p_input_gate '{sim.inputs}' '{uid_arg}'"], text=True, capture_output=True, check=False)
        assert r.returncode == expect, r.stderr
        if expect:
            assert "L8P_INPUT_DIR_OWNER_MISMATCH" in r.stderr
    bad = subprocess.run(["bash", "-c", f". '{LIB}'; l8p_input_gate '{sim.inputs}' 0"], text=True, capture_output=True, check=False)
    assert bad.returncode == 1 and "L8P_INPUT_OPERATOR_UID_INVALID" in bad.stderr


# ═══════════════════════════════════════ 5. library unit tests ═══════════════════════════════════════════════════════════


def lib(script: str, **env: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", "-c", f". '{LIB}'; {script}"], text=True, capture_output=True, env={**os.environ, **env}, check=False)


def test_rollback_output_gate_requires_the_exact_fail_secure_semantics() -> None:
    ok_started = "L8P_DEVICE_ACTION_TAKEN=NONE\nL8P_ROLLBACK=FAIL_SECURE_HOLD_AND_EVIDENCE"
    ok_before = "L8P_DEVICE_ACTION_TAKEN=NONE\nL8P_ROLLBACK=COMPLETE"
    assert lib(f"l8p_rollback_output_gate 1 '{ok_started}'").returncode == 0
    assert lib(f"l8p_rollback_output_gate 0 '{ok_before}'").returncode == 0
    assert lib(f"l8p_rollback_output_gate 1 '{ok_before}'").returncode == 1, "after the first write a plain COMPLETE is not acceptable"
    assert lib("l8p_rollback_output_gate 1 'L8P_DEVICE_ACTION_TAKEN=REFLASH\nL8P_ROLLBACK=FAIL_SECURE_HOLD_AND_EVIDENCE'").returncode == 1
    assert lib("l8p_rollback_output_gate 0 'L8P_ROLLBACK=COMPLETE'").returncode == 1


def test_secret_scan_reports_only_counts_and_fails_on_any_secret_value(tmp_path: Path) -> None:
    inp = tmp_path / "in"
    inp.mkdir()
    for name, value in SECRET.items():
        (inp / name).write_text(value + "\n")
    ev = tmp_path / "ev"
    ev.mkdir()
    (ev / "clean.txt").write_text("nothing here\n")
    ok = lib(f"l8p_secret_scan '{ev}' '{inp}' python3", SUDO="")
    assert ok.returncode == 0
    (ev / "leak.txt").write_text(f"x {SECRET['mqtt.pass']} y\n")
    bad = lib(f"l8p_secret_scan '{ev}' '{inp}' python3", SUDO="")
    assert bad.returncode == 1 and SECRET["mqtt.pass"] not in bad.stdout + bad.stderr
    (ev / "leak.txt").write_text("-----BEGIN PRIVATE KEY-----\n")
    assert lib(f"l8p_secret_scan '{ev}' '{inp}' python3", SUDO="").returncode == 1


# ═══════════════════════════════════════ 6. forbidden operations and claims ═══════════════════════════════════════════════


def test_the_runner_never_invokes_the_flash_tool_or_any_device_operation_itself() -> None:
    for path in (RUNNER, LIB):
        code = code_only(path)
        # The ONE sanctioned exception is the read-only pre-consume interpreter gate (`l8p_esptool_python_gate`, pinned to `--help` by the test below) and its call.
        code = re.sub(r"l8p_esptool_python_gate\(\) \{.*?\n\}\n", "", code, flags=re.DOTALL)
        code = "\n".join(l for l in code.splitlines() if "l8p_esptool_python_gate" not in l)
        assert not re.search(r"esptool|platformio|\bpio\b|write_flash|read_flash|erase|efuse|write_mem|/dev/tty|picocom|minicom|screen ", code.replace("AEGIS_L8P_ESPTOOL", "")), path.name
    assert "p4-l8-device.py" not in code_only(RUNNER) and "HardwareDevice" not in code_only(RUNNER)
    assert len([l for l in code_only(RUNNER).splitlines() if "p4-l8p-device.py" in l]) == 1, "only the existence gate; the handlers reach it"


def test_the_runner_sends_no_cut_or_restore_and_opens_no_plaintext_transport() -> None:
    for path in (RUNNER, LIB):
        code = code_only(path)
        assert not re.search(r"mosquitto_pub|mosquitto_sub|aegisctl|\bRESTORE\b|\bCUT\b|:1883|\b1883\b|nc |ncat|curl|ssh ", code), path.name


def test_the_runner_never_retries_reflashes_or_loops_over_the_handlers() -> None:
    code = code_only(RUNNER)
    assert not re.search(r"\b(while|until)\b", code) and not re.search(r"\bfor\b[^\n]*\bhandler (apply|verify|rollback)", code)
    assert "retry" not in code.lower().replace("not retrying", "").replace("do not retry", "")
    assert code.count("handler apply.sh") == 1 and code.count("handler verify.sh") == 1 and code.count("handler rollback.sh") == 1


def test_the_hardware_backend_is_requested_in_exactly_one_place_after_the_attempt_is_consumed() -> None:
    text = code_only(RUNNER)
    assert text.count("AEGIS_L8P_LIVE_AUTHORIZED=YES") == 1 and text.count("AEGIS_L8P_BACKEND=hardware") == 1
    assert text.index("l8p_consume_attempt") < text.index("handler apply.sh")
    handler_def = text.index("handler() {")
    assert handler_def < text.index("AEGIS_L8P_BACKEND=hardware") < text.index("own_pre()")


def test_the_runner_claims_nothing_beyond_provisioning_and_uses_l8p_records_only() -> None:
    text = RUNNER.read_text()
    for forbidden in ("RECOVERY_R1_R8_PROVEN=YES", "LVR_PROVEN=YES", "L8_ACCEPTANCE=YES", "ELECTRICAL_RELAY_PROOF=YES", "L8_STARTED=YES", "L8_LIVE_ACCEPTANCE"):
        assert forbidden not in text
    assert "authorization-L8p.txt" in text and "k3-L8p.txt" in text and "authorization-L7u" not in text and "L7u-ATTEMPT" not in text
    assert "--stage L8p --mode live" in text and "p4-stage-gate.sh" in text


def test_the_runner_reuses_the_canonical_handlers_and_stage_gate_without_duplicating_them() -> None:
    code = code_only(RUNNER)
    assert '"$STG/$1"' in code and "p4-stage-gate.sh" in code and "p4-l0-capture.sh" in code and "p4-compare.sh" in code
    assert "stages/L8p" in code or 'STG=$P4/stages/L8p' in code
    assert not re.search(r"sha256sum -c.*first-write|first-write\.marker\" *>", code)


# ═══════════════ 11. the PRE-L8p NTP runtime must be TRUE NOW, before the attempt is consumed and before any device access ═══════════════
# Root cause behind these gates: the consumed 2026-10-03 NTP reactivation passed VERIFY and then lost chronyd to its own POST capture. L8p's PRE capture comes before
# the attempt marker, so the runner proves the NTP runtime in the pre-gates AND again after the PRE capture, immediately before consuming the attempt.

NTP_BREAKERS = [
    ("chronyd-inactive", lambda s: s.prop("chronyd.service", "ActiveState", "inactive\n"), "NTPREACT_UNIT_STATE_MISMATCH:chronyd.service.ActiveState=inactive"),
    ("timesyncd-active", lambda s: (s.prop("systemd-timesyncd.service", "ActiveState", "active\n"), s.prop("systemd-timesyncd.service", "SubState", "running\n")),
     "NTPREACT_UNIT_STATE_MISMATCH:systemd-timesyncd.service.ActiveState=active"),
    ("chronyd-unitfile-enabled", lambda s: s.prop("chronyd.service", "UnitFileState", "enabled\n"), "NTPREACT_UNIT_STATE_MISMATCH:chronyd.service.UnitFileState=enabled"),
    ("timesyncd-unitfile-disabled", lambda s: s.prop("systemd-timesyncd.service", "UnitFileState", "disabled\n"),
     "NTPREACT_UNIT_STATE_MISMATCH:systemd-timesyncd.service.UnitFileState=disabled"),
    ("no-listener", lambda s: s.ss_lines("udp UNCONN 0 0 127.0.0.1:323 0.0.0.0:*"), "AP_NTP_LISTENER_MISSING_OR_DUPLICATED:0"),
    ("wildcard-listener", lambda s: s.ss_lines("udp UNCONN 0 0 0.0.0.0:123 0.0.0.0:*"), "WILDCARD_NTP_LISTENER_FORBIDDEN"),
    ("foreign-address-listener", lambda s: s.ss_lines("udp UNCONN 0 0 192.0.2.1:123 0.0.0.0:*"), "NON_AP_NTP_LISTENER_FORBIDDEN:192.0.2.1"),
    ("extra-wildcard-listener", lambda s: s.ss_lines("udp UNCONN 0 0 10.77.30.1:123 0.0.0.0:*", "udp UNCONN 0 0 [::]:123 [::]:*"), "WILDCARD_NTP_LISTENER_FORBIDDEN"),
    ("clock-unsynced", lambda s: s.inject("clock-unsynced"), "NTPREACT_TRUSTEDCLOCK_NOT_OK"),
    ("clock-maxerror-over-bound", lambda s: (s.dir / "clock-maxerror").write_text("1000001\n"), "NTPREACT_MAXERROR_EXCEEDED:1000001"),
    ("chrony-conf-changed", lambda s: (s.dir / "chrony.conf").write_text("server evil.example iburst\n"), "NTPREACT_CHRONY_CONF_NOT_APPROVED_L5_CONTENT"),
]


def _assert_nothing_consumed_or_touched(sim: Sim, res: subprocess.CompletedProcess[str]) -> None:
    assert res.returncode != 0 and "L8P_PROVISIONING=PASS" not in res.stdout + res.stderr
    assert not sim.marker(), "no attempt may be consumed"
    calls = sim.calls()
    for forbidden in ("apply", "verify", "rollback"):
        assert forbidden not in calls, f"{forbidden} handler (the only device path) must not run"
    assert not any(c.startswith("env:") for c in calls), "no handler (hence no serial access, reset or first write) may start"
    assert not list(sim.evid_base.glob("**/first-write.marker")), "no first write"


@pytest.mark.parametrize("name,breaker,reason", NTP_BREAKERS, ids=[b[0] for b in NTP_BREAKERS])
def test_an_absent_ntp_runtime_refuses_in_the_pre_gates_before_anything_is_created(tmp_path: Path, name: str, breaker, reason: str) -> None:
    sim = Sim(tmp_path)
    breaker(sim)
    res = sim.run()
    out = res.stdout + res.stderr
    _assert_nothing_consumed_or_touched(sim, res)
    assert reason in out and "L8P_NTP_RUNTIME_NOT_READY" in out and "the PRE-L8p NTP runtime is not true now" in out
    assert "capture:pre" not in sim.calls(), "the pre-gate must fail before the PRE capture and before the evidence directory exists"
    assert not any(sim.evid_base.iterdir()), "no evidence directory is created when a pre-gate fails"


def test_a_healthy_ntp_runtime_lets_the_runner_pass_the_gate_and_reach_the_device_handlers(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    res = sim.run()
    assert res.returncode == 0, res.stdout + res.stderr
    assert sim.calls().count("apply") == 1


def test_ntp_lost_by_the_pre_capture_itself_refuses_before_the_attempt_is_consumed(tmp_path: Path) -> None:
    """The exact consumed-attempt failure mode: the NTP runtime is true in the pre-gates, then the evidence capture stops chronyd."""
    sim = Sim(tmp_path)
    sim.inject("ntp-lost-by-pre-capture")
    res = sim.run()
    out = res.stdout + res.stderr
    assert res.returncode == 1 and "the PRE-L8p NTP runtime is not true after the PRE capture" in out
    assert "NTPREACT_UNIT_STATE_MISMATCH:chronyd.service.ActiveState=inactive" in out
    assert "the attempt was NOT consumed and the device was NOT touched" in out
    assert "capture:pre" in sim.calls(), "the first (pre-gate) check passed and the PRE capture ran"
    _assert_nothing_consumed_or_touched(sim, res)


def test_the_ntp_gate_runs_in_the_pre_gates_and_again_after_the_pre_capture_and_before_the_marker() -> None:
    code = code_only(RUNNER)
    assert code.count("l8p_ntp_runtime_gate") == 2
    first, second = (m.start() for m in re.finditer(r"l8p_ntp_runtime_gate", code))
    pre_capture, consume = code.index("capture PRE"), code.index("l8p_consume_attempt")
    assert code.index("l7_disk_gate") < first < pre_capture < second < consume
    assert code.index("l8p_receipt_gate") < first, "the receipt gate is not weakened or reordered"
    assert code.index("handler apply.sh") > consume > second, "the only device path (apply.sh) is reached only after the second gate and the consumed attempt"
    # the gate itself is the shared read-only predicate: it can never start, stop or repair a time daemon
    lib = code_only(LIB)
    assert "ntpreact_runtime_ready_gate" in lib
    assert not re.search(r"systemctl\s+(start|stop|restart|enable|disable|mask|reload)", lib)
    ntp = code_only(DEPLOY / "p4-ntp-reactivation-lib.sh")
    gate_body = ntp[ntp.index("ntpreact_runtime_ready_gate()"):]
    gate_body = gate_body[:gate_body.index("\n}\n")]
    for needle in ("start", "stop", "restart", "enable", "disable", "timedatectl", "show-timesync", "chronyc"):
        assert not re.search(rf"\b{needle}\b", gate_body), needle


def test_the_ntp_gate_does_not_weaken_the_disk_gate_the_receipt_gate_or_one_shot_semantics(tmp_path: Path) -> None:
    refuses(Sim(tmp_path / "a", l8p_done=True), "L8P_ALREADY_PROVISIONED")
    sim = Sim(tmp_path / "b")
    sim.prop("chronyd.service", "ActiveState", "inactive\n")
    sim.inject("clock-unsynced")
    res = sim.run()
    assert "the PRE-L8p NTP runtime is not true now" in res.stdout + res.stderr and not sim.marker()
    code = code_only(RUNNER)
    assert "l7_disk_gate 80 / /var /opt /run" in code and "l8p_attempt_unconsumed" in code and "l7_idea2_s10_gate" in code


# ═══════════ 12. the esptool interpreter is its own frozen pin and is proven loadable BEFORE the attempt is consumed ═══════════
# Root cause: the orchestration Python (PY / AEGIS_PYTHON_BIN) was also the implicit esptool launcher, and it cannot import the pinned esptool's dependencies, so a live run would have failed
# after the one-shot attempt was consumed. ESPTOOL_PYTHON is a separate frozen pin; l8p_esptool_python_gate runs the PINNED script with `--help` (no serial, no flash command) in the pre-gates.


def test_the_committed_template_carries_the_esptool_python_pin_unresolved_and_hardcodes_no_interpreter() -> None:
    text = RUNNER.read_text()
    assert re.search(r"^ESPTOOL_PYTHON=PIN_ESPTOOL_PYTHON$", text, re.MULTILINE)
    assert "ESPTOOL_PYTHON" in re.search(r"^for pin in .*?; do", text, re.MULTILINE | re.DOTALL).group(0), "it is part of the frozen-pin refusal loop"
    assert not re.search(r"^ESPTOOL_PYTHON=/", text, re.MULTILINE), "no local interpreter path is committed"
    assert "aegis-esptool" not in text
    res = subprocess.run(["bash", str(RUNNER), "/nonexistent"], text=True, capture_output=True, check=False)
    assert res.returncode == 2 and "runner is not pinned" in res.stdout


def test_freeze_substitution_supports_the_new_pin_and_changes_only_pin_lines(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    frozen = sim.runner.read_text().splitlines()
    template = RUNNER.read_text().splitlines()
    assert not [l for l in frozen if re.match(r"^[A-Z_0-9]+=PIN_", l)], "no unresolved pin value remains"
    assert f"ESPTOOL_PYTHON={sys.executable}" in frozen
    changed = {t.split("=")[0] for t, f in zip(template, frozen) if t != f and re.match(r"^[A-Z_0-9]+=PIN_", t)}
    assert "ESPTOOL_PYTHON" in changed


def test_a_healthy_esptool_python_passes_the_gate_and_the_run_completes(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    res = sim.run()
    assert res.returncode == 0, res.stdout + res.stderr


ESPTOOL_BREAKERS = [
    ("nonexistent-interpreter", lambda s: setattr(s, "esptool_python", "/nonexistent/venv-esptool/bin/python"), "L8P_ESPTOOL_PYTHON_NOT_EXECUTABLE"),
    ("relative-interpreter", lambda s: setattr(s, "esptool_python", "python3"), "L8P_ESPTOOL_PYTHON_NOT_ABSOLUTE"),
    ("not-a-python-name", lambda s: setattr(s, "esptool_python", shutil.which("true")), "L8P_ESPTOOL_PYTHON_NOT_A_PYTHON_INTERPRETER"),
    ("missing-esptool-dependency", lambda s: s.inject("esptool-dep-missing"), "L8P_ESPTOOL_PYTHON_CANNOT_LOAD_PINNED_ESPTOOL:ModuleNotFoundError: No module named 'intelhex_dependency_is_not_installed'"),
    ("unexpected-esptool-build", lambda s: (s.dir / "esptool-banner").write_text("esptool v5.4.0\n"), "L8P_ESPTOOL_PYTHON_UNEXPECTED_ESPTOOL_BUILD"),
]


@pytest.mark.parametrize("name,breaker,reason", ESPTOOL_BREAKERS, ids=[b[0] for b in ESPTOOL_BREAKERS])
def test_an_unusable_esptool_python_fails_in_the_pre_gates_with_no_attempt_and_no_device_access(tmp_path: Path, name: str, breaker, reason: str) -> None:
    sim = Sim(tmp_path)
    breaker(sim)
    # the interpreter pin is substituted into the frozen runner at build time: rebuild it for the value-changing cases
    sim.runner.write_text(re.sub(r"^ESPTOOL_PYTHON=.*$", lambda _m: f"ESPTOOL_PYTHON={sim.esptool_python}", sim.runner.read_text(), count=1, flags=re.MULTILINE))
    res = sim.run()
    out = res.stdout + res.stderr
    assert res.returncode == 1, out
    assert reason in out and "the pinned esptool Python cannot load the pinned esptool" in out
    assert not sim.marker(), "ATTEMPT_CONSUMED=NO"
    assert sim.calls() == [], "no capture, no handler (hence no serial/reset/write): ESP32_TOUCHED=NO"
    assert not list(sim.evid_base.iterdir()), "no evidence directory is created by a failed pre-gate"


def test_a_broken_interpreter_that_exits_nonzero_fails_the_gate_before_the_attempt(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    broken = sim.dir / "python-broken"
    broken.write_text("#!/usr/bin/env bash\necho \"ImportError: cannot import name 'serial'\" >&2\nexit 1\n")
    broken.chmod(0o755)
    sim.esptool_python = str(broken)
    sim.runner.write_text(re.sub(r"^ESPTOOL_PYTHON=.*$", lambda _m: f"ESPTOOL_PYTHON={broken}", sim.runner.read_text(), count=1, flags=re.MULTILINE))
    res = sim.run()
    assert res.returncode == 1 and "CANNOT_LOAD_PINNED_ESPTOOL:ImportError: cannot import name 'serial'" in res.stdout + res.stderr
    assert not sim.marker() and sim.calls() == []


def test_a_non_executable_interpreter_file_fails_the_gate_before_the_attempt(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    noexec = sim.dir / "python-noexec"
    noexec.write_text("#!/bin/sh\n")
    noexec.chmod(0o644)
    sim.runner.write_text(re.sub(r"^ESPTOOL_PYTHON=.*$", lambda _m: f"ESPTOOL_PYTHON={noexec}", sim.runner.read_text(), count=1, flags=re.MULTILINE))
    res = sim.run()
    assert res.returncode == 1 and "L8P_ESPTOOL_PYTHON_NOT_EXECUTABLE" in res.stdout + res.stderr
    assert not sim.marker() and sim.calls() == []


def test_the_orchestration_python_and_the_esptool_python_stay_separate_in_the_handler_environment(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    assert sim.run().returncode == 0
    seen = [c for c in sim.calls() if c.startswith("py:")]
    assert seen, "the handler stubs recorded their environment"
    for line in seen:
        control = line.split("control=")[1].split(" esptool=")[0]
        tool = line.split(" esptool=")[1]
        assert control == "python3", line               # AEGIS_PYTHON_BIN is the orchestration interpreter (PY), unchanged
        assert tool == sys.executable, line             # the esptool interpreter is the frozen, distinct pin
        assert control != tool


def test_the_runner_threads_the_separate_variable_and_never_repurposes_the_orchestration_interpreter() -> None:
    code = code_only(RUNNER)
    assert 'AEGIS_PYTHON_BIN="$PY"' in code and 'AEGIS_L8P_ESPTOOL_PYTHON="$ESPTOOL_PYTHON"' in code
    assert re.search(r"^PY=/home/kittipat/\.venvs/aegis-idea3-core/bin/python$", code, re.MULTILINE), "the orchestration interpreter is untouched"
    assert not re.search(r"^PY=.*ESPTOOL", code, re.MULTILINE)
    uses = [l.strip() for l in code.splitlines() if "$ESPTOOL_PYTHON" in l]
    assert len(uses) == 2 and any("l8p_esptool_python_gate" in l for l in uses) and any("AEGIS_L8P_ESPTOOL_PYTHON=" in l for l in uses), uses


def test_the_esptool_gate_runs_in_the_pre_gates_before_the_pre_capture_and_the_attempt_marker() -> None:
    code = code_only(RUNNER)
    gate = code.index("l8p_esptool_python_gate")
    assert code.index("l8p_receipt_gate") < gate < code.index("capture PRE") < code.index("l8p_consume_attempt")
    assert code.index("l8p_file_gate \"$FLASH_TOOL_SCRIPT\"") < gate, "the script existence gate precedes it"
    assert code.count("l8p_esptool_python_gate") == 1


def test_the_esptool_gate_only_runs_help_and_opens_no_device_or_package_manager() -> None:
    lib = code_only(LIB)
    body = lib[lib.index("l8p_esptool_python_gate()"):]
    body = body[:body.index("\n}\n")]
    assert '"$py" "$script" --help' in body
    assert "</dev/null" in body, "stdin is closed so the tool can never prompt or read a device"
    body = body.replace("</dev/null", "")
    for banned in ("flash_id", "read_flash", "write_flash", "erase", "write_mem", "reset", "/dev/", "pip", "pacman", "sudo", "curl", "wget", "python3 ", "command -v", "which "):
        assert banned not in body, banned
    assert "env -i" in body and "PATH=/usr/bin:/bin" in body, "a scrubbed environment: no inherited PYTHONPATH/venv state"
    assert "timeout 60" in body


# ═════════════ 13. live attempt 1 regression: the comparator takes EXACTLY two positional arguments ═════════════
# The merged runner called `p4-compare.sh "$1" "$2" "$3" > "$3"`; the real comparator stops at its usage gate on a third argument, so the PRE->POST / PRE->RB comparison could never run
# (live attempt 1: COMPARE_RESULT=FAIL after a pre-first-write rollback). The stub above now behaves like the real comparator and exits 2 unless $# == 2.


def test_the_comparator_is_invoked_with_exactly_two_positional_arguments(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    res = sim.run()
    assert res.returncode == 0, res.stdout + res.stderr
    argcs = [c for c in sim.calls() if c.startswith("argc:")]
    assert argcs and set(argcs) == {"argc:2"}, argcs
    compares = [c for c in sim.calls() if c.startswith("compare:")]
    assert len(compares) == 1
    before, after = compares[0].split(":")[1:3]
    assert before.endswith("/pre-root") and after.endswith("/post-root"), compares


def test_the_comparator_report_is_captured_at_the_runner_supplied_path_not_passed_as_an_argument(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    assert sim.run().returncode == 0
    evid = next(sim.evid_base.iterdir())
    report = evid / "compare-pre-post.txt"
    assert report.is_file(), "the runner redirects the comparator output to its own report path"
    text = report.read_text()
    assert "COMPARE_RESULT=PASS" in text and "FINDINGS_NEW_OR_WORSENED_DRIFT=0" in text and "usage" not in text.lower()
    code = code_only(RUNNER)
    line = next(l for l in code.splitlines() if 'bash "$P4/p4-compare.sh"' in l)
    assert re.search(r'p4-compare\.sh" "\$1" "\$2" > "\$3" 2>&1', line), line


def test_a_pre_first_write_rollback_runs_the_formal_pre_to_rb_comparator_successfully(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.inject("fail-before-write")      # apply fails BEFORE the first device write: stage-local rollback, then the mandatory PRE->RB compare
    res = sim.run()
    out = res.stdout + res.stderr
    assert res.returncode == 1 and "PRE_RB_COMPARE=PASS" in out and "PRE_RB_COMPARE=FAIL" not in out, out
    assert "L8P_PROVISIONING=NOT_PROVEN" in out and "NOT retrying" in out
    argcs = [c for c in sim.calls() if c.startswith("argc:")]
    assert argcs and set(argcs) == {"argc:2"}, argcs
    rb = [c for c in sim.calls() if c.startswith("compare:") and "rb-root" in c]
    assert len(rb) == 1 and rb[0].split(":")[1].endswith("/pre-root"), rb
    evid = next(sim.evid_base.iterdir())
    assert "COMPARE_RESULT=PASS" in (evid / "compare-pre-rb.txt").read_text()
    assert not list(sim.evid_base.glob("**/first-write.marker")), "no first write happened"
    assert sim.calls().count("apply") == 1 and "verify" not in sim.calls()


def test_the_consumed_attempt_stays_consumed_after_a_pre_first_write_failure(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.inject("fail-before-write")
    assert sim.run().returncode == 1 and sim.marker()
    again = sim.run()
    assert again.returncode != 0 and "L8P_ATTEMPT_ALREADY_CONSUMED" in again.stdout + again.stderr
    assert sim.calls().count("apply") == 1, "no second attempt"


def test_the_capture_stub_now_emits_the_real_p4_log_line_so_the_runner_gate_is_exercised_on_it(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    assert sim.run().returncode == 0
    evid = next(sim.evid_base.iterdir())
    log = (evid / "pre-root" / "capture.log").read_text()
    assert re.search(r"^\d{4}-\d\d-\d\dT[\d:]+Z L0_CAPTURE=COMPLETE evidence=\S+$", log, re.MULTILINE), log
    assert "L0_CAPTURE=COMPLETE" not in log.splitlines()  # never the bare line
