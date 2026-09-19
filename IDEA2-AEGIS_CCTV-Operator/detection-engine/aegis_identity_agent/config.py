"""Strict configuration for the dedicated AEGIS Identity Agent."""

from __future__ import annotations

from dataclasses import dataclass
import os
import re
from typing import Mapping
from urllib.parse import urlsplit, urlunsplit


_NODE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def _number(env: Mapping[str, str], name: str, default: str, low: float, high: float) -> float:
    try:
        value = float(env.get(name, default))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be numeric") from exc
    if not low <= value <= high:
        raise ValueError(f"{name} is outside its allowed range")
    return value


@dataclass(frozen=True)
class AgentConfig:
    monitor_base_url: str
    audience: str
    node_id: str
    key_version: int
    protected_key_path: str
    connect_timeout_s: float
    read_timeout_s: float
    renew_before_ms: int
    retry_max_s: float

    @property
    def http_timeout(self) -> tuple[float, float]:
        return (self.connect_timeout_s, self.read_timeout_s)

    @classmethod
    def from_env(cls, source: Mapping[str, str] | None = None) -> "AgentConfig":
        env = os.environ if source is None else source
        raw_url = str(env.get("AEGIS_AGENT_MONITOR_BASE_URL", "")).strip()
        parsed = urlsplit(raw_url)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("AEGIS_AGENT_MONITOR_BASE_URL must be credential-free HTTPS without query or fragment")
        canonical_url = urlunsplit(("https", parsed.netloc, parsed.path.rstrip("/"), "", ""))
        audience = str(env.get("AEGIS_AGENT_AUTH_AUDIENCE", "")).strip()
        audience_url = urlsplit(audience)
        if audience_url.scheme != "https" or not audience_url.hostname or audience_url.query or audience_url.fragment:
            raise ValueError("AEGIS_AGENT_AUTH_AUDIENCE must be a canonical HTTPS origin")
        if audience_url.path not in ("", "/") or audience_url.username is not None:
            raise ValueError("AEGIS_AGENT_AUTH_AUDIENCE must not contain path or credentials")
        audience = urlunsplit(("https", audience_url.netloc, "", "", ""))
        node_id = str(env.get("AEGIS_AGENT_NODE_ID", "")).strip()
        if not _NODE_ID_RE.fullmatch(node_id):
            raise ValueError("AEGIS_AGENT_NODE_ID is invalid")
        try:
            key_version = int(str(env.get("AEGIS_AGENT_KEY_VERSION", "")), 10)
        except ValueError as exc:
            raise ValueError("AEGIS_AGENT_KEY_VERSION is invalid") from exc
        if not 1 <= key_version <= (1 << 32) - 1:
            raise ValueError("AEGIS_AGENT_KEY_VERSION is outside its allowed range")
        key_path = str(env.get("AEGIS_AGENT_KEY_PATH", "")).strip()
        if not key_path:
            raise ValueError("AEGIS_AGENT_KEY_PATH is required")
        tls_verify = str(env.get("AEGIS_AGENT_TLS_VERIFY", "true")).strip().lower()
        if tls_verify not in {"1", "true", "yes", "on"}:
            raise ValueError("TLS certificate verification cannot be disabled")
        connect = _number(env, "AEGIS_AGENT_CONNECT_TIMEOUT_S", "2", 0.1, 10.0)
        read = _number(env, "AEGIS_AGENT_READ_TIMEOUT_S", "5", 0.1, 30.0)
        renew_s = _number(env, "AEGIS_AGENT_RENEW_BEFORE_S", "120", 1.0, 300.0)
        retry_max = _number(env, "AEGIS_AGENT_RETRY_MAX_S", "30", 1.0, 30.0)
        return cls(
            monitor_base_url=canonical_url,
            audience=audience,
            node_id=node_id,
            key_version=key_version,
            protected_key_path=key_path,
            connect_timeout_s=connect,
            read_timeout_s=read,
            renew_before_ms=int(renew_s * 1000),
            retry_max_s=retry_max,
        )

    def redacted(self) -> dict[str, object]:
        return {
            "monitor_base_url": self.monitor_base_url,
            "audience": self.audience,
            "node_id": self.node_id,
            "key_version": self.key_version,
            "connect_timeout_s": self.connect_timeout_s,
            "read_timeout_s": self.read_timeout_s,
            "renew_before_ms": self.renew_before_ms,
            "retry_max_s": self.retry_max_s,
        }
