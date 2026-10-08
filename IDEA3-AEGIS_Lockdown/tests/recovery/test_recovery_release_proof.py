"""Hermetic tests of the Recovery release / restore-CLI identity proof (read-only).

Everything is a temporary exact-main Git repository (a release commit R, then a main commit M that carries the tools and the receipts) and a temporary host tree under a private test root.
Nothing touches Production. A PASS here is a PASS about SYNTHETIC fixtures in HERMETIC_TEST mode; it never says that Recovery is ready or authorized.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import recovery_support as sup  # noqa: E402

ACC_REL = "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/recovery-acceptance"
P4_REL = "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4"
LOGS_REL = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
TOOL_SRC = sup.P4 / "recovery-acceptance" / "recovery_release_proof.py"
REAL_LOGS = sup.ROOT.parent / LOGS_REL
REAL_RELEASE = "954ce1c191885e9e90198a6f54a3d990bcf144fc"
PREFIX = "RECOVERY_RELEASE_PROOF_"
freeze = sup.load_tool(sup.P4 / "recovery-acceptance" / "recovery_runner_freeze.py", "rrp_test_freeze")

AEGIS_FILES = {
    "__init__.py": "# package\n", "cli.py": "def restore():\n    return 'cli'\n", "recovery_core.py": "CORE = 1\n", "production_detector.py": "DETECTOR = 1\n",
    "historical_disposition.py": "DISPOSITION = 1\n", "supervisor.py": "SUPERVISOR = 1\n",
}


def sha(data: bytes | str) -> str:
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode()).hexdigest()


def git(repo: Path, *args: str) -> str:
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@e.invalid", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@e.invalid", "HOME": "/nonexistent"}
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True, env=env).stdout.strip()


class World:
    """An exact-main repository (release commit R, then main M) plus a synthetic host release tree under a private test root."""

    LIBS = ("p4-r1bv-run-lib.sh p4-f1u-run-lib.sh p4-f1i-run-lib.sh p4-f1r-run-lib.sh p4-f1-run-lib.sh p4-l6b-run-lib.sh p4-l7-run-lib.sh p4-l7u-run-lib.sh p4-l8p-run-lib.sh "
            "p4-ntp-reactivation-lib.sh").split()

    def __init__(self, tmp: Path, *, real_logs: bool = False, libs: bool = False) -> None:
        self.tmp = tmp
        tmp.chmod(0o700)
        self.repo = tmp / "repo"
        self.root = tmp / "root"
        self.root.mkdir(mode=0o700)
        git_dir = self.repo
        git_dir.mkdir()
        subprocess.run(["git", "-C", str(self.repo), "init", "-q"], check=True)
        for name, text in AEGIS_FILES.items():
            path = self.repo / "IDEA3-AEGIS_Lockdown/aegis_soc" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-qm", "release source")
        self.release = git(self.repo, "rev-parse", "HEAD")
        self.copy_authority(libs)
        logs = self.repo / LOGS_REL
        logs.mkdir(parents=True, exist_ok=True)
        if real_logs:
            for item in REAL_LOGS.glob("*.md"):
                shutil.copy2(item, logs / item.name)
        canonical = next(logs.glob("*_music_idea3-rru-live-closeout.md"), None)
        if canonical is not None:
            canonical.write_text(canonical.read_text().replace(REAL_RELEASE, self.release))
        else:
            canonical = logs / "2026-10-07_005834_music_idea3-rru-live-closeout.md"
            canonical.write_text(self.minimal_receipt())
        self.receipt = canonical
        self.commit_main()
        self.host_release = self.root / "opt/aegis-idea3/releases" / self.release
        self.current = self.root / "opt/aegis-idea3/current"
        self.build_host()

    def copy_authority(self, libs: bool) -> None:
        """Only the files the tool (and, when asked, the reviewed shell gate) need: keeps the temporary footprint small."""
        dest = self.repo / P4_REL
        shutil.copytree(sup.P4 / "recovery-acceptance", dest / "recovery-acceptance", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        (dest / "owner-run").mkdir(parents=True, exist_ok=True)
        shutil.copy2(sup.P4 / "owner-run/run-recovery-owner.sh", dest / "owner-run/run-recovery-owner.sh")
        shutil.copy2(sup.P4 / "p4-l7-release-guard.py", dest / "p4-l7-release-guard.py")
        if libs:
            for name in self.LIBS:
                shutil.copy2(sup.P4 / name, dest / name)

    # -- repository
    def commit_main(self) -> None:
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-qm", "main", "--allow-empty")
        self.main = git(self.repo, "rev-parse", "HEAD")

    def minimal_receipt(self) -> str:
        lines = ["RRU_LIVE=CLOSED_PASS", "RRU_LIVE_EXECUTED=YES", "RRU_RESULT=PASS", "RRU_PRODUCTION_DEPLOYED=YES", "RRU_ATTEMPT_CONSUMED=YES", "RRU_RERUN_ALLOWED=NO", f"RRU_RELEASE_ID={self.release}",
                 "RECOVERY_RUNTIME_RELEASE_READY=YES", "NEW_RELEASE_IS_OLD_PLUS_CLI_ONLY=YES", "RRU_RECOVERY_EXECUTED=NO", "RECOVERY_ATTEMPT_CONSUMED=NO", "RECOVERY_LIVE_EXECUTED=NO", "RECOVERY_R2_R8_EXECUTED=NO"]
        return "---\ntitle: RRu\n---\n" + "".join(f"- `{line}`\n" for line in lines)

    # -- host tree
    def build_host(self, *, cli_text: str | None = None, manifest_overrides: dict | None = None) -> None:
        if self.host_release.parent.exists():
            shutil.rmtree(self.root / "opt")
        host = self.host_release
        (host / "aegis_soc").mkdir(parents=True)
        (host / "venv/bin").mkdir(parents=True)
        for name, text in AEGIS_FILES.items():
            (host / "aegis_soc" / name).write_text(cli_text if (cli_text is not None and name == "cli.py") else text)
        (host / "venv/bin/python").write_text("#!/bin/sh\nexit 0\n")
        (host / "requirements.txt").write_text("aegis==1\n")
        manifest = {"schema_version": 1, "release_id": self.release, "source_git_sha": self.release, "source_tree_dirty": False, "python_version": "3.12.0",
                    "requirements_sha256": sha("aegis==1\n"), "file_count": 0, "created_by_tool_version": "1"}
        manifest.update(manifest_overrides or {})
        (host / "RELEASE-MANIFEST.json").write_text("")  # placeholder so the payload count includes it
        payload = sorted(p.relative_to(host).as_posix() for p in host.rglob("*") if p.is_file())
        manifest["file_count"] = manifest_overrides.get("file_count", len([p for p in payload if p != "RELEASE-MANIFEST.json"])) if manifest_overrides else len([p for p in payload if p != "RELEASE-MANIFEST.json"])
        (host / "RELEASE-MANIFEST.json").write_text(json.dumps(manifest, sort_keys=True))
        self.reseal()
        self.current.symlink_to(host)
        self.normalise_modes()

    def reseal(self) -> None:
        host = self.host_release
        sums = host / "RELEASE-SHA256SUMS"
        if sums.exists():
            sums.chmod(0o644)
            sums.unlink()
        files = sorted(p.relative_to(host).as_posix() for p in host.rglob("*") if p.is_file())
        sums.write_text("".join(f"{sha((host / rel).read_bytes())}  {rel}\n" for rel in files))
        sums.chmod(0o644)

    def normalise_modes(self) -> None:
        for path in [self.root, *self.root.rglob("*")]:
            if path.is_symlink():
                continue
            path.chmod(0o700 if path == self.root else (0o755 if path.is_dir() or path.name == "python" else 0o644))

    @property
    def sums_digest(self) -> str:
        return sha((self.host_release / "RELEASE-SHA256SUMS").read_bytes())

    @property
    def derived(self) -> dict[str, str]:
        return {pin: sha(AEGIS_FILES[rel]) for pin, rel in (("RESTORE_CLI_SHA256", "cli.py"), ("RECOVERY_CORE_SHA256", "recovery_core.py"), ("PRODUCTION_DETECTOR_SHA256", "production_detector.py"))}

    # -- running the tool
    def tool(self) -> Path:
        return self.repo / ACC_REL / "recovery_release_proof.py"

    def run(self, *more: str, host: bool = True, pin: bool = True, hermetic: bool = True, env: dict[str, str] | None = None, main: str | None = None,
            tool: Path | None = None) -> subprocess.CompletedProcess[str]:
        args = ["/usr/bin/python3", "-I", "-B", str(tool or self.tool()), "--repo", str(self.repo), "--main", main or self.main]
        if hermetic:
            args += ["--hermetic", "--test-root", str(self.root)]
        if host:
            args.append("--host")
        if host and pin:
            args += ["--release-sums-sha256", self.sums_digest]
        args += list(more)
        return subprocess.run(args, text=True, capture_output=True, env={"PATH": "/usr/bin:/bin", **({"RECOVERY_RELEASE_PROOF_TEST_ONLY": "YES"} if hermetic else {}), **(env or {})})

    def frozen_runner(self, **override: str) -> Path:
        pins = dict(sup.PINS)
        pins.update(EXPECTED_MAIN=self.main, REPO=str(self.repo), PY="/usr/bin/python3", EVIDENCE_ROOT=str(self.tmp / "evidence"), CTU_LIVE_RECEIPT_RELATIVE="/ctu-live-receipt.md",
                    CTV_LIVE_RECEIPT_RELATIVE="Obsidian/x/ctv.md", RELEASE_ID=self.release, RELEASE_SUMS_SHA256=self.sums_digest, **self.derived)
        pins.update(override)
        text = freeze.render(freeze.read_template(self.repo, self.main), pins)
        path = self.tmp / f"frozen-{len(list(self.tmp.glob('frozen-*')))}.sh"
        path.write_text(text)
        path.chmod(0o555)
        return path

    def mutate_tool(self, old: str, new: str) -> None:
        tool = self.tool()
        text = tool.read_text()
        assert text.count(old) == 1, old
        tool.write_text(text.replace(old, new))
        self.commit_main()

    def snapshot(self) -> dict[str, tuple[int, bytes | None, str | None]]:
        out = {}
        for base in (self.root, self.tmp / "evidence"):
            for path in ([base] if base.exists() else []) + (list(base.rglob("*")) if base.exists() else []):
                st = path.lstat()
                out[str(path)] = (st.st_mode, path.read_bytes() if path.is_file() and not path.is_symlink() else None, os.readlink(path) if path.is_symlink() else None)
        return out


@pytest.fixture()
def world(tmp_path: Path) -> World:
    return World(tmp_path)


@pytest.fixture()
def real_world(tmp_path: Path) -> World:
    """The same, but carrying the repository's real receipt corpus and the reviewed shell-gate libraries."""
    return World(tmp_path, real_logs=True, libs=True)


