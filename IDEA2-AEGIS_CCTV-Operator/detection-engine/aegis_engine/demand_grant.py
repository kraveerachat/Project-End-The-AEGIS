"""Server-only canonical demand envelopes; a MAC is not sufficient authority."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re

DOMAIN = b"aegis-producer-demand-v1\n"
FIELDS = frozenset(("v", "action", "jti", "demandOwnerId", "producerGeneration",
                    "logicalCameraId", "nodeId", "physicalCameraId", "engineBootId",
                    "userId", "sessionBindingHash", "expiresAtMs"))


class DemandGrantError(ValueError):
    """Generic fail-closed denial; never include token contents in errors."""


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _decode(value: str) -> bytes:
    if not isinstance(value, str) or re.fullmatch(r"[A-Za-z0-9_-]+", value) is None:
        raise DemandGrantError("invalid demand grant")
    raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if _b64(raw) != value:
        raise DemandGrantError("invalid demand grant")
    return raw


def _key(secret: str) -> bytes:
    return hmac.new(secret.encode(), b"AEGIS-demand-grant-v1-key", hashlib.sha256).digest()


def sign_payload(payload: dict, secret: str, domain: bytes = DOMAIN) -> str:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
    mac = hmac.new(_key(secret), domain + raw, hashlib.sha256).digest()
    return _b64(raw) + "." + _b64(mac)


def verify_grant(token: bytes, *, secret: str, boot_id: str, node_id: str,
                 now_ms: int) -> dict:
    try:
        if not secret or len(token) > 4096:
            raise ValueError()
        body, signature = token.decode("ascii").split(".")
        raw, mac = _decode(body), _decode(signature)
        if not hmac.compare_digest(mac, hmac.new(_key(secret), DOMAIN + raw, hashlib.sha256).digest()):
            raise ValueError()
        value = json.loads(raw)
        canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
        if not isinstance(value, dict) or raw != canonical or set(value) != FIELDS:
            raise ValueError()
        if type(value["v"]) is not int or value["v"] != 1:
            raise ValueError()
        if value["action"] not in ("attach", "refresh", "revoke", "retire"):
            raise ValueError()
        for name in ("jti", "demandOwnerId"):
            if len(_decode(value[name])) != 32:
                raise ValueError()
        for name in ("producerGeneration", "userId"):
            text = value[name]
            if not isinstance(text, str) or re.fullmatch(r"[1-9][0-9]{0,18}", text) is None or int(text) > 9223372036854775807:
                raise ValueError()
        physical = value["physicalCameraId"]
        if type(physical) is not int or not 1 <= physical <= 9007199254740991:
            raise ValueError()
        if not isinstance(value["logicalCameraId"], str) or re.fullmatch(r"CAM-[0-9]{1,60}", value["logicalCameraId"]) is None:
            raise ValueError()
        if value["nodeId"] != node_id or value["engineBootId"] != boot_id:
            raise ValueError()
        if not isinstance(value["sessionBindingHash"], str) or re.fullmatch(r"v1:[0-9a-f]{64}", value["sessionBindingHash"]) is None:
            raise ValueError()
        expiry = value["expiresAtMs"]
        if type(expiry) is not int or not now_ms < expiry <= now_ms + 30_000:
            raise ValueError()
        return value
    except (ValueError, TypeError, KeyError, UnicodeError, OverflowError) as exc:
        raise DemandGrantError("invalid demand grant") from None
