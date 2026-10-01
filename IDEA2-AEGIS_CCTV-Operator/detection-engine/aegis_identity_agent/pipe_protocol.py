"""Closed, bounded JSON protocol between the Engine and Identity Agent."""

from __future__ import annotations

from dataclasses import dataclass
import json
import math
import re
from typing import Any


PIPE_VERSION = 1
MAX_REQUEST_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 4 * 1024
PIPE_OPERATIONS = frozenset({"heartbeat", "detection", "alert", "clip"})

_CAMERA_RE = re.compile(r"^CAM-[0-9]{2,3}$")
_FORBIDDEN_FIELDS = frozenset({
    "nodeid", "physicalcameraid", "sessionid", "signature", "requestnonce",
    "canonicalpayload", "privatekey", "rawbytestosign", "url", "method",
    "path", "headers", "apikey", "authorization",
})
_ERROR_CODES = frozenset({
    "AGENT_UNAVAILABLE", "BUSY", "INVALID_OPERATION", "INVALID_PAYLOAD",
    "MONITOR_REJECTED", "SESSION_EXHAUSTED", "UNAUTHORIZED_CALLER",
})


class PipeProtocolError(ValueError):
    def __init__(self, message: str, *, code: str = "INVALID_PAYLOAD"):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class PipeRequest:
    operation: str
    payload: dict[str, Any]


@dataclass(frozen=True)
class PipeResponse:
    ok: bool
    status: int | None
    error: str | None = None


def _strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise PipeProtocolError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _decode_object(raw: bytes, *, limit: int, kind: str) -> dict[str, Any]:
    if not isinstance(raw, bytes) or len(raw) > limit:
        raise PipeProtocolError(f"{kind} exceeds size limit")
    try:
        value = json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=_strict_object)
    except PipeProtocolError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PipeProtocolError(f"{kind} is not canonical UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise PipeProtocolError(f"{kind} must be a JSON object")
    return value


def _closed(value: dict[str, Any], *, required: set[str], optional: set[str] = set()) -> None:
    fields = set(value)
    if not required <= fields or not fields <= required | optional:
        raise PipeProtocolError("payload field set is not allowed")


def _text(value: Any, *, label: str, maximum: int, nullable: bool = False) -> None:
    if value is None and nullable:
        return
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise PipeProtocolError(f"{label} must be bounded non-empty text")


def _number(value: Any, *, label: str, nullable: bool = False, integer: bool = False) -> None:
    if value is None and nullable:
        return
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise PipeProtocolError(f"{label} must be a finite number")
    if integer and not isinstance(value, int):
        raise PipeProtocolError(f"{label} must be an integer")


def _camera(value: Any) -> None:
    if not isinstance(value, str) or _CAMERA_RE.fullmatch(value) is None:
        raise PipeProtocolError("cameraId is not canonical")


def _reject_authority_fields(value: Any) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).lower() in _FORBIDDEN_FIELDS:
                raise PipeProtocolError(f"field {key!r} is Agent-owned")
            _reject_authority_fields(child)
    elif isinstance(value, list):
        for child in value:
            _reject_authority_fields(child)


def _validate_heartbeat(payload: dict[str, Any]) -> None:
    optional = {
        "cameraReconnects", "captureFps", "detectFps", "latencyMs", "latencyMsAvg",
        "uptimeS", "framesCaptured", "segmentsWritten", "nasLastStatus", "nasPending",
        "cameraDeviceName",
    }
    _closed(payload, required={"cameraConnected"}, optional=optional)
    if not isinstance(payload["cameraConnected"], bool):
        raise PipeProtocolError("cameraConnected must be boolean")
    for field in ("cameraReconnects", "framesCaptured", "segmentsWritten", "nasPending"):
        if field in payload:
            _number(payload[field], label=field, nullable=True, integer=True)
    for field in ("captureFps", "detectFps", "latencyMs", "latencyMsAvg", "uptimeS"):
        if field in payload:
            _number(payload[field], label=field, nullable=True)
    if "nasLastStatus" in payload:
        _text(payload["nasLastStatus"], label="nasLastStatus", maximum=32, nullable=True)
    if "cameraDeviceName" in payload:
        _text(payload["cameraDeviceName"], label="cameraDeviceName", maximum=256, nullable=True)