def facts(proc: subprocess.CompletedProcess[str]) -> dict[str, str]:
    return {k.removeprefix(PREFIX): v for k, v in (line.split("=", 1) for line in proc.stdout.splitlines() if line.startswith(PREFIX))}


def reason(proc: subprocess.CompletedProcess[str]) -> str:
    return proc.stderr.strip()


# ═════════════════════════════════════════════ derivation from the exact-main repository ═════════════════════════════════════════════
def test_the_release_id_and_source_digests_are_derived_from_exact_main_never_supplied(world: World) -> None:
    proc = world.run(host=False)
    f = facts(proc)
    assert proc.returncode == 3, proc.stderr
    assert f["RELEASE_ID"] == world.release and f["RELEASE_COMMIT_IS_ANCESTOR_OF_MAIN"] == "YES"
    for pin, digest in world.derived.items():
        assert f[f"DERIVED_{pin}"] == digest
    assert f["PIN_SOURCE_OF_RELEASE_ID_AND_SOURCE_DIGESTS"] == "DERIVED_FROM_THE_PINNED_MAIN_NOT_SUPPLIED"
    assert f["SOURCE_AUTHORITY"] == "EXACT_MAIN_GIT_OBJECTS_REPLACEMENT_DISABLED"
    assert f["RRU_CLOSEOUT_RECEIPT"].endswith("_music_idea3-rru-live-closeout.md")


