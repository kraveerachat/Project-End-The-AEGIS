"""Pure offline contract evaluator; it cannot inspect or change a host."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from typing import Any

BASE_MAIN = "dbf00185331474053f46486fcefa795a46f5b821"
OLD_RELEASE = "954ce1c191885e9e90198a6f54a3d990bcf144fc"
SHA40 = re.compile(r"[0-9a-f]{40}\Z")
SHA64 = re.compile(r"[0-9a-f]{64}\Z")
DETECTOR_FIELDS = ("load_state", "active_state", "sub_state", "unit_file_state", "pid", "process_count", "unit_sha256")
REQUIRED_RUNTIME_FILES = {
    "aegis_soc/__init__.py", "aegis_soc/cli.py", "aegis_soc/production_detector.py",
    "aegis_soc/recovery_core.py", "aegis_soc/recovery_ui.py", "aegis_soc/supervisor.py", "aegis_soc/local_cut.py",
}
MANIFEST_FIELDS = (
    "schema_version", "release_id", "source_git_sha", "source_tree_dirty", "python_version",
    "requirements_sha256", "file_count", "created_by_tool_version",
)
PRESERVED_SERVICES = {
    "idea1", "idea2", "mqtt_broker", "mqtt_service_2", "twingate", "tunnel", "firewall", "nftables",
    "network", "relay", "esp32", "incidents", "recovery_markers", "database",
}
def _mapping(parent: Mapping[str, Any], key: str) -> Mapping[str, Any] | None:
    value = parent.get(key)
    return value if isinstance(value, Mapping) else None


def _sha(value: Any, pattern: re.Pattern[str]) -> bool:
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _file_set_sha(files: Mapping[str, Any]) -> str:
    if not all(isinstance(path, str) and isinstance(files[path], str) for path in files):
        return ""
    try:
        body = "".join(f"{files[path]}  {path}\n" for path in sorted(files))
        return hashlib.sha256(body.encode("ascii")).hexdigest()
    except UnicodeEncodeError:
        return ""


def _checks(evidence: Mapping[str, Any]) -> tuple[dict[str, str], list[str]]:
    checks: dict[str, str] = {}
    blockers: list[str] = []

    source = _mapping(evidence, "source")
    candidate_source = _mapping(_mapping(evidence, "releases") or {}, "candidate")
    source_ok = bool(
        source
        and source.get("base_main") == BASE_MAIN
        and source.get("clean_tree") is True
        and _sha(source.get("reviewed_main"), SHA40)
        and candidate_source
        and candidate_source.get("source_git_sha") == source.get("reviewed_main")
    )
    checks["source_binding"] = "CONSISTENT" if source_ok else "REJECTED"
    if not source_ok:
        blockers.append("SOURCE_MAIN_OR_CLEAN_TREE_MISMATCH")

    releases = _mapping(evidence, "releases")
    old = _mapping(releases or {}, "old")
    candidate = candidate_source
    old_ok = bool(
        old
        and old.get("release_id") == OLD_RELEASE
        and _sha(old.get("tree_sha256"), SHA64)
        and old.get("digest_basis") == "OWNER_VERIFIED"
    )
    if not old_ok:
        blockers.append("OLD_RELEASE_TREE_DIGEST_NOT_OWNER_VERIFIED")

    source_files = candidate.get("source_files") if candidate else None
    payload_files = candidate.get("payload_files") if candidate else None
    payload_kinds = candidate.get("payload_kinds") if candidate else None
    expected_paths = candidate.get("guard_payload_paths") if candidate else None
    release_sums_content = candidate.get("release_sums_content") if candidate else None
    manifest = candidate.get("manifest") if candidate else None
    files_ok = (
        isinstance(source_files, Mapping)
        and isinstance(payload_files, Mapping)
        and isinstance(payload_kinds, Mapping)
        and set(payload_kinds) == set(payload_files)
        and all(kind == "regular" for kind in payload_kinds.values())
        and isinstance(expected_paths, list)
        and all(isinstance(path, str) for path in expected_paths)
        and len(expected_paths) == len(set(expected_paths))
        and set(expected_paths) == set(payload_files)
        and bool(source_files)
        and REQUIRED_RUNTIME_FILES.issubset(source_files)
        and all(
            isinstance(path, str)
            and path.startswith("aegis_soc/")
            and path.endswith(".py")
            and ".." not in path.split("/")
            and _sha(source_files[path], SHA64)
            for path in source_files
        )
        and {path for path in payload_files if isinstance(path, str) and path.startswith("aegis_soc/")} == set(source_files)
        and all(_sha(digest, SHA64) for digest in payload_files.values())
        and "requirements.txt" in payload_files
        and "RELEASE-MANIFEST.json" in payload_files
        and "venv/bin/python" in payload_files
        and {path.split("/", 1)[0] for path in payload_files} == {"aegis_soc", "requirements.txt", "RELEASE-MANIFEST.json", "venv"}
        and all(isinstance(path, str) and ".." not in path.split("/") and not path.startswith("/") for path in payload_files)
        and all(source_files[path] == payload_files[path] for path in source_files)
    )
    manifest_sha_ok = False
    if isinstance(manifest, Mapping) and candidate and isinstance(payload_files, Mapping):
        try:
            manifest_bytes = json.dumps(dict(manifest), indent=2).encode("ascii") + b"\n"
            manifest_sha_ok = (
                tuple(manifest.keys()) == MANIFEST_FIELDS
                and manifest.get("schema_version") == 1
                and manifest.get("release_id") == candidate.get("release_id")
                and manifest.get("source_git_sha") == candidate.get("source_git_sha")
                and manifest.get("source_tree_dirty") is False
                and _sha(manifest.get("requirements_sha256"), SHA64)
                and manifest.get("requirements_sha256") == payload_files.get("requirements.txt")
                and type(manifest.get("file_count")) is int
                and manifest.get("file_count") == len(payload_files) - 1
                and hashlib.sha256(manifest_bytes).hexdigest() == candidate.get("manifest_sha256")
                and candidate.get("manifest_sha256") == payload_files.get("RELEASE-MANIFEST.json")
            )
        except (TypeError, ValueError, UnicodeEncodeError):
            manifest_sha_ok = False
    sums_entries_ok = False
    if isinstance(release_sums_content, str) and isinstance(payload_files, Mapping):
        try:
            sums_entries: dict[str, str] = {}
            for line in release_sums_content.splitlines(keepends=True):
                match = re.fullmatch(r"([0-9a-f]{64})  ([^\n]+)\n", line)
                if match is None or match.group(2) in sums_entries:
                    break
                sums_entries[match.group(2)] = match.group(1)
            else:
                sums_entries_ok = sums_entries == payload_files
        except (TypeError, ValueError):
            sums_entries_ok = False
    sums_sha_ok = bool(
        isinstance(payload_files, Mapping)
        and sums_entries_ok
        and isinstance(release_sums_content, str)
        and _sha(candidate.get("release_sums_sha256"), SHA64)
        and hashlib.sha256(release_sums_content.encode("ascii")).hexdigest() == candidate.get("release_sums_sha256")
    ) if candidate else False
    tree_sha_ok = bool(
        isinstance(payload_files, Mapping)
        and _sha(candidate.get("tree_sha256"), SHA64)
        and candidate.get("tree_sha256") == _file_set_sha(payload_files)
    ) if candidate else False
    release_ok = bool(
        candidate
        and old
        and candidate.get("release_id") != old.get("release_id")
        and candidate.get("guard") == "VERIFIED"
        and tree_sha_ok
        and _sha(candidate.get("manifest_sha256"), SHA64)
        and manifest_sha_ok
        and sums_sha_ok
        and files_ok
    )
    checks["release_content_closure"] = "CONSISTENT" if release_ok else "REJECTED"
    if not release_ok:
        blockers.append("NEW_RELEASE_CONTENT_CLOSURE_MISMATCH")

    detector = _mapping(evidence, "detector")
    pre = _mapping(detector or {}, "pre")
    post = _mapping(detector or {}, "post")
    inactive = {
        "load_state": "loaded", "active_state": "inactive", "sub_state": "dead",
        "unit_file_state": "disabled", "pid": 0, "process_count": 0,
    }
    detector_ok = bool(
        pre and post
        and all(k in pre and k in post for k in DETECTOR_FIELDS)
        and all(pre.get(k) == v and post.get(k) == v for k, v in inactive.items())
        and _sha(pre.get("unit_sha256"), SHA64)
        and pre.get("unit_sha256") == post.get("unit_sha256")
        and all(pre.get(k) == post.get(k) for k in DETECTOR_FIELDS)
    )
    checks["inactive_detector"] = "CONSISTENT" if detector_ok else "REJECTED"
    if not detector_ok:
        blockers.append("DETECTOR_NOT_INACTIVE_AND_UNCHANGED")

    systemd = _mapping(evidence, "systemd")
    restart_ok = bool(
        systemd
        and systemd.get("dependency_verified") is True
        and systemd.get("inactive_restart_behavior_verified") is True
        and systemd.get("restart_argv") == ["restart", "aegis-idea3-core.service"]
        and systemd.get("job_mode") == "default"
    )
    checks["systemd_contract_input"] = "CONSISTENT" if restart_ok else "REJECTED"
    if not restart_ok:
        blockers.append("SYSTEMD_DEPENDENCY_OR_RESTART_CONTRACT_MISSING")

    rollback = _mapping(evidence, "rollback")
    rollback_ok = bool(
        old
        and rollback
        and rollback.get("target_release_id") == old.get("release_id") == OLD_RELEASE
        and rollback.get("target_tree_sha256") == old.get("tree_sha256")
        and rollback.get("pre_tree_sha256") == old.get("tree_sha256")
        and rollback.get("safety_class") == "EXACT_RELEASE"
        and rollback.get("owner_approved") is True
        and old.get("rollback_approved") is True
        and old_ok
    )
    checks["rollback_target"] = "CONSISTENT" if rollback_ok else "REJECTED"
    if not rollback_ok:
        blockers.append("ROLLBACK_TARGET_OR_APPROVAL_UNPROVEN")

    history = _mapping(evidence, "history")
    ctu = _mapping(history or {}, "ctu")
    ctv = _mapping(history or {}, "ctv")
    history_ok = bool(
        ctu and ctv
        and set(ctu) == {"result", "attempt_consumed", "rerun_allowed"}
        and ctu.get("result") == "FAIL_IMMUTABLE"
        and ctu.get("attempt_consumed") is True
        and ctu.get("rerun_allowed") is False
        and set(ctv) == {"result", "live", "attempt_consumed", "rerun_allowed", "s10", "s10_promoted"}
        and ctv.get("result") == "FAIL_IMMUTABLE"
        and ctv.get("live") == "CLOSED_FAIL"
        and ctv.get("attempt_consumed") is True
        and ctv.get("rerun_allowed") is False
        and ctv.get("s10") == "FAIL"
        and ctv.get("s10_promoted") is False
    )
    checks["ctu_ctv_history"] = "CONSISTENT" if history_ok else "REJECTED"
    if not history_ok:
        blockers.append("IMMUTABLE_CTU_CTV_HISTORY_CONTRADICTED")

    preservation = _mapping(evidence, "preservation")
    preserved_pre = _mapping(preservation or {}, "pre")
    preserved_post = _mapping(preservation or {}, "post")
    preservation_ok = bool(
        preserved_pre and preserved_post
        and set(preserved_pre) == PRESERVED_SERVICES
        and set(preserved_post) == PRESERVED_SERVICES
        and all(preserved_pre[k] == preserved_post[k] for k in PRESERVED_SERVICES)
    )
    checks["service_preservation_input"] = "CONSISTENT" if preservation_ok else "REJECTED"
    if not preservation_ok:
        blockers.append("PRESERVED_SERVICE_SNAPSHOTS_DIFFER_OR_INCOMPLETE")

    effects = evidence.get("effects")
    effects_ok = isinstance(effects, list) and len(effects) == 0
    checks["prohibited_effects_absent"] = "CONSISTENT" if effects_ok else "REJECTED"
    if not effects_ok:
        blockers.append("PROHIBITED_EFFECT_DECLARED")
    return checks, blockers

def evaluate(evidence: Mapping[str, Any]) -> dict[str, Any]:
    """Evaluate a supplied fixture without I/O; live authority is never returned."""
    if not isinstance(evidence, Mapping) or evidence.get("schema") != "idea3-inactive-core-successor-evidence-v1":
        checks, blockers = {}, ["EVIDENCE_SCHEMA_INVALID"]
    else:
        checks, blockers = _checks(evidence)
    return {
        "offline_contract": "STRUCTURALLY_CONSISTENT" if checks and all(v == "CONSISTENT" for v in checks.values()) else "INCONSISTENT",
        "live_executor": "BLOCKED",
        "production_readiness": "NOT_ASSESSED",
        "authorization": "NONE",
        "physical_containment": "NOT_PROVEN",
        "checks": checks,
        "blockers": sorted(set(blockers + [
            "LIVE_EXECUTOR_NOT_IMPLEMENTED", "OFFLINE_INPUT_AUTHENTICITY_NOT_VERIFIED",
            "INSTALLED_SYSTEMD_BEHAVIOR_NOT_LIVE_PROVEN", "CURRENT_OLD_RELEASE_TREE_DIGEST_NOT_SUPPLIED",
            "ROLLBACK_OWNER_APPROVAL_NOT_SUPPLIED", "FRESH_HOST_SERVICE_EVIDENCE_NOT_SUPPLIED",
            "NEW_RELEASE_CLOSURE_NOT_BUILT_OR_OWNER_PINNED", "SEPARATE_CORE_UPGRADE_AUTHORITY_NOT_APPROVED",
            "RECOVERY_AUTHORITY_REMAINS_SEPARATE_AND_UNGRANTED", "CTU_CTV_MARKER_BYTES_NOT_REINSPECTED",
            "PRODUCTION_READINESS_NOT_ASSESSED",
        ])),
    }