def _validate_detection(payload: dict[str, Any]) -> None:
    _closed(payload, required={"cameraId", "entities"}, optional={"frameId", "at"})
    _camera(payload["cameraId"])
    entities = payload["entities"]
    if not isinstance(entities, list) or len(entities) > 64:
        raise PipeProtocolError("entities must be a bounded list")
    for entity in entities:
        if not isinstance(entity, dict):
            raise PipeProtocolError("entity must be an object")
        _closed(entity, required={"status"}, optional={"name", "confidence"})
        if entity["status"] not in {"Authorized", "Unknown", "NoFace"}:
            raise PipeProtocolError("entity status is invalid")
        if "name" in entity:
            _text(entity["name"], label="entity name", maximum=120, nullable=True)
        if "confidence" in entity:
            _number(entity["confidence"], label="entity confidence", nullable=True)
    if "frameId" in payload:
        _text(payload["frameId"], label="frameId", maximum=128, nullable=True)
    if "at" in payload:
        _text(payload["at"], label="at", maximum=64, nullable=True)


def _validate_alert(payload: dict[str, Any]) -> None:
    _closed(payload, required={
        "cameraId", "severity", "alertType", "title", "snapshotPath", "telegramSent",
    })
    _camera(payload["cameraId"])
    if payload["severity"] not in {"amber", "red"}:
        raise PipeProtocolError("severity is invalid")
    _text(payload["alertType"], label="alertType", maximum=64)
    _text(payload["title"], label="title", maximum=200)
    _text(payload["snapshotPath"], label="snapshotPath", maximum=1024, nullable=True)
    if not isinstance(payload["telegramSent"], bool):
        raise PipeProtocolError("telegramSent must be boolean")


def _validate_clip(payload: dict[str, Any]) -> None:
    _closed(payload, required={
        "cameraId", "startedAt", "durationSec", "filePath", "storedOnNas",
    })
    _camera(payload["cameraId"])
    _text(payload["startedAt"], label="startedAt", maximum=64)
    _number(payload["durationSec"], label="durationSec")
    _text(payload["filePath"], label="filePath", maximum=1024)
    if not isinstance(payload["storedOnNas"], bool):
        raise PipeProtocolError("storedOnNas must be boolean")


_VALIDATORS = {
    "heartbeat": _validate_heartbeat,
    "detection": _validate_detection,
    "alert": _validate_alert,
    "clip": _validate_clip,
}


def validate_operation_payload(operation: object, payload: object) -> tuple[str, dict[str, Any]]:
    if not isinstance(operation, str) or operation not in PIPE_OPERATIONS:
        raise PipeProtocolError("operation is not allowed", code="INVALID_OPERATION")
    if not isinstance(payload, dict):
        raise PipeProtocolError("payload must be an object")
    _reject_authority_fields(payload)
    _VALIDATORS[operation](payload)
    return operation, payload


def encode_request(operation: str, payload: dict[str, Any]) -> bytes:
    operation, payload = validate_operation_payload(operation, payload)
    encoded = json.dumps(
        {"version": PIPE_VERSION, "operation": operation, "payload": payload},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    if len(encoded) > MAX_REQUEST_BYTES:
        raise PipeProtocolError("request exceeds size limit")
    return encoded


def decode_request(raw: bytes) -> PipeRequest:
    value = _decode_object(raw, limit=MAX_REQUEST_BYTES, kind="request")
    if set(value) != {"version", "operation", "payload"} or value["version"] != PIPE_VERSION:
        raise PipeProtocolError("request envelope is not canonical")
    operation, payload = validate_operation_payload(value["operation"], value["payload"])
    return PipeRequest(operation, payload)


def encode_response(*, ok: bool, status: int | None, error: str | None = None) -> bytes:
    if not isinstance(ok, bool):
        raise PipeProtocolError("response ok must be boolean")
    if status is not None and (isinstance(status, bool) or not isinstance(status, int) or not 100 <= status <= 599):
        raise PipeProtocolError("response status is invalid")
    if ok:
        value = {"ok": True, "status": status}
    else:
        if error not in _ERROR_CODES:
            raise PipeProtocolError("response error is invalid")
        value = {"ok": False, "status": status, "error": error}
    encoded = json.dumps(value, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_RESPONSE_BYTES:
        raise PipeProtocolError("response exceeds size limit")
    return encoded


def decode_response(raw: bytes) -> PipeResponse:
    value = _decode_object(raw, limit=MAX_RESPONSE_BYTES, kind="response")
    if value.get("ok") is True and set(value) == {"ok", "status"}:
        encode_response(ok=True, status=value["status"])
        return PipeResponse(True, value["status"])
    if value.get("ok") is False and set(value) == {"ok", "status", "error"}:
        encode_response(ok=False, status=value["status"], error=value["error"])
        return PipeResponse(False, value["status"], value["error"])
    raise PipeProtocolError("response envelope is not canonical")
