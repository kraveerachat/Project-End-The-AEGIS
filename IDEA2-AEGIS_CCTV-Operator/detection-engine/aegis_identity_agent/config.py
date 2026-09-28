"""Strict configuration for the dedicated AEGIS Identity Agent."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from ipaddress import ip_address
import os
from pathlib import Path
import re
import stat
from typing import Mapping
from urllib.parse import urlsplit, urlunsplit

from cryptography import x509
from cryptography.x509.extensions import ExtensionNotFound

from .browser_server import normalize_allowed_origins


_NODE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_SID_RE = re.compile(r"^S-[0-9]+(?:-[0-9]+)+$")
_DNS_LABEL_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")
_CERTIFICATE_PEM_RE = re.compile(
    rb"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----",
    re.DOTALL,
)
_PRIVATE_KEY_PEM_RE = re.compile(
    rb"-----BEGIN (?:ENCRYPTED |RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
)
_MAX_CA_BUNDLE_BYTES = 1024 * 1024
UNMANAGED_TLS_TRUST_ENVIRONMENT = (
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
)


def _reject_reparse_path(path: Path, *, stop_before: Path | None = None) -> None:
    candidate = path
    stop = stop_before.resolve(strict=False) if stop_before is not None else None
    while True:
        metadata = os.lstat(candidate)
        file_attributes = getattr(metadata, "st_file_attributes", 0)
        reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        if stat.S_ISLNK(metadata.st_mode) or file_attributes & reparse_flag:
            raise ValueError("AEGIS_AGENT_CA_BUNDLE path must not contain a reparse point")
        if candidate.parent == candidate or (stop is not None and candidate == stop):
            return
        candidate = candidate.parent


def validate_ca_bundle(value: str) -> str:
    """Validate a public-only CA bundle and return its canonical absolute path."""
    raw_path = str(value).strip()
    path = Path(raw_path)
    if not raw_path or not path.is_absolute():
        raise ValueError("AEGIS_AGENT_CA_BUNDLE must be an absolute path")
    try:
        metadata = os.lstat(path)
    except OSError as exc:
        raise ValueError("AEGIS_AGENT_CA_BUNDLE is unavailable") from exc
    _reject_reparse_path(path)
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError("AEGIS_AGENT_CA_BUNDLE must be a regular file")
    if metadata.st_size <= 0 or metadata.st_size > _MAX_CA_BUNDLE_BYTES:
        raise ValueError("AEGIS_AGENT_CA_BUNDLE has an invalid size")
    try:
        material = path.read_bytes()
    except OSError as exc:
        raise ValueError("AEGIS_AGENT_CA_BUNDLE is unreadable") from exc
    if _PRIVATE_KEY_PEM_RE.search(material):
        raise ValueError("AEGIS_AGENT_CA_BUNDLE must not contain private-key material")
    blocks = _CERTIFICATE_PEM_RE.findall(material)
    remainder = _CERTIFICATE_PEM_RE.sub(b"", material)
    if not blocks or remainder.strip():
        raise ValueError("AEGIS_AGENT_CA_BUNDLE must contain only PEM certificates")
    now = datetime.now(timezone.utc)
    for block in blocks:
        try:
            certificate = x509.load_pem_x509_certificate(block)
            constraints = certificate.extensions.get_extension_for_class(
                x509.BasicConstraints
            ).value
        except (ValueError, ExtensionNotFound) as exc:
            raise ValueError("AEGIS_AGENT_CA_BUNDLE contains an invalid CA certificate") from exc
        if not constraints.ca:
            raise ValueError("AEGIS_AGENT_CA_BUNDLE contains a non-CA certificate")
        not_before = getattr(certificate, "not_valid_before_utc", None)
        not_after = getattr(certificate, "not_valid_after_utc", None)
        if not_before is None:
            not_before = certificate.not_valid_before.replace(tzinfo=timezone.utc)
        if not_after is None:
            not_after = certificate.not_valid_after.replace(tzinfo=timezone.utc)
        if now < not_before or now >= not_after:
            raise ValueError("AEGIS_AGENT_CA_BUNDLE contains an inactive CA certificate")
    try:
        return str(path.resolve(strict=True))
    except OSError as exc:
        raise ValueError("AEGIS_AGENT_CA_BUNDLE cannot be resolved") from exc


def _deployment_hostname(value: str) -> bool:
    if not value or len(value) > 253 or value.endswith(".") or value.lower() == "localhost":
        return False
    try:
        ip_address(value)
        return False
    except ValueError:
        pass
    labels = value.rstrip(".").split(".")
    return len(labels) >= 2 and all(_DNS_LABEL_RE.fullmatch(label) for label in labels)


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
    browser_allowed_origins: tuple[str, ...]
    engine_stream_url: str
    ca_bundle_path: str | None = None
    pipe_name: str = r"\\.\pipe\AEGIS.IdentityAgent.v1"
    engine_user_sid: str | None = None
    pipe_timeout_s: float = 5.0

    @property
    def http_timeout(self) -> tuple[float, float]:
        return (self.connect_timeout_s, self.read_timeout_s)

    @property
    def tls_verify(self) -> bool | str:
        return self.ca_bundle_path or True

    @classmethod
    def from_env(cls, source: Mapping[str, str] | None = None) -> "AgentConfig":
        env = os.environ if source is None else source
        for name in UNMANAGED_TLS_TRUST_ENVIRONMENT:
            if str(env.get(name, "")).strip():
                raise ValueError(f"{name} is forbidden; use AEGIS_AGENT_CA_BUNDLE")
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
        raw_ca_bundle = str(env.get("AEGIS_AGENT_CA_BUNDLE", "")).strip()
        if raw_ca_bundle:
            raw_configuration_root = str(env.get("AEGIS_AGENT_CONFIGURATION_ROOT", "")).strip()
            configuration_root = Path(raw_configuration_root)
            if not raw_configuration_root or not configuration_root.is_absolute():
                raise ValueError("AEGIS_AGENT_CONFIGURATION_ROOT is required for a managed CA bundle")
            try:
                root_metadata = os.lstat(configuration_root)
            except OSError as exc:
                raise ValueError("AEGIS_AGENT_CONFIGURATION_ROOT is unavailable") from exc
            if not stat.S_ISDIR(root_metadata.st_mode):
                raise ValueError("AEGIS_AGENT_CONFIGURATION_ROOT must be a directory")
            _reject_reparse_path(configuration_root)
            ca_bundle_path = validate_ca_bundle(raw_ca_bundle)
            expected_bundle = configuration_root.resolve(strict=True) / "agent-ca-bundle.pem"
            if Path(ca_bundle_path) != expected_bundle:
                raise ValueError("AEGIS_AGENT_CA_BUNDLE must use the managed configuration path")
        else:
            ca_bundle_path = None
        connect = _number(env, "AEGIS_AGENT_CONNECT_TIMEOUT_S", "2", 0.1, 10.0)
        read = _number(env, "AEGIS_AGENT_READ_TIMEOUT_S", "5", 0.1, 30.0)
        renew_s = _number(env, "AEGIS_AGENT_RENEW_BEFORE_S", "120", 1.0, 300.0)
        retry_max = _number(env, "AEGIS_AGENT_RETRY_MAX_S", "30", 1.0, 30.0)
        raw_origins = str(env.get("AEGIS_IDENTITY_BROWSER_ALLOWED_ORIGINS", ""))
        browser_allowed_origins = tuple(sorted(normalize_allowed_origins(raw_origins.split(","))))
        raw_stream_url = str(env.get("AEGIS_AGENT_ENGINE_STREAM_URL", "")).strip()
        stream_url = urlsplit(raw_stream_url)
        try:
            stream_port = stream_url.port
        except ValueError as exc:
            raise ValueError("AEGIS_AGENT_ENGINE_STREAM_URL has an invalid port") from exc
        if (
            stream_url.scheme != "http"
            or not _deployment_hostname(stream_url.hostname or "")
            or stream_port is None
            or stream_port < 1
            or stream_port == 80
            or stream_url.path != "/stream.mjpg"
            or stream_url.username is not None
            or stream_url.password is not None
            or stream_url.query
            or stream_url.fragment
        ):
            raise ValueError(
                "AEGIS_AGENT_ENGINE_STREAM_URL must be the credential-free "
                "http://<deployment-hostname>:<explicit-non-default-port>/stream.mjpg tunnel endpoint"
            )
        engine_stream_url = urlunsplit((
            "http",
            f"{stream_url.hostname.lower()}:{stream_port}",
            "/stream.mjpg",
            "",
            "",
        ))
        pipe_name = str(
            env.get("AEGIS_AGENT_PIPE_NAME", r"\\.\pipe\AEGIS.IdentityAgent.v1")
        ).strip()
        if not pipe_name.startswith("\\\\.\\pipe\\") or len(pipe_name) > 256:
            raise ValueError("AEGIS_AGENT_PIPE_NAME must name a bounded local pipe")
        engine_user_sid = str(env.get("AEGIS_AGENT_ENGINE_USER_SID", "")).strip() or None
        if engine_user_sid is not None and _SID_RE.fullmatch(engine_user_sid) is None:
            raise ValueError("AEGIS_AGENT_ENGINE_USER_SID must be a canonical SID")
        pipe_timeout = _number(env, "AEGIS_AGENT_PIPE_TIMEOUT_S", "5", 0.1, 5.0)
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
            browser_allowed_origins=browser_allowed_origins,
            engine_stream_url=engine_stream_url,
            ca_bundle_path=ca_bundle_path,
            pipe_name=pipe_name,
            engine_user_sid=engine_user_sid,
            pipe_timeout_s=pipe_timeout,
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
            "browser_allowed_origins": self.browser_allowed_origins,
            "engine_stream_url": self.engine_stream_url,
            "ca_bundle_state": "MANAGED" if self.ca_bundle_path else "DEFAULT",
            "pipe_name": self.pipe_name,
            "engine_user_sid_configured": self.engine_user_sid is not None,
            "pipe_timeout_s": self.pipe_timeout_s,
        }