def test_without_the_host_proof_the_verdict_is_partial_with_the_unknowns_named_and_a_nonzero_exit(world: World) -> None:
    proc = world.run(host=False)
    f = facts(proc)
    assert proc.returncode == 3 and f["VERDICT"] == "PARTIAL"
    assert (f["RELEASE_IDENTITY"], f["RESTORE_CLI_PROOF"], f["MANIFEST_PROOF"]) == ("UNKNOWN", "UNKNOWN", "UNKNOWN")
    assert f["HOST_PROOF"] == "NOT_PERFORMED" and set(f["UNKNOWN_INPUTS"].split(",")) == {"HOST_RELEASE_AND_CLI_STATE", "RELEASE_SUMS_SHA256"}


def test_cli_source_drift_since_the_release_is_reported_and_the_release_digest_is_the_pin(world: World) -> None:
    (world.repo / "IDEA3-AEGIS_Lockdown/aegis_soc/cli.py").write_text("def restore():\n    return 'newer cli on main'\n")
    world.commit_main()
    world.build_host()
    f = facts(world.run(host=False))
    assert f["RESTORE_CLI_SHA256_AT_MAIN_DIFFERS_FROM_RELEASE"] == "YES"
    assert f["DERIVED_RESTORE_CLI_SHA256"] == world.derived["RESTORE_CLI_SHA256"]       # what the deployed release carries, not what main now says


# ═════════════════════════════════════════════ host proof ═════════════════════════════════════════════
def test_a_matching_host_release_and_owner_pin_prove_identity_but_not_recovery_readiness(world: World) -> None:
    proc = world.run()
    f = facts(proc)
    assert proc.returncode == 0, proc.stderr
    assert (f["VERDICT"], f["RELEASE_IDENTITY"], f["RESTORE_CLI_PROOF"], f["MANIFEST_PROOF"]) == ("PASS", "PASS", "PASS", "PASS")
    assert f["MODE"] == "HERMETIC_TEST" and f["PASS_SCOPE"] == "RELEASE_AND_RESTORE_CLI_IDENTITY_ONLY"
    assert (f["RECOVERY_AUTHORIZED"], f["RECOVERY_READINESS"], f["READ_ONLY"], f["PRODUCTION_MUTATION"]) == ("NO", "NOT_ASSESSED", "YES", "NO")
    assert f["HOST_RESTORE_CLI_SHA256"] == world.derived["RESTORE_CLI_SHA256"] and f["HOST_CURRENT_LINK_NAMES_THIS_RELEASE"] == "YES"
    assert f["HOST_RELEASE_SUMS_SHA256"] == world.sums_digest and f["UNKNOWN_INPUTS"] == "NONE"
    assert "DETECTOR_UNIT_SHA256" in f["NOT_PROVEN_BY_THIS_TOOL"] and "RECOVERY_AUTHORIZATION_INPUTS" in f["NOT_PROVEN_BY_THIS_TOOL"]


def test_a_missing_sums_pin_is_unknown_and_the_observed_host_value_is_not_a_pin(world: World) -> None:
    proc = world.run(pin=False)
    f = facts(proc)
    assert proc.returncode == 3 and f["VERDICT"] == "PARTIAL" and f["RELEASE_SUMS_SHA256"] == "UNKNOWN" and f["UNKNOWN_INPUTS"] == "RELEASE_SUMS_SHA256"
    assert f["HOST_RELEASE_SUMS_SHA256_OBSERVED_NOT_A_PIN"] == world.sums_digest
    assert (f["RELEASE_IDENTITY"], f["RESTORE_CLI_PROOF"]) == ("UNKNOWN", "UNKNOWN")


def test_a_wrong_or_invented_sums_pin_fails_and_exits_one(world: World) -> None:
    for bad in ("0" * 64, "f" * 64, "not-a-digest"):
        proc = world.run(host=True, pin=False, *("--release-sums-sha256", bad))
        assert proc.returncode == 1 and re.search(r"RELEASE_SUMS_PIN_(NOT_THE_HOST_MANIFEST|MALFORMED)", reason(proc)), (bad, reason(proc))


def test_the_proof_is_deterministic(world: World) -> None:
    first, second = world.run(), world.run()
    assert first.stdout == second.stdout and first.returncode == second.returncode == 0
    assert re.search(rf"^{PREFIX}PROOF_SHA256=[0-9a-f]{{64}}$", first.stdout, re.M)
    lines = [ln for ln in first.stdout.splitlines() if not ln.startswith(PREFIX + "PROOF_SHA256=")]
    assert hashlib.sha256(("\n".join(lines) + "\n").encode()).hexdigest() == facts(first)["PROOF_SHA256"]


def test_the_proof_changes_when_what_it_verified_changes(world: World) -> None:
    before = facts(world.run())["PROOF_SHA256"]
    world.build_host(manifest_overrides={"python_version": "3.12.1"})
    assert facts(world.run())["PROOF_SHA256"] != before


@pytest.mark.parametrize("tamper", ["cli_changed_with_resealed_sums", "core_changed_with_resealed_sums", "extra_aegis_soc_file_matching_nothing"])
def test_a_host_aegis_soc_file_that_is_not_the_release_commit_source_is_refused_even_when_the_sums_are_resealed(world: World, tamper: str) -> None:
    host = world.host_release
    if tamper == "cli_changed_with_resealed_sums":
        (host / "aegis_soc/cli.py").write_text("def restore():\n    return 'evil'\n")
    elif tamper == "core_changed_with_resealed_sums":
        (host / "aegis_soc/recovery_core.py").write_text("CORE = 'evil'\n")
    else:
        (host / "aegis_soc/extra_module.py").write_text("X = 1\n")
    _fix_manifest_count(world)
    world.reseal()
    world.normalise_modes()
    proc = world.run()
    assert proc.returncode == 1 and re.search(r"RELEASE_CONTENT_NOT_THE_RELEASE_COMMIT_SOURCE|HOST_FILE_NOT_THE_DERIVED", reason(proc)), reason(proc)


def _fix_manifest_count(world: World) -> None:
    host = world.host_release
    manifest = json.loads((host / "RELEASE-MANIFEST.json").read_text())
    payload = [p for p in host.rglob("*") if p.is_file() and p.name not in ("RELEASE-SHA256SUMS", "RELEASE-MANIFEST.json")]
    manifest["file_count"] = len(payload)
    (host / "RELEASE-MANIFEST.json").write_text(json.dumps(manifest, sort_keys=True))


