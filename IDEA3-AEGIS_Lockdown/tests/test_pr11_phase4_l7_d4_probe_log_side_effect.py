"""PR11 Phase 4 L7 — D4 restore-credential probes must never write into the caller's CWD.

Live incident (2026-09-29): a real L7 owner-run attempt failed with `L7_APPLY=FAIL reason=D4_CREDENTIAL_UNSAFE`.
Definitive reproduction traced it to an import side effect, not a real credential/permission problem:
`aegis_soc.local_restore` imports `aegis_soc.database` at module scope, and `database.py` creates a
`RotatingFileHandler(config.LOG_PATH, ...)` the moment it is imported. `config.LOG_PATH` falls back to the
relative path `"aegis_soc.log"` whenever `AEGIS_LOG_PATH` is unset and no systemd runtime path is available —
exactly the case for `apply.sh`'s two D4 probes, which import `aegis_soc.local_restore` directly via a bare
`"$PY" -`/`as_service "$SVC_PY" -` invocation outside the production systemd environment. In the live incident
this tried to create `aegis_soc.log` in a directory the invoking identity could not write to, raising a
`PermissionError` before `RestoreCredential.load()` was ever reached — masked as `D4_CREDENTIAL_UNSAFE` because
both probes redirect stdout+stderr to `/dev/null`.

These tests prove the fix (`AEGIS_LOG_PATH=/dev/null` passed explicitly to both probe subprocesses) without
weakening RestoreCredential's real security checks in any way: the fixture's restore.credential is valid, and
both probes still run the REAL `aegis_soc.local_restore.RestoreCredential.parse`/`.load` code, unmocked.

conftest.py sets AEGIS_LOG_PATH process-wide for the pytest run itself, so every test here explicitly removes
it via monkeypatch before calling Fx.run — Fx.env() copies os.environ at call time, so this reproduces the true
"no override present" condition the live incident hit, not just "the test didn't set it".
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from l7_support import APPLY, SECRETS, Fx, build


@pytest.fixture()
def fx(tmp_path: Path) -> Fx:
    return build(tmp_path)


def test_apply_d4_probes_never_create_a_stray_log_in_a_writable_cwd(fx: Fx, monkeypatch: pytest.MonkeyPatch) -> None:
    """The behavioral proof the mission asks for: run the REAL apply.sh from a dedicated, monitored, writable CWD with
    AEGIS_LOG_PATH genuinely unset, and prove no aegis_soc.log appears there. Before the fix this test is RED: the
    file appears. Apply must still succeed and the real D4 checks must still run."""
    monkeypatch.delenv("AEGIS_LOG_PATH", raising=False)
    cwd = fx.tmp / "monitored-cwd"
    cwd.mkdir()

    res = fx.run(APPLY, cwd=cwd)

    assert res.returncode == 0, res.stdout + res.stderr
    assert "L7_APPLY=PASS" in res.stdout
    assert not (cwd / "aegis_soc.log").exists(), "D4 probe wrote a stray log into the caller's CWD"
    assert list(cwd.iterdir()) == [], "D4 probes must leave the caller's CWD completely untouched"
    for secret in SECRETS:
        assert secret not in res.stdout + res.stderr


def test_apply_d4_probes_do_not_fail_from_an_unwritable_cwd(fx: Fx, monkeypatch: pytest.MonkeyPatch) -> None:
    """Faithfully reproduces the live failure mode: a CWD the invoking identity cannot write into. Before the fix,
    apply.sh fails closed here — RotatingFileHandler's open() raises PermissionError, which whichever probe hits it
    first masks as either RESTORE_CREDENTIAL_INVALID (the plain parse-format probe) or D4_CREDENTIAL_UNSAFE (the
    as_service load probe); this fixture's non-escalating "as_service" runs both as the same test-process identity,
    so it surfaces the FIRST probe's masked failure. After the fix, neither probe attempts to open anything relative
    to CWD, so an unwritable CWD is irrelevant and apply succeeds."""
    monkeypatch.delenv("AEGIS_LOG_PATH", raising=False)
    cwd = fx.tmp / "readonly-cwd"
    cwd.mkdir()
    cwd.chmod(0o500)  # r-x for the owner (this test process), matching the live incident's read-only-for-us directory
    try:
        res = fx.run(APPLY, cwd=cwd)
        assert res.returncode == 0, res.stdout + res.stderr
        assert "L7_APPLY=PASS" in res.stdout
        assert "D4_CREDENTIAL_UNSAFE" not in (res.stdout + res.stderr)
        assert "RESTORE_CREDENTIAL_INVALID" not in (res.stdout + res.stderr)
    finally:
        cwd.chmod(0o700)  # restore so pytest's tmp_path cleanup can remove it
