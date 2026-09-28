"""In-memory Monitor Agent-session acquisition and renewal."""

from __future__ import annotations

import base64
from dataclasses import dataclass
import threading
import time

from .protocol import canonical_auth_payload, parse_canonical_token, parse_uint
from .sequence import SequenceAllocator


class AgentAuthenticationError(RuntimeError):
    pass


@dataclass(frozen=True)
class AgentSession:
    session_id: str
    expires_at_ms: int


class AgentSessionClient:
    def __init__(self, config, signer, *, http=None, now_ms=None):
        self.config = config
        self._signer = signer
        if http is None:
            import requests
            http = requests.Session()
            http.trust_env = False
        self._http = http
        self._now_ms = now_ms or (lambda: int(time.time() * 1000))
        self._lock = threading.RLock()
        self._session = None
        self.sequences = SequenceAllocator()
        self.camera_demand_side_effects = 0

    def ensure_session(self, *, force=False) -> AgentSession:
        with self._lock:
            now = int(self._now_ms())
            current = self._session
            if current and now >= current.expires_at_ms:
                self._session = None
                current = None
            if current and not force and current.expires_at_ms - now > self.config.renew_before_ms:
                return current
            try:
                replacement = self._authenticate()
            except AgentAuthenticationError:
                if current and now < current.expires_at_ms:
                    return current
                raise
            self._session = replacement
            self.sequences = SequenceAllocator()
            return replacement

    def invalidate(self) -> None:
        with self._lock:
            self._session = None
            self.sequences = SequenceAllocator()

    def _authenticate(self) -> AgentSession:
        challenge_url = f"{self.config.monitor_base_url}/internal/agent-auth/challenge"
        verify_url = f"{self.config.monitor_base_url}/internal/agent-auth/verify"
        try:
            response = self._http.post(
                challenge_url,
                json={"nodeId": self.config.node_id},
                timeout=self.config.http_timeout,
                verify=self.config.tls_verify,
            )
            if response.status_code != 200:
                raise AgentAuthenticationError("Agent authentication unavailable")
            challenge = response.json()
            canonical = canonical_auth_payload(challenge)
            if (
                challenge.get("audience") != self.config.audience
                or challenge.get("nodeId") != self.config.node_id
                or parse_uint(challenge.get("keyVersion"), label="key version", positive=True, max_value=(1 << 32) - 1)
                != self.config.key_version
                or int(self._now_ms()) >= parse_uint(challenge.get("expiresAtMs"), label="expires at")
            ):
                raise AgentAuthenticationError("Agent authentication failed")
            signature = base64.urlsafe_b64encode(self._signer.sign(canonical)).rstrip(b"=").decode("ascii")
            response = self._http.post(
                verify_url,
                json={"challengeId": challenge["challengeId"], "signature": signature},
                timeout=self.config.http_timeout,
                verify=self.config.tls_verify,
            )
            if response.status_code != 200:
                raise AgentAuthenticationError("Agent authentication failed")
            body = response.json()
            session_id = parse_canonical_token(body.get("sessionId"), 32, "session id")
            expires_at = parse_uint(body.get("expiresAtMs"), label="session expiry")
            if int(self._now_ms()) >= expires_at:
                raise AgentAuthenticationError("Agent authentication failed")
            return AgentSession(session_id=session_id, expires_at_ms=expires_at)
        except AgentAuthenticationError:
            raise
        except Exception as exc:
            raise AgentAuthenticationError("Agent authentication unavailable") from exc