def test_a_modified_payload_with_stale_sums_is_refused_by_the_reviewed_release_guard(world: World) -> None:
    (world.host_release / "aegis_soc/cli.py").write_text("def restore():\n    return 'evil'\n")
    proc = world.run()
    assert proc.returncode == 1 and "RELEASE_GUARD_REFUSED:CHECKSUM_MISMATCH" in reason(proc)


@pytest.mark.parametrize("mutate,expected", [
    (lambda w: (w.host_release / "aegis_soc/cli.py").chmod(0o666), "RELEASE_PATH_NOT_TRUSTED"),                                 # group/world writable payload
    (lambda w: (w.host_release / "stray.txt").write_text("x"), "RELEASE_GUARD_REFUSED"),                                         # an unmanifested file
    (lambda w: (w.host_release / "aegis_soc/link.py").symlink_to("cli.py"), "RELEASE_PATH_NOT_TRUSTED"),                        # a symlink in the release
    (lambda w: os.mkfifo(w.host_release / "fifo"), "RELEASE_PATH_NOT_TRUSTED"),                                                  # a special file
    (lambda w: (w.host_release / "venv/bin/python").chmod(0o644), "INTERPRETER_NOT_A_TRUSTED_EXECUTABLE|RELEASE_GUARD_REFUSED"), # interpreter not executable
])
def test_untrusted_release_contents_are_refused(world: World, mutate, expected: str) -> None:
    mutate(world)
    proc = world.run()
    assert proc.returncode == 1 and re.search(expected, reason(proc)), reason(proc)


def test_a_group_or_world_writable_ancestor_of_the_release_is_refused(world: World) -> None:
    for directory in (world.root / "opt/aegis-idea3/releases", world.root / "opt/aegis-idea3", world.root / "opt"):
        directory.chmod(0o775)
        proc = world.run()
        assert proc.returncode == 1 and "RELEASE_PATH_NOT_TRUSTED" in reason(proc), directory
        directory.chmod(0o755)


def test_a_release_that_is_a_symlink_or_missing_or_noncanonical_is_refused(world: World) -> None:
    target = world.tmp / "elsewhere"
    world.host_release.rename(target)
    world.host_release.symlink_to(target)
    assert world.run(pin=False).returncode == 1
    world.host_release.unlink()
    assert world.run(pin=False).returncode == 1                                                                                   # missing entirely


def test_the_manifest_must_name_the_derived_release_and_source_commit(world: World) -> None:
    world.build_host(manifest_overrides={"source_git_sha": "1" * 40})
    proc = world.run()
    assert proc.returncode == 1 and "MANIFEST_SOURCE_COMMIT_NOT_THE_RELEASE_COMMIT" in reason(proc)
    world.build_host(manifest_overrides={"release_id": "other"})
    proc = world.run()
    assert proc.returncode == 1 and "MANIFEST_RELEASE_ID_MISMATCH" in reason(proc)
    world.build_host(manifest_overrides={"source_tree_dirty": True})
    assert "MANIFEST_SOURCE_TREE_DIRTY" in reason(world.run())


@pytest.mark.parametrize("how,expected", [("missing", "CURRENT_LINK_MISSING_OR_NOT_A_SYMLINK"), ("regular", "CURRENT_LINK_MISSING_OR_NOT_A_SYMLINK"), ("elsewhere", "CURRENT_LINK_NOT_THE_RELEASE")])
def test_the_current_link_must_be_exactly_this_release(world: World, how: str, expected: str) -> None:
    world.current.unlink()
    if how == "regular":
        world.current.write_text("x")
    elif how == "elsewhere":
        other = world.root / "opt/aegis-idea3/releases/other"
        other.mkdir()
        world.current.symlink_to(other)
    proc = world.run()
    assert proc.returncode == 1 and expected in reason(proc)


def test_the_release_must_be_the_one_the_receipt_names_not_a_look_alike_directory(world: World) -> None:
    decoy = world.root / "opt/aegis-idea3/releases" / ("a" * 40)
    shutil.copytree(world.host_release, decoy)
    shutil.rmtree(world.host_release)
    world.current.unlink()
    world.current.symlink_to(decoy)
    assert world.run(pin=False).returncode == 1


# ═════════════════════════════════════════════ the trusted RRu receipt authority ═════════════════════════════════════════════
def _set_receipt(world: World, edit) -> None:
    world.receipt.write_text(edit(world.receipt.read_text()))
    world.commit_main()


def test_a_missing_or_duplicated_canonical_closeout_is_refused(world: World) -> None:
    second = world.receipt.with_name("2026-10-09_000000_music_idea3-rru-live-closeout.md")
    second.write_text(world.receipt.read_text())
    world.commit_main()
    proc = world.run(host=False)
    assert proc.returncode == 1 and "RRU_CLOSEOUT_MISSING_OR_AMBIGUOUS" in reason(proc)
    second.unlink()
    world.receipt.unlink()
    world.commit_main()
    assert "RRU_CLOSEOUT_MISSING_OR_AMBIGUOUS" in reason(world.run(host=False))


def test_a_release_claim_repeated_in_another_receipt_is_ambiguous(world: World) -> None:
    other = world.receipt.parent / "2026-10-08_999999_music_idea3-other.md"
    other.write_text("- `RRU_RESULT=PASS`\n")
    world.commit_main()
    assert "RRU_FIELD_NOT_ONLY_IN_THE_CANONICAL_CLOSEOUT:RRU_RESULT" in reason(world.run(host=False))


def test_a_second_or_different_release_id_anywhere_is_ambiguous(world: World) -> None:
    other = world.receipt.parent / "2026-10-08_999999_music_idea3-other.md"
    other.write_text(f"- `RRU_RELEASE_ID={'b' * 40}`\n")
    world.commit_main()
    assert "RELEASE_ID_NOT_UNIQUE" in reason(world.run(host=False))
    other.unlink()
    _set_receipt(world, lambda t: t + f"\n- `RRU_RELEASE_ID={'c' * 40}`\n")
    assert "RELEASE_ID_NOT_UNIQUE" in reason(world.run(host=False))


