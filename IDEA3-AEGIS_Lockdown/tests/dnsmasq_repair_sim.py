"""Host simulator extension for the dnsmasq unit boot-order repair tests.

Wraps tests/l34_sim.py (which stays untouched) and adds only what the repair needs: ``systemctl daemon-reload`` / ``restart``,
``systemctl show -p NeedDaemonReload`` for the dnsmasq unit (derived from the fixture unit file vs. the definition systemd has loaded),
and ``systemd-analyze verify``. Every other command is delegated unchanged. Nothing here touches a real host.
"""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import l34_sim as base  # noqa: E402

EXTRA_COMMANDS = ("systemd-analyze",)
UNIT_REL = "etc/systemd/system/aegis-idea3-dnsmasq.service"
RELOAD_UNITS = {"aegis-idea3-dnsmasq.service", "aegis-idea3-mosquitto.service", "aegis-idea3-core.service", "twingate.service", "mosquitto.service"}

# Keys added by this wrapper (all default to "healthy repair host"); l34_sim ignores unknown keys.
REPAIR_DEFAULTS = {
    "dnsmasq_loaded_unit": "old",     # which unit definition systemd has loaded: "old" | "new" (changes only on daemon-reload)
    "reload_works": True,
    "restart_works": True,
    "analyze_ok": True,
    "need_reload_override": {},        # unit -> "yes"|"no"
    "dnsmasq_pid": 4242,
    "dnsmasq_fail_after_reload": False,  # after daemon-reload the (new) dnsmasq start fails
    "dnsmasq_journal": [],             # lines `journalctl -u aegis-idea3-dnsmasq.service -b` prints for the current boot
    "dnsmasq_nrestarts": None,         # overrides the dnsmasq NRestarts (None = base behaviour)
    "twingate_state": "active",
}


def _fs_unit_kind() -> str:
    root = os.environ.get("AEGIS_P4_FS_ROOT", "")
    f = Path(root) / UNIT_REL
    text = f.read_text() if f.is_file() else ""
    return "new" if "ExecStartPre=/usr/bin/timeout" in text else "old"


def install(stub_dir: Path, sim_dir: Path, **overrides) -> None:
    base.install(stub_dir, sim_dir, **{**REPAIR_DEFAULTS, **overrides})
    # rewrite every stub to go through this wrapper; add systemd-analyze
    for name in (*base.COMMANDS, *EXTRA_COMMANDS):
        f = stub_dir / name
        f.write_text(f'#!/usr/bin/env bash\nexec {sys.executable} {Path(__file__).resolve()} {name} "$@"\n')
        f.chmod(f.stat().st_mode | stat.S_IXUSR)


def _handle(name: str, args: list[str]) -> int | None:
    sim = base._sim_dir()
    s = base.load(sim)
    with (sim / "calls.log").open("a") as fh:
        fh.write(name + " " + " ".join(args) + "\n")
    if name == "systemd-analyze":
        return 0 if (args[:1] == ["verify"] and len(args) == 2 and s.get("analyze_ok", True)) else 1
    if name == "journalctl" and args[:2] == ["-u", "aegis-idea3-dnsmasq.service"] and "--no-pager" in args:
        lines = s.get("dnsmasq_journal") or ["-- No entries --"]
        print("\n".join(lines))
        return 0
    if name != "systemctl":
        return None
    if args[:1] == ["daemon-reload"]:
        if not s.get("reload_works", True):
            return 1
        s["dnsmasq_loaded_unit"] = _fs_unit_kind()
        base.save(sim, s)
        return 0
    if args[:2] == ["restart", "aegis-idea3-dnsmasq.service"]:
        if s["dnsmasq"] == "failed" or not s.get("restart_works", True) or not s["ap_active"] or s["dnsmasq_start_fails_rc"]:
            s["dnsmasq"] = "failed"
            base.save(sim, s)
            return 1
        s["dnsmasq"] = "active"
        s["dnsmasq_pid"] = s.get("dnsmasq_pid", 4242) + 101
        base.save(sim, s)
        return 0
    if args[:2] == ["start", "aegis-idea3-dnsmasq.service"] and s["dnsmasq"] != "failed" and s["dnsmasq"] != "active":
        if s.get("dnsmasq_fail_after_reload") and s.get("dnsmasq_loaded_unit") == "new":
            s["dnsmasq"] = "failed"
            base.save(sim, s)
            return 1
        ok = s["ap_active"] and s["dnsmasq_start_works"] and not s["dnsmasq_start_fails_rc"]
        s["dnsmasq"] = "active" if ok else "failed"
        if ok:
            s["dnsmasq_pid"] = s.get("dnsmasq_pid", 4242) + 101
        base.save(sim, s)
        return 0 if ok else 1
    if args[:1] == ["show"] and "NeedDaemonReload" in args:
        unit = args[-1]
        if unit in RELOAD_UNITS:
            need = s.get("need_reload_override", {}).get(unit)
            if need is None:
                need = "yes" if unit == "aegis-idea3-dnsmasq.service" and s.get("dnsmasq_loaded_unit", "old") != _fs_unit_kind() else "no"
            print(need if "--value" in args else f"NeedDaemonReload={need}")
            return 0
    return None


def main(argv: list[str]) -> int:
    name, args = argv[1], argv[2:]
    # pid-aware dnsmasq props: patch the base props function so MainPID follows the simulated restarts
    original = base._dnsmasq_props_base

    def patched(s: dict) -> dict:
        props = original(s)
        if s["dnsmasq"] == "active":
            props["MainPID"] = str(s.get("dnsmasq_pid", 4242))
        if s.get("dnsmasq_nrestarts") is not None:
            props["NRestarts"] = str(s["dnsmasq_nrestarts"])
        return props

    base._dnsmasq_props_base = patched
    base._SIM_DIR = base._sim_dir()
    rc = _handle(name, args)
    if rc is not None:
        return rc
    # delegate; calls.log line was already written above, so remove the duplicate main() will add by popping ours first
    log = base._sim_dir() / "calls.log"
    lines = log.read_text().splitlines(keepends=True)
    log.write_text("".join(lines[:-1]))
    return base.main(argv)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
