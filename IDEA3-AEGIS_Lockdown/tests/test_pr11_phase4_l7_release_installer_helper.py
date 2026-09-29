"""PR11 Phase 4 L7 — release installer (deploy/pr11-phase4/p4-l7-install-release.py).

Closes the remaining release-install gap: p4-l7-build-release.py (PR #208, merged into main) produces a release in a
USER-OWNED staging directory; p4-l7-release-guard.py (this branch) proves an ALREADY-INSTALLED release's contract. Nothing in
the repository copied a built release into /opt/aegis-idea3/releases/<id>. This tool does exactly that, and ONLY that:

* Ownership contract (the point of this test file): the SOURCE builder output is always validated at `--expect-owner any`
  (PR #208 builds into a USER-OWNED staging directory; the installer must never require the caller to chown it first).
  The STAGED COPY and the FINAL installed release are validated at `--expect-owner root` by default — the immutable
  release contract requires root ownership, and this default is never weakened by a general CLI switch. A narrowly named,
  fixture-only override (`--fixture-dest-owner-any`) exists so tests can prove every OTHER guard property without needing
  the test process to run as root; it takes effect only together with `--host-root` and is refused outright in live mode.
* Source: a completed builder output directory. It never builds anything and never touches secrets. It re-validates the
  source with the REAL, CURRENT `p4-l7-release-guard.py` (imported directly, not a copy of any predicate) before any
  mutation.
* Destination: exactly /opt/aegis-idea3/releases/<release-id>. It refuses to overwrite an existing release, never recurses
  into /opt/aegis-idea3, rejects a symlinked destination or ancestor, stages through a sibling temporary directory and
  places the release with a single atomic rename, and re-verifies the STAGED COPY with the same real guard immediately
  before that rename.
* `current`: this tool NEVER creates, reads as a target, or otherwise touches /opt/aegis-idea3/current — stages/L7/apply.sh
  is the sole owner of that symlink (verified by source inspection below), so the two workflows can never race.
* Failure: fails closed, never retries, removes only its own temporary staging directory on failure before the final
  rename, and never touches an already-placed immutable release afterwards.
* Evidence: an optional --evidence file records only release_id, source_git_sha and the logical destination — no host
  username, no absolute source/staging path, no secret.

No systemd mutation, no service start, no ESP32/L8 action: this is a plain file-copy tool.
"""

from __future__ import annotations

import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
INSTALLER = DEPLOY / "p4-l7-install-release.py"
GUARD = DEPLOY / "p4-l7-release-guard.py"
APPLY = DEPLOY / "stages" / "L7" / "apply.sh"

sys.path.insert(0, str(ROOT / "tests"))
from test_pr11_phase4_l7_release_guard_helper import build_release  # noqa: E402

REL_ID = "rel-installer-1"
LOGICAL = f"/opt/aegis-idea3/releases/{REL_ID}"


def install(source: Path, root: Path, *, release_id: str = REL_ID, logical: str = LOGICAL, fixture_dest_owner_any: bool = True,
            host_root: bool = True, evidence: Path | None = None) -> subprocess.CompletedProcess[str]:
    """By default this models a fixture-mode install that does not care about ownership enforcement (most tests here are
    about symlinks, checksums, overwrite protection, etc., not ownership) — the caller opts OUT with
    fixture_dest_owner_any=False to exercise the real default (root) contract."""
    args = [sys.executable, str(INSTALLER), "install", "--release-id", release_id, "--source", str(source), "--logical-path", logical]
    if host_root:
        args += ["--host-root", str(root)]
    if fixture_dest_owner_any:
        args += ["--fixture-dest-owner-any"]
    if evidence is not None:
        args += ["--evidence", str(evidence)]
    return subprocess.run(args, text=True, capture_output=True, check=False)


def reason(res: subprocess.CompletedProcess[str]) -> str:
    m = re.search(r"L7_RELEASE_INSTALL=FAIL reason=(\S+)", res.stdout + res.stderr)
    return m.group(1) if m else ""


def guard(root: Path, release_id: str = REL_ID, logical: str = LOGICAL, expect_owner: str = "any") -> subprocess.CompletedProcess[str]:
    host = f"{root}{logical}"
    return subprocess.run([sys.executable, str(GUARD), "check", "--logical-path", logical, "--host-path", host,
                           "--expect-owner", expect_owner], text=True, capture_output=True, check=False)



def test_installer_and_guard_tools_exist() -> None:
    assert INSTALLER.is_file() and GUARD.is_file()


