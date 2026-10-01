"""Canonical wire protocol shared by the AEGIS Monitor and Identity Agent."""

from __future__ import annotations

import base64
import json
import re
from collections.abc import Mapping


AUTH_DOMAIN = "AEGIS-AGENT-AUTH-V1"
REQUEST_PROOFS = {
    "heartbeat": {
        "domain": "AEGIS-AGENT-HEARTBEAT-V1",
        "method": "POST",
        "path": "/internal/heartbeat",
    },
    "detection": {
        "domain": "AEGIS-ENGINE-DETECTION-V1",
        "method": "POST",
        "path": "/internal/detections",
    },
    "alert": {
        "domain": "AEGIS-ENGINE-ALERT-V1",
        "method": "POST",
        "path": "/internal/alerts",
    },
    "clip": {
        "domain": "AEGIS-ENGINE-CLIP-V1",
        "method": "POST",
        "path": "/internal/clips",
    },
}

_TOKEN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_MAX_UINT64 = (1 << 64) - 1
_MAX_UINT32 = (1 << 32) - 1
_AUTH_FIELDS = {
    "challengeId", "nonce", "issuedAtMs", "expiresAtMs",
    "audience", "purpose", "nodeId", "keyVersion",
}
_REQUEST_FIELDS = {
    "domain", "sessionId", "requestNonce", "timestampMs",
    "sequence", "method", "path", "bodySha256",
}


def _exact_fields(value: Mapping[str, object], expected: set[str]) -> None:
    if not isinstance(value, Mapping) or set(value) != expected:
        raise ValueError("field set is not canonical")


def _text_b64(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be non-empty text")
    return base64.urlsafe_b64encode(value.encode("utf-8")).rstrip(b"=").decode("ascii")


def parse_canonical_token(value: object, expected_bytes: int, label: str = "token") -> str:
    if not isinstance(value, str) or not _TOKEN_RE.fullmatch(value):
        raise ValueError(f"{label} is not canonical Base64URL")
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, base64.binascii.Error) as exc:
        raise ValueError(f"{label} is not canonical Base64URL") from exc
    canonical = base64.urlsafe_b64encode(decoded).rstrip(b"=").decode("ascii")
    if len(decoded) != expected_bytes or canonical != value:
        raise ValueError(f"{label} has the wrong canonical length")
    return value


def parse_uint(value: object, *, label: str = "integer", positive: bool = False, max_value: int = _MAX_UINT64) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{label} is not an unsigned decimal integer")
    if isinstance(value, int):
        rendered = str(value)
    elif isinstance(value, str):
        rendered = value
    else:
        raise ValueError(f"{label} is not an unsigned decimal integer")
    if re.fullmatch(r"(?:0|[1-9][0-9]*)", rendered) is None:
        raise ValueError(f"{label} is not canonical unsigned decimal")
    parsed = int(rendered)
    if (positive and parsed == 0) or parsed > max_value:
        raise ValueError(f"{label} is outside the allowed range")
    return parsed


def canonical_auth_payload(fields: Mapping[str, object]) -> bytes:
    _exact_fields(fields, _AUTH_FIELDS)
    issued = parse_uint(fields["issuedAtMs"], label="issued at")
    expires = parse_uint(fields["expiresAtMs"], label="expires at")
    if expires <= issued:
        raise ValueError("expires at must follow issued at")
    if fields["purpose"] != "agent-authenticate":
        raise ValueError("purpose is not canonical")
    lines = (
        AUTH_DOMAIN,
        f"challenge_id={parse_canonical_token(fields['challengeId'], 32, 'challenge id')}",
        f"nonce={parse_canonical_token(fields['nonce'], 32, 'nonce')}",
        f"issued_at_ms={issued}",
        f"expires_at_ms={expires}",
        f"audience_b64={_text_b64(fields['audience'], 'audience')}",
        f"purpose_b64={_text_b64(fields['purpose'], 'purpose')}",
        f"node_id_b64={_text_b64(fields['nodeId'], 'node id')}",
        f"key_version={parse_uint(fields['keyVersion'], label='key version', positive=True, max_value=_MAX_UINT32)}",
    )
    return "\n".join(lines).encode("utf-8")


def canonical_request_payload(fields: Mapping[str, object]) -> bytes:
    _exact_fields(fields, _REQUEST_FIELDS)
    proof = next((item for item in REQUEST_PROOFS.values() if item["domain"] == fields["domain"]), None)
    if proof is None:
        raise ValueError("domain is not recognized")
    if fields["method"] != proof["method"]:
        raise ValueError("method does not match proof domain")
    if fields["path"] != proof["path"]:
        raise ValueError("path does not match proof domain")
    body_hash = fields["bodySha256"]
    if not isinstance(body_hash, str) or _HASH_RE.fullmatch(body_hash) is None:
        raise ValueError("body hash is not canonical")
    lines = (
        str(proof["domain"]),
        f"session_id={parse_canonical_token(fields['sessionId'], 32, 'session id')}",
        f"request_nonce={parse_canonical_token(fields['requestNonce'], 16, 'request nonce')}",
        f"timestamp_ms={parse_uint(fields['timestampMs'], label='timestamp')}",
        f"sequence={parse_uint(fields['sequence'], label='sequence', positive=True)}",
        f"method_b64={_text_b64(fields['method'], 'method')}",
        f"path_b64={_text_b64(fields['path'], 'path')}",
        f"body_sha256={body_hash}",
    )
    return "\n".join(lines).encode("utf-8")


def _reject_duplicate_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def parse_strict_json_bytes(raw_bytes: bytes, *, max_bytes: int = 16 * 1024) -> dict:
    if len(raw_bytes) > max_bytes:
        raise ValueError("JSON body exceeds size limit")
    try:
        text = raw_bytes.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise ValueError("JSON body is not valid UTF-8") from exc
    try:
        value = json.loads(text, object_pairs_hook=_reject_duplicate_pairs)
    except json.JSONDecodeError as exc:
        raise ValueError("JSON body is invalid") from exc
    if not isinstance(value, dict):
        raise ValueError("JSON body must be an object")
    return value
