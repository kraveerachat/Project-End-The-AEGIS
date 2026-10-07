#!/usr/bin/env python3
"""CTv frozen-runner provenance helper; CTu Authorization/K3 is never reused."""
from __future__ import annotations
import hashlib
import re
from pathlib import Path

TEMPLATE_REL = "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctv-owner.sh"
PIN_RE = re.compile(r"^([A-Z0-9_]+)=(PIN_[A-Z0-9_]+)$", re.M)

def template_bytes(repo: Path, main: str) -> bytes:
    import subprocess
    return subprocess.check_output(["git", "-C", str(repo), "cat-file", "-p", f"{main}:{TEMPLATE_REL}"], env={"GIT_NO_REPLACE_OBJECTS":"1", "PATH":"/usr/bin:/bin"})

def render(template: str, pins: dict[str, str]) -> str:
    out = template
    for key, value in pins.items():
        out, count = re.subn(rf"^{re.escape(key)}=PIN_[A-Z0-9_]+$", f"{key}={value}", out, flags=re.M)
        if count != 1:
            raise ValueError(f"pin site invalid: {key}")
    return out

def verify_domains(runner: Path, template: Path, bundle_manifest: Path, control_manifest: Path) -> dict[str, str]:
    if runner.is_symlink() or not runner.is_file() or runner.stat().st_mode & 0o222:
        raise ValueError("CTV_FROZEN_RUNNER_UNTRUSTED")
    values = {
        "CTV_FROZEN_RUNNER_SHA256": hashlib.sha256(runner.read_bytes()).hexdigest(),
        "CTV_RUNNER_TEMPLATE_SHA256": hashlib.sha256(template.read_bytes()).hexdigest(),
        "CTV_BUNDLE_MANIFEST_SHA256": hashlib.sha256(bundle_manifest.read_bytes()).hexdigest(),
        "CTV_CONTROL_MANIFEST_SHA256": hashlib.sha256(control_manifest.read_bytes()).hexdigest(),
    }
    if values["CTV_FROZEN_RUNNER_SHA256"] == values["CTV_RUNNER_TEMPLATE_SHA256"]:
        raise ValueError("CTV_PROVENANCE_DOMAINS_COLLAPSED")
    return values

def verify_frozen_derivation(repo: Path, main: str, runner: Path, pins: dict[str, str]) -> dict[str, str]:
    """Prove the actual frozen artifact is the exact-main template plus pins."""
    if runner.is_symlink() or not runner.is_file() or runner.stat().st_mode & 0o222:
        raise ValueError("CTV_FROZEN_RUNNER_UNTRUSTED")
    template = template_bytes(repo, main).decode("utf-8")
    rendered = render(template, pins).encode("utf-8")
    if runner.read_bytes() != rendered:
        raise ValueError("CTV_RUNNER_TEMPLATE_DERIVATION_INVALID")
    return {
        "CTV_FROZEN_RUNNER_SHA256": hashlib.sha256(rendered).hexdigest(),
        "CTV_RUNNER_TEMPLATE_SHA256": hashlib.sha256(template.encode("utf-8")).hexdigest(),
    }
