"""L8 hardware backend PROTOTYPE — mock esptool only. No serial port is ever opened by these tests.

The prototype is deliberately NOT wired into load_backend()/apply.sh: enabling live L8 is a separate,
owner-approved policy change (OD-L8-05/06 currently say the repository contains no Production write tool).
"""
from __future__ import annotations

import importlib.util
import os
import re
import stat
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "deploy/pr11-phase4/p4-l8-hardware.py"


def load():
    spec = importlib.util.spec_from_file_location("p4_l8_hardware", MODULE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


FAKE = r"""#!/usr/bin/env bash
# fake esptool v5: logs argv, simulates flash as files under $FAKE_FLASH
echo "$*" >> "$FAKE_LOG"
[ -n "${FAKE_FAIL_ON:-}" ] && [[ " $* " == *" $FAKE_FAIL_ON "* ]] && { echo "A fatal error occurred" >&2; exit 2; }
args=("$@"); i=0; verb=""
while [ $i -lt $# ]; do case "${args[$i]}" in read-mac|flash-id|write-flash|read-flash|erase-flash|erase-region) verb=${args[$i]}; break;; esac; i=$((i+1)); done
case "$verb" in
  read-mac) printf 'esptool v5.4.0\nConnected to ESP32 on %s:\nChip type:          ESP32-D0WD-V3 (revision v3.1)\nMAC:                %s\n' "$FAKE_PORT" "${FAKE_MAC:-aa:bb:cc:dd:ee:ff}";;
  flash-id) printf 'Detected flash size: %s\n' "${FAKE_FLASH_SIZE:-4MB}";;
  write-flash) off=${args[$((i+1))]}; cp "${args[$((i+2))]}" "$FAKE_FLASH/$off.bin";;
  read-flash) off=${args[$((i+1))]}; size=${args[$((i+2))]}; head -c "$size" "$FAKE_FLASH/$off.bin" > "${args[$((i+3))]}";;
  *) echo "unexpected verb $verb" >&2; exit 9;;
esac
"""


@pytest.fixture()
def rig(tmp_path: Path):
    fake = tmp_path / "esptool"
    fake.write_text(FAKE); fake.chmod(0o755)
    flash = tmp_path / "flash"; flash.mkdir()
    log = tmp_path / "calls.log"
    env = {"FAKE_FLASH": str(flash), "FAKE_LOG": str(log), "FAKE_PORT": "/dev/ttyUSB0"}
    old = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    yield {"tmp": tmp_path, "esptool": fake, "log": log, "flash": flash}
    for k, v in old.items():
        os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)


def device(rig, mod, **kw):
    args = dict(port="/dev/ttyUSB0", esptool=str(rig["esptool"]), reset_mode="no-reset", live_authorized="YES", work_dir=rig["tmp"] / "work")
    args.update(kw)
    return mod.EsptoolDevice(**args)


def calls(rig) -> list[str]:
    return rig["log"].read_text().splitlines() if rig["log"].exists() else []


def test_requires_explicit_live_authorization(rig):
    mod = load()
    for bad in ("NO", "", "yes", None):
        with pytest.raises(mod.L8Error, match="LIVE_AUTHORIZATION"):
            device(rig, mod, live_authorized=bad)
    assert calls(rig) == []


@pytest.mark.parametrize("port", ["/dev/ttyS0", "/dev/tty", "ttyUSB0", "/dev/ttyUSB0; rm -rf /", "/dev/ttyUSB", "/dev/../dev/ttyUSB0"])
def test_port_must_be_ttyusb_or_ttyacm(rig, port):
    mod = load()
    with pytest.raises(mod.L8Error, match="serial_port"):
        device(rig, mod, port=port)


@pytest.mark.parametrize("mode", ["", "default_reset", "hard-reset", "auto", None])
def test_reset_mode_is_explicit_and_restricted(rig, mode):
    mod = load()
    with pytest.raises(mod.L8Error, match="reset_mode"):
        device(rig, mod, reset_mode=mode)