@pytest.mark.parametrize("claim", ["RECOVERY_R2_R8_EXECUTED=YES", "RECOVERY_RESULT=PASS", "LVR_PROVEN=YES", "RRU_RECOVERY_EXECUTED=YES", "F1_REAL_DETECTOR_ACCEPTANCE=PROVEN"])
def test_a_contradictory_claim_anywhere_makes_the_release_record_untrustworthy(world: World, claim: str) -> None:
    other = world.receipt.parent / "2026-10-08_999999_music_idea3-other.md"
    other.write_text(f"- `{claim}`\n")
    world.commit_main()
    proc = world.run(host=False)
    assert proc.returncode == 1 and "CONTRADICTORY_CLAIM" in reason(proc)


@pytest.mark.parametrize("old,new", [("RRU_RERUN_ALLOWED=NO", "RRU_RERUN_ALLOWED=YES"), ("RRU_ATTEMPT_CONSUMED=YES", "RRU_ATTEMPT_CONSUMED=NO"), ("RRU_RESULT=PASS", "RRU_RESULT=FAIL"),
                                     ("RECOVERY_RUNTIME_RELEASE_READY=YES", "RECOVERY_RUNTIME_RELEASE_READY=NO"), ("RECOVERY_ATTEMPT_CONSUMED=NO", "RECOVERY_ATTEMPT_CONSUMED=YES")])
def test_a_receipt_that_does_not_carry_the_required_values_is_refused(world: World, old: str, new: str) -> None:
    text = world.receipt.read_text()
    assert f"- `{old}`" in text
    _set_receipt(world, lambda t: t.replace(f"- `{old}`", f"- `{new}`", 1))
    proc = world.run(host=False)
    assert proc.returncode == 1 and re.search(r"RRU_FIELD_(NOT_ONLY_IN_THE_CANONICAL_CLOSEOUT|MISSING_FROM_THE_CANONICAL_CLOSEOUT)", reason(proc)), reason(proc)


def test_a_release_id_that_is_not_a_commit_or_not_an_ancestor_of_main_is_refused(world: World) -> None:
    _set_receipt(world, lambda t: t.replace(world.release, "d" * 40))
    assert "RELEASE_COMMIT_NOT_A_COMMIT_OBJECT" in reason(world.run(host=False))
    _set_receipt(world, lambda t: t.replace("d" * 40, "not-a-commit-id"))
    assert "RELEASE_ID_NOT_A_COMMIT_ID" in reason(world.run(host=False))
    # a real commit that is NOT an ancestor of main
    git(world.repo, "checkout", "-q", "--orphan", "side")
    (world.repo / "side.txt").write_text("x")
    git(world.repo, "add", "side.txt")
    git(world.repo, "commit", "-qm", "side")
    side = git(world.repo, "rev-parse", "HEAD")
    git(world.repo, "checkout", "-q", "-f", "master") if False else None
    branch = git(world.repo, "branch", "--list", "master", "main").replace("*", "").split()[0]
    git(world.repo, "checkout", "-q", "-f", branch)
    _set_receipt(world, lambda t: t.replace("not-a-commit-id", side))
    assert "RELEASE_COMMIT_NOT_AN_ANCESTOR_OF_MAIN" in reason(world.run(host=False))


def test_a_release_commit_missing_a_required_source_file_is_refused(tmp_path: Path) -> None:
    w = World(tmp_path)
    git(w.repo, "rm", "-q", "-f", "--cached", "IDEA3-AEGIS_Lockdown/aegis_soc/cli.py") if False else None
    # build a world whose release commit lacks cli.py
    t2 = tmp_path / "second"
    t2.mkdir()
    bad = World.__new__(World)
    bad.tmp = t2
    t2.chmod(0o700)
    bad.repo = t2 / "repo"
    bad.repo.mkdir()
    subprocess.run(["git", "-C", str(bad.repo), "init", "-q"], check=True)
    for name, text in AEGIS_FILES.items():
        if name != "cli.py":
            (bad.repo / "IDEA3-AEGIS_Lockdown/aegis_soc").mkdir(parents=True, exist_ok=True)
            (bad.repo / "IDEA3-AEGIS_Lockdown/aegis_soc" / name).write_text(text)
    git(bad.repo, "add", "-A")
    git(bad.repo, "commit", "-qm", "release source")
    bad.release = git(bad.repo, "rev-parse", "HEAD")
    bad.copy_authority(False)
    logs = bad.repo / LOGS_REL
    logs.mkdir(parents=True)
    bad.receipt = logs / "2026-10-07_005834_music_idea3-rru-live-closeout.md"
    bad.receipt.write_text(bad.minimal_receipt())
    bad.commit_main()
    bad.root = t2 / "root"
    bad.root.mkdir(mode=0o700)
    proc = bad.run(host=False)
    assert proc.returncode == 1 and "GIT_OBJECT_MISSING:IDEA3-AEGIS_Lockdown/aegis_soc/cli.py" in reason(proc)


# ═════════════════════════════════════════════ frozen-runner pins ═════════════════════════════════════════════
def test_a_frozen_runner_carrying_exactly_the_derived_pins_is_accepted(world: World) -> None:
    proc = world.run(pin=False, *("--frozen-runner", str(world.frozen_runner())))
    f = facts(proc)
    assert proc.returncode == 0, proc.stderr
    assert all(f[f"FROZEN_PIN_{name}"] == "MATCHES_THE_DERIVED_VALUE" for name in ("RELEASE_ID", "RESTORE_CLI_SHA256", "RECOVERY_CORE_SHA256", "PRODUCTION_DETECTOR_SHA256"))
    assert f["FROZEN_PIN_RELEASE_SUMS_SHA256"] == "OWNER_SUPPLIED_NOT_DERIVABLE_FROM_THE_REPOSITORY" and f["VERDICT"] == "PASS"


@pytest.mark.parametrize("name", ["RELEASE_ID", "RESTORE_CLI_SHA256", "RECOVERY_CORE_SHA256", "PRODUCTION_DETECTOR_SHA256"])
def test_a_frozen_pin_that_is_not_the_derived_value_is_an_invented_pin(world: World, name: str) -> None:
    wrong = "e" * 40 if name == "RELEASE_ID" else "e" * 64
    proc = world.run(pin=False, *("--frozen-runner", str(world.frozen_runner(**{name: wrong}))))
    assert proc.returncode == 1 and f"INVENTED_OR_STALE_PIN:{name}" in reason(proc)


