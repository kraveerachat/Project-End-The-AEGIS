"""Hermetic tests for the CTv incident Option B read-only verifier and the (unauthorized, unexecuted) disposition action.

Nothing here touches the real host: systemctl/pgrep are stubs on a test-only PATH, the canonical/work dirs are temp dirs, and the
exact-main git repository is a temp repo holding byte-copies of the real scripts and libraries.
"""

from __future__ import annotations

import ast
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "IDEA3-AEGIS_Lockdown"
P4 = APP / "deploy" / "pr11-phase4"
INCIDENT = P4 / "ctv-incident"
VERIFIER_SRC = INCIDENT / "ctv-option-b-verify.sh"
ACTION_SRC = INCIDENT / "ctv-incident-disposition.sh"
GUARD_SRC = INCIDENT / "ctv-option-b-guard.sh"
PROD_CANON = "/var/lib/aegis-idea3-governance"
UNIT_EXAMPLE = APP / "deploy" / "aegis-idea3-core.service.example"
PIN_UNIT = "82446332f6367f16390f432370ec9bcb7f16f78d0bc6badb4f187b7a74c1627c"
REPO_FILES = (
    "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctv-incident/ctv-option-b-verify.sh",
    "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctv-incident/ctv-incident-disposition.sh",
    "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctv-incident/ctv-option-b-guard.sh",
    "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctv-run-lib.sh",
    "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh",
    "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l5-clock.py",
    "IDEA3-AEGIS_Lockdown/deploy/aegis-idea3-core.service.example",
    "IDEA3-AEGIS_Lockdown/aegis_soc/__init__.py",
    "IDEA3-AEGIS_Lockdown/aegis_soc/trusted_time.py",
    "IDEA3-AEGIS_Lockdown/aegis_soc/protocol_v1.py",
)
DEVICE = "aegis-relay-01"
DROPINS = "/etc/systemd/system/aegis-idea3-core.service.d/10-recovery.conf /etc/systemd/system/aegis-idea3-core.service.d/20-f1-alert.conf"

SYSTEMCTL = r'''#!/usr/bin/env python3
import json, os, sys
base = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..")
state_path = os.path.join(base, "state.json")
st = json.load(open(state_path))
open(os.path.join(base, "calls"), "a").write("systemctl " + " ".join(sys.argv[1:]) + "\n")
args = sys.argv[1:]
if not args or args[0] != "show":
    sys.exit(0)
props, value_only, unit = [], False, None
i = 1
while i < len(args):
    if args[i] == "-p": props.append(args[i + 1]); i += 2
    elif args[i] == "--value": value_only = True; i += 1
    else: unit = args[i]; i += 1
side = "core" if unit == "aegis-idea3-core.service" else "detector"
vals = dict(st[side])
if side == "core":
    n = st.get("calls", 0) + 1
    st["calls"] = n
    json.dump(st, open(state_path, "w"))
    if st.get("flip_after") is not None and n > st["flip_after"] and "MainPID" in props:
        vals["MainPID"] = "4321"
for p in props:
    v = vals.get(p, "")
    print(v if value_only else f"{p}={v}")
'''
PGREP = '#!/bin/bash\nc=$(cat "$(dirname "$(readlink -f "$0")")/../pgrep_count" 2>/dev/null || echo 0)\necho "$c"\n[ "$c" != 0 ]\n'


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(repo: Path, *args: str) -> str:
    env = dict(os.environ, HOME="/nonexistent", GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_SYSTEM="/dev/null")
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True, env=env).strip()


COMPARE_FAIL = (
    "P4_COMPARE_SCHEMA=1\nEVIDENCE_CLASS=CORE_HOST_READ_ONLY\nBEFORE=ctv-pre captured_at=t0\nAFTER=ctv-post captured_at=t1\n"
    "FINDING\tNEW_OR_WORSENED_DRIFT\tsvc.aegis-idea3-core.service.MainPID\nPRESERVATION_S10=FAIL\nCOMPARE_RESULT=FAIL\nPRODUCTION_MUTATION_PERFORMED=NO\n"
)
DETECTOR_PRE = {"LoadState": "loaded", "ActiveState": "inactive", "SubState": "dead", "MainPID": "0", "UnitFileState": "disabled"}


