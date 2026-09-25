"""L5 live TrustedClock probes must be able to import aegis_soc from any working directory."""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
L5 = DEPLOY / "stages" / "L5"
SCRIPTS = ["apply.sh", "verify.sh", "rollback.sh"]
PATH_RE = re.compile(r"sys\.path\.insert\(0, '\$P4_HERE/([^']*)'\)")


def resolved_roots(name: str) -> list[Path]:
    text = (L5 / name).read_text()
    found = PATH_RE.findall(text)
    assert found, f"{name}: no sys.path.insert for the TrustedClock probe"
    # P4_HERE in the handlers is "$(cd stages/L5/../.. && pwd)" == deploy/pr11-phase4
    return [(DEPLOY / rel).resolve() for rel in found]


@pytest.mark.parametrize("name", SCRIPTS)
def test_trustedclock_probe_path_contains_aegis_soc(name: str) -> None:
    for root in resolved_roots(name):
        assert (root / "aegis_soc" / "trusted_time.py").is_file(), f"{name}: {root} has no aegis_soc/trusted_time.py"


@pytest.mark.parametrize("name", SCRIPTS)
def test_probe_import_works_from_foreign_cwd(name: str, tmp_path: Path) -> None:
    root = resolved_roots(name)[0]
    code = f"import sys; sys.path.insert(0, {str(root)!r}); from aegis_soc.trusted_time import TrustedClock, adjtimex_probe"
    r = subprocess.run([sys.executable, "-c", code], cwd=tmp_path, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


def test_apply_has_no_top_level_local() -> None:
    text = "\n".join(ln for ln in (L5 / "apply.sh").read_text().splitlines() if not ln.lstrip().startswith("#"))
    assert re.search(r"^\s*local substate\b", text, re.M) is None
