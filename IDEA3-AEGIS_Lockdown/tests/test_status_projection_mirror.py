"""The sidecar's stdlib-only projection must stay byte-for-byte equivalent to the Core contract owner.

``aegis_soc.runtime.safe_status_projection`` is not changed by the sidecar work (the governed Core release closure is pinned);
``aegis_soc.status_projection.project_status_document`` mirrors it so the sidecar need not ship the Core. Drift fails here.
"""

from __future__ import annotations

import itertools
import json

import pytest

from aegis_soc import runtime, status_projection

STATES = ["RUNNING", "DEGRADED", "LOCKDOWN", "FAILED", "SHUTDOWN", "INIT", "PREFLIGHT", "WAIT_BROKER", "WAIT_DEVICE", "bogus", None, 3, True]
BROKER = ["CONNECTED", "DISCONNECTED", "UNKNOWN", "bogus", None]
DEVICE = ["ONLINE", "OFFLINE", "UNKNOWN", None]
UPLINK = ["NORMAL", "LOCKDOWN", "UNKNOWN", None]
DISPATCH = ["DISABLED", "ACTIVE", "PAUSED_CREDENTIAL", "UNAVAILABLE", "UNKNOWN", None]
COMPONENTS = [{}, {"detector": "RUNNING", "gui": "FAILED", "preflight": "STOPPED", "core": "RUNNING"}, {"detector": "bogus"}, "bad", None]
UPDATED = [1.7e9, 1, True, "x", None, -1, 1e30, float("nan")]
_BASE = {"profile": "production", "dry_run": False, "auto_contain": False, "armed": "MONITOR_ONLY", "detail": "secret", "pid": 4}


def _same(document) -> None:
    left = runtime.safe_status_projection(json.loads(json.dumps(document)) if document is not None else None)
    right = status_projection.project_status_document(json.loads(json.dumps(document)) if document is not None else None)
    assert json.dumps(left, sort_keys=True) == json.dumps(right, sort_keys=True), document


def test_mirror_matches_the_core_over_the_full_vocabulary_product() -> None:
    count = 0
    for state, broker, device, uplink, dispatch in itertools.product(STATES, BROKER, DEVICE, UPLINK, DISPATCH):
        _same({**_BASE, "state": state, "broker": broker, "device": device, "uplink": uplink, "dispatch": dispatch,
               "updated_at": 1.7e9, "components": {}})
        count += 1
    assert count == 13 * 5 * 4 * 4 * 6


@pytest.mark.parametrize("components", COMPONENTS)
@pytest.mark.parametrize("updated_at", UPDATED)
@pytest.mark.parametrize("dry_run", [True, False, None, 0, 1])
def test_mirror_matches_the_core_for_components_timestamps_and_dry_run(components, updated_at, dry_run) -> None:
    _same({**_BASE, "state": "RUNNING", "broker": "CONNECTED", "device": "ONLINE", "uplink": "NORMAL", "dispatch": "DISABLED",
           "dry_run": dry_run, "updated_at": updated_at, "components": components})


@pytest.mark.parametrize("value", [None, 3, "s", [], ()])
def test_mirror_matches_the_core_for_non_documents(value) -> None:
    assert runtime.safe_status_projection(value) == status_projection.project_status_document(value)


def test_mirror_matches_the_core_for_the_runtime_status_dataclass() -> None:
    status = runtime.RuntimeStatus(state=runtime.RuntimeState.RUNNING, profile="production", dry_run=False, auto_contain=False,
                                   broker="CONNECTED", device="ONLINE", uplink="NORMAL", armed="MONITOR_ONLY", dispatch="DISABLED",
                                   time_trust="SYNCED", updated_at=1.7e9, components={})
    assert runtime.safe_status_projection(status) == status_projection.project_status_document(runtime.asdict(status))


def test_mirror_imports_nothing_from_the_core() -> None:
    import ast
    import pathlib

    tree = ast.parse(pathlib.Path(status_projection.__file__).read_text())
    imported = {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
    imported |= {n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
    assert imported <= {"__future__", "time"}
