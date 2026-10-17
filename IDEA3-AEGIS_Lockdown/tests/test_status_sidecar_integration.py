"""Offline integration: synthetic Core status -> the BUILT sidecar publisher (a separate process from its own root) -> the Desktop reader.

Everything is disposable: temporary directories, a sidecar built from a throwaway git repo, no network, no broker, no Core.
A fixture is never a Production result; these tests prove fail-closed behaviour of the packaged code only.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import test_status_sidecar_release as rel_tests

from aegis_soc import observer as desktop_reader

GOOD = {
    "state": "RUNNING", "profile": "production", "dry_run": False, "auto_contain": False, "broker": "CONNECTED", "device": "ONLINE",
    "uplink": "NORMAL", "armed": "MONITOR_ONLY", "dispatch": "DISABLED", "time_trust": "SYNCED", "components": {"detector": "RUNNING"},
}
ENV = {"PATH": "/usr/bin:/bin"}


@pytest.fixture(scope="module")
def sidecar(tmp_path_factory):
    base = tmp_path_factory.mktemp("integration")
    return rel_tests.load().build_sidecar(rel_tests.make_repo(base), base / "staging", "integration-1")


@pytest.fixture()
def lanes(tmp_path):
    source_dir, out_dir = tmp_path / "core-run", tmp_path / "status-out"
    source_dir.mkdir(mode=0o700)
    out_dir.mkdir(mode=0o700)
    return source_dir / "status.json", out_dir


def write_status(path: Path, **overrides) -> None:
    path.write_text(json.dumps({**GOOD, "updated_at": time.time(), **overrides}))
    os.chmod(path, 0o600)


def publish(sidecar: Path, source: Path, out: Path) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-E", "-s", "-B", "-m", "tools.status_projection_publisher", "--source", str(source),
                           "--dest-dir", str(out), "--once"], cwd=sidecar, capture_output=True, text=True, env=ENV, check=False)


def projection(out: Path) -> dict:
    return json.loads((out / "status.projection.json").read_text())


def test_good_status_reaches_the_desktop_reader_with_the_core_timestamp(sidecar, lanes) -> None:
    source, out = lanes
    write_status(source)
    created = json.loads(source.read_text())["updated_at"]
    assert publish(sidecar, source, out).returncode == 0
    evidence = desktop_reader.read_observer_status(out / "status.projection.json")
    assert (evidence.valid, evidence.freshness, evidence.runtime_state) == (True, "FRESH", "RUNNING")
    assert float(evidence.evidence_timestamp) == created, "the Core's updated_at is preserved, never replaced by publish time"
    document = projection(out)
    assert document["provenance"]["freshness_basis"] == "source_updated_at" and document["provenance"]["physical_verification"] == "NOT_VERIFIED"
    assert "detail" not in json.dumps(document) and "pid" not in document


@pytest.mark.parametrize("overrides,status", [
    ({"state": "DEGRADED", "broker": "DISCONNECTED"}, "DEGRADED"),
    ({"state": "RUNNING", "broker": "DISCONNECTED"}, "DEGRADED"),
    ({"state": "DEGRADED", "device": "OFFLINE"}, "DEGRADED"),
    ({"state": "LOCKDOWN", "uplink": "LOCKDOWN"}, "DEGRADED"),
    ({"state": "RUNNING", "dispatch": "PAUSED_CREDENTIAL"}, "DEGRADED"),
    ({"state": "RUNNING", "components": {"detector": "FAILED"}}, "DEGRADED"),
    ({"state": "FAILED"}, "FAILED"),
    ({"state": "WAIT_BROKER", "broker": "UNKNOWN"}, "UNKNOWN"),
])
def test_degraded_cores_are_published_truthfully_and_never_as_healthy(sidecar, lanes, overrides, status) -> None:
    source, out = lanes
    write_status(source, **overrides)
    assert publish(sidecar, source, out).returncode == 0
    assert projection(out)["web_projection"]["status"] == status != "HEALTHY"
    assert desktop_reader.read_observer_status(out / "status.projection.json").valid is True


@pytest.mark.parametrize("name,prepare,reason", [
    ("missing", lambda p: None, "MISSING"),
    ("malformed", lambda p: p.write_text("{not json"), "INVALID"),
    ("empty", lambda p: p.write_text(""), "INVALID"),
    ("array", lambda p: p.write_text("[]"), "INVALID"),
    ("stale", lambda p: write_status(p, updated_at=time.time() - 3600), "STALE"),
    ("future", lambda p: write_status(p, updated_at=time.time() + 3600), "INVALID"),
    ("contradictory lockdown", lambda p: write_status(p, state="LOCKDOWN", uplink="NORMAL"), "CONTRADICTORY"),
    ("production dry-run", lambda p: write_status(p, dry_run=True), "CONTRADICTORY"),
    ("unknown vocabulary", lambda p: write_status(p, broker="PERFECT"), ""),
    ("oversized", lambda p: p.write_text(json.dumps({**GOOD, "updated_at": time.time(), "pad": "x" * 200_000})), ""),
])
def test_unusable_sources_publish_nothing(sidecar, lanes, name, prepare, reason) -> None:
    source, out = lanes
    prepare(source)
    result = publish(sidecar, source, out)
    assert result.returncode == 1 and reason in result.stderr, (name, result.stderr)
    assert not (out / "status.projection.json").exists()
    assert desktop_reader.read_observer_status(out / "status.projection.json").valid is False


@pytest.mark.skipif(os.geteuid() == 0, reason="root can read a mode-000 file")
def test_an_unreadable_source_publishes_nothing_and_does_not_fall_back_to_privilege(sidecar, lanes) -> None:
    source, out = lanes
    write_status(source)
    os.chmod(source, 0)
    result = publish(sidecar, source, out)
    assert result.returncode == 1 and not (out / "status.projection.json").exists()
    assert "sudo" not in result.stderr.lower()


def test_a_symlinked_source_is_refused(sidecar, lanes, tmp_path) -> None:
    source, out = lanes
    real = tmp_path / "elsewhere.json"
    write_status(real)
    source.symlink_to(real)
    assert publish(sidecar, source, out).returncode == 1 and not (out / "status.projection.json").exists()


def test_a_dead_core_makes_the_previous_projection_age_into_stale_not_healthy(sidecar, lanes) -> None:
    source, out = lanes
    write_status(source)
    assert publish(sidecar, source, out).returncode == 0
    later = time.time() + 600
    evidence = desktop_reader.read_observer_status(out / "status.projection.json", now=later)
    assert evidence.valid is False and evidence.freshness == "STALE"
    write_status(source, updated_at=time.time() - 600)
    again = publish(sidecar, source, out)
    assert again.returncode == 1 and "STALE" in again.stderr, "the publisher never refreshes an old Core document"


def test_publisher_restart_continues_with_newer_evidence_and_keeps_the_core_clock(sidecar, lanes) -> None:
    source, out = lanes
    write_status(source, updated_at=time.time() - 5)
    assert publish(sidecar, source, out).returncode == 0
    first = projection(out)
    time.sleep(0.05)
    write_status(source)
    assert publish(sidecar, source, out).returncode == 0
    second = projection(out)
    assert second["updated_at"] > first["updated_at"] and second["provenance"]["published_at"] >= first["provenance"]["published_at"]
    assert second["provenance"]["source_updated_at"] == second["updated_at"]


def test_publisher_failure_leaves_the_core_status_untouched_and_is_contained(sidecar, lanes, tmp_path) -> None:
    source, _out = lanes
    write_status(source)
    before = (source.read_bytes(), source.stat().st_mtime_ns, oct(source.stat().st_mode))
    result = publish(sidecar, source, tmp_path / "no-such-dir")
    assert result.returncode == 2
    assert (source.read_bytes(), source.stat().st_mtime_ns, oct(source.stat().st_mode)) == before
    protected = publish(sidecar, source, source.parent)
    assert protected.returncode == 2 and "Core status directory" in protected.stderr


def test_publisher_never_writes_into_the_sidecar_tree_or_leaves_temporaries(sidecar, lanes) -> None:
    source, out = lanes
    write_status(source)
    snapshot = sorted(p.relative_to(sidecar).as_posix() for p in sidecar.rglob("*"))
    assert publish(sidecar, source, out).returncode == 0
    assert sorted(p.relative_to(sidecar).as_posix() for p in sidecar.rglob("*")) == snapshot
    assert sorted(p.name for p in out.iterdir()) == ["status.projection.json"]
    assert oct(os.stat(out / "status.projection.json").st_mode & 0o777) == "0o600"


def test_a_tampered_sidecar_is_detected_before_it_could_be_installed(sidecar, tmp_path) -> None:
    builder = rel_tests.load()
    import shutil

    copy = tmp_path / sidecar.name
    shutil.copytree(sidecar, copy)
    target = copy / "tools" / "status_projection_publisher.py"
    os.chmod(target, 0o644)
    target.write_text(target.read_text().replace("MAX_OUTPUT_BYTES = 16 * 1024", "MAX_OUTPUT_BYTES = 16 * 1024 * 1024"))
    with pytest.raises(Exception, match="CHECKSUM_MISMATCH"):
        builder.verify_sidecar(copy, expect_owner="self")


def test_the_pusher_in_the_sidecar_is_inert_without_explicit_enablement(sidecar, lanes) -> None:
    source, _ = lanes
    write_status(source)
    env = {**ENV, "AEGIS_CORE_STATUS_PUSH_SOURCE": str(source), "AEGIS_CORE_STATUS_PUSH_BASE_URL": "https://127.0.0.1:1/x"}
    result = subprocess.run([sys.executable, "-E", "-s", "-B", "-m", "tools.status_push_client", "--once"], cwd=sidecar, capture_output=True,
                            text=True, env=env, timeout=20, check=False)
    assert result.returncode == 0 and "disabled" in result.stdout and "nothing was sent" in result.stdout


# ---- STEP 38.8: side effects of the units and the programs ----
def publish_with_umask(sidecar: Path, source: Path, out: Path, *extra: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-E", "-s", "-B", "-m", "tools.status_projection_publisher", "--source", str(source), "--dest-dir",
                           str(out), "--once", *extra], cwd=sidecar, capture_output=True, text=True, env=ENV, check=False,
                          preexec_fn=lambda: os.umask(0o077))  # the unit's UMask=0077


def test_umask_0077_does_not_break_the_group_readable_projection(sidecar, lanes) -> None:
    source, out = lanes
    write_status(source)
    os.chmod(out, 0o750)  # what RuntimeDirectoryMode=0750 gives
    result = publish_with_umask(sidecar, source, out, "--allow-group-readable-dir")
    assert result.returncode == 0, result.stderr
    assert oct(os.stat(out / "status.projection.json").st_mode & 0o777) == "0o640", "explicit fchmod, independent of the umask"
    assert oct(os.stat(out).st_mode & 0o777) == "0o750"


def test_without_the_owner_switch_the_projection_stays_private_under_the_same_umask(sidecar, lanes) -> None:
    source, out = lanes
    write_status(source)
    assert publish_with_umask(sidecar, source, out).returncode == 0
    assert oct(os.stat(out / "status.projection.json").st_mode & 0o777) == "0o600"
    os.chmod(out, 0o750)
    refused = publish_with_umask(sidecar, source, out)
    assert refused.returncode == 2 and "allow-group-readable-dir" in refused.stderr


def test_the_publisher_cannot_expose_the_private_core_status_file(sidecar, lanes, tmp_path) -> None:
    source, out = lanes
    write_status(source, detail="TOKEN-SHOULD-NEVER-LEAK", pid=4242, secret_path="/etc/shadow", extra={"password": "hunter2"})
    secret_before = (source.read_bytes(), oct(source.stat().st_mode), source.stat().st_mtime_ns)
    assert publish(sidecar, source, out).returncode == 0
    published = (out / "status.projection.json").read_text()
    for needle in ("TOKEN-SHOULD-NEVER-LEAK", "4242", "/etc/shadow", "hunter2", "password", str(source)):
        assert needle not in published, needle
    assert (source.read_bytes(), oct(source.stat().st_mode), source.stat().st_mtime_ns) == secret_before
    assert not os.stat(source).st_mode & 0o077


def test_a_planted_symlink_at_the_output_name_is_replaced_never_followed(sidecar, lanes, tmp_path) -> None:
    source, out = lanes
    write_status(source)
    victim = tmp_path / "victim.txt"
    victim.write_text("keep me")
    (out / "status.projection.json").symlink_to(victim)
    assert publish(sidecar, source, out).returncode == 0
    assert victim.read_text() == "keep me"
    assert not (out / "status.projection.json").is_symlink()
    link_dir = tmp_path / "linkdir"
    link_dir.symlink_to(out)
    refused = publish(sidecar, source, link_dir)
    assert refused.returncode == 2 and "symlink" in refused.stderr


def test_the_publisher_refuses_the_private_runtime_locations(sidecar, lanes) -> None:
    source, _ = lanes
    write_status(source)
    for forbidden in ("/run/aegis-idea3", "/var/lib/aegis-idea3", "/etc", "/opt/aegis-idea3-status"):
        result = publish(sidecar, source, Path(forbidden))
        assert result.returncode == 2, forbidden
    assert not Path("/opt/aegis-idea3-status").exists()


def test_the_pusher_is_disabled_by_default_in_the_shipped_environment_template() -> None:
    template = (rel_tests.ROOT / "deploy" / "aegis-idea3-status-push.env.example").read_text()
    active = [line for line in template.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    enabled = [line for line in active if line.startswith("AEGIS_CORE_STATUS_PUSH_ENABLED=")]
    assert enabled in ([], ["AEGIS_CORE_STATUS_PUSH_ENABLED=0"])
    for line in active:
        name, _, value = line.partition("=")
        if "KEY" in name or "CERT" in name or "CA_FILE" in name:
            assert value.startswith("/") and "BEGIN" not in value, line  # paths only, never key material


def test_the_sidecar_has_no_cut_restore_mqtt_or_device_identifiers(sidecar) -> None:
    import ast

    forbidden = {"publish", "issue_cut", "cut", "restore", "restore_request", "serial", "gpio", "subscribe", "mqtt", "relay", "esp32"}
    for rel in rel_tests.FILES:
        tree = ast.parse((sidecar / rel).read_text())
        names = {n.id.lower() for n in ast.walk(tree) if isinstance(n, ast.Name)} | {n.attr.lower() for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
        names |= {n.name.lower() for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.ClassDef))}
        assert not names & forbidden, (rel, names & forbidden)
