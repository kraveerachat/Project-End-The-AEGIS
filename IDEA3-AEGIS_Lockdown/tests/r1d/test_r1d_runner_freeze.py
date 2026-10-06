"""M6: the frozen R1D runner is MECHANICALLY DERIVED from the reviewed template (exact EXPECTED_MAIN Git object, replacement objects disabled) plus ONLY the approved pin substitutions, and the frozen file is
protected (root-owned, not writable). The tool never creates an Authorization/K3 and nothing here runs a live runner."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest

import test_r1d_stage as base

TOOL_PATH = base.P4 / "r1d-acceptance/r1d_runner_freeze.py"
TEMPLATE_REL = "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-r1d-owner.sh"
SHA = {c: c * 64 for c in "abcdef"}

spec = spec_from_file_location("r1d_runner_freeze", TOOL_PATH)
tool = module_from_spec(spec)
sys.modules["r1d_runner_freeze"] = tool
spec.loader.exec_module(tool)


def pins_for(main: str, **override: str) -> dict[str, str]:
    pins = {
        "EXPECTED_MAIN": main, "OPERATOR_USER": "owner", "OPERATOR_UID": "1000", "RELEASE_ID": base.RELEASE, "PRODUCTION_DETECTOR_SHA256": SHA["a"], "DETECTOR_UNIT_SHA256": SHA["b"],
        "RECOVERY_CORE_SHA256": SHA["c"], "CONTROL_SNAPSHOT_DIR": "/opt/x/control", "CONTROL_MANIFEST_SHA256": SHA["d"], "VERIFIER_SNAPSHOT_DIR": "/opt/x/verifier",
        "VERIFIER_MANIFEST_SHA256": SHA["e"], "R1I_TOOL_SHA256": SHA["f"], "AUDIT_DB": "/var/lib/x/audit.db", "DETECTOR_UID": "948", "BINDING_SHA256": "7" * 64,
        "REPO": "/srv/worktree", "PY": "/usr/bin/python3", "EVIDENCE_ROOT": "/srv/evidence",
    }
    pins.update(override)
    return pins


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], text=True, capture_output=True, check=True).stdout.strip()


def make_repo(tmp_path: Path, template: str | None = None) -> tuple[Path, str]:
    repo = tmp_path / "repo"
    target = repo / TEMPLATE_REL
    target.parent.mkdir(parents=True)
    target.write_text(template if template is not None else base.RUNNER.read_text())
    git(repo, "init", "-q")
    git(repo, "config", "user.email", "t@e.invalid")
    git(repo, "config", "user.name", "t")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "reviewed template")
    return repo, git(repo, "rev-parse", "HEAD")


def frozen_world(tmp_path: Path) -> tuple[Path, str, Path]:
    repo, main = make_repo(tmp_path)
    out = tmp_path / "frozen.sh"
    tool.freeze(repo, main, pins_for(main), out)
    return repo, main, out


def cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, str(TOOL_PATH), *args], text=True, capture_output=True)


# --- 1/2: legitimate pins freeze, and the output verifies against the template ---------------------------------------------------------------------


def test_legitimate_pins_freeze_and_the_output_is_the_template_plus_only_the_pin_sites(tmp_path: Path) -> None:
    repo, main = make_repo(tmp_path)
    out = tmp_path / "frozen.sh"
    results = tool.freeze(repo, main, pins_for(main), out)
    assert results["RUNNER_TEMPLATE_AUTHORITY"] == "PASS" and results["RUNNER_ONLY_APPROVED_PINS_CHANGED"] == "PASS"
    template = base.RUNNER.read_text().splitlines()
    frozen = out.read_text().splitlines()
    assert len(template) == len(frozen)
    changed = [i for i, (a, b) in enumerate(zip(template, frozen)) if a != b]
    assert len(changed) == len(tool.PIN_SPECS) == 18  # exactly one line per approved pin site, nothing else
    assert oct(out.stat().st_mode & 0o777) == "0o555"
    assert git(repo, "status", "--porcelain") == "" and (repo / TEMPLATE_REL).read_text() == base.RUNNER.read_text()  # the template is never modified
    again = tool.verify(repo, main, out, owner_uid=None)
    assert again["RUNNER_SHA256"] == hashlib.sha256(out.read_bytes()).hexdigest()  # the Authorization still names this exact digest
    assert "RUNNER_SHA256" in base.RUNNER.read_text()  # the template's Authorization SHA-256 binding is preserved
    assert out.read_text().count("SNAPSHOT_OWNER_UID=0") == 1 and out.read_text().count("SNAPSHOT_TRUST_ROOT=/\n") == 1
    syntax = subprocess.run(["bash", "-n", str(out)], capture_output=True, text=True)
    assert syntax.returncode == 0


def test_the_frozen_runner_is_a_refusing_runner_for_an_unpinned_value_only_not_for_pinned_ones(tmp_path: Path) -> None:
    repo, main, out = frozen_world(tmp_path)
    text = out.read_text()
    assert "PIN_" in text and text.count('PIN_*) echo "STOP: runner is not pinned') >= 1  # the refusal guards stay byte-identical to the template
    assert not re.search(r"^[A-Z0-9_]+=PIN_", text, re.M)  # no pin site is left unpinned


# --- 3-6: pin input is a strict allowlist -----------------------------------------------------------------------------------------------------------


def test_unknown_missing_and_duplicate_pins_are_refused(tmp_path: Path) -> None:
    repo, main = make_repo(tmp_path)
    good = pins_for(main)
    with pytest.raises(tool.FreezeError, match="UNKNOWN_PIN"):
        tool.load_pins(json.dumps({**good, "SNAPSHOT_OWNER_UID": "1000"}))  # an attempt to pin a gate constant
    with pytest.raises(tool.FreezeError, match="UNKNOWN_PIN"):
        tool.load_pins(json.dumps({**good, "EXTRA": "x"}))
    missing = dict(good)
    missing.pop("BINDING_SHA256")
    with pytest.raises(tool.FreezeError, match="MISSING_PIN"):
        tool.load_pins(json.dumps(missing))
    duplicate = json.dumps(good)[:-1] + ', "BINDING_SHA256": "' + "8" * 64 + '"}'
    with pytest.raises(tool.FreezeError, match="DUPLICATE_PIN"):
        tool.load_pins(duplicate)
    for bad in ("[]", "not json", json.dumps({**good, "BINDING_SHA256": 600})):
        with pytest.raises(tool.FreezeError):
            tool.load_pins(bad)
    assert tool.load_pins(json.dumps(good)) == good  # the legitimate set passes


INJECTIONS = ["x\nrm -rf /", "abc;rm -rf /", "$(id)", "`id`", 'a"b', "a b", "a'b", "a|b", "a&b", "/p/../../etc", "/p//q", "/p/", "PIN_X", "", "\ttab", "a\rb", "${HOME}", "x\\y"]


@pytest.mark.parametrize("name", sorted(tool.PIN_SPECS))
def test_no_pin_value_can_carry_newline_shell_code_or_a_placeholder(tmp_path: Path, name: str) -> None:
    repo, main = make_repo(tmp_path)
    for bad in INJECTIONS:
        pins = pins_for(main, **{name: bad})
        with pytest.raises(tool.FreezeError):
            tool.load_pins(json.dumps(pins))
    assert not (tmp_path / "frozen.sh").exists()


def test_the_tool_exposes_no_generic_search_and_replace_interface() -> None:
    text = TOOL_PATH.read_text()
    assert "--replace" not in text and "--sed" not in text and not re.search(r"\bsed\b", text) and "str.replace" not in text.replace("template.replace", "")
    parser_flags = set(re.findall(r'add_argument\("(--[a-z-]+)"', text))
    assert parser_flags == {"--repo", "--main", "--pins", "--out", "--root-owned", "--runner"}  # no --trust-root: the production trust root is the literal `/`


# --- 7-14: ANY non-pin byte change is detected -----------------------------------------------------------------------------------------------------


def mutate(path: Path, fn) -> None:
    path.chmod(0o644)
    path.write_text(fn(path.read_text()))
    path.chmod(0o555)


def assert_refused(repo: Path, main: str, out: Path, match: str = "NON_PIN_BYTES_DIFFER_FROM_THE_REVIEWED_TEMPLATE") -> None:
    with pytest.raises(tool.FreezeError, match=match):
        tool.verify(repo, main, out, owner_uid=None)


@pytest.mark.parametrize("label,fn", [
    ("owner uid constant", lambda t: t.replace("SNAPSHOT_OWNER_UID=0", "SNAPSHOT_OWNER_UID=1000", 1)),
    ("trust root constant", lambda t: t.replace("SNAPSHOT_TRUST_ROOT=/\n", "SNAPSHOT_TRUST_ROOT=/home\n", 1)),
    ("control_gate call deleted", lambda t: t.replace('control_gate || die "the control snapshot is not the frozen immutable authority; nothing was sourced, created or touched"\n', "", 1)),
    ("control_git_gate call deleted", lambda t: t.replace('control_git_gate || die "the control snapshot is not byte-identical to the pinned-main source; nothing was sourced, created or touched"\n', "", 1)),
    ("gates reordered", lambda t: re.sub(r'(control_gate \|\| die [^\n]*\n)(control_git_gate \|\| die [^\n]*\n)', r"\2\1", t, count=1)),
    ("line inserted before the first source", lambda t: t.replace('# shellcheck disable=SC1090\nsource "$LIB"', 'touch /tmp/pwned\n# shellcheck disable=SC1090\nsource "$LIB"', 1)),
    ("git wrapper modified", lambda t: t.replace('git() { GIT_NO_REPLACE_OBJECTS=1 command git "$@"; }', 'git() { command git "$@"; }', 1)),
    ("environment refusal list shortened", lambda t: t.replace(" AEGIS_P4_HANDLER_DIR", "", 1)),
    ("source location changed", lambda t: t.replace("LIB=$CTRL/p4-r1d-run-lib.sh", "LIB=/tmp/p4-r1d-run-lib.sh", 1)),
    ("no-retry marker logic bypassed", lambda t: t.replace('if r1d_run_attempt "$AUTH_DIR"; then', 'if true; then', 1)),
    ("claim boundary altered", lambda t: t.replace("F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "F1_REAL_DETECTOR_ACCEPTANCE=PROVEN", 1)),
    ("root execution path changed", lambda t: t.replace('bash "$STG/${2:-apply.sh}"', 'bash "/tmp/${2:-apply.sh}"', 1)),
    ("arbitrary extra line appended", lambda t: t + "\necho owned\n"),
    ("trailing whitespace", lambda t: t.replace("set -Eeuo pipefail\n", "set -Eeuo pipefail \n", 1)),
    ("comment edited", lambda t: t.replace("OWNER-RUN ONLY.", "OWNER-RUN ONLY!", 1)),
])
def test_any_change_outside_the_pin_sites_makes_verification_fail(tmp_path: Path, label: str, fn) -> None:
    repo, main, out = frozen_world(tmp_path)
    tool.verify(repo, main, out, owner_uid=None)  # baseline passes
    mutate(out, fn)
    assert out.read_text() != "" and subprocess.run(["bash", "-n", str(out)], capture_output=True).returncode in (0, 2)
    assert_refused(repo, main, out)


def test_a_runner_tampered_after_the_freeze_fails_verification_even_with_a_recomputed_self_hash(tmp_path: Path) -> None:
    repo, main, out = frozen_world(tmp_path)
    first = tool.verify(repo, main, out, owner_uid=None)["RUNNER_SHA256"]
    mutate(out, lambda t: t.replace("SNAPSHOT_OWNER_UID=0", "SNAPSHOT_OWNER_UID=1000", 1))
    new_self_hash = hashlib.sha256(out.read_bytes()).hexdigest()
    assert new_self_hash != first  # an Authorization naming the NEW self-hash would otherwise bless the altered runner
    assert_refused(repo, main, out)


def test_a_pin_site_that_became_ambiguous_is_refused(tmp_path: Path) -> None:
    repo, main, out = frozen_world(tmp_path)
    mutate(out, lambda t: t + "\nEXPECTED_MAIN=" + "0" * 40 + "\n")  # a second assignment of an approved pin
    with pytest.raises(tool.FreezeError, match="FROZEN_PIN_SITE_NOT_UNIQUE"):
        tool.verify(repo, main, out, owner_uid=None)


# --- 15/16: the template authority is the exact EXPECTED_MAIN Git object --------------------------------------------------------------------------


def test_wrong_expected_main_or_wrong_template_authority_fails(tmp_path: Path) -> None:
    repo, main = make_repo(tmp_path)
    out = tmp_path / "frozen.sh"
    with pytest.raises(tool.FreezeError, match="EXPECTED_MAIN_PIN_IS_NOT_THE_REVIEWED_MAIN"):
        tool.freeze(repo, main, pins_for("1" * 40), out)  # the pin names a different main than the authority commit
    assert not out.exists()
    tool.freeze(repo, main, pins_for(main), out)
    (repo / TEMPLATE_REL).write_text((repo / TEMPLATE_REL).read_text() + "\n# a later template revision\n")
    git(repo, "commit", "-aq", "-m", "template changed")
    later = git(repo, "rev-parse", "HEAD")
    with pytest.raises(tool.FreezeError, match="NON_PIN_BYTES_DIFFER|FROZEN_EXPECTED_MAIN_IS_NOT_THE_REVIEWED_MAIN"):
        tool.verify(repo, later, out, owner_uid=None)  # frozen from the OLD template: not the reviewed template of the later main
    with pytest.raises(tool.FreezeError, match="MAIN_NOT_A_COMMIT_OBJECT|GIT_READ_FAILED"):
        tool.verify(repo, "2" * 40, out, owner_uid=None)
    with pytest.raises(tool.FreezeError, match="MAIN_MALFORMED"):
        tool.read_template(repo, "HEAD")


def test_a_frozen_runner_pinned_to_a_different_main_than_the_reviewed_one_fails(tmp_path: Path) -> None:
    repo, main = make_repo(tmp_path)
    forged = tmp_path / "forged.sh"
    forged.write_text(tool.render(tool.read_template(repo, main), pins_for("1" * 40)))  # byte-equivalent to the template + pins, but EXPECTED_MAIN names another commit
    with pytest.raises(tool.FreezeError, match="FROZEN_EXPECTED_MAIN_IS_NOT_THE_REVIEWED_MAIN"):
        tool.verify(repo, main, forged, owner_uid=None)


def test_working_tree_bytes_are_never_the_template_authority(tmp_path: Path) -> None:
    repo, main = make_repo(tmp_path)
    (repo / TEMPLATE_REL).write_text("# an uncommitted, edited working-tree template\n" + (repo / TEMPLATE_REL).read_text())
    out = tmp_path / "frozen.sh"
    tool.freeze(repo, main, pins_for(main), out)
    assert "an uncommitted, edited working-tree template" not in out.read_text()  # the committed object, not the dirty file, was the authority


def test_git_replace_cannot_change_the_template_bytes(tmp_path: Path) -> None:
    repo, good = make_repo(tmp_path)
    good_template = (repo / TEMPLATE_REL).read_text()
    (repo / TEMPLATE_REL).write_text(good_template.replace("SNAPSHOT_OWNER_UID=0", "SNAPSHOT_OWNER_UID=1000", 1))
    git(repo, "commit", "-aq", "-m", "EVIL template")
    evil = git(repo, "rev-parse", "HEAD")
    git(repo, "checkout", "-q", good)
    git(repo, "replace", good, evil)  # GOOD's SHA now silently resolves to EVIL's bytes under plain Git
    assert "SNAPSHOT_OWNER_UID=1000" in git(repo, "show", f"{good}:{TEMPLATE_REL}")  # plain git is fooled ...
    assert tool.read_template(repo, good) == good_template  # ... the tool is not
    out = tmp_path / "frozen.sh"
    results = tool.freeze(repo, good, pins_for(good), out)
    assert "SNAPSHOT_OWNER_UID=0" in out.read_text() and "SNAPSHOT_OWNER_UID=1000" not in out.read_text() and results["RUNNER_TEMPLATE_AUTHORITY"] == "PASS"
    evil_frozen = tmp_path / "evil-frozen.sh"
    evil_frozen.write_text(tool.render(good_template.replace("SNAPSHOT_OWNER_UID=0", "SNAPSHOT_OWNER_UID=1000", 1), pins_for(good)))
    with pytest.raises(tool.FreezeError, match="NON_PIN_BYTES_DIFFER"):
        tool.verify(repo, good, evil_frozen, owner_uid=None)  # a runner built from the replaced (EVIL) bytes is refused
    env_attack = subprocess.run([sys.executable, str(TOOL_PATH), "verify", "--repo", str(repo), "--main", good, "--runner", str(evil_frozen)],
                                env={**os.environ, "GIT_NO_REPLACE_OBJECTS": "0", "GIT_DIR": str(tmp_path / "nowhere")}, text=True, capture_output=True)
    assert env_attack.returncode == 1 and "NON_PIN_BYTES_DIFFER" in env_attack.stderr  # the caller's GIT_* environment (replacement re-enabled, GIT_DIR redirected) is ignored


# --- 17: destination handling --------------------------------------------------------------------------------------------------------------------


def test_an_existing_destination_is_refused_and_left_untouched(tmp_path: Path) -> None:
    repo, main = make_repo(tmp_path)
    out = tmp_path / "frozen.sh"
    out.write_text("owner-kept\n")
    with pytest.raises(tool.FreezeError, match="DESTINATION_EXISTS"):
        tool.freeze(repo, main, pins_for(main), out)
    assert out.read_text() == "owner-kept\n"
    link = tmp_path / "link.sh"
    link.symlink_to(tmp_path / "elsewhere.sh")
    with pytest.raises(tool.FreezeError, match="DESTINATION_EXISTS"):
        tool.freeze(repo, main, pins_for(main), link)
    assert not (tmp_path / "elsewhere.sh").exists()  # a dangling symlink is not followed into creating a file


# --- 18: the production protection (root-owned, not writable, trusted ancestors) -----------------------------------------------------------------


needs_userns = base.needs_userns


def pins_file(tmp_path: Path, main: str) -> Path:
    path = tmp_path / "pins.json"
    path.write_text(json.dumps(pins_for(main)))
    return path


def tuserns(command: str, trust: Path) -> subprocess.CompletedProcess[str]:
    """Run inside a user namespace WITH the explicit TEST-ONLY trust seam (production has no such option and refuses the seam in the real root namespace)."""
    return base.userns_bash(f'export R1D_TEST_ONLY_RUNNER_TRUST_ENABLED=YES R1D_TEST_ONLY_RUNNER_TRUST_ROOT="{trust}"\n{command}')


def test_without_root_a_root_owned_freeze_is_refused_and_a_plain_freeze_does_not_claim_protection(tmp_path: Path) -> None:
    repo, main = make_repo(tmp_path)
    refused = cli("freeze", "--repo", str(repo), "--main", main, "--pins", str(pins_file(tmp_path, main)), "--out", str(tmp_path / "a.sh"), "--root-owned")
    assert refused.returncode == 1 and "ROOT_REQUIRED_FOR_ROOT_OWNED_RUNNER" in refused.stderr and not (tmp_path / "a.sh").exists()
    plain = cli("freeze", "--repo", str(repo), "--main", main, "--pins", str(pins_file(tmp_path, main)), "--out", str(tmp_path / "b.sh"))
    assert plain.returncode == 0 and not re.search(r"^RUNNER_(ROOT_OWNED|NONWRITABLE)=", plain.stdout, re.M) and "NOT proven" in plain.stdout
    strict = cli("verify", "--repo", str(repo), "--main", main, "--runner", str(tmp_path / "b.sh"))
    assert strict.returncode == 1 and "RUNNER_NOT_ROOT_OWNED" in strict.stderr  # the CLI verify has no way to skip the production proof


@needs_userns
def test_the_root_owned_freeze_and_verify_print_the_four_owner_results_and_the_sha(tmp_path: Path) -> None:
    repo, main = make_repo(tmp_path)
    out = tmp_path / "frozen.sh"
    frozen = tuserns(f'python3 -I -B "{base.authority_tools(tmp_path)}/r1d_runner_freeze.py" freeze --repo "{repo}" --main {main} --pins "{pins_file(tmp_path, main)}" --out "{out}" --root-owned', trust=tmp_path)
    assert frozen.returncode == 0, frozen.stderr
    for line in ("RUNNER_TEMPLATE_AUTHORITY=PASS", "RUNNER_ONLY_APPROVED_PINS_CHANGED=PASS", "RUNNER_ROOT_OWNED=PASS", "RUNNER_NONWRITABLE=PASS"):
        assert line in frozen.stdout, frozen.stdout
    sha = re.search(r"RUNNER_SHA256=([0-9a-f]{64})", frozen.stdout).group(1)
    assert sha == hashlib.sha256(out.read_bytes()).hexdigest()
    again = tuserns(f'python3 "{TOOL_PATH}" verify --repo "{repo}" --main {main} --runner "{out}"', trust=tmp_path)
    assert again.returncode == 0 and f"RUNNER_SHA256={sha}" in again.stdout
    assert out.stat().st_mode & 0o222 == 0


@needs_userns
@pytest.mark.parametrize("breach", ["writable_file", "group_writable_parent", "world_writable_parent", "symlinked_parent", "wrong_owner"])
def test_a_writable_or_untrusted_runner_location_fails_the_production_verify(tmp_path: Path, breach: str) -> None:
    repo, main = make_repo(tmp_path)
    trusted = tmp_path / "trusted"
    inner = trusted / "inner"
    inner.mkdir(parents=True)
    out = inner / "frozen.sh"
    ok = tuserns(f'python3 -I -B "{base.authority_tools(tmp_path)}/r1d_runner_freeze.py" freeze --repo "{repo}" --main {main} --pins "{pins_file(tmp_path, main)}" --out "{out}" --root-owned', trust=tmp_path)
    assert ok.returncode == 0, ok.stderr
    target = out
    if breach == "writable_file":
        out.chmod(0o644)
    elif breach == "group_writable_parent":
        inner.chmod(0o775)
    elif breach == "world_writable_parent":
        inner.chmod(0o777)
    elif breach == "symlinked_parent":
        real = tmp_path / "elsewhere"
        shutil.move(str(inner), str(real))
        inner.symlink_to(real)
        target = inner / "frozen.sh"
    verify_cmd = f'python3 "{TOOL_PATH}" verify --repo "{repo}" --main {main} --runner "{target}"'
    if breach == "wrong_owner":
        result = subprocess.run([sys.executable, str(TOOL_PATH), "verify", "--repo", str(repo), "--main", main, "--runner", str(target)], text=True, capture_output=True)
    else:
        result = tuserns(verify_cmd, trusted)
    assert result.returncode == 1 and ("RUNNER_" in result.stderr), (breach, result.stderr, result.stdout)


# --- static: the Authorization SHA-256 binding and the template's own gates are untouched by this task --------------------------------------------------


def test_the_authorization_runner_sha_binding_and_the_boot_order_are_still_in_the_template() -> None:
    text = base.RUNNER.read_text()
    assert 'grep -qF "$RUNNER_SHA256" "$AUTH_DIR/authorization-R1D.txt"' in text
    assert text.index("control_gate || die") < text.index("control_git_gate || die") < text.index('source "$LIB"')
    assert re.search(r"^SNAPSHOT_OWNER_UID=0$", text, re.M) and re.search(r"^SNAPSHOT_TRUST_ROOT=/$", text, re.M)


def test_the_freeze_tool_only_ever_writes_the_new_destination() -> None:
    code = "\n".join(line for line in TOOL_PATH.read_text().splitlines() if not line.lstrip().startswith("#"))
    assert code.count('open(out, "x"') == 1 and "os.O_EXCL" in code and "os.O_NOFOLLOW" in code and "dir_fd=parent_fd" in code
    assert not re.search(r"\b(unlink|rmtree|os\.remove|shutil\.move|os\.rename|os\.makedirs|mkdir)\b", code)  # never cleans up, never auto-creates a parent
    assert code.count("os.fchown") == 1 and "os.chown" not in code


# --- round 2 M6-A: a ROOT-OWNED freeze proves the destination path BEFORE it creates anything ----------------------------------------------------------


def root_freeze(repo: Path, main: str, tmp_path: Path, out: Path, trust: Path | None) -> subprocess.CompletedProcess[str]:
    cmd = f'python3 -I -B "{base.authority_tools(tmp_path)}/r1d_runner_freeze.py" freeze --repo "{repo}" --main {main} --pins "{pins_file(tmp_path, main)}" --out "{out}" --root-owned'
    return tuserns(cmd, tmp_path) if trust is not None else base.userns_bash(cmd)


def files_under(root: Path) -> list[str]:
    return sorted(str(p.relative_to(root)) for p in root.rglob("*") if p.is_file() or p.is_symlink())


@needs_userns
def test_a_symlinked_parent_is_refused_before_any_file_is_created_at_the_symlink_target(tmp_path: Path) -> None:
    repo, main = make_repo(tmp_path)
    trusted = tmp_path / "trusted"
    real_inner = trusted / "real"
    real_inner.mkdir(parents=True)
    (trusted / "link").symlink_to(real_inner)
    result = root_freeze(repo, main, tmp_path, trusted / "link" / "frozen.sh", trusted)
    assert result.returncode == 1 and "RUNNER_PARENT_MISSING_OR_SYMLINK" in result.stderr, result.stderr
    assert files_under(real_inner) == [] and not (real_inner / "frozen.sh").exists()  # nothing was created at the symlink target
    # a symlink further up the chain: the parent itself is a real directory but the PATH traverses a symlink
    (real_inner / "inner").mkdir()
    (trusted / "mid").symlink_to(real_inner)
    deep = root_freeze(repo, main, tmp_path, trusted / "mid" / "inner" / "frozen.sh", trusted)
    assert deep.returncode == 1 and "RUNNER_PARENT_NOT_TRUSTED" in deep.stderr and "NOT_CANONICAL" in deep.stderr, deep.stderr
    assert files_under(real_inner) == []


@needs_userns
def test_a_parent_owned_by_another_uid_is_refused_before_create(tmp_path: Path) -> None:
    """The destination gate itself (the tool/repo authority gates run first in the CLI): /usr/share is owned by the REAL root, so inside the user namespace it appears as another (nobody) uid."""
    target = Path("/usr/share/r1d-freeze-must-never-exist.sh")
    code = (f"import sys; sys.path.insert(0, '{base.authority_tools(tmp_path)}'); import r1d_runner_freeze as t; from pathlib import Path\n"
            f"try:\n    t._prewrite_path_proof(Path('{target}'))\nexcept t.FreezeError as e:\n    print('REFUSED', e)\n")
    result = tuserns(f'python3 -I -B -c "{code}"', Path("/usr/share"))
    assert "REFUSED RUNNER_PARENT_NOT_TRUSTED" in result.stdout and "NOT_TRUSTED_OWNER" in result.stdout, (result.stdout, result.stderr)
    assert not target.exists()


@needs_userns
@pytest.mark.parametrize("mode", [0o775, 0o777])
def test_a_group_or_world_writable_parent_is_refused_before_create(tmp_path: Path, mode: int) -> None:
    repo, main = make_repo(tmp_path)
    trusted = tmp_path / "trusted"
    inner = trusted / "inner"
    inner.mkdir(parents=True)
    inner.chmod(mode)
    result = root_freeze(repo, main, tmp_path, inner / "frozen.sh", trusted)
    assert result.returncode == 1 and "RUNNER_PARENT_NOT_TRUSTED" in result.stderr and "WRITABLE" in result.stderr, result.stderr
    assert files_under(trusted) == []


@needs_userns
def test_a_missing_parent_is_never_auto_created_and_an_existing_destination_is_never_touched(tmp_path: Path) -> None:
    repo, main = make_repo(tmp_path)
    trusted = tmp_path / "trusted"
    trusted.mkdir()
    missing = root_freeze(repo, main, tmp_path, trusted / "new-dir" / "frozen.sh", trusted)
    assert missing.returncode == 1 and "RUNNER_PARENT_MISSING_OR_SYMLINK" in missing.stderr and not (trusted / "new-dir").exists()
    existing = trusted / "frozen.sh"
    existing.write_text("owner-kept\n")
    before = existing.stat()
    kept = root_freeze(repo, main, tmp_path, existing, trusted)
    assert kept.returncode == 1 and "DESTINATION_EXISTS" in kept.stderr
    assert existing.read_text() == "owner-kept\n" and existing.stat().st_mtime_ns == before.st_mtime_ns and existing.stat().st_mode == before.st_mode
    dangling = trusted / "dangling.sh"
    dangling.symlink_to(trusted / "target-must-not-appear.sh")
    refused = root_freeze(repo, main, tmp_path, dangling, trusted)
    assert refused.returncode == 1 and "DESTINATION_EXISTS" in refused.stderr and not (trusted / "target-must-not-appear.sh").exists()


@needs_userns
def test_the_canonical_root_owned_parent_succeeds_and_the_full_verify_runs_after_creation(tmp_path: Path) -> None:
    repo, main = make_repo(tmp_path)
    trusted = tmp_path / "trusted"
    (trusted / "authority").mkdir(parents=True)
    out = trusted / "authority" / "frozen.sh"
    result = root_freeze(repo, main, tmp_path, out, trusted)
    assert result.returncode == 0, result.stderr
    for line in ("RUNNER_TEMPLATE_AUTHORITY=PASS", "RUNNER_ONLY_APPROVED_PINS_CHANGED=PASS", "RUNNER_ROOT_OWNED=PASS", "RUNNER_NONWRITABLE=PASS"):
        assert line in result.stdout
    assert out.stat().st_mode & 0o777 == 0o555
    code = "\n".join(line for line in TOOL_PATH.read_text().splitlines() if not line.lstrip().startswith("#"))
    assert code.index("_prewrite_path_proof(out)") < code.index("os.O_EXCL") < code.index("return verify(repo, main, out, owner_uid=0)")  # prove -> create -> verify


# --- round 2 M6-B: the production trust root is the literal `/`; a narrower one exists only as a guarded TEST seam ------------------------------------


def test_the_production_cli_has_no_trust_root_option(tmp_path: Path) -> None:
    repo, main = make_repo(tmp_path)
    full = {"freeze": ["--pins", str(pins_file(tmp_path, main)), "--out", str(tmp_path / "x.sh")], "verify": ["--runner", str(tmp_path / "x.sh")]}
    for command, extra in full.items():
        result = cli(command, "--repo", str(repo), "--main", main, *extra, "--trust-root", str(tmp_path))
        assert result.returncode == 2 and "unrecognized arguments: --trust-root" in result.stderr
        assert not (tmp_path / "x.sh").exists()


def test_the_default_trust_root_is_the_literal_slash_and_the_owner_commands_never_name_one(monkeypatch) -> None:
    for var in (tool.TEST_SEAM_ENABLED, tool.TEST_SEAM_ROOT):
        monkeypatch.delenv(var, raising=False)
    assert tool.trust_root() == "/"
    readme = (base.P4 / "README.md").read_text()
    section = readme[readme.index("## 19. Stages R1Du and R1D"):]
    assert "--trust-root" not in section  # the R1D owner workflow never names a trust-root option (the production trust root is the literal `/`)


def test_a_test_trust_root_without_the_enable_flag_or_half_set_is_refused(tmp_path: Path, monkeypatch) -> None:
    repo, main, out = frozen_world(tmp_path)
    monkeypatch.setenv(tool.TEST_SEAM_ROOT, str(tmp_path))
    monkeypatch.delenv(tool.TEST_SEAM_ENABLED, raising=False)
    with pytest.raises(tool.FreezeError, match="TEST_TRUST_SEAM_INCOMPLETE"):
        tool.trust_root()
    monkeypatch.setenv(tool.TEST_SEAM_ENABLED, "yes")  # not exactly YES
    with pytest.raises(tool.FreezeError, match="TEST_TRUST_SEAM_INCOMPLETE"):
        tool.trust_root()
    monkeypatch.setenv(tool.TEST_SEAM_ENABLED, "YES")
    monkeypatch.delenv(tool.TEST_SEAM_ROOT)
    with pytest.raises(tool.FreezeError, match="TEST_TRUST_SEAM_INCOMPLETE"):
        tool.trust_root()
    env = {**os.environ, tool.TEST_SEAM_ROOT: str(tmp_path)}
    env.pop(tool.TEST_SEAM_ENABLED, None)
    cli_run = subprocess.run([sys.executable, str(TOOL_PATH), "verify", "--repo", str(repo), "--main", main, "--runner", str(out)], env=env, text=True, capture_output=True)
    assert cli_run.returncode == 1 and "TEST_TRUST_SEAM_INCOMPLETE" in cli_run.stderr  # the live CLI never silently accepts a narrowed root


def test_the_test_seam_is_refused_in_the_real_root_namespace(tmp_path: Path) -> None:
    repo, main, out = frozen_world(tmp_path)
    env = {**os.environ, tool.TEST_SEAM_ENABLED: "YES", tool.TEST_SEAM_ROOT: str(tmp_path)}
    result = subprocess.run([sys.executable, str(TOOL_PATH), "verify", "--repo", str(repo), "--main", main, "--runner", str(out)], env=env, text=True, capture_output=True)
    assert result.returncode == 1 and "TEST_TRUST_SEAM_REFUSED_IN_THE_REAL_ROOT_NAMESPACE" in result.stderr  # a real (initial-namespace) caller cannot narrow the trust root
    assert tool._initial_user_namespace() is True


@needs_userns
def test_the_seam_works_only_inside_a_user_namespace_and_must_name_a_canonical_directory(tmp_path: Path) -> None:
    repo, main, out = frozen_world(tmp_path)
    inside = tuserns(f'python3 -c "import sys; sys.path.insert(0, \'{TOOL_PATH.parent}\'); import r1d_runner_freeze as t; print(t.trust_root(), t._initial_user_namespace())"', tmp_path)
    assert inside.returncode == 0 and inside.stdout.split() == [str(tmp_path), "False"], inside.stderr
    bad = tuserns(f'python3 -c "import sys; sys.path.insert(0, \'{TOOL_PATH.parent}\'); import r1d_runner_freeze as t; print(t.trust_root())"', Path("relative/dir"))
    assert bad.returncode != 0 and "TEST_TRUST_SEAM_ROOT_INVALID" in bad.stderr


@needs_userns
def test_a_live_root_owned_freeze_pins_the_trust_root_to_slash_and_creates_nothing_when_ancestors_are_untrusted(tmp_path: Path) -> None:
    repo, main = make_repo(tmp_path)
    trusted = tmp_path / "trusted"
    trusted.mkdir()
    out = trusted / "frozen.sh"
    result = root_freeze(repo, main, tmp_path, out, None)  # NO seam: the chain to `/` is checked, and `/tmp`, `/` are not uid 0 inside the namespace
    assert result.returncode == 1 and "PRIVILEGED_AUTHORITY_NOT_TRUSTED" in result.stderr, result.stderr  # the tool authority chain (/tmp, `/`) is refused before anything else
    assert not out.exists() and files_under(trusted) == []
    verify = base.userns_bash(f'python3 "{TOOL_PATH}" verify --repo "{repo}" --main {main} --runner "{out}"')
    assert verify.returncode == 1  # and verify has no way to stop earlier than `/` either