def test_a_frozen_sums_pin_that_the_host_does_not_match_fails(world: World) -> None:
    proc = world.run(pin=False, *("--frozen-runner", str(world.frozen_runner(RELEASE_SUMS_SHA256="9" * 64))))
    assert proc.returncode == 1 and "RELEASE_SUMS_PIN_NOT_THE_HOST_MANIFEST" in reason(proc)


def test_a_frozen_runner_that_is_not_the_reviewed_template_or_names_another_main_is_refused(world: World) -> None:
    runner = world.frozen_runner()
    tampered = world.tmp / "tampered.sh"
    tampered.write_text(runner.read_text().replace("umask 077", "umask 022", 1))
    assert "FROZEN_RUNNER_NOT_THE_REVIEWED_TEMPLATE" in reason(world.run(pin=False, *("--frozen-runner", str(tampered))))
    assert world.run(pin=False, *("--frozen-runner", str(world.tmp / "absent.sh"))).returncode == 1
    unpinned = world.tmp / "unpinned.sh"
    unpinned.write_text((sup.P4 / "owner-run/run-recovery-owner.sh").read_text())
    assert world.run(pin=False, *("--frozen-runner", str(unpinned))).returncode == 1


def test_a_sums_pin_that_disagrees_with_the_frozen_runner_is_refused(world: World) -> None:
    proc = world.run(pin=False, *("--frozen-runner", str(world.frozen_runner()), "--release-sums-sha256", "a" * 64))
    assert proc.returncode == 1 and "RELEASE_SUMS_PIN_DISAGREES_WITH_THE_FROZEN_RUNNER" in reason(proc)


# ═════════════════════════════════════════════ tool authority, seams and side effects ═════════════════════════════════════════════
def test_a_tool_or_sibling_that_differs_from_the_pinned_main_blob_is_refused_before_it_is_loaded(world: World) -> None:
    marker = world.tmp / "EXECUTED"
    guard = world.repo / P4_REL / "p4-l7-release-guard.py"
    guard.write_text(guard.read_text().replace("from __future__ import annotations\n", f"from __future__ import annotations\nfrom pathlib import Path\nPath({str(marker)!r}).write_text('ran')\n", 1))
    proc = world.run()
    assert proc.returncode == 1 and "TOOL_FILE_DIFFERS_FROM_THE_PINNED_MAIN:guard" in reason(proc)
    assert not marker.exists()                                                  # the modified code was hashed, never executed
    for rel, key in (("recovery-acceptance/recovery_runner_freeze.py", "freeze"), ("recovery-acceptance/recovery_verifier_snapshot.py", "snapshot")):
        path = world.repo / P4_REL / rel
        original = path.read_text()
        path.write_text(original + "\n# local edit\n")
        assert f"TOOL_FILE_DIFFERS_FROM_THE_PINNED_MAIN:{key}" in reason(world.run())
        path.write_text(original)
    tool = world.tool()
    tool.write_text(tool.read_text() + "\n# local edit\n")
    assert "TOOL_FILE_DIFFERS_FROM_THE_PINNED_MAIN:self" in reason(world.run())


def test_a_group_writable_tool_is_refused(world: World) -> None:
    world.tool().chmod(0o664)
    assert "TOOL_FILE_GROUP_OR_WORLD_WRITABLE:self" in reason(world.run())


def test_the_pinned_main_must_be_the_repository_head_and_a_real_commit(world: World) -> None:
    assert "MAIN_MALFORMED" in reason(world.run(main="xyz"))
    assert "MAIN_NOT_A_COMMIT_OBJECT" in reason(world.run(main="1" * 40))
    (world.repo / "later.txt").write_text("x")
    git(world.repo, "add", "-A")
    git(world.repo, "commit", "-qm", "later")
    assert "REPO_HEAD_NOT_THE_PINNED_MAIN" in reason(world.run(main=world.main))


def test_a_replacement_object_cannot_change_what_the_proof_reads(world: World) -> None:
    good_blob = git(world.repo, "rev-parse", f"{world.release}:IDEA3-AEGIS_Lockdown/aegis_soc/cli.py")
    evil = subprocess.run(["git", "-C", str(world.repo), "hash-object", "-w", "--stdin"], input="def restore():\n    return 'evil'\n", capture_output=True, text=True, check=True).stdout.strip()
    git(world.repo, "replace", good_blob, evil)
    assert facts(world.run(host=False))["DERIVED_RESTORE_CLI_SHA256"] == world.derived["RESTORE_CLI_SHA256"]


def test_the_hermetic_seam_is_refused_without_the_test_environment_and_in_unsafe_places(world: World) -> None:
    assert "HERMETIC_REQUIRES_THE_TEST_ENVIRONMENT" in reason(subprocess.run(
        ["/usr/bin/python3", "-I", "-B", str(world.tool()), "--repo", str(world.repo), "--main", world.main, "--hermetic", "--test-root", str(world.root)], text=True, capture_output=True, env={"PATH": "/usr/bin:/bin"}))
    assert "TEST_SEAM_INCOMPLETE" in reason(world.run(hermetic=False, env={"RECOVERY_RELEASE_PROOF_TEST_ONLY": "YES"}, *("--test-root", str(world.root))))
    for unsafe in ("/", "/opt", "/etc", "/usr/lib", "/var/lib"):
        proc = subprocess.run(["/usr/bin/python3", "-I", "-B", str(world.tool()), "--repo", str(world.repo), "--main", world.main, "--hermetic", "--test-root", unsafe],
                              text=True, capture_output=True, env={"PATH": "/usr/bin:/bin", "RECOVERY_RELEASE_PROOF_TEST_ONLY": "YES"})
        assert proc.returncode == 1 and re.search(r"TEST_ROOT_(UNSAFE|INVALID)", reason(proc)), unsafe
    loose = world.tmp / "loose"
    loose.mkdir(mode=0o777)
    loose.chmod(0o777)
    proc = subprocess.run(["/usr/bin/python3", "-I", "-B", str(world.tool()), "--repo", str(world.repo), "--main", world.main, "--hermetic", "--test-root", str(loose)],
                          text=True, capture_output=True, env={"PATH": "/usr/bin:/bin", "RECOVERY_RELEASE_PROOF_TEST_ONLY": "YES"})
    assert "TEST_ROOT_NOT_PRIVATE" in reason(proc)