class World:
    def __init__(self, tmp: Path) -> None:
        self.tmp = tmp
        tmp.chmod(0o700)
        self.repo = tmp / "repo"
        for rel in REPO_FILES:
            dest = self.repo / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / rel, dest)
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.email", "t@example.invalid")
        git(self.repo, "config", "user.name", "T")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-qm", "exact main")
        self.main = git(self.repo, "rev-parse", "HEAD")
        self.verifier = self.repo / REPO_FILES[0]
        self.action = self.repo / REPO_FILES[1]
        self.guard = self.repo / REPO_FILES[2]
        self.canon = tmp / "canon"
        self.work = tmp / "work"
        self.unit = tmp / "installed.service"
        self.core_env = tmp / "core.env"
        self.bin = tmp / "bin"
        self.state = tmp / "state.json"
        self.calls = tmp / "calls"
        self.auth = tmp / "authorization.txt"
        for d in (self.canon, self.work / "pre-root", self.work / "post-root", self.bin):
            d.mkdir(parents=True)
        shutil.copy2(UNIT_EXAMPLE, self.unit)
        self.unit.chmod(0o644)
        self.preimage = self.work / "journal.preimage"
        self.preimage.write_text("ORIGINAL-UNIT-BYTES\n")
        self.pre_sha = sha(self.preimage)
        (self.work / "journal").write_text(f"phase=apply-verified\npreimage={self.preimage}\n")
        (self.canon / "CTV-GLOBAL-ATTEMPT-CONSUMED").write_text(
            f"CTV_ATTEMPT_CONSUMED=YES\nCTV_RERUN_ALLOWED=NO\nCTV_FROZEN_RUNNER_SHA256={'a' * 64}\nwork={self.work}\n")
        (self.canon / "CTU-GLOBAL-ATTEMPT-CONSUMED").write_text("CTU_ATTEMPT_CONSUMED=YES\n")
        (self.canon / "CTU-GLOBAL-CLOSEOUT-FAIL").write_text("CTU_RESULT=FAIL_IMMUTABLE\n")
        self.core_env.write_text(f"AEGIS_P1_DEVICE_ID={DEVICE}\n")
        for d in ("pre-root", "post-root"):
            (self.work / d / "capture.log").write_text("L0_CAPTURE=COMPLETE\n")
        self.write_services_tsv(DETECTOR_PRE)
        (self.work / "compare-pre-post.txt").write_text(COMPARE_FAIL)
        self.reseal()
        (self.bin / "systemctl").write_text(SYSTEMCTL)
        (self.bin / "pgrep").write_text(PGREP)
        for b in self.bin.iterdir():
            b.chmod(0o755)
        self.set_state({
            "core": {"LoadState": "loaded", "ActiveState": "active", "SubState": "running", "Result": "success", "MainPID": "1234",
                     "InvocationID": "0123456789abcdef0123456789abcdef", "ExecMainStartTimestampMonotonic": "555", "NRestarts": "0",
                     "FragmentPath": str(self.unit), "NeedDaemonReload": "no", "ProtectClock": "no", "User": "aegis-idea3",
                     "NoNewPrivileges": "yes", "CapabilityBoundingSet": "", "AmbientCapabilities": "", "DropInPaths": DROPINS},
            "detector": {"LoadState": "loaded", "ActiveState": "inactive", "SubState": "dead", "UnitFileState": "disabled", "Restart": "no",
                         "Result": "success", "MainPID": "0", "InvocationID": "", "ExecMainStartTimestampMonotonic": "0", "NRestarts": "0"},
        })
        self.write_auth()

    # -- evidence helpers
    def write_services_tsv(self, detector: dict[str, str]) -> None:
        rows = "".join(f"svc.aegis-idea3-detector.service.{k}\t{v}\n" for k, v in detector.items())
        (self.work / "pre-root" / "services.tsv").write_text(rows)
        (self.work / "post-root" / "services.tsv").write_text(rows)

    def reseal(self) -> None:
        for d in ("pre-root", "post-root"):
            files = sorted(p for p in (self.work / d).iterdir() if p.name != "SHA256SUMS")
            (self.work / d / "SHA256SUMS").write_text("".join(f"{sha(p)}  {p.name}\n" for p in files))

    def digests(self) -> tuple[str, str, str]:
        return sha(self.work / "pre-root" / "SHA256SUMS"), sha(self.work / "post-root" / "SHA256SUMS"), sha(self.work / "compare-pre-post.txt")

    def set_state(self, state: dict) -> None:
        self.state.write_text(json.dumps(state))

    def edit_state(self, side: str, **kv: str) -> None:
        st = json.loads(self.state.read_text())
        st[side].update(kv)
        self.set_state(st)

    def write_auth(self, extra: str = "", drop: str = "", **override: str) -> None:
        pre, post, cmp_ = self.digests()
        vals = {
            "stage": "CTv-incident-disposition", "disposition": "OPTION_B_TARGET_UNIT_RETAINED", "expected_main": self.main,
            "unit_sha256": PIN_UNIT, "preimage_sha256": self.pre_sha, "device_id": DEVICE, "verifier_sha256": sha(self.verifier),
            "action_sha256": sha(self.action), "guard_sha256": sha(self.guard), "pre_sha256sums_sha256": pre,
            "post_sha256sums_sha256": post, "compare_output_sha256": cmp_, "authorization_id": "AUTH-TEST-0001",
        }
        vals.update(override)
        lines = [f"{k}={v}" for k, v in vals.items() if k != drop]
        self.auth.write_text("\n".join(lines) + "\n" + extra)
        self.auth.chmod(0o600)

    def common(self, main: str | None = None) -> list[str]:
        return ["--repo", str(self.repo), "--main", main or self.main, "--canon", str(self.canon), "--work", str(self.work), "--device", DEVICE,
                "--hermetic", "--unit-dest", str(self.unit), "--core-env", str(self.core_env), "--clock-fixture", "synced:5",
                "--preimage-sha256", self.pre_sha, "--path-prefix", str(self.bin)]

    def env(self, **extra: str) -> dict[str, str]:
        base = {k: v for k, v in os.environ.items() if k not in ("BASH_ENV", "ENV")}
        base.update(CTV_OPTION_B_TEST_ONLY="YES", CTV_OPTION_B_TEST_ROOT=str(self.tmp))
        base.update(extra)
        return base

    def verify(self, *more: str, main: str | None = None, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run([str(self.verifier), *self.common(main), *more], text=True, capture_output=True, env=env or self.env())

    def action_run(self, *more: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run([str(self.action), "--authorization", str(self.auth), *self.common(), *more], text=True, capture_output=True, env=env or self.env())

    def snapshot(self) -> dict[str, str]:
        out = {}
        for base in (self.canon, self.work):
            for p in sorted(base.rglob("*")):
                if p.is_file():
                    out[str(p)] = sha(p)
        out[str(self.unit)] = sha(self.unit)
        return out


@pytest.fixture()
def world(tmp_path: Path) -> World:
    return World(tmp_path)


def verb_set(w: World) -> set[str]:
    return {line.split()[1] for line in w.calls.read_text().splitlines()}


def test_verifier_passes_on_the_verified_incident_state_and_is_strictly_read_only(world: World) -> None:
    before = world.snapshot()
    pre, post, cmp_ = world.digests()
    r = world.verify("--bind-evidence", "--expect-pre-sums", pre, "--expect-post-sums", post, "--expect-compare", cmp_)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip().splitlines()[-1] == "CTV_OPTION_B_VERIFY=PASS"
    for expected in ("CTV_OPTION_B_UNIT_SHA256=" + PIN_UNIT, "CTV_OPTION_B_TRUSTEDCLOCK=SYNCED", "CTV_OPTION_B_DETECTOR_BASELINE_MODE=INACTIVE",
                     "CTV_OPTION_B_PRE_DETECTOR_BASELINE=INACTIVE", "CTV_OPTION_B_DROPINS=EXACT", "CTV_OPTION_B_ROLLBACK_COMPLETE=NO",
                     "CTV_OPTION_B_S10_HISTORICAL_COMPARE=FAIL", "CTV_OPTION_B_S10_POSITIVELY_EVIDENCED=YES", "CTV_OPTION_B_S10_PROMOTED_TO_PASS=NO",
                     "CTV_OPTION_B_EVIDENCE_DIGESTS_BOUND=YES", "CTV_OPTION_B_RECOVERY_AUTHORITY_UNCHANGED=YES", "CTV_OPTION_B_ADDITIONAL_RESTART=NO"):
        assert expected in r.stdout, expected
    assert world.snapshot() == before
    assert verb_set(world) == {"show"}


# ── B1: --hermetic / test seams can never reach Production ────────────────────────────────────────────────────────────
def test_verifier_refuses_every_test_seam_without_hermetic(world: World) -> None:
    for flag, val in (("--unit-dest", str(world.unit)), ("--core-env", str(world.core_env)), ("--clock-fixture", "synced:5"),
                      ("--preimage-sha256", "0" * 64), ("--path-prefix", str(world.bin))):
        r = subprocess.run([str(world.verifier), "--repo", str(world.repo), "--main", world.main, "--canon", str(world.canon), "--work", str(world.work),
                            "--device", DEVICE, flag, val], text=True, capture_output=True, env=world.env())
        assert r.returncode == 1 and "NON_HERMETIC_OVERRIDE_REFUSED" in r.stderr, flag


def test_hermetic_flag_alone_is_not_enough(world: World) -> None:
    env = {k: v for k, v in world.env().items() if k not in ("CTV_OPTION_B_TEST_ONLY", "CTV_OPTION_B_TEST_ROOT")}
    for run in (lambda: world.verify(env=env), lambda: world.action_run(env=env), lambda: world.action_run("--record", env=env)):
        r = run()
        assert r.returncode == 1 and "HERMETIC_REQUIRES_TEST_ONLY_ENV" in r.stderr, r.stderr
    both_missing_root = dict(env, CTV_OPTION_B_TEST_ONLY="YES")
    assert "TEST_ROOT_INVALID" in world.verify(env=both_missing_root).stderr


@pytest.mark.parametrize("bad_root", ["/", "/etc", "/var/tmp", "/usr", "/root", "relative/path", "/tmp/../etc"])
def test_unsafe_test_roots_are_rejected(world: World, bad_root: str) -> None:
    for run in (lambda e: world.verify(env=e), lambda e: world.action_run("--record", env=e)):
        r = run(world.env(CTV_OPTION_B_TEST_ROOT=bad_root))
        assert r.returncode == 1 and re.search(r"reason=TEST_ROOT_(INVALID|UNSAFE|NOT_CANONICAL)", r.stderr), (bad_root, r.stderr)


def test_group_writable_or_symlinked_test_root_is_rejected(world: World, tmp_path_factory) -> None:
    world.tmp.chmod(0o770)
    assert "TEST_ROOT_UNSAFE" in world.verify().stderr
    world.tmp.chmod(0o700)
    link = tmp_path_factory.mktemp("lnk") / "root-link"
    link.symlink_to(world.tmp)
    assert "TEST_ROOT_INVALID" in world.verify(env=world.env(CTV_OPTION_B_TEST_ROOT=str(link))).stderr


def test_hermetic_cannot_name_the_real_canonical_directory_or_paths_outside_the_test_root(world: World, tmp_path_factory) -> None:
    outside = tmp_path_factory.mktemp("outside")
    for flag, val in (("--canon", PROD_CANON), ("--canon", "/etc/aegis-idea3"), ("--work", str(outside)), ("--repo", str(outside)),
                      ("--unit-dest", "/etc/systemd/system/aegis-idea3-core.service"), ("--core-env", "/etc/aegis-idea3/core.env"),
                      ("--path-prefix", "/usr/bin")):
        args = world.common()
        args[args.index(flag) + 1] = val
        for exe, extra in ((world.verifier, []), (world.action, ["--authorization", str(world.auth), "--record"])):
            r = subprocess.run([str(exe), *extra, *args], text=True, capture_output=True, env=world.env())
            assert r.returncode == 1 and re.search(r"reason=(HERMETIC_PATH_OUTSIDE_TEST_ROOT|HERMETIC_PATH_IS_PRODUCTION|ACTION_NOT_RUN_FROM_REPO|VERIFIER_NOT_RUN_FROM_REPO)", r.stderr), (flag, val, r.stderr)


def test_hermetic_path_with_symlink_component_is_rejected(world: World) -> None:
    link = world.tmp / "canon-link"
    link.symlink_to(world.canon)
    args = world.common()
    args[args.index("--canon") + 1] = str(link)
    r = subprocess.run([str(world.verifier), *args], text=True, capture_output=True, env=world.env())
    assert r.returncode == 1 and "HERMETIC_PATH_NOT_CANONICAL" in r.stderr


def test_production_mode_requires_the_production_canonical_directory_and_root_trusted_repo(world: World) -> None:
    prod = [a for a in world.common() if a not in ("--hermetic",)]
    # strip the hermetic-only seams, keep a non-production canon
    base = ["--repo", str(world.repo), "--main", world.main, "--canon", str(world.canon), "--work", str(world.work), "--device", DEVICE]
    r = subprocess.run([str(world.verifier), *base], text=True, capture_output=True, env=world.env())
    assert r.returncode == 1 and "CANON_NOT_PRODUCTION_PATH" in r.stderr
    base[base.index("--canon") + 1] = PROD_CANON
    r = subprocess.run([str(world.verifier), *base], text=True, capture_output=True, env=world.env())
    assert r.returncode == 1 and "REPO_NOT_ROOT_TRUSTED" in r.stderr  # a user-owned worktree is never trusted to run as root
    ra = subprocess.run([str(world.action), "--authorization", str(world.auth), "--record", *base], text=True, capture_output=True, env=world.env())
    assert ra.returncode == 1 and "REPO_NOT_ROOT_TRUSTED" in ra.stderr
    assert prod  # (silences unused warning)


# ── B3: trusted execution, complete import closure, sudo pin, unit ownership, env injection ──────────────────────────
def _closure(entry: Path, pkg_root: Path) -> set[str]:
    seen: set[str] = set()
    todo = [entry]
    while todo:
        path = todo.pop()
        for node in ast.walk(ast.parse(path.read_text())):
            names: list[str] = []
            if isinstance(node, ast.ImportFrom):
                if node.level:  # relative import inside aegis_soc
                    base = "aegis_soc" + (f".{node.module}" if node.module else "")
                    names.append(base)
                    names += [f"aegis_soc.{a.name}" for a in node.names] if not node.module else []
                elif node.module:
                    names.append(node.module)
                    names += [f"{node.module}.{a.name}" for a in node.names]
            elif isinstance(node, ast.Import):
                names += [a.name for a in node.names]
            for name in names:
                if name.split(".")[0] != "aegis_soc":
                    continue
                parts = name.split(".")
                for i in range(1, len(parts) + 1):
                    mod = pkg_root.joinpath(*parts[:i])
                    f = mod / "__init__.py" if mod.is_dir() else mod.with_suffix(".py")
                    if f.is_file():
                        rel = str(f.relative_to(pkg_root))
                        if rel not in seen:
                            seen.add(rel)
                            todo.append(f)
    return seen


def test_verifier_authority_list_is_the_complete_aegis_soc_import_closure_of_the_clock_probe() -> None:
    computed = _closure(P4 / "p4-l5-clock.py", APP)
    declared = set(re.search(r'AEGIS_SOC_CLOSURE="([^"]+)"', VERIFIER_SRC.read_text()).group(1).split())
    assert computed == declared and "aegis_soc/protocol_v1.py" in declared


@pytest.mark.parametrize("rel", ["IDEA3-AEGIS_Lockdown/aegis_soc/__init__.py", "IDEA3-AEGIS_Lockdown/aegis_soc/trusted_time.py",
                                 "IDEA3-AEGIS_Lockdown/aegis_soc/protocol_v1.py", "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l5-clock.py",
                                 "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctv-incident/ctv-option-b-guard.sh"])
def test_every_executed_file_must_equal_the_exact_main_blob(world: World, rel: str) -> None:
    target = world.repo / rel
    target.write_text(target.read_text() + "\n# tampered after the exact-main commit\n")
    r = world.verify()
    assert r.returncode == 1 and "AUTHORITY_FILE_DIFFERS_FROM_MAIN" in r.stderr
    assert world.action_run().returncode == 1


def test_group_writable_executed_file_is_not_trusted_even_if_its_bytes_match_main(world: World) -> None:
    (world.repo / "IDEA3-AEGIS_Lockdown/aegis_soc/trusted_time.py").chmod(0o664)
    r = world.verify()
    assert r.returncode == 1 and "EXEC_PATH_NOT_TRUSTED" in r.stderr


def test_unit_must_be_owned_and_not_group_or_world_writable(world: World) -> None:
    world.unit.chmod(0o666)
    r = world.verify()
    assert r.returncode == 1 and "UNIT_OWNERSHIP_INVALID" in r.stderr


def test_sudo_is_pinned_and_environment_injection_is_neutralized(world: World, tmp_path_factory) -> None:
    evil = tmp_path_factory.mktemp("evil")
    marker = evil / "pwned"
    (evil / "evil.sh").write_text(f"#!/bin/bash\ntouch {marker}\n")
    (evil / "evil.sh").chmod(0o755)
    (evil / "bashenv").write_text(f"touch {marker}\n")
    pkg = evil / "aegis_soc"
    pkg.mkdir()
    (pkg / "trusted_time.py").write_text(f"open('{marker}', 'w').write('x')\n")
    hostile = world.env(CTV_SUDO=str(evil / "evil.sh"), SUDO=str(evil / "evil.sh"), PYTHONPATH=str(evil), PYTHONSTARTUP=str(evil / "bashenv"),
                        BASH_ENV=str(evil / "bashenv"), ENV=str(evil / "bashenv"), PYTHONSAFEPATH="", SHELLOPTS="xtrace")
    for exe, extra in ((world.verifier, []), (world.action, ["--authorization", str(world.auth)])):
        r = subprocess.run([str(exe), *extra, *world.common()], text=True, capture_output=True, env=hostile)  # direct exec: shebang is `bash -p`
        assert r.returncode == 0, r.stderr
        assert not marker.exists(), "environment injection executed attacker code"
    text = (GUARD_SRC.read_text(), VERIFIER_SRC.read_text())
    assert "CTV_SUDO=/usr/bin/sudo" in text[0] and "ob_guard_init_sudo_repin" in text[1]


def test_bash_env_is_refused_when_the_script_is_run_through_bash_explicitly(world: World, tmp_path_factory) -> None:
    evil = tmp_path_factory.mktemp("bashenv")
    marker = evil / "ran"
    (evil / "bashenv").write_text(f"touch {marker}\n")
    for exe in (world.verifier, world.action):
        r = subprocess.run(["/bin/bash", str(exe), *world.common()], text=True, capture_output=True, env=world.env(BASH_ENV=str(evil / "bashenv")))
        assert r.returncode == 1 and "BASH_ENV_INJECTION_REFUSED" in r.stderr
    assert (evil / "ran").exists()  # bash itself ran it before our first line: the refusal is the containment, and nothing was verified or written
    assert verb_set(world) if world.calls.exists() else True


def test_clock_probe_neutralizes_python_environment_and_pycache() -> None:
    code = VERIFIER_SRC.read_text()
    assert "-I -B -X pycache_prefix=" in code and "/usr/bin/python3" in code


# ── B2: positive, integrity-anchored historical FAIL evidence; PRE detector baseline; digests bound to the authorization ──
@pytest.mark.parametrize(
    ("content", "reason"),
    [
        ("", "HISTORICAL_COMPARE_NOT_A_REPORT"),
        ("COMPARE_RESULT=FAIL\n", "HISTORICAL_COMPARE_NOT_A_REPORT"),
        ("STOP: comparison failed\nCOMPARE_RESULT=FAIL\n", "HISTORICAL_COMPARE_NOT_A_REPORT"),
        (COMPARE_FAIL.replace("P4_COMPARE_SCHEMA=1\n", ""), "HISTORICAL_COMPARE_NOT_A_REPORT"),
        (COMPARE_FAIL.replace("PRODUCTION_MUTATION_PERFORMED=NO\n", ""), "HISTORICAL_COMPARE_NOT_A_REPORT"),
        (COMPARE_FAIL.replace("PRESERVATION_S10=FAIL\n", ""), "HISTORICAL_S10_FAIL_NOT_POSITIVELY_EVIDENCED"),
        (COMPARE_FAIL.replace("COMPARE_RESULT=FAIL\n", ""), "HISTORICAL_S10_FAIL_NOT_POSITIVELY_EVIDENCED"),
        (COMPARE_FAIL + "COMPARE_RESULT=FAIL\n", "HISTORICAL_S10_FAIL_NOT_POSITIVELY_EVIDENCED"),
        (COMPARE_FAIL.replace("=FAIL", "=PASS"), "HISTORICAL_S10_FAIL_NOT_POSITIVELY_EVIDENCED"),
    ],
)
def test_historical_s10_fail_must_be_positively_evidenced(world: World, content: str, reason: str) -> None:
    (world.work / "compare-pre-post.txt").write_text(content)
    r = world.verify()
    assert r.returncode == 1 and f"reason={reason}" in r.stderr, r.stderr
    assert "CTV_OPTION_B_VERIFY=PASS" not in r.stdout


def test_pre_detector_baseline_comes_from_integrity_verified_pre_evidence(world: World) -> None:
    world.write_services_tsv({**DETECTOR_PRE, "ActiveState": "active", "SubState": "running", "MainPID": "321"})
    # negative control: edited without resealing -> integrity failure, not a baseline verdict
    assert "EVIDENCE_INTEGRITY_FAIL" in world.verify().stderr
    world.reseal()
    r = world.verify()
    assert r.returncode == 1 and "PRE_DETECTOR_BASELINE_NOT_INACTIVE" in r.stderr
    world.write_services_tsv(DETECTOR_PRE)
    (world.work / "pre-root" / "services.tsv").write_text("")  # key missing entirely
    world.reseal()
    assert "PRE_DETECTOR_BASELINE_NOT_INACTIVE" in world.verify().stderr


@pytest.mark.parametrize("which", ["pre", "post", "compare"])
def test_bound_evidence_digests_must_match(world: World, which: str) -> None:
    good = dict(zip(("pre", "post", "compare"), world.digests()))
    bad = dict(good, **{which: "f" * 64})
    r = world.verify("--bind-evidence", "--expect-pre-sums", bad["pre"], "--expect-post-sums", bad["post"], "--expect-compare", bad["compare"])
    assert r.returncode == 1 and "EVIDENCE_DIGEST_MISMATCH" in r.stderr
    assert "EVIDENCE_BINDING_INCOMPLETE" in world.verify("--bind-evidence", "--expect-pre-sums", good["pre"]).stderr
    assert "EVIDENCE_EXPECTATION_INVALID" in world.verify("--expect-compare", "xyz").stderr


def test_evidence_modified_consistently_after_authorization_is_caught_by_the_bound_digest(world: World) -> None:
    world.write_auth()  # owner binds the current evidence
    (world.work / "compare-pre-post.txt").write_text(COMPARE_FAIL + "# edited later but still a plausible FAIL report\n")
    before = world.snapshot()
    r = world.action_run("--record")
    assert r.returncode == 1 and "VERIFIER_FAILED" in r.stderr and "EVIDENCE_DIGEST_MISMATCH" in r.stderr
    assert world.snapshot() == before and not (world.canon / "CTV-GLOBAL-CLOSEOUT-FAIL").exists()


def _mut_unit(w: World) -> None:
    w.unit.write_text(w.unit.read_text() + "# tampered\n")


def _mut_preimage(w: World) -> None:
    w.preimage.write_text("DIFFERENT\n")


def _mut_phase(w: World) -> None:
    (w.work / "journal").write_text(f"phase=rollback-complete\npreimage={w.preimage}\n")


def _mut_pass_closeout(w: World) -> None:
    (w.canon / "CTV-GLOBAL-CLOSEOUT-PASS").write_text("x\n")


def _mut_fail_closeout(w: World) -> None:
    (w.canon / "CTV-GLOBAL-CLOSEOUT-FAIL").write_text("x\n")


def _mut_recovery(w: World) -> None:
    (w.canon / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED").write_text("x\n")


def _mut_marker_work(w: World) -> None:
    (w.canon / "CTV-GLOBAL-ATTEMPT-CONSUMED").write_text("CTV_ATTEMPT_CONSUMED=YES\nCTV_RERUN_ALLOWED=NO\nwork=/some/other/work\n")


def _mut_marker_rerun(w: World) -> None:
    (w.canon / "CTV-GLOBAL-ATTEMPT-CONSUMED").write_text(f"CTV_ATTEMPT_CONSUMED=YES\nCTV_RERUN_ALLOWED=YES\nwork={w.work}\n")


def _mut_evidence(w: World) -> None:
    (w.work / "post-root" / "capture.log").write_text("L0_CAPTURE=COMPLETE\ntampered\n")


def _mut_device(w: World) -> None:
    w.core_env.write_text("AEGIS_P1_DEVICE_ID=another-device\n")


def _mut_unit_symlink(w: World) -> None:
    real = w.tmp / "real.service"
    shutil.move(str(w.unit), real)
    w.unit.symlink_to(real)


@pytest.mark.parametrize(
    ("mutate", "reason"),
    [
        (_mut_unit, "UNIT_IDENTITY_INVALID"), (_mut_unit_symlink, "HERMETIC_PATH_NOT_CANONICAL|UNIT_OWNERSHIP_INVALID|UNIT_IDENTITY_INVALID"),
        (_mut_preimage, "PREIMAGE_SHA256_MISMATCH"), (_mut_phase, "JOURNAL_NOT_APPLY_VERIFIED"),
        (_mut_pass_closeout, "CTV_PASS_CLOSEOUT_PRESENT"), (_mut_fail_closeout, "CTV_FAIL_CLOSEOUT_ALREADY_PRESENT"),
        (_mut_recovery, "RECOVERY_AUTHORITY_PRESENT"), (_mut_marker_work, "CTV_MARKER_WORK_DIR_MISMATCH"),
        (_mut_marker_rerun, "CTV_MARKER_INVALID"), (_mut_evidence, "EVIDENCE_INTEGRITY_FAIL"), (_mut_device, "DEVICE_ID_MISMATCH"),
    ],
)
def test_verifier_fails_closed_on_file_and_governance_drift(world: World, mutate, reason: str) -> None:
    mutate(world)
    r = world.verify()
    assert r.returncode == 1 and re.search(rf"reason=({reason})", r.stderr), r.stderr
    assert "CTV_OPTION_B_VERIFY=PASS" not in r.stdout


@pytest.mark.parametrize(
    ("side", "kv", "reason"),
    [
        ("core", {"ActiveState": "inactive", "SubState": "dead"}, "CORE_NOT_ACTIVE_RUNNING"),
        ("core", {"Result": "exit-code"}, "CORE_NOT_ACTIVE_RUNNING"),
        ("core", {"MainPID": "0"}, "CORE_MAINPID_INVALID"),
        ("core", {"NeedDaemonReload": "yes"}, "CORE_NEEDS_DAEMON_RELOAD"),
        ("core", {"FragmentPath": "/etc/systemd/system/other.service"}, "CORE_FRAGMENT_PATH_MISMATCH"),
        ("core", {"ProtectClock": "yes"}, "EFFECTIVE_SECURITY_PROPERTIES_INVALID"),
        ("core", {"User": "root"}, "EFFECTIVE_SECURITY_PROPERTIES_INVALID"),
        ("core", {"NoNewPrivileges": "no"}, "EFFECTIVE_SECURITY_PROPERTIES_INVALID"),
        ("core", {"CapabilityBoundingSet": "cap_sys_time"}, "EFFECTIVE_SECURITY_PROPERTIES_INVALID"),
        ("core", {"AmbientCapabilities": "cap_sys_time"}, "EFFECTIVE_SECURITY_PROPERTIES_INVALID"),
        ("core", {"DropInPaths": DROPINS + " /etc/systemd/system/aegis-idea3-core.service.d/99-extra.conf"}, "DROPINS_NOT_EXACT"),
        ("core", {"DropInPaths": DROPINS.split()[0]}, "DROPINS_NOT_EXACT"),
        ("detector", {"ActiveState": "active", "SubState": "running", "MainPID": "77"}, "DETECTOR_BASELINE_NOT_INACTIVE"),
    ],
)
def test_verifier_fails_closed_on_runtime_drift(world: World, side: str, kv: dict[str, str], reason: str) -> None:
    world.edit_state(side, **kv)
    r = world.verify()
    assert r.returncode == 1 and f"reason={reason}" in r.stderr, r.stderr


def test_verifier_fails_closed_on_untrusted_clock_wrong_main_and_dirty_authority(world: World) -> None:
    assert world.verify().returncode == 0
    args = world.common()
    args[args.index("synced:5")] = "unsynced:5"
    r = subprocess.run([str(world.verifier), *args], text=True, capture_output=True, env=world.env())
    assert r.returncode == 1 and ("TRUSTEDCLOCK_NOT_OK" in r.stderr or "TRUSTEDCLOCK_NOT_SYNCED" in r.stderr), r.stderr
    wrong_main = world.verify(main="0" * 40)
    assert wrong_main.returncode == 1 and "REPO_HEAD_NOT_EXPECTED_MAIN" in wrong_main.stderr
    lib = world.repo / REPO_FILES[3]
    lib.write_text(lib.read_text() + "\n# uncommitted change\n")
    dirty = world.verify()
    assert dirty.returncode == 1 and "AUTHORITY_FILE_DIFFERS_FROM_MAIN" in dirty.stderr


def test_verifier_detects_state_change_during_verification(world: World) -> None:
    world.set_state({**json.loads(world.state.read_text()), "flip_after": 1})
    r = world.verify()
    assert r.returncode == 1 and "reason=STATE_CHANGED_DURING_VERIFY" in r.stderr, r.stderr


def test_verifier_post_phase_requires_the_fail_closeout(world: World) -> None:
    assert "CTV_FAIL_CLOSEOUT_MISSING" in world.verify("--phase", "post").stderr
    (world.canon / "CTV-GLOBAL-CLOSEOUT-FAIL").write_text("x\n")
    assert world.verify("--phase", "post").returncode == 0


# ── disposition action ─────────────────────────────────────────────────────────────────────────────────────────────
CLOSEOUT = "CTV-GLOBAL-CLOSEOUT-FAIL"


def test_action_dry_check_writes_nothing_prints_digests_and_record_requires_exact_authorization(world: World) -> None:
    before = world.snapshot()
    dry = world.action_run()
    assert dry.returncode == 0 and "CHECK_ONLY_NOTHING_WRITTEN" in dry.stdout
    pre, post, cmp_ = world.digests()
    assert f"CTV_OPTION_B_PRE_SHA256SUMS_SHA256={pre}" in dry.stdout and f"CTV_OPTION_B_COMPARE_OUTPUT_SHA256={cmp_}" in dry.stdout
    assert world.snapshot() == before
    for label, setup in (
        ("AUTHORIZATION_MISSING", lambda: world.auth.unlink()),
        ("AUTHORIZATION_NOT_EXACT", lambda: world.write_auth(extra="rogue=1\n")),
        ("AUTHORIZATION_NOT_EXACT", lambda: world.write_auth(drop="device_id")),
        ("AUTHORIZATION_NOT_EXACT", lambda: world.write_auth(drop="compare_output_sha256")),
        ("AUTHORIZATION_NOT_EXACT", lambda: world.write_auth(drop="guard_sha256")),
        ("AUTHORIZATION_EVIDENCE_DIGEST_INVALID", lambda: world.write_auth(pre_sha256sums_sha256="nothex")),
        ("AUTHORIZATION_ID_INVALID", lambda: world.write_auth(authorization_id="x")),
    ):
        setup()
        r = world.action_run("--record")
        assert r.returncode == 1 and label in r.stderr, (label, r.stderr)
        assert world.snapshot() == before
        world.write_auth()
    world.auth.chmod(0o666)
    assert "AUTHORIZATION_WRITABLE" in world.action_run("--record").stderr
    assert world.snapshot() == before


def test_action_rejects_authorization_bound_to_a_different_verifier_guard_or_main(world: World) -> None:
    for old in (sha(world.verifier), sha(world.guard), world.main):
        world.write_auth()
        world.auth.write_text(world.auth.read_text().replace(old, "0" * (len(old))))
        assert "AUTHORIZATION_NOT_EXACT" in world.action_run("--record").stderr


def test_action_records_one_truthful_append_only_fail_closeout_without_touching_anything_else(world: World) -> None:
    before = world.snapshot()
    r = world.action_run("--record")
    assert r.returncode == 0, r.stderr
    assert "CTV_INCIDENT_DISPOSITION=RECORDED" in r.stdout and "CTV_INCIDENT_ADDITIONAL_RESTART=NO" in r.stdout
    closeout = world.canon / CLOSEOUT
    lines = closeout.read_text().splitlines()
    for line in ("CTV_RESULT=FAIL_IMMUTABLE", "CTV_LIVE=CLOSED_FAIL", "CTV_ATTEMPT_CONSUMED=YES", "CTV_RERUN_ALLOWED=NO", "CTV_IS_CTU_RETRY=NO",
                 "CTV_INCIDENT_DISPOSITION=OPTION_B_TARGET_UNIT_RETAINED", "CTV_ROLLBACK_COMPLETE=NO", "CTV_TARGET_UNIT_RETAINED=YES",
                 "CTV_ADDITIONAL_CORE_RESTART=NO", "CTV_S10_HISTORICAL_COMPARE=FAIL", "CTV_S10_PROMOTED_TO_PASS=NO", "CTV_RECOVERY_AUTHORIZED=NO",
                 "CTV_JOURNAL_PHASE=apply-verified", f"CTV_UNIT_SHA256={PIN_UNIT}", f"CTV_PREIMAGE_SHA256={world.pre_sha}", f"CTV_DEVICE_ID={DEVICE}",
                 "CTV_DETECTOR_BASELINE_MODE=INACTIVE", "CTV_TRUSTEDCLOCK_AT_DISPOSITION=SYNCED", "CTV_INCIDENT_AUTHORIZATION_ID=AUTH-TEST-0001",
                 f"CTV_GUARD_SHA256={sha(world.guard)}", f"CTV_COMPARE_OUTPUT_SHA256={world.digests()[2]}"):
        assert line in lines, line
    assert "CLOSED_PASS" not in closeout.read_text()
    assert oct(closeout.stat().st_mode & 0o777) == "0o600"
    sidecar = world.canon / (CLOSEOUT + ".sha256")
    assert sidecar.read_text() == f"{sha(closeout)}  {CLOSEOUT}\n" and oct(sidecar.stat().st_mode & 0o777) == "0o444"
    after = world.snapshot()
    assert {k for k in after if k not in before} == {str(closeout), str(sidecar)}
    assert {k: v for k, v in after.items() if k in before} == before  # marker, journal, evidence, CTu closeout, unit: untouched
    assert not list(world.canon.glob("*.tmp.*")) and verb_set(world) == {"show"}


def test_action_is_idempotent_and_never_overwrites_a_foreign_or_existing_closeout(world: World) -> None:
    assert world.action_run("--record").returncode == 0
    closeout = world.canon / CLOSEOUT
    first = closeout.read_bytes()
    again = world.action_run("--record")
    assert again.returncode == 0 and "ALREADY_RECORDED" in again.stdout and closeout.read_bytes() == first
    world.auth.write_text(world.auth.read_text().replace("AUTH-TEST-0001", "AUTH-OTHER-0002"))
    other = world.action_run("--record")
    assert other.returncode == 1 and "DIFFERENT_FAIL_CLOSEOUT_PRESENT" in other.stderr and closeout.read_bytes() == first


def test_action_refuses_a_preexisting_foreign_fail_closeout(world: World) -> None:
    foreign = world.canon / CLOSEOUT
    foreign.write_text("CTV_RESULT=FAIL_IMMUTABLE\nCTV_FAILURE_REASON=APPLY\n")
    r = world.action_run("--record")
    assert r.returncode == 1 and "DIFFERENT_FAIL_CLOSEOUT_PRESENT" in r.stderr
    assert foreign.read_text() == "CTV_RESULT=FAIL_IMMUTABLE\nCTV_FAILURE_REASON=APPLY\n"


# ── B4: crash between closeout creation and sidecar creation ─────────────────────────────────────────────────────────
def test_crash_after_closeout_before_sidecar_is_completed_idempotently_without_rewriting_the_closeout(world: World) -> None:
    crashed = world.action_run("--record", env=world.env(CTV_OPTION_B_FAILPOINT="after-closeout"))
    assert crashed.returncode == 1 and "FAILPOINT_AFTER_CLOSEOUT" in crashed.stderr
    closeout, sidecar = world.canon / CLOSEOUT, world.canon / (CLOSEOUT + ".sha256")
    assert closeout.exists() and not sidecar.exists()
    frozen = closeout.read_bytes()
    healed = world.action_run("--record")
    assert healed.returncode == 0 and "ALREADY_RECORDED_SIDECAR_COMPLETED" in healed.stdout and "CTV_INCIDENT_CLOSEOUT_UNCHANGED=YES" in healed.stdout
    assert closeout.read_bytes() == frozen and sidecar.read_text() == f"{sha(closeout)}  {CLOSEOUT}\n"
    assert oct(sidecar.stat().st_mode & 0o777) == "0o444" and not list(world.canon.glob("*.tmp.*"))
    third = world.action_run("--record")
    assert third.returncode == 0 and "ALREADY_RECORDED" in third.stdout and "COMPLETED" not in third.stdout and closeout.read_bytes() == frozen


def test_failpoints_are_inert_outside_hermetic_test_mode(world: World) -> None:
    assert "CTV_OPTION_B_FAILPOINT" in ACTION_SRC.read_text()
    for line in ACTION_SRC.read_text().splitlines():
        if line.startswith("[ \"${CTV_OPTION_B_FAILPOINT") or ("CTV_OPTION_B_FAILPOINT:-}\" = after-closeout" in line):
            assert 'HERMETIC' in line


def test_tampered_or_mismatched_closeout_state_is_never_repaired_or_overwritten(world: World) -> None:
    assert world.action_run("--record", env=world.env(CTV_OPTION_B_FAILPOINT="after-closeout")).returncode == 1
    closeout, sidecar = world.canon / CLOSEOUT, world.canon / (CLOSEOUT + ".sha256")
    original = closeout.read_bytes()
    closeout.write_bytes(original + b"CTV_RECOVERY_AUTHORIZED=YES\n")  # tampered closeout, no sidecar
    r = world.action_run("--record")
    assert r.returncode == 1 and "DIFFERENT_FAIL_CLOSEOUT_PRESENT" in r.stderr and not sidecar.exists()
    assert closeout.read_bytes() == original + b"CTV_RECOVERY_AUTHORIZED=YES\n"
    closeout.write_bytes(original)
    sidecar.write_text("0" * 64 + f"  {CLOSEOUT}\n")  # wrong sidecar must not be replaced
    r2 = world.action_run("--record")
    assert r2.returncode == 1 and "CLOSEOUT_SHA256_MISMATCH" in r2.stderr and sidecar.read_text().startswith("0" * 64)
    assert closeout.read_bytes() == original


def test_orphan_sidecar_and_stale_temp_files_are_handled_safely(world: World) -> None:
    stale = world.canon / (CLOSEOUT + ".tmp.99999")
    stale.write_text("partial\n")  # a crash before the link leaves only a temp file: harmless
    ok = world.action_run("--record")
    assert ok.returncode == 0 and stale.read_text() == "partial\n"
    (world.canon / CLOSEOUT).unlink()  # simulate loss of the closeout, sidecar remains
    orphan = world.action_run("--record")
    assert orphan.returncode == 1 and "ORPHAN_SIDECAR_PRESENT" in orphan.stderr and not (world.canon / CLOSEOUT).exists()


# ── I1: revalidate immediately before the commit ───────────────────────────────────────────────────────────────────
def test_state_drift_between_first_proof_and_commit_refuses_to_record(world: World) -> None:
    # first verifier run = 5 core `show` calls; the second (pre-commit) run sees a different, self-consistent MainPID.
    world.set_state({**json.loads(world.state.read_text()), "flip_after": 5})
    before = world.snapshot()
    r = world.action_run("--record")
    assert r.returncode == 1 and "STATE_DRIFT_BEFORE_COMMIT" in r.stderr, r.stderr
    assert world.snapshot() == before and not list(world.canon.glob("*.tmp.*")) and not (world.canon / CLOSEOUT).exists()


def test_drift_during_the_pre_commit_revalidation_refuses_to_record(world: World) -> None:
    world.set_state({**json.loads(world.state.read_text()), "flip_after": 7})
    before = world.snapshot()
    r = world.action_run("--record")
    assert r.returncode == 1 and "REVALIDATION_FAILED" in r.stderr and "STATE_CHANGED_DURING_VERIFY" in r.stderr
    assert world.snapshot() == before and not list(world.canon.glob("*.tmp.*"))


def test_no_drift_negative_control_records(world: World) -> None:
    assert world.action_run("--record").returncode == 0


def test_action_refuses_when_the_verifier_fails_and_writes_nothing(world: World) -> None:
    world.edit_state("core", NeedDaemonReload="yes")
    before = world.snapshot()
    r = world.action_run("--record")
    assert r.returncode == 1 and "VERIFIER_FAILED" in r.stderr
    assert world.snapshot() == before


def test_action_is_exclusive_under_the_canonical_directory_lock(world: World) -> None:
    fd = os.open(world.canon, os.O_RDONLY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        before = world.snapshot()
        r = world.action_run("--record")
        assert r.returncode == 1 and "LOCK_HELD" in r.stderr
        assert world.snapshot() == before
    finally:
        os.close(fd)


def test_action_rejects_an_action_script_that_differs_from_main(world: World) -> None:
    world.action.write_text(world.action.read_text() + "\n# local edit\n")
    r = world.action_run()
    assert r.returncode == 1 and "AUTHORITY_FILE_DIFFERS_FROM_MAIN" in r.stderr


# ── static safety / scope guards ───────────────────────────────────────────────────────────────────────────────────
def _code(path: Path) -> str:
    return "\n".join(l for l in path.read_text().splitlines() if not l.lstrip().startswith("#"))


def test_scripts_contain_no_mutating_host_verbs_and_do_not_use_the_broken_or_consuming_helpers() -> None:
    for path in (VERIFIER_SRC, ACTION_SRC, GUARD_SRC):
        code = _code(path)
        assert not re.search(r"systemctl\s+(?!show\b)\w+", code), path.name
        for forbidden in ("daemon-reload", "restart", "ctv_apply_governed", "ctv_rollback_governed", "ctv_consume_attempt", "ctv_host_runtime_verify",
                          "ctv_record_failure", "ctv_record_success", "run-ctv-owner", "run-ctu-owner", "install ", "chown", "kill "):
            assert forbidden not in code, (path.name, forbidden)
    assert not re.search(r"(^|[\s;|&])(cp|mv|rm|tee|touch|mkdir|ln|chmod|sync)\s", _code(VERIFIER_SRC) + _code(GUARD_SRC))
    action = _code(ACTION_SRC)
    assert all(re.match(r'rm -f -- "\$s?tmp"', m) for m in re.findall(r"\brm\b[^\n;}]*", action)), "action may only delete its own temp files"
    assert not re.search(r"(^|[\s;|&])(cp|mv|tee|touch|mkdir)\s", action)
    assert all(m.startswith(('"$tmp"', '"$stmp"')) for m in re.findall(r"chmod\s+[0-7]+\s+(\S+)", action))


def test_guard_runs_before_any_library_is_sourced_or_test_seam_honoured() -> None:
    v = VERIFIER_SRC.read_text()
    assert v.index("ob_guard_init\n") < v.index('. "$P4/p4-ctv-run-lib.sh"')
    a = ACTION_SRC.read_text()
    assert a.index("ob_guard_init\n") < a.index("PIN_PREIMAGE_SHA256=$PREIMAGE_OVERRIDE")
    assert a.index("ob_guard_init\n") < a.index('PATH="$PATH_PREFIX:$PATH"')
    assert v.startswith("#!/bin/bash -p\n") and a.startswith("#!/bin/bash -p\n")


def test_recovery_gate_still_refuses_any_ctv_fail_closeout_so_the_disposition_grants_no_recovery() -> None:
    text = (P4 / "p4-recovery-run-lib.sh").read_text()
    assert 'RECOVERY_CTV_FAIL_CLOSEOUT_PRESENT' in text
    assert re.search(r'\[ ! -e "\$canon/CTV-GLOBAL-CLOSEOUT-FAIL" \]', text)


def test_pins_match_the_owner_evidence_and_the_reviewed_unit_source() -> None:
    for path in (VERIFIER_SRC, ACTION_SRC):
        text = path.read_text()
        assert f"PIN_UNIT_SHA256={PIN_UNIT}" in text
        assert "PIN_PREIMAGE_SHA256=b2425b0bdc4402f09b7ff616afb66b0686f045459d3b7826796e73ad64a59890" in text
    assert sha(UNIT_EXAMPLE) == PIN_UNIT
