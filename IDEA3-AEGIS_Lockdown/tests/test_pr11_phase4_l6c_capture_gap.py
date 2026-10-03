"""AEGIS IDEA3 PR11 Phase 4 — G-15 capture/compare coverage of `/opt/aegis-idea3/releases/<id>` (the L6c release-install
observability gap, 2026-09-27).

Before this fix, `p4-l0-capture.sh` recorded only `host.path./opt/aegis-idea3/current` (presence/target) and NOTHING about
the immutable release catalog under `/opt/aegis-idea3/releases/`. A PRE→POST comparison of a real L6c-style install could
therefore PASS with zero reported drift while a whole new release tree — or, worse, a byte-level mutation of an EXISTING
release — went completely unrecorded.

The fix: two new deterministic, non-secret, fixed capture keys (`host.path./opt/aegis-idea3`,
`host.path./opt/aegis-idea3/releases`) plus one new deterministic catalog key (`host.aegis_idea3.release_catalog`, value
`<id>:<tree-state sha256>` pairs, sorted, comma-joined — never file contents, never an individual path, never a
credential). The tree-state digest (p4-l6c-tree-digest.py, 2026-09-27) is computed over the release's ACTUAL current
filesystem entries (relative path, type, uid, gid, mode, and — for regular files — real byte content), never merely
over the release's own RELEASE-SHA256SUMS claim about itself: a payload byte edit, a chmod/chown, a directory-mode
change, an added/removed entry, or a symlink/special file are all detected even when RELEASE-SHA256SUMS itself is
never touched. A new, narrowly scoped, opt-in `ALLOW_L6C_RELEASE_FILE` (mirroring the existing `ALLOW_TRANSITIONS_FILE` /
`ALLOW_DYNAMIC_TRANSITIONS_FILE` pattern) names the ONE exact expected new release id for a run; the relational rule in
`p4-compare.sh` enforces, UNCONDITIONALLY and regardless of any allow file: every release id present in BEFORE must still
be present in AFTER with an IDENTICAL fingerprint, or the change is NEW_OR_WORSENED_DRIFT — never a silently approved
key-level pass. The allow file only ever approves the addition of the one named NEW id.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
CAPTURE = DEPLOY / "p4-l0-capture.sh"
COMPARE = DEPLOY / "p4-compare.sh"

sys.path.insert(0, str(ROOT / "tests"))
from test_pr11_phase4_g15_host_artifacts import make_bundle  # noqa: E402
from test_pr11_phase4_l7_release_guard_helper import build_release  # noqa: E402

RELEASE_CATALOG_KEY = "host.aegis_idea3.release_catalog"
TREE_DIGEST = DEPLOY / "p4-l6c-tree-digest.py"


def sums_hash(release_dir: Path) -> str:
    return hashlib.sha256((release_dir / "RELEASE-SHA256SUMS").read_bytes()).hexdigest()


def tree_hash(release_dir: Path) -> str:
    """The independent oracle for the new fingerprint: invokes the real, shipped p4-l6c-tree-digest.py exactly as
    p4-l0-capture.sh does, over the actual current filesystem state of release_dir."""
    res = subprocess.run([sys.executable, str(TREE_DIGEST), str(release_dir)], text=True, capture_output=True, check=False)
    assert res.returncode == 0 and res.stdout.strip() != "UNREADABLE", res.stdout + res.stderr
    return res.stdout.strip()


def capture(root: Path, evid: Path, label: str) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "AEGIS_P4_FS_ROOT": str(root), "EVID_DIR": str(evid), "CAPTURE_LABEL": label,
           "JOURNAL_SINCE": "2026-09-27 00:00:00 UTC"}
    return subprocess.run(["bash", str(CAPTURE)], text=True, capture_output=True, check=False, env=env)


def read_tsv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in path.read_text().splitlines():
        k, _, v = line.partition("\t")
        out[k] = v
    return out


def install_release(root: Path, release_id: str, tmp_path: Path, *, tag: str = "") -> Path:
    src = build_release(tmp_path / f"staging-{release_id}{tag}", release_id=release_id)
    dest = root / "opt/aegis-idea3/releases" / release_id
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dest)
    return dest


def compare(before: Path, after: Path, *, allow_release_file: Path | None = None, allow_keys_file: Path | None = None) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ, DISK_THRESHOLD_PCT="90")
    if allow_release_file is not None:
        env["ALLOW_L6C_RELEASE_FILE"] = str(allow_release_file)
    if allow_keys_file is not None:
        env["ALLOW_KEYS_FILE"] = str(allow_keys_file)
    return subprocess.run(["bash", str(COMPARE), str(before), str(after)], text=True, capture_output=True, env=env, check=False)


def release_drift(res: subprocess.CompletedProcess[str]) -> list[tuple[str, str]]:
    """(code, key) of every NEW_OR_WORSENED_DRIFT finding that concerns the L6c release surface (the two parent-directory
    host.path keys and the release catalog). The real capture also reads the live test host, so unrelated drift (e.g. an
    ephemeral UDP listener appearing between PRE and POST) can legitimately add findings elsewhere; the L6c proofs must be
    decided by the release surface alone. Production capture/compare semantics are deliberately NOT narrowed."""
    out = []
    for line in res.stdout.splitlines():
        f = line.split("\t")
        if len(f) >= 4 and f[0] == "FINDING" and f[1] == "NEW_OR_WORSENED_DRIFT" and (
                f[3].startswith("host.path./opt/aegis-idea3") or f[3].startswith(RELEASE_CATALOG_KEY)):
            out.append((f[2], f[3]))
    return out


def release_allow_file(tmp_path: Path, release_id: str, *, name: str = "allow-release.txt") -> Path:
    f = tmp_path / name
    f.write_text(f"stage L6c\nrelease_id {release_id}\n")
    return f


# ── 1. capture: two new deterministic host.path keys + the release-catalog fingerprint key ──────────────────────────────


def test_capture_records_opt_and_releases_dir_presence(tmp_path: Path) -> None:
    root = tmp_path / "fs"
    (root / "etc/aegis-idea3").mkdir(parents=True)
    evid = tmp_path / "evid"
    assert capture(root, evid, "pre").returncode in (0, 3)
    host = read_tsv(evid / "host.tsv")
    assert host["host.path./opt/aegis-idea3"] == "absent"
    assert host["host.path./opt/aegis-idea3/releases"] == "absent"


def test_capture_release_catalog_absent_when_no_releases_dir(tmp_path: Path) -> None:
    root = tmp_path / "fs"
    (root / "etc/aegis-idea3").mkdir(parents=True)
    evid = tmp_path / "evid"
    assert capture(root, evid, "pre").returncode in (0, 3)
    host = read_tsv(evid / "host.tsv")
    assert host[RELEASE_CATALOG_KEY] == "absent"


def test_capture_release_catalog_empty_when_releases_dir_exists_but_empty(tmp_path: Path) -> None:
    root = tmp_path / "fs"
    (root / "etc/aegis-idea3").mkdir(parents=True)
    (root / "opt/aegis-idea3/releases").mkdir(parents=True)
    evid = tmp_path / "evid"
    assert capture(root, evid, "pre").returncode in (0, 3)
    host = read_tsv(evid / "host.tsv")
    assert host["host.path./opt/aegis-idea3"] == "present"
    assert host["host.path./opt/aegis-idea3/releases"] == "present"
    assert host[RELEASE_CATALOG_KEY] == "<empty>"


def test_capture_release_catalog_records_id_and_content_fingerprint_never_file_contents(tmp_path: Path) -> None:
    root = tmp_path / "fs"
    (root / "etc/aegis-idea3").mkdir(parents=True)
    dest = install_release(root, "rel-a", tmp_path)
    evid = tmp_path / "evid"
    res = capture(root, evid, "post")
    assert res.returncode in (0, 3), res.stdout + res.stderr
    host = read_tsv(evid / "host.tsv")
    fingerprint = tree_hash(dest)
    assert host[RELEASE_CATALOG_KEY] == f"rel-a:{fingerprint}"
    # never the raw payload, never a filename beyond the release id itself, never any secret-shaped content
    for value in host.values():
        assert "supervisor.py" not in value and "aegis_soc" not in value


def test_capture_release_catalog_sorted_and_comma_joined_for_multiple_releases(tmp_path: Path) -> None:
    root = tmp_path / "fs"
    (root / "etc/aegis-idea3").mkdir(parents=True)
    b_dest = install_release(root, "rel-b", tmp_path)
    a_dest = install_release(root, "rel-a", tmp_path)
    evid = tmp_path / "evid"
    assert capture(root, evid, "post").returncode in (0, 3)
    host = read_tsv(evid / "host.tsv")
    assert host[RELEASE_CATALOG_KEY] == f"rel-a:{tree_hash(a_dest)},rel-b:{tree_hash(b_dest)}"


def test_capture_release_catalog_never_touches_current(tmp_path: Path) -> None:
    """The observability fix must not create, read as a target, or otherwise mutate /opt/aegis-idea3/current."""
    root = tmp_path / "fs"
    (root / "etc/aegis-idea3").mkdir(parents=True)
    (root / "opt/aegis-idea3").mkdir(parents=True)
    (root / "opt/aegis-idea3/current").symlink_to("/opt/aegis-idea3/releases/rel-a")
    evid = tmp_path / "evid"
    assert capture(root, evid, "post").returncode in (0, 3)
    assert os.readlink(root / "opt/aegis-idea3/current") == "/opt/aegis-idea3/releases/rel-a"


# ── 2. compare: the relational release-catalog rule, exercised through synthetic bundles (make_bundle) ──────────────────


def bundle(tmp_path: Path, label: str, catalog: str) -> Path:
    return make_bundle(tmp_path / f"bundle-{label}", label, {RELEASE_CATALOG_KEY: catalog})


def test_no_releases_before_one_release_after_needs_the_exact_allow_file(tmp_path: Path) -> None:
    before = bundle(tmp_path, "b", "absent")
    after = bundle(tmp_path, "a", "rel-a:" + "1" * 64)
    denied = compare(before, after)
    assert denied.returncode == 1 and "COMPARE_RESULT=FAIL" in denied.stdout and "RELEASE_UNAPPROVED_ADDITION" in denied.stdout
    ok = compare(before, after, allow_release_file=release_allow_file(tmp_path, "rel-a"))
    assert ok.returncode == 0, ok.stdout + ok.stderr
    assert "FINDINGS_NEW_OR_WORSENED_DRIFT=0" in ok.stdout and "L6C_RELEASE_INSTALLED" in ok.stdout


def test_existing_unrelated_release_unchanged_plus_one_new_release(tmp_path: Path) -> None:
    before = bundle(tmp_path, "b", "rel-a:" + "1" * 64)
    after = bundle(tmp_path, "a", "rel-a:" + "1" * 64 + ",rel-b:" + "2" * 64)
    denied = compare(before, after)
    assert denied.returncode == 1
    ok = compare(before, after, allow_release_file=release_allow_file(tmp_path, "rel-b"))
    assert ok.returncode == 0, ok.stdout + ok.stderr
    assert "FINDINGS_NEW_OR_WORSENED_DRIFT=0" in ok.stdout


def test_mutation_of_a_preexisting_release_is_never_silently_approved(tmp_path: Path) -> None:
    """Even a correctly-scoped allow file for a DIFFERENT new release must not launder a content mutation of rel-a."""
    before = bundle(tmp_path, "b", "rel-a:" + "1" * 64)
    after = bundle(tmp_path, "a", "rel-a:" + "9" * 64 + ",rel-b:" + "2" * 64)
    res = compare(before, after, allow_release_file=release_allow_file(tmp_path, "rel-b"))
    assert res.returncode == 1 and "RELEASE_CONTENT_DRIFT" in res.stdout
    # and with no allow file at all, both differences are refused
    res2 = compare(before, after)
    assert res2.returncode == 1 and "RELEASE_CONTENT_DRIFT" in res2.stdout


def test_release_removal_is_never_silently_approved(tmp_path: Path) -> None:
    before = bundle(tmp_path, "b", "rel-a:" + "1" * 64 + ",rel-b:" + "2" * 64)
    after = bundle(tmp_path, "a", "rel-a:" + "1" * 64)
    res = compare(before, after, allow_release_file=release_allow_file(tmp_path, "rel-b"))
    assert res.returncode == 1 and "RELEASE_REMOVED" in res.stdout


def test_current_symlink_change_still_fails(tmp_path: Path) -> None:
    before = make_bundle(tmp_path / "b2", "b", {"host.symlink./opt/aegis-idea3/current.target": "/opt/aegis-idea3/releases/rel-a"})
    after = make_bundle(tmp_path / "a2", "a", {"host.symlink./opt/aegis-idea3/current.target": "/opt/aegis-idea3/releases/rel-b"})
    res = compare(before, after)
    assert res.returncode == 1 and "IDEA3_HOST_PATH_DRIFT" in res.stdout


def test_pre_rb_exact_restoration_passes_with_no_allowances(tmp_path: Path) -> None:
    before = bundle(tmp_path, "b", "rel-a:" + "1" * 64)
    rb = bundle(tmp_path, "rb", "rel-a:" + "1" * 64)
    res = compare(before, rb)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "FINDINGS_NEW_OR_WORSENED_DRIFT=0" in res.stdout and "FINDINGS_APPROVED_CHANGE=0" in res.stdout


def test_pre_rb_residual_new_release_fails_with_no_allowances(tmp_path: Path) -> None:
    """If rollback leaves the newly installed release behind, PRE->RB with zero allow files must fail."""
    before = bundle(tmp_path, "b", "rel-a:" + "1" * 64)
    rb = bundle(tmp_path, "rb", "rel-a:" + "1" * 64 + ",rel-b:" + "2" * 64)
    res = compare(before, rb)
    assert res.returncode == 1 and "RELEASE_UNAPPROVED_ADDITION" in res.stdout


def test_unrelated_opt_drift_fails(tmp_path: Path) -> None:
    before = make_bundle(tmp_path / "b3", "b", {"host.path./opt/aegis-idea3": "absent"})
    after = make_bundle(tmp_path / "a3", "a", {"host.path./opt/aegis-idea3": "present"})
    res = compare(before, after)
    assert res.returncode == 1 and "IDEA3_HOST_PATH_DRIFT" in res.stdout


@pytest.mark.parametrize("line", ["stage L7\nrelease_id rel-a\n", "release_id rel-a\n", "stage L6c\n",
                                  "stage L6c\nrelease_id ../evil\n", "stage L6c\nrelease_id rel-a\nrelease_id rel-b\n",
                                  "stage L6c\nstage L6c\nrelease_id rel-a\n"])
def test_allow_l6c_release_file_is_strict(tmp_path: Path, line: str) -> None:
    before = bundle(tmp_path, "b", "absent")
    after = bundle(tmp_path, "a", "rel-a:" + "1" * 64)
    f = tmp_path / "bad-allow.txt"
    f.write_text(line)
    res = compare(before, after, allow_release_file=f)
    assert res.returncode == 2 and "STOP" in res.stdout


# ── 3. end-to-end: real capture + real compare, no synthetic bundles ─────────────────────────────────────────────────────


def test_real_end_to_end_capture_then_compare_requires_the_allow_file(tmp_path: Path) -> None:
    root = tmp_path / "fs"
    (root / "etc/aegis-idea3").mkdir(parents=True)
    pre = tmp_path / "pre"
    assert capture(root, pre, "pre").returncode in (0, 3)
    install_release(root, "rel-a", tmp_path)
    post = tmp_path / "post"
    assert capture(root, post, "post").returncode in (0, 3)
    denied = compare(pre, post)
    assert denied.returncode == 1 and "COMPARE_RESULT=FAIL" in denied.stdout
    assert ("RELEASE_UNAPPROVED_ADDITION", f"{RELEASE_CATALOG_KEY}#rel-a") in release_drift(denied)
    # a real L6c apply also creates the two parent-directory host.path keys it had to create (see design L6C_MUTATION_BOUNDARY)
    keys = tmp_path / "allow-keys.txt"
    keys.write_text("host.path./opt/aegis-idea3\nhost.path./opt/aegis-idea3/releases\n")
    ok = compare(pre, post, allow_release_file=release_allow_file(tmp_path, "rel-a"), allow_keys_file=keys)
    # The release-specific proof is that NO drift finding remains on the release surface once the allow files are given.
    # The host-wide FINDINGS_NEW_OR_WORSENED_DRIFT total and COMPARE_RESULT are intentionally not asserted: the real capture
    # reads the live host (ephemeral UDP listeners, nft/boot_id need privileges this sandbox lacks), which made this flaky.
    assert release_drift(ok) == [], ok.stdout + ok.stderr
    assert "L6C_RELEASE_INSTALLED" in ok.stdout


def test_unrelated_host_listener_churn_cannot_decide_the_release_proof(tmp_path: Path) -> None:
    """Regression for the 2026-10-03 flake: a UDP listener that appears between PRE and POST is real host drift that the
    production compare MUST keep reporting, but it must not change the L6c release-surface verdict of this harness."""
    import socket

    root = tmp_path / "fs"
    (root / "etc/aegis-idea3").mkdir(parents=True)
    pre = tmp_path / "pre"
    assert capture(root, pre, "pre").returncode in (0, 3)
    install_release(root, "rel-a", tmp_path)
    keys = tmp_path / "allow-keys.txt"
    keys.write_text("host.path./opt/aegis-idea3\nhost.path./opt/aegis-idea3/releases\n")
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
        udp.bind(("0.0.0.0", 0))  # an unrelated ephemeral high-port UDP listener, alive only during the POST capture
        post = tmp_path / "post"
        assert capture(root, post, "post").returncode in (0, 3)
    denied = compare(pre, post)
    assert ("RELEASE_UNAPPROVED_ADDITION", f"{RELEASE_CATALOG_KEY}#rel-a") in release_drift(denied)
    ok = compare(pre, post, allow_release_file=release_allow_file(tmp_path, "rel-a"), allow_keys_file=keys)
    assert release_drift(ok) == [], ok.stdout + ok.stderr
    assert "L6C_RELEASE_INSTALLED" in ok.stdout


def test_real_end_to_end_content_mutation_of_an_existing_release_is_caught(tmp_path: Path) -> None:
    root = tmp_path / "fs"
    (root / "etc/aegis-idea3").mkdir(parents=True)
    dest = install_release(root, "rel-a", tmp_path)
    pre = tmp_path / "pre"
    assert capture(root, pre, "pre").returncode in (0, 3)
    (dest / "aegis_soc" / "supervisor.py").write_text("print('tampered')\n")
    (dest / "RELEASE-SHA256SUMS").write_text((dest / "RELEASE-SHA256SUMS").read_text() + "\n")  # a byte-level change is enough
    post = tmp_path / "post"
    assert capture(root, post, "post").returncode in (0, 3)
    res = compare(pre, post)
    assert res.returncode == 1 and "RELEASE_CONTENT_DRIFT" in res.stdout


# ── 4. tree-state digest: real drift detection WITHOUT ever touching RELEASE-SHA256SUMS (2026-09-27 correctness fix) ────
# The old fingerprint (sha256 of the release's own RELEASE-SHA256SUMS file) proved only that the sums file itself was
# unchanged. Every test below mutates the actual filesystem state and asserts the drift is caught while deliberately
# leaving RELEASE-SHA256SUMS byte-for-byte untouched — the exact gap the old algorithm could not see.


def pre_post(root: Path, tmp_path: Path) -> tuple[Path, Path]:
    pre = tmp_path / "pre"
    assert capture(root, pre, "pre").returncode in (0, 3)
    return pre, tmp_path / "post"


def test_real_capture_detects_a_payload_byte_modification_without_touching_the_sums_file(tmp_path: Path) -> None:
    root = tmp_path / "fs"
    (root / "etc/aegis-idea3").mkdir(parents=True)
    dest = install_release(root, "rel-a", tmp_path)
    pre, post = pre_post(root, tmp_path)
    sums_before = (dest / "RELEASE-SHA256SUMS").read_bytes()
    (dest / "aegis_soc" / "supervisor.py").write_text("print('tampered')\n")
    assert (dest / "RELEASE-SHA256SUMS").read_bytes() == sums_before  # never touched
    assert capture(root, post, "post").returncode in (0, 3)
    res = compare(pre, post)
    assert res.returncode == 1 and "RELEASE_CONTENT_DRIFT" in res.stdout


def test_real_capture_detects_a_chmod_of_an_existing_payload_file(tmp_path: Path) -> None:
    root = tmp_path / "fs"
    (root / "etc/aegis-idea3").mkdir(parents=True)
    dest = install_release(root, "rel-a", tmp_path)
    pre, post = pre_post(root, tmp_path)
    sums_before = (dest / "RELEASE-SHA256SUMS").read_bytes()
    (dest / "aegis_soc" / "supervisor.py").chmod(0o777)
    assert (dest / "RELEASE-SHA256SUMS").read_bytes() == sums_before
    assert capture(root, post, "post").returncode in (0, 3)
    res = compare(pre, post)
    assert res.returncode == 1 and "RELEASE_CONTENT_DRIFT" in res.stdout


def test_real_capture_detects_a_directory_mode_change(tmp_path: Path) -> None:
    root = tmp_path / "fs"
    (root / "etc/aegis-idea3").mkdir(parents=True)
    dest = install_release(root, "rel-a", tmp_path)
    pre, post = pre_post(root, tmp_path)
    sums_before = (dest / "RELEASE-SHA256SUMS").read_bytes()
    (dest / "aegis_soc").chmod(0o750)
    assert (dest / "RELEASE-SHA256SUMS").read_bytes() == sums_before
    assert capture(root, post, "post").returncode in (0, 3)
    res = compare(pre, post)
    assert res.returncode == 1 and "RELEASE_CONTENT_DRIFT" in res.stdout


def test_real_capture_detects_an_added_unexpected_file(tmp_path: Path) -> None:
    root = tmp_path / "fs"
    (root / "etc/aegis-idea3").mkdir(parents=True)
    dest = install_release(root, "rel-a", tmp_path)
    pre, post = pre_post(root, tmp_path)
    sums_before = (dest / "RELEASE-SHA256SUMS").read_bytes()
    (dest / "aegis_soc" / "unexpected.py").write_text("# planted\n")
    assert (dest / "RELEASE-SHA256SUMS").read_bytes() == sums_before
    assert capture(root, post, "post").returncode in (0, 3)
    res = compare(pre, post)
    assert res.returncode == 1 and "RELEASE_CONTENT_DRIFT" in res.stdout


def test_real_capture_detects_a_removed_payload_file(tmp_path: Path) -> None:
    root = tmp_path / "fs"
    (root / "etc/aegis-idea3").mkdir(parents=True)
    dest = install_release(root, "rel-a", tmp_path)
    pre, post = pre_post(root, tmp_path)
    sums_before = (dest / "RELEASE-SHA256SUMS").read_bytes()
    (dest / "requirements.txt").unlink()
    assert (dest / "RELEASE-SHA256SUMS").read_bytes() == sums_before
    assert capture(root, post, "post").returncode in (0, 3)
    res = compare(pre, post)
    assert res.returncode == 1 and "RELEASE_CONTENT_DRIFT" in res.stdout


def test_real_capture_detects_a_symlink_planted_inside_the_release(tmp_path: Path) -> None:
    root = tmp_path / "fs"
    (root / "etc/aegis-idea3").mkdir(parents=True)
    dest = install_release(root, "rel-a", tmp_path)
    pre, post = pre_post(root, tmp_path)
    sums_before = (dest / "RELEASE-SHA256SUMS").read_bytes()
    (dest / "planted-link").symlink_to("/etc/passwd")
    assert (dest / "RELEASE-SHA256SUMS").read_bytes() == sums_before
    assert capture(root, post, "post").returncode in (0, 3)
    res = compare(pre, post)
    assert res.returncode == 1 and "RELEASE_CONTENT_DRIFT" in res.stdout


def test_real_capture_detects_a_special_file_planted_inside_the_release(tmp_path: Path) -> None:
    root = tmp_path / "fs"
    (root / "etc/aegis-idea3").mkdir(parents=True)
    dest = install_release(root, "rel-a", tmp_path)
    pre, post = pre_post(root, tmp_path)
    sums_before = (dest / "RELEASE-SHA256SUMS").read_bytes()
    os.mkfifo(dest / "planted-fifo")
    assert (dest / "RELEASE-SHA256SUMS").read_bytes() == sums_before
    assert capture(root, post, "post").returncode in (0, 3)
    res = compare(pre, post)
    assert res.returncode == 1 and "RELEASE_CONTENT_DRIFT" in res.stdout


def release_catalog_findings(stdout: str) -> list[list[str]]:
    """Parse only the FINDING lines (FINDING\\tcls\\tcode\\tkey\\tbefore\\tafter) whose key is the release-catalog
    key, for either rel-a or rel-b. This test is a REAL end-to-end capture against the actual live host: unrelated
    live host state (an ephemeral listener opening/closing between the two capture snapshots, etc.) can legitimately
    change and must not be conflated with the release-catalog property this test exists to prove."""
    out = []
    for line in stdout.splitlines():
        parts = line.split("\t")
        if len(parts) == 6 and parts[0] == "FINDING" and parts[3].startswith("host.aegis_idea3.release_catalog"):
            out.append(parts)
    return out


def test_real_capture_unchanged_existing_release_plus_one_new_release_passes(tmp_path: Path) -> None:
    root = tmp_path / "fs"
    (root / "etc/aegis-idea3").mkdir(parents=True)
    a_dest = install_release(root, "rel-a", tmp_path)
    pre, post = pre_post(root, tmp_path)
    a_fingerprint = tree_hash(a_dest)
    install_release(root, "rel-b", tmp_path)  # the ONLY change: one new, named release added
    assert capture(root, post, "post").returncode in (0, 3)
    denied = compare(pre, post)
    assert denied.returncode == 1 and "RELEASE_UNAPPROVED_ADDITION" in denied.stdout

    ok = compare(pre, post, allow_release_file=release_allow_file(tmp_path, "rel-b"))
    findings = release_catalog_findings(ok.stdout)
    # exactly one release-catalog finding: rel-b approved as a new addition, before=<absent>
    assert len(findings) == 1, (findings, ok.stdout + ok.stderr)
    cls, code, key, before, after = findings[0][1:]
    assert (cls, code, key, before) == ("APPROVED_CHANGE", "L6C_RELEASE_INSTALLED",
                                         "host.aegis_idea3.release_catalog#rel-b", "<absent>")
    # rel-a's own release-catalog entry produced no finding at all (no drift, no re-approval needed)
    assert not any(f[3] == "host.aegis_idea3.release_catalog#rel-a" for f in findings)
    assert "RELEASE_CONTENT_DRIFT" not in ok.stdout and "RELEASE_REMOVED" not in ok.stdout
    # the approved rel-b entry carries the exact tree-state digest produced by the real install, and rel-a's own
    # fingerprint (computed independently, before rel-b was ever installed) is exactly what a fresh capture of it
    # right now still reports -- i.e. installing rel-b did not perturb rel-a's own release-catalog entry.
    host = read_tsv(post / "host.tsv")
    catalog = dict(pair.split(":", 1) for pair in host[RELEASE_CATALOG_KEY].split(","))
    assert catalog["rel-a"] == a_fingerprint
    assert catalog["rel-b"] == after


def test_real_capture_pre_to_rollback_restores_release_catalog_with_zero_allowance(tmp_path: Path) -> None:
    root = tmp_path / "fs"
    (root / "etc/aegis-idea3").mkdir(parents=True)
    install_release(root, "rel-a", tmp_path)
    pre, _ = pre_post(root, tmp_path)
    dest = install_release(root, "rel-b", tmp_path)
    mid = tmp_path / "mid"
    assert capture(root, mid, "mid").returncode in (0, 3)
    shutil.rmtree(dest)  # rollback: remove exactly the newly installed release, restoring the exact pre-state
    rb = tmp_path / "rb"
    assert capture(root, rb, "rb").returncode in (0, 3)
    res = compare(pre, rb)
    # Release-catalog-specific proof: PRE and RB are byte-for-byte identical at the catalog key, and the comparator
    # emits no finding of any class for that key without an allow file. Overall COMPARE_RESULT can still fail on this
    # real-host capture fixture when unrelated host state changes between snapshots (for example an ephemeral listener).
    assert read_tsv(pre / "host.tsv")[RELEASE_CATALOG_KEY] == read_tsv(rb / "host.tsv")[RELEASE_CATALOG_KEY]
    catalog_findings = [
        line
        for line in res.stdout.splitlines()
        if line.startswith("FINDING\t")
        and len(line.split("\t")) >= 4
        and line.split("\t")[3].partition("#")[0] == RELEASE_CATALOG_KEY
    ]
    assert catalog_findings == [], res.stdout + res.stderr


def load_tree_digest_module():
    import importlib.util

    spec = importlib.util.spec_from_file_location("p4_l6c_tree_digest", TREE_DIGEST)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def test_tree_digest_fails_closed_if_a_regular_file_becomes_a_symlink_after_scan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    mod = load_tree_digest_module()
    release = tmp_path / "release"
    release.mkdir()
    payload = release / "payload.bin"
    payload.write_bytes(b"reviewed release bytes")
    outside = tmp_path / "outside-secret"
    outside.write_bytes(b"must never be followed")
    real_scan = mod._scan

    def scan_then_swap(root: Path):
        entries = real_scan(root)
        payload.unlink()
        payload.symlink_to(outside)
        return entries

    monkeypatch.setattr(mod, "_scan", scan_then_swap)
    with pytest.raises(mod.Unreadable):
        mod.tree_state_digest(release)


def test_tree_digest_helper_is_sensitive_to_owner_uid_metadata_alone(tmp_path: Path) -> None:
    """Unit-tests the metadata serialization directly: an owner (uid) change with every other field held constant
    changes the digest input. This avoids a real chown while preserving the race check's honest opened-file metadata."""
    mod = load_tree_digest_module()
    f = tmp_path / "f.txt"
    f.write_bytes(b"hello")
    info = f.lstat()
    changed = os.stat_result((info.st_mode, info.st_ino, info.st_dev, info.st_nlink, info.st_uid + 1, info.st_gid,
                              info.st_size, info.st_atime, info.st_mtime, info.st_ctime))
    before = hashlib.sha256()
    after = hashlib.sha256()
    mod._update_entry_metadata(before, "f.txt", info, "f")
    mod._update_entry_metadata(after, "f.txt", changed, "f")
    assert before.digest() != after.digest()
