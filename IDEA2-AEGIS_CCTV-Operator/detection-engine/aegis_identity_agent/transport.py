"""Authenticated outbound Monitor transport owned by the Identity Agent."""

from __future__ import annotations

import base64
from dataclasses import dataclass
from hashlib import sha256
import json
import os
import time

from .protocol import REQUEST_PROOFS, canonical_request_payload
from .pipe_protocol import PipeProtocolError, validate_operation_payload
from .sequence import SequenceExhausted


@dataclass(frozen=True)
class TransportResult:
    ok: bool
    status: int | None
    error: str | None = None


def _canonical_nonce(random_bytes) -> str:
    for _ in range(128):
        value = base64.urlsafe_b64encode(random_bytes(16)).rstrip(b"=").decode("ascii")
        if value and value[0].isalnum():
            return value
    raise RuntimeError("request nonce allocation failed")


class AgentTransport:
    def __init__(self, config, session_client, signer, *, http=None, now_ms=None, random_bytes=None):
        self.config = config
        self._sessions = session_client
        self._signer = signer
        if http is None:
            import requests
            http = requests.Session()
            http.trust_env = False
        self._http = http
        self._now_ms = now_ms or (lambda: int(time.time() * 1000))
        self._random_bytes = random_bytes or os.urandom

    def submit(self, operation: str, payload: dict) -> TransportResult:
        proof = REQUEST_PROOFS.get(operation)
        try:
            validate_operation_payload(operation, payload)
        except PipeProtocolError:
            return TransportResult(False, None, "INVALID_OPERATION")
        # The unprivileged Engine can submit availability metrics, but cannot
        # choose identity, logical alias, or a URL for Monitor to fetch. The
        # dedicated Agent adds its reviewed local reverse-tunnel endpoint only
        # after the closed pipe schema has rejected Engine-owned authority.
        outbound_payload = (
            {**payload, "streamUrl": self.config.engine_stream_url}
            if operation == "heartbeat"
            else payload
        )
        body = json.dumps(outbound_payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(body) > 16 * 1024:
            return TransportResult(False, None, "INVALID_PAYLOAD")
        try:
            session = self._sessions.ensure_session()
            sequence = self._sessions.sequences.next()
            nonce = _canonical_nonce(self._random_bytes)
            timestamp = int(self._now_ms())
            message = canonical_request_payload({
                "domain": proof["domain"],
                "sessionId": session.session_id,
                "requestNonce": nonce,
                "timestampMs": timestamp,
                "sequence": sequence,
                "method": proof["method"],
                "path": proof["path"],
                "bodySha256": sha256(body).hexdigest(),
            })
            signature = base64.urlsafe_b64encode(self._signer.sign(message)).rstrip(b"=").decode("ascii")
            response = self._http.post(
                f"{self.config.monitor_base_url}{proof['path']}",
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "X-Aegis-Agent-Session": session.session_id,
                    "X-Aegis-Request-Nonce": nonce,
                    "X-Aegis-Request-Timestamp": str(timestamp),
                    "X-Aegis-Request-Sequence": str(sequence),
                    "X-Aegis-Request-Signature": signature,
                },
                timeout=self.config.http_timeout,
                verify=self.config.tls_verify,
                allow_redirects=False,
            )
        except SequenceExhausted:
            self._sessions.invalidate()
            return TransportResult(False, None, "SESSION_EXHAUSTED")
        except Exception:
            return TransportResult(False, None, "AGENT_UNAVAILABLE")
        if response.status_code == 401:
            # Invalidate for the *next* event. Never replay an already-signed
            # detection/heartbeat across an Agent-session boundary.
            self._sessions.invalidate()
        return TransportResult(
            200 <= response.status_code < 300,
            response.status_code,
            None if 200 <= response.status_code < 300 else "MONITOR_REJECTED",
        )