def test_esptool_must_be_absolute_executable_and_not_a_symlink(rig):
    mod = load()
    with pytest.raises(mod.L8Error, match="esptool"):
        device(rig, mod, esptool="esptool")
    link = rig["tmp"] / "link"; link.symlink_to(rig["esptool"])
    with pytest.raises(mod.L8Error, match="esptool"):
        device(rig, mod, esptool=str(link))


def test_identity_is_parsed_from_esptool_output(rig):
    mod = load()
    ident = device(rig, mod).identity()
    assert ident == {"mac": "aa:bb:cc:dd:ee:ff", "chip_identity": "ESP32-D0WD-V3", "flash_size": "4MB"}


def test_malformed_identity_output_fails_closed(rig, monkeypatch):
    mod = load()
    monkeypatch.setenv("FAKE_MAC", "not-a-mac")
    with pytest.raises(mod.L8Error, match="identity"):
        device(rig, mod).identity()


def test_write_then_read_roundtrip_and_offsets(rig):
    mod = load()
    d = device(rig, mod)
    payload = bytes(range(256)) * 4
    d.write_region("nvs", 0x9000, payload)
    assert d.read_region("nvs", 0x9000) == payload
    text = "\n".join(calls(rig))
    assert "write-flash 0x9000 " in text and "read-flash 0x9000 1024 " in text


def test_every_call_disables_dtr_rts_reset_and_never_erases(rig):
    mod = load()
    d = device(rig, mod)
    d.identity(); d.write_region("firmware", 0x10000, b"x" * 64); d.read_region("firmware", 0x10000)
    for c in calls(rig):
        assert "--before no-reset" in c and "--after no-reset" in c, c
        assert "erase" not in c and "--chip esp32" in c and "--port /dev/ttyUSB0" in c


def test_default_reset_mode_is_passed_through_only_when_chosen(rig):
    mod = load()
    device(rig, mod, reset_mode="default-reset").identity()
    assert all("--before default-reset" in c for c in calls(rig))


def test_read_before_write_is_refused(rig):
    mod = load()
    with pytest.raises(mod.L8Error, match="unknown size"):
        device(rig, mod).read_region("nvs", 0x9000)


def test_esptool_failure_is_reported_without_echoing_output(rig, monkeypatch):
    mod = load()
    monkeypatch.setenv("FAKE_FAIL_ON", "write-flash")
    d = device(rig, mod)
    with pytest.raises(mod.L8Error) as exc:
        d.write_region("nvs", 0x9000, b"secret-nvs-image-bytes")
    assert "ESPTOOL_FAILED" in str(exc.value) and "secret-nvs-image-bytes" not in str(exc.value)
    assert "fatal error" not in str(exc.value)


def test_temp_payload_files_are_private_and_removed(rig):
    mod = load()
    d = device(rig, mod)
    d.write_region("nvs", 0x9000, b"payload")
    work = rig["tmp"] / "work"
    assert stat.S_IMODE(work.stat().st_mode) == 0o700
    assert list(work.iterdir()) == []


def test_only_allowlisted_verbs_are_reachable(rig):
    mod = load()
    d = device(rig, mod)
    for verb in ("erase-flash", "erase-region", "write-mem", "burn-efuse", "espefuse"):
        with pytest.raises(mod.L8Error, match="verb"):
            d._run([verb])
    assert calls(rig) == []


def test_source_has_no_shell_no_serial_library_no_direct_line_control():
    text = MODULE.read_text()
    code = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))
    body = code.split('"""', 2)[2]  # drop the module docstring
    assert "shell=True" not in body and "os.system" not in body
    assert not re.search(r"^\s*(import|from)\s+serial\b", body, re.M)
    assert not re.search(r"setDTR|setRTS|\.dtr\s*=|\.rts\s*=|termios|fcntl", body)
    assert "erase" not in body.split("ALLOWED_VERBS")[1].split("\n")[0]
