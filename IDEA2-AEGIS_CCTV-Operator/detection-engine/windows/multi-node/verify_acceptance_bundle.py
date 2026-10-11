from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


REQUIRED_PHASES = (
    "pre_viewer",
    "operator_live",
    "post_operator_release",
    "operator2_live",
    "post_operator2_release",
    "post_reboot",
)


def _load(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: snapshot must be an object")
    return data


def _health(snapshot: dict[str, Any]) -> dict[str, Any]:
    health = snapshot.get("engine_health")
    if not isinstance(health, dict):
        raise ValueError("engine_health missing")
    return health


def _lifecycle(snapshot: dict[str, Any]) -> dict[str, Any]:
    lifecycle = snapshot.get("lifecycle")
    if not isinstance(lifecycle, dict):
        raise ValueError("lifecycle missing")
    return lifecycle


def _boundary(snapshot: dict[str, Any]) -> dict[str, Any]:
    boundary = snapshot.get("collection_boundary")
    if not isinstance(boundary, dict):
        raise ValueError("collection_boundary missing")
    return boundary


def _require_boundary(snapshot: dict[str, Any]) -> None:
    boundary = _boundary(snapshot)
    expected = {
        "server_contact": "NO",
        "production_mutation": "NO",
        "twingate_mutation": "NO",
        "camera_open_by_collector": "NO",
        "private_key_read": "NO",
        "config_read": "NO",
        "localhost_engine_health_only": "YES",
    }
    for key, value in expected.items():
        if boundary.get(key) != value:
            raise ValueError(f"unsafe or unknown collector boundary: {key}")


def _require_runtime_owners(snapshot: dict[str, Any]) -> None:
    lifecycle = _lifecycle(snapshot)

    if lifecycle.get("identity_agent_installed") is not True:
        raise ValueError("Identity Agent not installed")
    if lifecycle.get("identity_agent_state") != "Running":
        raise ValueError("Identity Agent not running")
    if lifecycle.get("identity_agent_start_mode") != "Auto":
        raise ValueError("Identity Agent not automatic")
    if lifecycle.get("detection_tunnel_task_present") is not True:
        raise ValueError("Detection Tunnel task missing")
    if lifecycle.get("detection_tunnel_task_state") != "Running":
        raise ValueError("Detection Tunnel not running")
    if lifecycle.get("engine_hkcu_run_present") is not True:
        raise ValueError("HKCU Engine startup owner missing")

    if lifecycle.get("legacy_engine_task_present") is True:
        if lifecycle.get("legacy_engine_task_state") != "Disabled":
            raise ValueError("legacy Engine Scheduled Task must remain disabled")


def _require_idle(snapshot: dict[str, Any], phase: str) -> None:
    health = _health(snapshot)

    if health.get("reachable") is not True:
        raise ValueError(f"{phase}: Engine health unreachable")
    if health.get("status") != "idle":
        raise ValueError(f"{phase}: Engine must be idle")
    if health.get("camera_demanded") is not False:
        raise ValueError(f"{phase}: camera demand must be false")
    if health.get("camera_connected") is not False:
        raise ValueError(f"{phase}: camera must be closed")
    if int(health.get("stream_viewers", -1)) != 0:
        raise ValueError(f"{phase}: stream viewers must be zero")


def _require_live(snapshot: dict[str, Any], phase: str) -> None:
    health = _health(snapshot)

    if health.get("reachable") is not True:
        raise ValueError(f"{phase}: Engine health unreachable")
    if health.get("camera_demanded") is not True:
        raise ValueError(f"{phase}: camera must be demanded")
    if health.get("camera_connected") is not True:
        raise ValueError(f"{phase}: camera must be connected")
    if int(health.get("stream_viewers", 0)) < 1:
        raise ValueError(f"{phase}: expected at least one stream viewer")
    if float(health.get("capture_fps") or 0) <= 0:
        raise ValueError(f"{phase}: capture FPS must be positive")


def verify(paths: list[Path]) -> None:
    snapshots = [_load(path) for path in paths]

    by_phase: dict[str, dict[str, Any]] = {}
    node_labels: set[str] = set()

    for snapshot in snapshots:
        if snapshot.get("schema_version") != 1:
            raise ValueError("unsupported snapshot schema")
        phase = snapshot.get("phase")
        if phase not in REQUIRED_PHASES:
            raise ValueError(f"unexpected phase {phase!r}")
        if phase in by_phase:
            raise ValueError(f"duplicate phase {phase}")

        node_label = snapshot.get("node_label")
        if not isinstance(node_label, str) or not node_label:
            raise ValueError("node_label missing")

        _require_boundary(snapshot)
        _require_runtime_owners(snapshot)

        node_labels.add(node_label)
        by_phase[phase] = snapshot

    if len(node_labels) != 1:
        raise ValueError("all snapshots must belong to one Node")

    missing = [phase for phase in REQUIRED_PHASES if phase not in by_phase]
    if missing:
        raise ValueError("missing phases: " + ", ".join(missing))

    for phase in (
        "pre_viewer",
        "post_operator_release",
        "post_operator2_release",
        "post_reboot",
    ):
        _require_idle(by_phase[phase], phase)

    for phase in ("operator_live", "operator2_live"):
        _require_live(by_phase[phase], phase)

    print("MN_P3_LOCAL_LIFECYCLE=PASS")
    print(f"NODE_LABEL={next(iter(node_labels))}")
    print("ACCOUNT_ALIAS_ROUTING=NOT_PROVEN_BY_LOCAL_BUNDLE")
    print("CROSS_NODE_ISOLATION=NOT_PROVEN_BY_LOCAL_BUNDLE")
    print("EVENT_ALIAS_ATTRIBUTION=NOT_PROVEN_BY_LOCAL_BUNDLE")
    print("PRODUCTION_ACCEPTANCE=NOT_PROVEN_BY_LOCAL_BUNDLE")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("snapshots", nargs="+", type=Path)
    args = parser.parse_args()

    try:
        verify(args.snapshots)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise SystemExit(f"MN_P3_LOCAL_LIFECYCLE=FAIL: {exc}") from exc


if __name__ == "__main__":
    main()
