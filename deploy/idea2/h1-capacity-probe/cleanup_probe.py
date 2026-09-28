#!/usr/bin/env python3
"""Exact cleanup for the isolated H1 capacity probe only."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from typing import Any


PROJECT_NAME = "aegis-h1-capacity-probe"
POSTGRES_VOLUME = "aegis-h1-capacity-probe_postgres_data"
BUILDER_NAME = "aegis-h1-capacity-builder"
COMPOSE_FILE = Path(__file__).resolve().parents[1] / "h1-capacity-probe.compose.yml"
IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
PROBE_IMAGE_REFERENCE = re.compile(r"^aegis-h1-capacity-probe-(?:monitor|gateway):[a-z0-9][a-z0-9._-]*$")
EVIDENCE_MARKER = ".aegis-h1-capacity-probe-evidence"


def _run(command: list[str], execute: bool) -> None:
    if not execute:
        print(json.dumps(command))
        return
    result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        diagnostic = (result.stderr or result.stdout or "no diagnostic").strip().splitlines()[-1]
        raise RuntimeError(f"cleanup command failed: {command[0]} ({diagnostic})")


def _exists(command: list[str]) -> bool:
    result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=30)
    return result.returncode == 0


def _safe_evidence_path(value: str) -> Path:
    path = Path(value).resolve()
    if not path.name.startswith("aegis-h1-capacity-probe-"):
        raise RuntimeError("evidence directory name is outside the probe cleanup boundary")
    if path.parent == path or len(path.parts) < 3:
        raise RuntimeError("refusing a broad evidence cleanup path")
    marker = path / EVIDENCE_MARKER
    if not marker.is_file() or marker.is_symlink() or marker.read_text(encoding="utf-8").strip() != PROJECT_NAME:
        raise RuntimeError("evidence directory is not owned by the exact probe project")
    return path


def _introduced_images(manifest_path: Path | None) -> list[tuple[str, str]]:
    if manifest_path is None or not manifest_path.exists():
        return []
    payload: Any = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise RuntimeError("introduced-image manifest must be a JSON list")
    result: list[tuple[str, str]] = []
    for entry in payload:
        if not isinstance(entry, dict) or entry.get("introduced_by_probe") is not True:
            continue
        image_id = entry.get("image_id")
        if not isinstance(image_id, str) or not IMAGE_ID.fullmatch(image_id):
            raise RuntimeError("introduced-image manifest contains an invalid image ID")
        reference = entry.get("reference")
        if not isinstance(reference, str) or not PROBE_IMAGE_REFERENCE.fullmatch(reference):
            raise RuntimeError("introduced-image manifest contains a non-probe reference")
        result.append((reference, image_id))
    return sorted(set(result))


def cleanup(
    *,
    execute: bool,
    evidence_dir: Path | None = None,
    delete_evidence: bool = False,
    image_manifest: Path | None = None,
    fallback_image_references: tuple[str, ...] = (),
) -> None:
    _run(
        [
            "docker",
            "compose",
            "--project-name",
            PROJECT_NAME,
            "--file",
            str(COMPOSE_FILE),
            "down",
            "--volumes",
            "--remove-orphans",
            "--timeout",
            "10",
        ],
        execute,
    )
    if not execute or _exists(["docker", "volume", "inspect", POSTGRES_VOLUME]):
        _run(["docker", "volume", "rm", POSTGRES_VOLUME], execute)
    if not execute or _exists(["docker", "buildx", "inspect", BUILDER_NAME]):
        _run(["docker", "buildx", "rm", BUILDER_NAME], execute)
    introduced = dict(_introduced_images(image_manifest))
    for reference in fallback_image_references:
        if not PROBE_IMAGE_REFERENCE.fullmatch(reference):
            raise RuntimeError("fallback image reference is outside the probe namespace")
        if reference in introduced:
            continue
        if execute:
            current = subprocess.run(
                ["docker", "image", "inspect", "--format", "{{.Id}}", reference],
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
            )
            if current.returncode == 0:
                image_id = current.stdout.strip()
                if not IMAGE_ID.fullmatch(image_id):
                    raise RuntimeError("fallback probe image has an invalid image ID")
                introduced[reference] = image_id
    for reference, image_id in sorted(introduced.items()):
        if execute:
            current = subprocess.run(
                ["docker", "image", "inspect", "--format", "{{.Id}}", reference],
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
            )
            if current.returncode != 0 or current.stdout.strip() != image_id:
                raise RuntimeError("probe image identity changed before cleanup")
        _run(["docker", "image", "rm", image_id], execute)

    if delete_evidence:
        if evidence_dir is None:
            raise RuntimeError("explicit evidence directory is required")
        safe_path = _safe_evidence_path(str(evidence_dir))
        if execute:
            shutil.rmtree(safe_path)
        else:
            print(json.dumps(["remove-tree", str(safe_path)]))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", action="store_true")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--evidence-dir")
    parser.add_argument("--delete-evidence", action="store_true")
    parser.add_argument("--image-manifest")
    args = parser.parse_args()
    if args.plan == args.execute:
        parser.error("choose exactly one of --plan or --execute")
    if args.execute and os.environ.get("AEGIS_CAPACITY_PROBE_CLEANUP_AUTHORIZED") != "YES":
        print("cleanup execution requires AEGIS_CAPACITY_PROBE_CLEANUP_AUTHORIZED=YES", file=sys.stderr)
        return 2
    try:
        cleanup(
            execute=args.execute,
            evidence_dir=Path(args.evidence_dir) if args.evidence_dir else None,
            delete_evidence=args.delete_evidence,
            image_manifest=Path(args.image_manifest) if args.image_manifest else None,
        )
    except Exception as exc:
        print(f"cleanup blocked: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