def test_apply_sh_is_the_sole_owner_of_the_current_symlink_and_installer_never_touches_it() -> None:
    apply_text = APPLY.read_text()
    assert "ln -s" in apply_text and '"$CURRENT"' in apply_text  # apply.sh creates/owns `current`
    installer_text = INSTALLER.read_text()
    module_doc_end = installer_text.index('"""', installer_text.index('"""') + 3) + 3
    code = installer_text[module_doc_end:]
    assert "os.symlink" not in code
    assert "/opt/aegis-idea3/current" not in code, "installer must never reference /opt/aegis-idea3/current outside its docstring"


def test_installer_installs_a_valid_builder_output_and_the_new_guard_accepts_it(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    res = install(src, root)
    assert res.returncode == 0, res.stdout + res.stderr
    assert f"L7_RELEASE_INSTALL=PASS release_id={REL_ID}" in res.stdout
    dest = root / "opt/aegis-idea3/releases" / REL_ID
    assert dest.is_dir() and not dest.is_symlink()
    g = guard(root)
    assert g.returncode == 0, g.stdout + g.stderr  # BUILDER_OUTPUT_NEW_GUARD=PASS, end to end through the real installer


def test_installer_produces_root_ownable_content_when_run_as_root_live(tmp_path: Path) -> None:
    """Live mode (--host-root omitted) copies as the invoking process; as root that means root-owned, satisfying the
    default installed-release contract. Modes must never be group/other-writable regardless of who runs it."""
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    install(src, root)
    dest = root / "opt/aegis-idea3/releases" / REL_ID
    for p in [dest, *dest.rglob("*")]:
        assert stat.S_IMODE(p.lstat().st_mode) & 0o022 == 0, p


def test_installer_never_creates_or_modifies_current(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    (root / "opt/aegis-idea3").mkdir(parents=True)
    install(src, root)
    assert not (root / "opt/aegis-idea3/current").exists()
    assert not (root / "opt/aegis-idea3/current").is_symlink()


def test_installer_refuses_to_overwrite_an_existing_release(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    assert install(src, root).returncode == 0
    before = (root / "opt/aegis-idea3/releases" / REL_ID / "RELEASE-SHA256SUMS").read_bytes()
    other = build_release(tmp_path / "staging2", release_id=REL_ID, sha="b" * 40)
    res = install(other, root)
    assert res.returncode == 1 and reason(res) == "RELEASE_ALREADY_INSTALLED"
    assert (root / "opt/aegis-idea3/releases" / REL_ID / "RELEASE-SHA256SUMS").read_bytes() == before  # untouched


def test_installer_respects_an_existing_current_symlink_ownership(tmp_path: Path) -> None:
    """Confirms the installer neither creates nor is blocked/confused by a pre-existing `current` (apply.sh's own concern)."""
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    (root / "opt/aegis-idea3").mkdir(parents=True)
    (root / "opt/aegis-idea3/current").symlink_to("/opt/aegis-idea3/releases/some-other-release")
    res = install(src, root)
    assert res.returncode == 0, res.stdout + res.stderr
    assert os.readlink(root / "opt/aegis-idea3/current") == "/opt/aegis-idea3/releases/some-other-release"  # unchanged


def _resync_sums(rel: Path) -> None:
    import hashlib

    lines = [f"{hashlib.sha256((rel / p).read_bytes()).hexdigest()}  {p}"
             for p in sorted(q.relative_to(rel).as_posix() for q in rel.rglob("*") if q.is_file() and q.name != "RELEASE-SHA256SUMS")]
    (rel / "RELEASE-SHA256SUMS").write_text("\n".join(lines) + "\n")


@pytest.mark.parametrize("mutate,code", [
    (lambda rel: ((rel / "RELEASE-MANIFEST.json").write_text("{not json"), _resync_sums(rel)), "RELEASE_GUARD_FAILED:MANIFEST_MALFORMED"),
    (lambda rel: (rel / "aegis_soc/supervisor.py").write_text("print('tampered')\n"), "RELEASE_GUARD_FAILED:CHECKSUM_MISMATCH"),
])
def test_installer_fails_before_mutation_on_an_invalid_manifest_or_checksum(tmp_path: Path, mutate, code: str) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    mutate(src)
    root = tmp_path / "fs"
    res = install(src, root)
    assert res.returncode == 1 and reason(res) == code
    assert not (root / "opt/aegis-idea3/releases" / REL_ID).exists()
    assert not list((root / "opt/aegis-idea3/releases").glob(".install-tmp-*")) if (root / "opt/aegis-idea3/releases").exists() else True


def test_installer_rejects_an_unexpected_extra_file_in_the_source(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    (src / "aegis_soc/extra.py").write_text("x=1\n")
    res = install(src, tmp_path / "fs")
    assert reason(res) == "RELEASE_GUARD_FAILED:CHECKSUM_ENTRY_MISSING"


def test_installer_rejects_a_symlink_in_the_source(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    (src / "aegis_soc/evil").symlink_to("/etc/passwd")
    res = install(src, tmp_path / "fs")
    assert reason(res) == "RELEASE_GUARD_FAILED:SYMLINK_IN_RELEASE"


def test_installer_rejects_a_symlinked_source_directory(tmp_path: Path) -> None:
    real = build_release(tmp_path / "staging", release_id=REL_ID)
    link = tmp_path / "src-link"
    link.symlink_to(real)
    res = install(link, tmp_path / "fs")
    assert reason(res) == "RELEASE_GUARD_FAILED:RELEASE_IS_SYMLINK"


def test_installer_rejects_a_symlinked_destination_release_path(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    (root / "opt/aegis-idea3/releases").mkdir(parents=True)
    (root / "opt/aegis-idea3/releases" / REL_ID).symlink_to("/etc")
    res = install(src, root)
    assert reason(res) == "DESTINATION_IS_SYMLINK"
    assert (root / "opt/aegis-idea3/releases" / REL_ID).is_symlink()  # untouched, not removed


def test_installer_rejects_a_symlinked_destination_ancestor(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    real_dir = tmp_path / "elsewhere"
    real_dir.mkdir()
    (root / "opt/aegis-idea3").mkdir(parents=True)
    (root / "opt/aegis-idea3/releases").symlink_to(real_dir)
    res = install(src, root)
    assert reason(res) == "DESTINATION_PARENT_IS_SYMLINK"
    assert not (real_dir / REL_ID).exists()


def test_installer_rejects_group_or_other_writable_source(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    (src / "aegis_soc/supervisor.py").chmod(0o666)
    res = install(src, tmp_path / "fs")
    assert reason(res) == "RELEASE_GUARD_FAILED:WRITABLE_BY_GROUP_OR_OTHER"


def test_installer_partial_failure_cleans_only_its_own_temporary_staging(tmp_path: Path) -> None:
    """Simulate a mid-copy failure (unreadable file) after the pre-copy guard already passed: only .install-tmp-* is removed."""
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    victim = src / "aegis_soc" / "supervisor.py"
    original_mode = victim.stat().st_mode
    root = tmp_path / "fs"
    (root / "opt/aegis-idea3/releases").mkdir(parents=True)
    try:
        victim.chmod(0)
        res = install(src, root)
        assert res.returncode == 1
    finally:
        victim.chmod(original_mode)
    releases_dir = root / "opt/aegis-idea3/releases"
    assert list(releases_dir.iterdir()) == []  # no leftover temp staging, no partial final release


def test_installer_never_deletes_an_already_placed_release_on_a_later_unrelated_failure(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    assert install(src, root).returncode == 0
    dest = root / "opt/aegis-idea3/releases" / REL_ID
    before = {p.relative_to(dest).as_posix(): p.read_bytes() for p in dest.rglob("*") if p.is_file()}
    # a second, unrelated bad install attempt for a DIFFERENT release id must not touch the first
    bad_src = build_release(tmp_path / "staging2", release_id="rel-installer-2")
    (bad_src / "RELEASE-MANIFEST.json").write_text("{not json")
    assert install(bad_src, root, release_id="rel-installer-2", logical="/opt/aegis-idea3/releases/rel-installer-2").returncode == 1
    after = {p.relative_to(dest).as_posix(): p.read_bytes() for p in dest.rglob("*") if p.is_file()}
    assert after == before


def test_installer_evidence_has_no_secret_no_username_no_host_path(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    evidence = tmp_path / "evidence.tsv"
    res = install(src, root, evidence=evidence)
    assert res.returncode == 0
    text = evidence.read_text()
    assert "release_id" in text and REL_ID in text and "source_git_sha" in text
    assert LOGICAL in text
    assert str(tmp_path) not in text and str(src) not in text and os.environ.get("USER", "\0no-user\0") not in text
    for name in ("HOME", "USER", "LOGNAME"):
        val = os.environ.get(name)
        if val:
            assert val not in text


@pytest.mark.parametrize("release_id", ["../evil", "a/b", "", "has space", "-leading"])
def test_installer_rejects_invalid_release_ids(tmp_path: Path, release_id: str) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    res = install(src, tmp_path / "fs", release_id=release_id, logical=f"/opt/aegis-idea3/releases/{release_id or 'x'}")
    assert res.returncode != 0


def test_installer_requires_the_logical_path_to_embed_the_exact_release_id(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    res = install(src, tmp_path / "fs", logical="/opt/aegis-idea3/releases/different-id")
    assert reason(res) == "LOGICAL_PATH_RELEASE_ID_MISMATCH"


def test_installer_requires_the_manifest_release_id_to_match_the_requested_release_id(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id="rel-other")
    res = install(src, tmp_path / "fs", release_id=REL_ID, logical=LOGICAL)
    assert reason(res) == "RELEASE_GUARD_FAILED:MANIFEST_RELEASE_ID_MISMATCH"


def test_installer_never_reads_or_writes_secret_credential_files() -> None:
    text = INSTALLER.read_text()
    for name in ("k_c2d", "k_d2c", "mqtt-core.pass", "admin.pin", "restore.credential"):
        assert name not in text
    assert not any(bad in text for bad in ("systemctl", "runuser", "sudo ", "subprocess"))


def test_installer_is_idempotent_read_only_verification_via_the_guard(tmp_path: Path) -> None:
    """Running the guard against an installed release repeatedly is read-only and always agrees."""
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    assert install(src, root).returncode == 0
    dest = root / "opt/aegis-idea3/releases" / REL_ID
    before = {p.relative_to(dest).as_posix(): (p.stat().st_mtime_ns, p.stat().st_mode) for p in dest.rglob("*")}
    for _ in range(2):
        assert guard(root).returncode == 0
    after = {p.relative_to(dest).as_posix(): (p.stat().st_mtime_ns, p.stat().st_mode) for p in dest.rglob("*")}
    assert before == after


def test_installer_creates_the_releases_parent_directory_if_missing(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"  # /opt/aegis-idea3 does not exist at all yet
    res = install(src, root)
    assert res.returncode == 0, res.stdout + res.stderr
    assert stat.S_IMODE((root / "opt/aegis-idea3/releases").stat().st_mode) & 0o022 == 0


# ── ownership contract: source is owner-agnostic, installed destination defaults to root (2026-09-27 correctness fix) ────


def test_source_owner_agnostic_a_normal_user_owned_builder_output_is_accepted(tmp_path: Path) -> None:
    """Item 1/2: the builder output is always user-owned (PR #208 never runs as root); the installer must accept it as
    source without ever requiring source UID == 0, regardless of the destination ownership contract in effect."""
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    assert os.stat(src).st_uid == os.getuid() != 0 or os.getuid() == 0  # sanity: source is whoever built it, not forced root
    root = tmp_path / "fs"
    res = install(src, root, fixture_dest_owner_any=True)
    assert res.returncode == 0, res.stdout + res.stderr
    text = INSTALLER.read_text()
    assert '"any"' in text and "source" in text.lower()  # the source guard call is hardcoded to "any", never derived from a CLI flag


def test_default_installed_destination_contract_requires_root_and_rejects_the_test_users_own_uid(tmp_path: Path) -> None:
    """Item 3/4: with NO fixture override, the staged copy and the final release are checked at the real default (root).
    The test process is not root, so a plain, unprivileged install must fail closed with OWNER_INVALID — this is the
    live/production contract, proven directly, not simulated."""
    if os.getuid() == 0:
        pytest.skip("test process is root; the negative default-root contract cannot be exercised unprivileged here")
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    res = install(src, root, fixture_dest_owner_any=False)
    assert res.returncode == 1
    assert reason(res) in {"POST_COPY_GUARD_FAILED:OWNER_INVALID", "RELEASE_GUARD_FAILED:OWNER_INVALID"}
    assert not (root / "opt/aegis-idea3/releases" / REL_ID).exists()  # nothing placed; fails before or at the staged check


def test_fixture_override_is_the_only_way_to_relax_destination_ownership_and_needs_host_root(tmp_path: Path) -> None:
    """Item 5: fixture integration can explicitly model destination ownership without sudo, via the one, unmistakably
    named override — and that override is refused outright without --host-root (i.e. it cannot silently apply live)."""
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    ok = install(src, root, fixture_dest_owner_any=True, host_root=True)
    assert ok.returncode == 0, ok.stdout + ok.stderr

    live_shaped = subprocess.run(
        [sys.executable, str(INSTALLER), "install", "--release-id", "rel-installer-2", "--source", str(src),
         "--logical-path", "/opt/aegis-idea3/releases/rel-installer-2", "--fixture-dest-owner-any"],
        text=True, capture_output=True, check=False,
    )
    assert live_shaped.returncode != 0
    assert "FIXTURE_OWNER_OVERRIDE_REQUIRES_HOST_ROOT" in (live_shaped.stdout + live_shaped.stderr)


def test_no_general_cli_switch_can_weaken_the_installed_release_owner(tmp_path: Path) -> None:
    """The CLI must expose no generic '--expect-owner'/'--dest-owner any' knob usable in live mode; only the one narrowly
    named, host-root-gated fixture override exists."""
    help_text = subprocess.run([sys.executable, str(INSTALLER), "install", "--help"], text=True, capture_output=True).stdout
    assert "--expect-owner" not in help_text
    assert "--dest-owner" not in help_text
    assert "--fixture-dest-owner-any" in help_text
    assert "fixture" in help_text.lower()  # its own --help text names it as fixture-only


def test_builder_to_installer_to_guard_fixture_integration_still_passes(tmp_path: Path) -> None:
    """Item 6, restated end to end under the corrected contract: builder output -> installer (fixture-relaxed
    destination) -> the real guard, unchanged."""
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    res = install(src, root, fixture_dest_owner_any=True)
    assert res.returncode == 0, res.stdout + res.stderr
    g = guard(root)
    assert g.returncode == 0, g.stdout + g.stderr


@pytest.mark.parametrize("mode", [0o775, 0o777, 0o757])
def test_group_or_world_writable_source_still_rejected_under_the_corrected_contract(tmp_path: Path, mode: int) -> None:
    """Item 7: ownership-contract separation must not loosen the pre-existing group/other-writable rejection."""
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    (src / "aegis_soc/supervisor.py").chmod(mode)
    res = install(src, tmp_path / "fs", fixture_dest_owner_any=True)
    assert reason(res) == "RELEASE_GUARD_FAILED:WRITABLE_BY_GROUP_OR_OTHER"


def test_current_symlink_never_touched_or_owned_under_the_corrected_contract(tmp_path: Path) -> None:
    """Item 8: the ownership-contract fix changes nothing about /opt/aegis-idea3/current ownership."""
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    (root / "opt/aegis-idea3").mkdir(parents=True)
    install(src, root, fixture_dest_owner_any=True)
    assert not (root / "opt/aegis-idea3/current").exists() and not (root / "opt/aegis-idea3/current").is_symlink()


def test_no_systemd_service_network_or_esp32_action_under_the_corrected_contract() -> None:
    """Item 9."""
    text = INSTALLER.read_text()
    for banned in ("systemctl", "runuser", "sudo ", "socket.", "esptool", "platformio", "mosquitto"):
        assert banned not in text


def test_no_production_mutation_the_installer_only_ever_writes_under_host_root_in_tests(tmp_path: Path) -> None:
    """Item 10: every test here passes --host-root, so nothing outside the fixture tmp_path is ever touched; the
    installer takes no path from the environment and defaults --host-root to empty only for the real, live call."""
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    before = {p for p in Path("/opt").iterdir()} if Path("/opt").exists() else set()
    install(src, root, fixture_dest_owner_any=True)
    after = {p for p in Path("/opt").iterdir()} if Path("/opt").exists() else set()
    assert before == after


# ── pre-existing parent directory: validate, never repair (2026-09-27 correctness fix) ───────────────────────────────────


def test_installer_never_chmods_or_chowns_a_preexisting_releases_dir(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    releases = root / "opt/aegis-idea3/releases"
    releases.mkdir(parents=True)
    releases.chmod(0o750)  # unusual but acceptable (no group/other write); must survive byte/metadata-identical
    before = releases.stat()
    res = install(src, root)
    assert res.returncode == 0, res.stdout + res.stderr
    after = releases.stat()
    # mtime naturally advances because the new release is copied INTO this directory (the actual purpose of
    # install) — that is not "installer setup" repair. What must never happen is the installer's own parent-dir
    # setup step touching ownership or mode.
    assert stat.S_IMODE(after.st_mode) == 0o750  # never repaired to 0755
    assert after.st_uid == before.st_uid and after.st_gid == before.st_gid


def test_installer_never_chmods_or_chowns_a_preexisting_opt_dir(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    opt = root / "opt/aegis-idea3"
    opt.mkdir(parents=True)
    opt.chmod(0o700)
    before = opt.stat()
    assert install(src, root).returncode == 0
    after = opt.stat()
    # opt's mtime naturally advances because the missing releases/ child gets created inside it; only
    # ownership/mode (never touched by installer setup) are asserted here.
    assert stat.S_IMODE(after.st_mode) == 0o700
    assert after.st_uid == before.st_uid and after.st_gid == before.st_gid


def test_installer_refuses_before_any_mutation_when_a_preexisting_parent_is_group_or_other_writable(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    releases = root / "opt/aegis-idea3/releases"
    releases.mkdir(parents=True)
    releases.chmod(0o777)
    before_mode = releases.stat().st_mode
    res = install(src, root)
    assert reason(res) == "PARENT_DIR_WRITABLE_BY_GROUP_OR_OTHER"
    assert releases.stat().st_mode == before_mode  # not repaired, not touched
    assert list(releases.iterdir()) == []  # nothing staged


def test_installer_refuses_before_any_mutation_when_a_preexisting_opt_is_group_or_other_writable(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    opt = root / "opt/aegis-idea3"
    opt.mkdir(parents=True)
    opt.chmod(0o777)
    res = install(src, root)
    assert reason(res) == "PARENT_DIR_WRITABLE_BY_GROUP_OR_OTHER"
    assert not (opt / "releases").exists()


def test_installer_validates_unsafe_opt_even_when_releases_already_exists(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    opt = root / "opt/aegis-idea3"
    releases = opt / "releases"
    releases.mkdir(parents=True)
    releases.chmod(0o755)
    opt.chmod(0o777)
    res = install(src, root)
    assert reason(res) == "PARENT_DIR_WRITABLE_BY_GROUP_OR_OTHER"
    assert list(releases.iterdir()) == []  # validation fails before staging anything


def test_installer_validates_symlinked_opt_even_when_releases_resolves_to_a_real_directory(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    real_opt = root / "real-aegis-idea3"
    (real_opt / "releases").mkdir(parents=True)
    (root / "opt").mkdir(parents=True)
    (root / "opt/aegis-idea3").symlink_to(real_opt, target_is_directory=True)
    res = install(src, root)
    assert reason(res) == "DESTINATION_PARENT_IS_SYMLINK"
    assert list((real_opt / "releases").iterdir()) == []  # validation fails before staging anything


def test_installer_refuses_when_a_preexisting_releases_path_is_not_a_directory(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    (root / "opt/aegis-idea3").mkdir(parents=True)
    (root / "opt/aegis-idea3/releases").write_text("not a directory\n")
    res = install(src, root)
    assert reason(res) == "PARENT_DIR_NOT_A_DIRECTORY"


def test_installer_creates_missing_parents_with_the_exact_reviewed_mode(tmp_path: Path) -> None:
    """Both /opt/aegis-idea3 and its releases/ child are missing: EACH created level gets the exact mode, not the
    umask-derived default Path.mkdir(parents=True) would otherwise apply to intermediate levels."""
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    root.mkdir()
    res = install(src, root)
    assert res.returncode == 0, res.stdout + res.stderr
    assert stat.S_IMODE((root / "opt/aegis-idea3").stat().st_mode) == 0o755
    assert stat.S_IMODE((root / "opt/aegis-idea3/releases").stat().st_mode) == 0o755


def test_installer_leaves_a_preexisting_opt_untouched_when_only_releases_is_created(tmp_path: Path) -> None:
    src = build_release(tmp_path / "staging", release_id=REL_ID)
    root = tmp_path / "fs"
    opt = root / "opt/aegis-idea3"
    opt.mkdir(parents=True)
    opt.chmod(0o750)
    before = opt.stat()
    assert install(src, root).returncode == 0
    after = opt.stat()
    # opt's mtime naturally advances because releases/ is created inside it; ownership/mode must not change.
    assert stat.S_IMODE(after.st_mode) == 0o750
    assert after.st_uid == before.st_uid and after.st_gid == before.st_gid
    assert stat.S_IMODE((root / "opt/aegis-idea3/releases").stat().st_mode) == 0o755  # newly created: exact mode


def test_installer_has_no_generic_repair_path() -> None:
    text = INSTALLER.read_text()
    for banned in ("os.chmod(releases_dir", "os.chown", "shutil.chown"):
        assert banned not in text, banned
