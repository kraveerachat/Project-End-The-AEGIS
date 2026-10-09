"""Shared L7u fixture support: a fixture host root, a fixture Host (ownership overlay, because the test user cannot chown), and a stateful
fake system backend (groupadd/groupdel/gpasswd/systemd-tmpfiles/systemctl) that models the facts L7u depends on.

Nothing here touches the real host. The fake Core "boots" from REAL on-disk facts (current pointer, core.env, drop-in, runtime
directory) so a test that skips a required mutation really observes a missing Recovery channel, rather than a scripted success.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import stat
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
ENGINE_PATH = DEPLOY / "p4-l7u-upgrade.py"
DROPIN_TEMPLATE = ROOT / "deploy" / "aegis-idea3-core-recovery.dropin.example"
TMPFILES_TEMPLATE = ROOT / "deploy" / "aegis-idea3-recovery.tmpfiles.example"
ALERT_DROPIN_TEMPLATE = ROOT / "deploy" / "aegis-idea3-core-alert.dropin.example"
ALERT_TMPFILES_TEMPLATE = ROOT / "deploy" / "aegis-idea3-alert.tmpfiles.example"

OLD_ID = "f2a5cd758ff3abe0e5cfb933f63af1960318dad0"
MAIN = "81f201a41bdb2153820c8ead61762d7ffb97ca3c"
NEW_ID = MAIN
OLD_LOGICAL = f"/opt/aegis-idea3/releases/{OLD_ID}"
NEW_LOGICAL = f"/opt/aegis-idea3/releases/{NEW_ID}"
UNIT = "aegis-idea3-core.service"
GROUP = "aegis-idea3-recovery"
ALERT_GROUP = "aegis-idea3-alert"
DETECTOR = "aegis-idea3-detector"
CORE_UID, CORE_GID = 952, 950
DETECTOR_UID, DETECTOR_GID = 953, 951  # a fixture value: the real uid is owner-frozen and never committed
NEW_ALERT_GROUP_GID = 948
ALERT_DIR = "/run/aegis-idea3-alert"
ALERT_SOCK = f"{ALERT_DIR}/alert.sock"
ALERT_DROPIN = "/etc/systemd/system/aegis-idea3-core.service.d/20-f1-alert.conf"
ALERT_TMPFILES = "/etc/tmpfiles.d/aegis-idea3-alert.conf"
OPERATOR, OPERATOR_UID, OPERATOR_GID = "kittipat", 1000, 1000
NEW_GROUP_GID = 949
ENV_SECRET_CANARY = "CANARY-env-secret-7f3a9c41"
PROBE_CANARY = "CANARY-probe-value-55d0e2"
RECOVERY_FILES = ("recovery_core.py", "recovery_protocol.py", "recovery_client.py", "recovery_ui.py")

CORE_ENV_LINES = [
    "# AEGIS Core environment (fixture)",
    "AEGIS_PROFILE=production",
    f"AEGIS_UNRELATED_SECRET_CANARY={ENV_SECRET_CANARY}",
    f"AEGIS_RECOVERY_MANAGEMENT_PROBE_TARGET={PROBE_CANARY}-mgmt",
    f"AEGIS_RECOVERY_NETWORK_PROBE_TARGETS={PROBE_CANARY}-net",
    f"AEGIS_RECOVERY_WEB_READINESS_URL={PROBE_CANARY}-web",
    "AEGIS_HEALTH_INTERVAL=30",
]


def load_engine():
    spec = importlib.util.spec_from_file_location("p4_l7u_upgrade", ENGINE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses resolves string annotations through sys.modules
    spec.loader.exec_module(module)
    return module


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def make_release(base: Path, release_id: str, source_sha: str, *, recovery: bool) -> Path:
    rel = base / release_id
    (rel / "venv/bin").mkdir(parents=True)
    (rel / "aegis_soc").mkdir()
    (rel / "venv/bin/python").write_text("#!/bin/sh\n")
    (rel / "venv/bin/python").chmod(0o755)
    (rel / "aegis_soc/supervisor.py").write_text("print('x')\n")
    (rel / "aegis_soc/__init__.py").write_text("")
    if recovery:
        for name in RECOVERY_FILES:
            (rel / "aegis_soc" / name).write_text(f"# {name}\n")
    (rel / "requirements.txt").write_text("paho-mqtt==2.1.0\n")
    payload = sorted(p.relative_to(rel).as_posix() for p in rel.rglob("*") if p.is_file())
    manifest = {"schema_version": 1, "release_id": release_id, "source_git_sha": source_sha, "source_tree_dirty": False,
                "python_version": "3.13.1", "requirements_sha256": sha(b"paho-mqtt==2.1.0\n"), "file_count": len(payload),
                "created_by_tool_version": "1"}
    (rel / "RELEASE-MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    lines = [f"{sha((rel / p).read_bytes())}  {p}" for p in sorted(
        p.relative_to(rel).as_posix() for p in rel.rglob("*") if p.is_file() and p.name != "RELEASE-SHA256SUMS")]
    (rel / "RELEASE-SHA256SUMS").write_text("\n".join(lines) + "\n")
    for p in [rel, *rel.rglob("*")]:
        if not p.is_symlink():
            p.chmod(0o755 if (p.is_dir() or os.access(p, os.X_OK)) else 0o644)
    return rel


@dataclass
class Fx:
    tmp: Path
    root: Path
    work: Path
    source: Path
    engine: object
    host: object = None
    system: object = None
    cfg: object = None

    def p(self, logical: str) -> Path:
        return self.root / logical.lstrip("/")


def make_host_class(engine):
    class FixtureHost(engine.Host):
        """Real filesystem operations under a fixture root; ownership is an overlay because the test user cannot chown."""

        def __init__(self, root: str = "") -> None:
            super().__init__(root)
            self.overlay: dict[str, tuple[int, int]] = {}

        def chown(self, logical: str, uid: int, gid: int) -> None:
            key = str(self.p(logical))
            old = self.overlay.get(key, (os.lstat(key).st_uid, os.lstat(key).st_gid))
            self.overlay[key] = (old[0] if uid < 0 else uid, old[1] if gid < 0 else gid)

        def replace(self, src_logical: str, dst_logical: str) -> None:
            src, dst = str(self.p(src_logical)), str(self.p(dst_logical))
            super().replace(src_logical, dst_logical)
            if src in self.overlay:
                self.overlay[dst] = self.overlay.pop(src)
            else:
                self.overlay.pop(dst, None)

        def owner_of(self, logical: str) -> tuple[int, int]:
            key = str(self.p(logical))
            info = os.lstat(key)
            return self.overlay.get(key, (info.st_uid, info.st_gid))

    return FixtureHost


@dataclass
class FakeSystemState:
    calls: list = field(default_factory=list)
    fail: str = ""
    pid: int = 4242
    nrestarts: int = 0
    active: str = "active"
    sub: str = "running"
    enabled: str = "enabled"
    result: str = "success"
    alert_hook: bool = True


def make_system_class(engine):
    class FakeSystem(engine.Backend):
        def __init__(self, host, *, new_gid: int = NEW_GROUP_GID, alert_gid: int = NEW_ALERT_GROUP_GID, fail: str = "") -> None:
            self.host = host
            self.new_gid = new_gid
            self.alert_gid = alert_gid
            self.state = FakeSystemState(fail=fail)
            self._rollback_started = False

        # ── group database (plain /etc/group edits, exactly what groupadd/gpasswd do) ──
        def _groups(self) -> list[list[str]]:
            return [line.split(":") for line in self.host.read_text("/etc/group").splitlines() if line]

        def _save_groups(self, rows: list[list[str]]) -> None:
            ident = self.host.identity("/etc/group")  # groupadd/gpasswd keep /etc/group's own owner and mode
            self.host.write_atomic("/etc/group", ("\n".join(":".join(r) for r in rows) + "\n").encode(), mode=ident.mode, uid=ident.uid, gid=ident.gid)

        def groupadd(self, name: str) -> None:
            self.state.calls.append(("groupadd", name))
            if self.state.fail == "groupadd":
                raise engine.Refusal("GROUPADD_FAILED")
            rows = self._groups()
            rows.append([name, "x", str(self.alert_gid if name == ALERT_GROUP else self.new_gid), ""])
            self._save_groups(rows)

        def groupdel(self, name: str) -> None:
            self.state.calls.append(("groupdel", name))
            self._save_groups([r for r in self._groups() if r[0] != name])

        def gpasswd_add(self, user: str, group: str) -> None:
            self.state.calls.append(("gpasswd_add", user, group))
            if self.state.fail == "gpasswd_add":
                raise engine.Refusal("GPASSWD_ADD_FAILED")
            rows = self._groups()
            for r in rows:
                if r[0] == group:
                    members = [m for m in r[3].split(",") if m]
                    if user not in members:
                        members.append(user)
                    r[3] = ",".join(members)
            self._save_groups(rows)

        def gpasswd_del(self, user: str, group: str) -> None:
            self.state.calls.append(("gpasswd_del", user, group))
            rows = self._groups()
            for r in rows:
                if r[0] == group:
                    r[3] = ",".join(m for m in r[3].split(",") if m and m != user)
            self._save_groups(rows)

        # ── systemd-tmpfiles: a real parse of the installed rule ──
        def tmpfiles_create(self, conf_logical: str) -> None:
            self.state.calls.append(("tmpfiles_create", conf_logical))
            if self.state.fail == ("alert_tmpfiles" if conf_logical == ALERT_TMPFILES else "tmpfiles"):
                raise engine.Refusal("TMPFILES_FAILED")
            for line in self.host.read_text(conf_logical).splitlines():
                if not line.strip() or line.startswith("#"):
                    continue
                kind, path, mode, user, group, *_ = line.split()
                assert kind == "d"
                uid = next(int(r[2]) for r in (x.split(":") for x in self.host.read_text("/etc/passwd").splitlines()) if r[0] == user)
                gid = next(int(r[2]) for r in self._groups() if r[0] == group)
                if not self.host.lexists(path):
                    self.host.mkdir(path, 0o700, uid, gid)
                wrong = self.state.fail == ("alert_tmpfiles_wrong_mode" if path == ALERT_DIR else "tmpfiles_wrong_mode")
                effective = 0o700 if wrong else int(mode, 8)  # the UMask-0077 trap: a 0700 directory
                os.chmod(self.host.p(path), effective)
                self.host.chown(path, uid, gid)

        # ── systemctl ──
        def systemctl(self, *args: str):
            self.state.calls.append(("systemctl", *args))
            verb = args[0]
            if verb == "show":
                return engine.CommandResult(0, self._show(args))
            if verb == "daemon-reload":
                return engine.CommandResult(1 if self.state.fail == "daemon-reload" else 0, "")
            if verb == "restart":
                return engine.CommandResult(*self._boot(restart=True))
            if verb == "stop":
                self.state.active, self.state.sub, self.state.pid = "inactive", "dead", 0
                self._drop_socket()
                return engine.CommandResult(0, "")
            if verb == "start":
                return engine.CommandResult(*self._boot(restart=False))
            if verb == "reset-failed":
                self.state.result = "success"
                return engine.CommandResult(0, "")
            raise AssertionError(f"unexpected systemctl verb {args}")

        def sleep(self, seconds: float) -> None:
            self.state.calls.append(("sleep", seconds))

        def _show(self, args) -> str:
            wanted = [args[i + 1] for i, a in enumerate(args) if a == "-p"]
            st = self.state
            table = {"LoadState": "loaded", "ActiveState": st.active, "SubState": st.sub, "UnitFileState": st.enabled,
                     "Result": st.result, "MainPID": str(st.pid), "NRestarts": str(st.nrestarts),
                     "ExecMainStartTimestamp": f"pid{st.pid}"}
            return "\n".join(f"{k}={table[k]}" for k in wanted)

        def _drop_socket(self) -> None:
            for logical in ("/run/aegis-idea3-recovery/recovery.sock", ALERT_SOCK):
                sock = self.host.p(logical)
                if sock.exists() or sock.is_symlink():
                    sock.unlink()

        def _env(self) -> dict[str, str]:
            out = {}
            for line in self.host.read_text("/etc/aegis-idea3/core.env").splitlines():
                if "=" in line and not line.startswith("#"):
                    k, _, v = line.partition("=")
                    out[k] = v
            return out

        def _supplementary(self) -> list[int]:
            gids = []
            for dropin in ("/etc/systemd/system/aegis-idea3-core.service.d/10-recovery.conf", ALERT_DROPIN):
                if self.host.lexists(dropin):
                    for line in self.host.read_text(dropin).splitlines():
                        if line.startswith("SupplementaryGroups="):
                            for name in line.split("=", 1)[1].split():
                                gids += [int(r[2]) for r in self._groups() if r[0] == name]
            return gids

        def _create_alert_socket(self, env: dict[str, str], supp: list[int]) -> None:
            """The fixture Core models the PHASE B hook: it creates the dedicated alert socket only when ``alert_hook`` is on (the real
            Core code does this since Phase B), the frozen uid is in its env and the runtime dir exists."""
            st = self.state
            alert_gid = next((int(r[2]) for r in self._groups() if r[0] == ALERT_GROUP), None)
            if not (st.alert_hook and st.fail != "no_alert_channel" and "AEGIS_ALERT_SOURCE_UID" in env and self.host.lexists(ALERT_DIR)
                    and alert_gid in supp):
                return
            sock = self.host.p(ALERT_SOCK)
            os.mknod(sock, stat.S_IFSOCK | 0o600)
            os.chmod(sock, 0o600 if st.fail == "bad_alert_socket_mode" else 0o620)
            self.host.chown(ALERT_SOCK, CORE_UID, alert_gid)

        def _boot(self, *, restart: bool):
            st = self.state
            if not restart:
                self._rollback_started = True
            if self._rollback_started and st.fail == "rollback_start":
                st.active, st.sub, st.result, st.pid = "failed", "failed", "exit-code", 0
                return 1, ""
            if not self._rollback_started and restart and st.fail == "restart_rc":
                st.active, st.sub, st.result, st.pid = "failed", "failed", "exit-code", 0
                return 1, ""
            st.pid += 1
            st.nrestarts = 0  # a manual (re)start resets the automatic-restart counter, as in systemd
            st.active, st.sub, st.result = "active", "running", "success"
            self._drop_socket()
            link = self.host.p("/opt/aegis-idea3/current")
            target = os.readlink(link)
            has_recovery = self.host.lexists(f"{target}/aegis_soc/recovery_core.py")
            env = self._env()
            supp = self._supplementary()
            groups = [CORE_GID, *supp]
            os.makedirs(self.host.p(f"/proc/{st.pid}"), exist_ok=True)
            self.host.write_atomic(f"/proc/{st.pid}/status", f"Name:\tpython\nGroups:\t{' '.join(map(str, groups))}\n".encode(),
                                   mode=0o644, uid=0, gid=0)
            if restart and st.fail == "unhealthy_after":
                st.active, st.sub, st.result, st.nrestarts = "failed", "failed", "exit-code", 3
                return 0, ""
            if restart and st.fail == "no_supp_group":
                self.host.write_atomic(f"/proc/{st.pid}/status", f"Name:\tpython\nGroups:\t{CORE_GID}\n".encode(), mode=0o644, uid=0, gid=0)
            self._create_alert_socket(env, supp)
            runtime = "/run/aegis-idea3-recovery"
            if has_recovery and "AEGIS_RECOVERY_OPERATOR_UID" in env and self.host.lexists(runtime) and st.fail != "no_channel":
                ident = self.host.identity(runtime)
                if ident.mode & 0o022 == 0 and ident.uid == CORE_UID:
                    sock = self.host.p(f"{runtime}/recovery.sock")
                    os.mknod(sock, stat.S_IFSOCK | 0o600)
                    gid = int(env["AEGIS_RECOVERY_SOCKET_GID"])
                    mode = 0o600 if st.fail == "bad_socket_mode" else 0o660
                    os.chmod(sock, mode)
                    self.host.chown(f"{runtime}/recovery.sock", CORE_UID, gid)
            return 0, ""

    return FakeSystem


def build(tmp_path: Path, *, group_rows: list[str] | None = None, passwd_extra: list[str] | None = None, env_lines: list[str] | None = None,
          env_newline: bool = True, current_target: str | None = None, core_active: bool = True, new_sha: str = MAIN,
          new_recovery: bool = True, old_recovery: bool = False, fail: str = "", stable_samples: int = 2, no_detector: bool = False,
          detector_uid: int = DETECTOR_UID, alert_source_uid: int = DETECTOR_UID, alert_hook: bool = True) -> Fx:
    engine = load_engine()
    root = tmp_path / "root"
    work = tmp_path / "work"
    host_cls = make_host_class(engine)
    for d in ("etc/aegis-idea3", "etc/systemd/system", "etc/tmpfiles.d", "opt/aegis-idea3/releases", "run/aegis-idea3", "proc", "var/lib/aegis-idea3"):
        (root / d).mkdir(parents=True)
    os.chmod(root / "run/aegis-idea3", 0o700)
    make_release(root / "opt/aegis-idea3/releases", OLD_ID, OLD_ID, recovery=old_recovery)
    os.symlink(current_target or OLD_LOGICAL, root / "opt/aegis-idea3/current")
    passwd = ["root:x:0:0:root:/root:/bin/bash", f"aegis-idea3:x:{CORE_UID}:{CORE_GID}::/var/lib/aegis-idea3:/usr/bin/nologin",
              f"{OPERATOR}:x:{OPERATOR_UID}:{OPERATOR_GID}::/home/{OPERATOR}:/bin/zsh",
              *([] if no_detector else [f"{DETECTOR}:x:{detector_uid}:{DETECTOR_GID}::/nonexistent:/usr/bin/nologin"]), *(passwd_extra or [])]
    (root / "etc/passwd").write_text("\n".join(passwd) + "\n")
    groups = ["root:x:0:", f"aegis-idea3:x:{CORE_GID}:", f"{OPERATOR}:x:{OPERATOR_GID}:", f"{DETECTOR}:x:{DETECTOR_GID}:",
              "wheel:x:998:" + OPERATOR, *(group_rows or [])]
    (root / "etc/group").write_text("\n".join(groups) + "\n")
    body = "\n".join(env_lines if env_lines is not None else CORE_ENV_LINES) + ("\n" if env_newline else "")
    (root / "etc/aegis-idea3/core.env").write_text(body)
    os.chmod(root / "etc/aegis-idea3/core.env", 0o640)
    os.utime(root / "etc/aegis-idea3/core.env", ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
    (root / "etc/systemd/system/aegis-idea3-core.service").write_text((ROOT / "deploy/aegis-idea3-core.service.example").read_text())
    source_base = tmp_path / "build"
    source_base.mkdir()
    source = make_release(source_base, NEW_ID, new_sha, recovery=new_recovery)
    host = host_cls(str(root))
    host.chown("/etc/aegis-idea3/core.env", 0, CORE_GID)
    host.chown("/run/aegis-idea3", CORE_UID, CORE_GID)
    system = make_system_class(engine)(host, fail=fail)
    system.state.alert_hook = alert_hook
    if not core_active:
        system.state.active, system.state.sub = "inactive", "dead"
    cfg = engine.Config(old_release_id=OLD_ID, new_release_id=NEW_ID, expected_main=MAIN, source_dir=source, work_dir=work,
                        operator_user=OPERATOR, operator_uid=OPERATOR_UID, alert_source_uid=alert_source_uid, owner_expect="any", stable_wait_sec=0, stable_samples=stable_samples)
    return Fx(tmp=tmp_path, root=root, work=work, source=source, engine=engine, host=host, system=system, cfg=cfg)


def snapshot(fx: Fx) -> dict[str, tuple]:
    """Every entry under the fixture root (except the fake /proc): kind, mode, owner overlay, content digest / link target, file mtime."""
    out: dict[str, tuple] = {}
    for path in sorted(fx.root.rglob("*")):
        rel = path.relative_to(fx.root).as_posix()
        if rel == "proc" or rel.startswith("proc/"):
            continue
        logical = "/" + rel
        uid, gid = fx.host.owner_of(logical)
        info = os.lstat(path)
        if stat.S_ISLNK(info.st_mode):
            out[rel] = ("link", os.readlink(path))
        elif stat.S_ISDIR(info.st_mode):
            out[rel] = ("dir", stat.S_IMODE(info.st_mode), uid, gid)
        elif stat.S_ISREG(info.st_mode):
            mtime = info.st_mtime_ns if rel.startswith("etc/aegis-idea3/") else 0  # mtime is load-bearing for core.env only
            out[rel] = ("file", stat.S_IMODE(info.st_mode), uid, gid, sha(path.read_bytes()), mtime)
        else:
            out[rel] = ("special", stat.S_IFMT(info.st_mode))
    return out