@pytest.mark.skipif(os.getuid() == 0, reason="needs a non-root caller")
def test_production_mode_refuses_the_host_proof_without_root_and_refuses_an_untrusted_checkout(world: World) -> None:
    assert "ROOT_REQUIRED_FOR_THE_HOST_PROOF" in reason(world.run(hermetic=False))
    proc = world.run(hermetic=False, host=False)
    assert proc.returncode == 1 and "TOOL_OR_REPOSITORY_AUTHORITY_NOT_TRUSTED" in reason(proc)       # a user-owned checkout is not root-trusted authority


def test_nothing_is_written_or_mutated_by_any_verdict(world: World) -> None:
    head = git(world.repo, "rev-parse", "HEAD")
    refs = git(world.repo, "for-each-ref")
    before = world.snapshot()
    runs = [world.run(), world.run(pin=False), world.run(host=False), world.run(pin=False, *("--release-sums-sha256", "0" * 64))]
    assert [r.returncode for r in runs] == [0, 3, 3, 1]
    assert world.snapshot() == before
    assert git(world.repo, "rev-parse", "HEAD") == head and git(world.repo, "for-each-ref") == refs and git(world.repo, "status", "--porcelain") == ""
    assert not list(world.repo.rglob("__pycache__"))


def test_the_tool_contains_no_mutating_or_executing_calls() -> None:
    code = "\n".join(line for line in TOOL_SRC.read_text().splitlines() if not line.lstrip().startswith("#"))
    for forbidden in (r"\.write_text\(", r"\.write_bytes\(", r"os\.(remove|unlink|rename|replace|chmod|chown|makedirs|mkdir|symlink|link)\(", r"shutil\.", r"subprocess\.(Popen|call|check_call|check_output)",
                      r"os\.system", r"\bsudo\b", r"systemctl", r"\bnft\b", r"mosquitto", r"open\([^)]*['\"][wa+]"):
        assert not re.search(forbidden, code), forbidden
    assert code.count("subprocess.run(") == 1 and '"git"' in code        # the only process it ever starts is git (read-only verbs)
    git_verbs = set(re.findall(r'git\(repo, "([a-z-]+)"', code)) | set(re.findall(r'git\(repo, "([a-z-]+)", ', code))
    assert git_verbs <= {"show", "ls-tree", "rev-parse", "cat-file", "merge-base"}


def test_the_tool_is_not_referenced_by_any_existing_gate_runner_or_freeze_tool() -> None:
    for existing in (sup.P4 / "p4-recovery-run-lib.sh", sup.P4 / "owner-run/run-recovery-owner.sh", sup.P4 / "recovery-acceptance/recovery_runner_freeze.py",
                     sup.P4 / "recovery-acceptance/recovery_verifier_snapshot.py", sup.P4 / "p4-r1bv-run-lib.sh", sup.P4 / "p4-rru-run-lib.sh"):
        assert "recovery_release_proof" not in existing.read_text(), existing


# ═════════════════════════════════════════════ agreement with the reviewed shell gate ═════════════════════════════════════════════
def test_the_derived_release_agrees_with_the_reviewed_rru_successor_gate(real_world: World) -> None:
    world = real_world
    lib = world.repo / P4_REL / "p4-r1bv-run-lib.sh"
    script = f'. "{lib}"; rru_recovery_successor_gate "{world.repo}" "{world.main}" "$1"; echo "rc=$?"'
    ok = subprocess.run(["env", "-i", "PATH=/usr/bin:/bin", "SUDO=", "bash", "--noprofile", "--norc", "-c", script, "_", world.release], text=True, capture_output=True)
    other = subprocess.run(["env", "-i", "PATH=/usr/bin:/bin", "SUDO=", "bash", "--noprofile", "--norc", "-c", script, "_", "f" * 40], text=True, capture_output=True)
    assert "rc=0" in ok.stdout, ok.stderr
    assert "rc=1" in other.stdout
    assert facts(world.run(host=False))["RELEASE_ID"] == world.release                                  # the proof derives the SAME release the reviewed gate accepts


def test_the_derivation_works_on_the_real_receipt_corpus_where_other_receipts_restate_fields(real_world: World) -> None:
    proc = real_world.run(host=False)
    assert proc.returncode == 3 and facts(proc)["RELEASE_ID"] == real_world.release, proc.stderr


