"""Closed browser-association proof protocol for the local Identity Agent."""

from __future__ import annotations

import base64
from collections.abc import Mapping

from .protocol import parse_canonical_token


BROWSER_ASSOCIATION_DOMAIN = "AEGIS-BROWSER-NODE-ASSOCIATION-V1"
_CLAIM_FIELDS = {
    "version", "purpose", "audience", "challenge_id", "challenge_nonce",
    "session_binding", "node_id", "key_version", "issued_at_ms", "expires_at_ms",
}
_CHALLENGE_FIELDS = _CLAIM_FIELDS - {"node_id", "key_version"}
_MAX_SAFE_INTEGER = (1 << 53) - 1


def _exact_fields(value: Mapping[str, object], expected: set[str], label: str) -> None:
    if not isinstance(value, Mapping) or set(value) != expected:
        raise ValueError(f"{label} field set is not canonical")


def _safe_integer(value: object, label: str, *, positive: bool = False) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > _MAX_SAFE_INTEGER:
        raise ValueError(f"{label} must be a canonical safe integer")
    if positive and value == 0:
        raise ValueError(f"{label} must be positive")
    return value


def _text_b64(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be non-empty text")
    return base64.urlsafe_b64encode(value.encode("utf-8")).rstrip(b"=").decode("ascii")


def validate_browser_challenge(challenge: Mapping[str, object]) -> dict[str, object]:
    _exact_fields(challenge, _CHALLENGE_FIELDS, "challenge")
    if challenge["version"] != 1:
        raise ValueError("version is not canonical")
    if challenge["purpose"] != BROWSER_ASSOCIATION_DOMAIN:
        raise ValueError("purpose is not canonical")
    issued = _safe_integer(challenge["issued_at_ms"], "issued at")
    expires = _safe_integer(challenge["expires_at_ms"], "expires at")
    if expires <= issued:
        raise ValueError("expires at must follow issued at")
    parse_canonical_token(challenge["challenge_id"], 32, "challenge id")
    parse_canonical_token(challenge["challenge_nonce"], 32, "challenge nonce")
    parse_canonical_token(challenge["session_binding"], 32, "session binding")
    _text_b64(challenge["audience"], "audience")
    return dict(challenge)


def canonical_browser_association_payload(claims: Mapping[str, object]) -> bytes:
    _exact_fields(claims, _CLAIM_FIELDS, "claim")
    challenge = validate_browser_challenge({key: claims[key] for key in _CHALLENGE_FIELDS})
    key_version = _safe_integer(claims["key_version"], "key version", positive=True)
    lines = (
        BROWSER_ASSOCIATION_DOMAIN,
        "version=1",
        f"purpose_b64={_text_b64(challenge['purpose'], 'purpose')}",
        f"audience_b64={_text_b64(challenge['audience'], 'audience')}",
        f"challenge_id={challenge['challenge_id']}",
        f"challenge_nonce={challenge['challenge_nonce']}",
        f"session_binding={challenge['session_binding']}",
        f"node_id_b64={_text_b64(claims['node_id'], 'node id')}",
        f"key_version={key_version}",
        f"issued_at_ms={challenge['issued_at_ms']}",
        f"expires_at_ms={challenge['expires_at_ms']}",
    )
    return "\n".join(lines).encode("utf-8")


def build_browser_assertion(challenge: Mapping[str, object], signer) -> dict[str, object]:
    validated = validate_browser_challenge(challenge)
    identity = signer.public_identity
    claims = {
        **validated,
        "node_id": identity.node_id,
        "key_version": identity.key_version,
    }
    signature = base64.urlsafe_b64encode(
        signer.sign(canonical_browser_association_payload(claims))
    ).rstrip(b"=").decode("ascii")
    return {"claims": claims, "signature": signature}
