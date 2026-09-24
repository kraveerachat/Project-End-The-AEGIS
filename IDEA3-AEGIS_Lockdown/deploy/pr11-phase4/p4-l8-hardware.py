#!/usr/bin/env python3
"""PROTOTYPE (not wired): L8 hardware device backend built on esptool v5, mirroring FixtureDevice's interface.

Design constraints (owner/L8 spec): D4 live before L8; identity proven before any write; fail secure; no
automatic restore, no reflash of previous firmware, no legacy v0, no plaintext-1883 fallback; evidence carries
no secret. This module only *drives* the flashing tool; it never generates, prints or stores key material.

* Only four esptool verbs are reachable: read-mac, flash-id, write-flash, read-flash (no erase-*, no efuse, no write-mem).
* `--before`/`--after` are explicit. `no-reset` = no DTR/RTS toggling at all (owner puts the board in bootloader
  mode by hand); `default-reset` uses DTR/RTS auto-reset and therefore resets the device (relay boots in its
  fail-secure state — OD-L8-05). The reset mode has NO default.
* The serial port comes only from the owner-supplied device.identity binding (/dev/ttyUSBn|ttyACMn).
* esptool is invoked with an argv list, an allowlisted environment and a timeout; its output is parsed for
  identity fields and never echoed into errors.
"""
from __future__ import annotations

import os
import re
import stat
import subprocess
import tempfile
from pathlib import Path

MAC_RE = re.compile(r"^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$")
SERIAL_PORT_RE = re.compile(r"^/dev/tty(?:USB|ACM)[0-9]+$")
RESET_MODES = ("no-reset", "default-reset")
ALLOWED_VERBS = ("read-mac", "flash-id", "write-flash", "read-flash")
TIMEOUT_SEC = 120


class L8Error(ValueError):
    """Fail-closed condition in the L8 hardware path."""


class EsptoolDevice:
    name = "hardware"

    def __init__(self, *, port, esptool, reset_mode, live_authorized, work_dir, runner=subprocess.run):
        if live_authorized != "YES":
            raise L8Error("LIVE_AUTHORIZATION required: AEGIS_L8_LIVE_AUTHORIZED=YES")
        if not isinstance(port, str) or SERIAL_PORT_RE.fullmatch(port) is None:
            raise L8Error("device.identity: serial_port must be /dev/ttyUSBn or /dev/ttyACMn")
        if reset_mode not in RESET_MODES:
            raise L8Error(f"reset_mode must be explicitly one of {RESET_MODES}")
        path = Path(str(esptool))
        if not path.is_absolute() or path.is_symlink() or not path.is_file() or not os.access(path, os.X_OK):
            raise L8Error("esptool must be an absolute, non-symlink, executable file")
        self.port, self.esptool, self.reset_mode, self._runner = port, str(path), reset_mode, runner
        self.work_dir = Path(work_dir)
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self.work_dir.chmod(0o700)
        self._sizes: dict[tuple[str, int], int] = {}

    def _run(self, args: list[str]) -> str:
        if not args or args[0] not in ALLOWED_VERBS:
            raise L8Error(f"esptool verb not allowed: {args[:1]}")
        argv = [self.esptool, "--chip", "esp32", "--port", self.port, "--before", self.reset_mode, "--after", "no-reset", *args]
        env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", **{k: v for k, v in os.environ.items() if k.startswith("FAKE_")}}
        try:
            result = self._runner(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=TIMEOUT_SEC, check=False, env=env)
        except (OSError, subprocess.SubprocessError) as exc:
            raise L8Error("ESPTOOL_FAILED") from exc
        if result.returncode != 0:
            raise L8Error(f"ESPTOOL_FAILED verb={args[0]} rc={result.returncode}")
        return result.stdout

    def identity(self) -> dict[str, str]:
        mac_out = self._run(["read-mac"])
        mac = re.search(r"^MAC:\s*([0-9a-fA-F:]{17})\s*$", mac_out, re.M)
        chip = re.search(r"^Chip type:\s*(ESP32[-A-Za-z0-9]*)", mac_out, re.M)
        size = re.search(r"Detected flash size:\s*(\d+MB)", self._run(["flash-id"]))
        if not (mac and chip and size) or MAC_RE.fullmatch(mac.group(1).lower()) is None:
            raise L8Error("device identity output could not be parsed")
        return {"mac": mac.group(1).lower(), "chip_identity": chip.group(1), "flash_size": size.group(1)}

    def write_region(self, region: str, offset: int, payload: bytes) -> None:
        fd, name = tempfile.mkstemp(dir=self.work_dir, prefix=".payload-")
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(payload)
            self._run(["write-flash", f"{offset:#x}", name])
            self._sizes[(region, offset)] = len(payload)
        finally:
            Path(name).unlink(missing_ok=True)

    def read_region(self, region: str, offset: int) -> bytes:
        size = self._sizes.get((region, offset))
        if size is None:
            raise L8Error(f"readback of region {region} refused: unknown size (nothing was written)")
        fd, name = tempfile.mkstemp(dir=self.work_dir, prefix=".readback-")
        os.close(fd)
        try:
            self._run(["read-flash", f"{offset:#x}", str(size), name])
            data = Path(name).read_bytes()
        finally:
            Path(name).unlink(missing_ok=True)
        if len(data) != size:
            raise L8Error(f"readback of region {region} has an unexpected length")
        return data