def test_the_real_repository_history_derives_the_real_release() -> None:
    """Against the committed receipts of this very repository (no host, no mutation): the release the RRu closeout names is derived."""
    head = subprocess.run(["git", "-C", str(sup.ROOT.parent), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    if not REAL_LOGS.exists() or subprocess.run(["git", "-C", str(sup.ROOT.parent), "cat-file", "-e", REAL_RELEASE], capture_output=True).returncode != 0:
        pytest.skip("repository history not available")
    spec_mod = sup.load_tool(TOOL_SRC, "rrp_real_tool")
    report = spec_mod.Report()
    derived = spec_mod.derive(sup.ROOT.parent, head, report)
    assert derived["release_id"] == REAL_RELEASE
    for pin, rel in spec_mod.DERIVED_PINS:
        blob = subprocess.run(["git", "-C", str(sup.ROOT.parent), "show", f"{REAL_RELEASE}:IDEA3-AEGIS_Lockdown/aegis_soc/{rel}"], capture_output=True).stdout
        assert derived[pin] == sha(blob)


# ═════════════════════════════════════════════ mutation tests: weakening a security-critical path must make an adverse case pass ═════════════════════════════════════════════
def _mutated(tmp_path: Path, old: str, new: str) -> World:
    world = World(tmp_path)
    world.mutate_tool(old, new)
    return world


def test_mutation_without_uniqueness_a_duplicated_canonical_closeout_is_accepted(tmp_path: Path) -> None:
    weak = _mutated(tmp_path, '    if len(canonical) != 1:\n        raise ProofError("RRU_CLOSEOUT_MISSING_OR_AMBIGUOUS")\n    receipt = canonical[0]', "    receipt = sorted(canonical)[0]")
    weak.receipt.with_name("2026-10-09_000000_music_idea3-rru-live-closeout.md").write_text(weak.receipt.read_text())
    weak.commit_main()
    result = weak.run(host=False)
    assert "RRU_CLOSEOUT_MISSING_OR_AMBIGUOUS" not in reason(result)


def test_mutation_without_the_ancestor_check_a_foreign_commit_is_accepted(tmp_path: Path) -> None:
    weak = _mutated(tmp_path, '    if git(repo, "merge-base", "--is-ancestor", release_id, main, check=False).returncode != 0:\n        raise ProofError("RELEASE_COMMIT_NOT_AN_ANCESTOR_OF_MAIN")\n', "")
    git(weak.repo, "checkout", "-q", "--orphan", "side")
    (weak.repo / "IDEA3-AEGIS_Lockdown/aegis_soc").mkdir(parents=True, exist_ok=True)
    for name, text in AEGIS_FILES.items():
        (weak.repo / "IDEA3-AEGIS_Lockdown/aegis_soc" / name).write_text(text)
    git(weak.repo, "add", "-A")
    git(weak.repo, "commit", "-qm", "side")
    side = git(weak.repo, "rev-parse", "HEAD")
    branch = [b for b in git(weak.repo, "branch", "--format=%(refname:short)").split() if b != "side"][0]
    git(weak.repo, "checkout", "-q", "-f", branch)
    weak.receipt.write_text(weak.receipt.read_text().replace(weak.release, side))
    weak.commit_main()
    assert "RELEASE_COMMIT_NOT_AN_ANCESTOR_OF_MAIN" not in reason(weak.run(host=False))


def test_mutation_without_the_blob_equality_check_a_tampered_aegis_soc_entry_is_accepted(tmp_path: Path) -> None:
    weak = _mutated(tmp_path, '        if want != digest:\n            raise ProofError(f"RELEASE_CONTENT_NOT_THE_RELEASE_COMMIT_SOURCE:{rel}")\n', "")
    (weak.host_release / "aegis_soc/__init__.py").write_text("# tampered\n")
    _fix_manifest_count(weak)
    weak.reseal()
    weak.normalise_modes()
    assert "RELEASE_CONTENT_NOT_THE_RELEASE_COMMIT_SOURCE" not in reason(weak.run())


def test_mutation_without_the_host_cli_digest_check_a_substituted_cli_is_accepted(tmp_path: Path) -> None:
    weak = _mutated(tmp_path, '        if host_digest != derived[pin] or aegis[f"aegis_soc/{rel}"] != host_digest:\n            raise ProofError(f"HOST_FILE_NOT_THE_DERIVED_{pin}")\n', "")
    weak.mutate_tool('        if want != digest:\n            raise ProofError(f"RELEASE_CONTENT_NOT_THE_RELEASE_COMMIT_SOURCE:{rel}")\n', "")
    (weak.host_release / "aegis_soc/cli.py").write_text("def restore():\n    return 'substituted'\n")
    _fix_manifest_count(weak)
    weak.reseal()
    weak.normalise_modes()
    result = weak.run()
    assert "HOST_FILE_NOT_THE_DERIVED" not in reason(result) and result.returncode != 1


def test_mutation_without_the_sums_pin_comparison_a_wrong_pin_is_accepted(tmp_path: Path) -> None:
    weak = _mutated(tmp_path, '    if not SHA256.fullmatch(sums_pin) or sums_pin != observed:\n        raise ProofError("RELEASE_SUMS_PIN_NOT_THE_HOST_MANIFEST")\n', "")
    result = weak.run(pin=False, *("--release-sums-sha256", "0" * 64))
    assert result.returncode == 0                                              # the unmutated tool exits 1 (asserted above)


def test_mutation_without_the_current_link_check_a_stale_pointer_is_accepted(tmp_path: Path) -> None:
    weak = _mutated(tmp_path, '    if link_info.st_uid != owner_uid or os.readlink(current) != str(release):\n        raise ProofError("CURRENT_LINK_NOT_THE_RELEASE")\n', "")
    other = weak.root / "opt/aegis-idea3/releases/other"
    other.mkdir()
    weak.current.unlink()
    weak.current.symlink_to(other)
    assert "CURRENT_LINK_NOT_THE_RELEASE" not in reason(weak.run())


def test_mutation_without_the_frozen_pin_comparison_an_invented_pin_is_accepted(tmp_path: Path) -> None:
    weak = _mutated(tmp_path, '    if wrong:\n        raise ProofError("INVENTED_OR_STALE_PIN:" + ",".join(wrong))\n', "")
    result = weak.run(pin=False, *("--frozen-runner", str(weak.frozen_runner(RESTORE_CLI_SHA256="e" * 64))))
    assert "INVENTED_OR_STALE_PIN" not in reason(result)


def test_mutation_without_hash_before_load_a_modified_sibling_would_execute(tmp_path: Path) -> None:
    weak = _mutated(tmp_path, '    if path.is_symlink() or sha256_bytes(data) != sha256_bytes(git_blob(repo, main, rel)):\n        raise ProofError(f"TOOL_FILE_DIFFERS_FROM_THE_PINNED_MAIN:{key}")\n', "")
    marker = weak.tmp / "EXECUTED"
    guard = weak.repo / P4_REL / "p4-l7-release-guard.py"
    guard.write_text(guard.read_text().replace("from __future__ import annotations\n", f"from __future__ import annotations\nfrom pathlib import Path\nPath({str(marker)!r}).write_text('ran')\n", 1))
    weak.run(host=False)
    assert marker.exists()                                                      # proves the real hash-before-load test above is exercising the guard


def test_mutation_without_the_contradiction_check_a_contradictory_receipt_is_accepted(tmp_path: Path) -> None:
    weak = _mutated(tmp_path, '        if any(_field_re(name, value).search(text) for text in logs.values()):\n            raise ProofError(f"CONTRADICTORY_CLAIM:{name}")\n', "        pass\n")
    (weak.receipt.parent / "2026-10-08_999999_music_idea3-other.md").write_text("- `RECOVERY_R2_R8_EXECUTED=YES`\n")
    weak.commit_main()
    assert "CONTRADICTORY_CLAIM" not in reason(weak.run(host=False))
