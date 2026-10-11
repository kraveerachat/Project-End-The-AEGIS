"""Desktop-side client and truthful lifecycle for the Core-local manual CUT channel (stdlib only).

This module is deliberately free of ``aegis_soc`` imports, MQTT, databases and Tk so the isolated Desktop launcher can load it by
path. It speaks the one bounded request/response protocol of ``aegis_soc.local_cut`` over the Core-owned AF_UNIX socket and
reports exactly what the Core said, no more:

  * The Core verifies the per-CUT secret, writes the strict pre-dispatch audit and dispatches. This client only carries them.
  * A MQTT ACK or a device-reported STATUS is PROTOCOL evidence. Physical disconnection is never claimed here.
  * A lost reply is OUTCOME_UNKNOWN and is never retried automatically.
  * Nothing about the secret is stored: it exists only inside one ``submit`` call.
"""

from __future__ import annotations

import json
import os
import socket
import struct
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

# Wire constants. tests/test_cut_client.py asserts they equal aegis_soc.local_cut's.
CUT_ORIGIN = "core-local-cut"
CONFIRMATION = "CUT UPLINK"
EVIDENCE_OP = "CUT_EVIDENCE"
MAX_MESSAGE_BYTES = 16_384
REASON_MIN_CHARS = 12
REASON_MAX_CHARS = 240
DEFAULT_CORE_USER = "aegis-idea3"
CORE_USER_ENV = "AEGIS_RECOVERY_CORE_USER"
EVIDENCE_TIMEOUT_SEC = 60.0
MAX_EVIDENCE_ERRORS = 3

# Severities for the UI.
OK, INFO, WARN, CRITICAL = "OK", "INFO", "WARN", "CRITICAL"


class ChannelUnavailable(RuntimeError):
    """No trusted Core channel accepted the request; nothing was sent."""


class OutcomeUnknown(RuntimeError):
    """The Core may have acted but no bounded answer arrived. Never retried automatically."""


def core_uid(environ=None) -> int:
    import pwd

    env = os.environ if environ is None else environ
    try:
        return pwd.getpwnam(env.get(CORE_USER_ENV, "").strip() or DEFAULT_CORE_USER).pw_uid
    except KeyError:
        raise ChannelUnavailable("the Core account cannot be resolved") from None


def _peer_uid(connection: socket.socket) -> int:
    raw = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    return struct.unpack("3i", raw)[1]


def send_request(path, body: dict, *, expected_uid: int, timeout: float = 5.0) -> dict:
    """One bounded request. The server must be the Core account; the peer is checked BEFORE anything is sent."""
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(timeout)
    connected = False
    try:
        client.connect(str(path))
        connected = True
        if _peer_uid(client) != expected_uid:
            raise ChannelUnavailable("the CUT server is not the Core account")
        client.sendall(json.dumps(body, ensure_ascii=False).encode("utf-8") + b"\n")
        reply = client.makefile("rb").readline(MAX_MESSAGE_BYTES + 1)
        if not reply or len(reply) > MAX_MESSAGE_BYTES:
            raise OutcomeUnknown("the Core returned no bounded result")
        try:
            response = json.loads(reply.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError):
            raise OutcomeUnknown("the Core returned an invalid result") from None
        if not isinstance(response, dict):
            raise OutcomeUnknown("the Core returned an invalid result")
        return response
    except (ChannelUnavailable, OutcomeUnknown):
        raise
    except OSError:
        if connected:
            raise OutcomeUnknown("the result was lost") from None
        raise ChannelUnavailable("the Core CUT channel is unavailable") from None
    finally:
        client.close()


def cut_request(reason: str, secret: str) -> dict:
    return {"v": 1, "op": "CUT_UPLINK", "origin": CUT_ORIGIN, "confirmation": CONFIRMATION,
            "reason": reason, "secret": secret}


def evidence_request(msg_id: str) -> dict:
    return {"v": 1, "op": EVIDENCE_OP, "msg_id": msg_id}


def reason_problem(reason) -> str | None:
    """Local pre-check only; the Core re-validates everything."""
    if not isinstance(reason, str) or not reason.strip():
        return "A reason is required."
    text = reason.strip()
    if not (REASON_MIN_CHARS <= len(text) <= REASON_MAX_CHARS) or not text.isprintable():
        return f"The reason must be {REASON_MIN_CHARS}-{REASON_MAX_CHARS} printable characters."
    return None


@dataclass(frozen=True)
class View:
    """What the operator is told. ``state`` is machine-readable; ``text`` is the truthful sentence."""

    state: str
    text: str
    severity: str
    terminal: bool
    msg_id: str | None = None


# Core refusal / result codes -> (state, severity, text). Wording never implies a physical result.
_CODES = {
    "CUT_PUBLISHED": ("PUBLISHED", INFO, "CUT published by the Core. Waiting for device ACK. Physical state is NOT proven."),
    "CUT_QUEUED": ("QUEUED", WARN, "CUT accepted but queued behind an in-flight RESTORE; it has no command id yet. "
                                    "Check Core evidence before acting again."),
    "CUT_DRY_RUN": ("DRY_RUN", WARN, "The Core is in dry-run mode. Nothing was sent to the device."),
    "AUTH_REQUIRED": ("REFUSED_AUTH", WARN, "Operator authentication is required. Nothing was sent."),
    "AUTH_FAILED": ("REFUSED_AUTH", WARN, "Authentication failed. Nothing was sent."),
    "AUTH_LOCKED_OUT": ("REFUSED_LOCKED", WARN, "Authentication is temporarily locked after repeated failures. Nothing was sent."),
    "AUDIT_UNAVAILABLE": ("REFUSED_AUDIT", CRITICAL, "The Core could not write its durable audit record. Nothing was sent."),
    "COMMAND_PENDING": ("REFUSED_PENDING", WARN, "Another command is still awaiting its ACK. Nothing new was sent."),
    "CORE_TIME_UNTRUSTED": ("REFUSED_TIME", CRITICAL, "The Core clock is not trusted. Nothing was sent."),
    "MQTT_UNAVAILABLE": ("NOT_SENT", CRITICAL, "The Core could not reach its broker. Nothing was sent."),
    "EXPIRED_AT_CORE": ("NOT_SENT", WARN, "The command expired at the Core. Nothing was sent."),
    "PROTOCOL_STORE_UNAVAILABLE": ("NOT_SENT", CRITICAL, "The Core protocol store is unavailable. Nothing was sent."),
    "PROTOCOL_NOT_CONFIGURED": ("NOT_SENT", CRITICAL, "The Core protocol is not configured. Nothing was sent."),
    "PEER_REFUSED": ("REFUSED_PEER", CRITICAL, "The Core does not accept this operator account."),
    "ORIGIN_REFUSED": ("REFUSED_INPUT", WARN, "The Core rejected the request origin. Nothing was sent."),
    "UNKNOWN_COMMAND": ("REFUSED_OTHER", WARN, "The Core has no CUT command with that identifier."),
    "CONFIRMATION_REQUIRED": ("REFUSED_INPUT", WARN, "The typed confirmation was not accepted. Nothing was sent."),
    "REASON_REQUIRED": ("REFUSED_INPUT", WARN, "A reason is required. Nothing was sent."),
    "REASON_INVALID": ("REFUSED_INPUT", WARN, "The reason was not accepted. Nothing was sent."),
    "MALFORMED_REQUEST": ("REFUSED_INPUT", WARN, "The Core rejected the request format. Nothing was sent."),
    "CHANNEL_CLOSING": ("NOT_SENT", WARN, "The Core CUT channel is closing. Nothing was sent."),
}


def describe_code(code, ok: bool, msg_id=None) -> View:
    state, severity, text = _CODES.get(
        code, ("REFUSED_OTHER" if not ok else "ACCEPTED_OTHER", WARN, f"The Core answered {code!s}. Verify with Core evidence."),
    )
    return View(state, text, severity, state != "PUBLISHED", msg_id)


def describe_evidence(ladder: dict, msg_id: str) -> View:
    """Map the Core's protocol evidence ladder to an honest lifecycle state. Physical proof is never inferred."""
    published = ladder.get("published")
    ack = ladder.get("ack")
    executed = ladder.get("executed")
    if published == "NOT_PUBLISHED":
        return View("NOT_SENT", "The Core reports the command was NOT published.", WARN, True, msg_id)
    if published != "PUBLISHED":
        return View("OUTCOME_UNKNOWN", "The Core cannot confirm publication. Do not assume the CUT happened.", CRITICAL, True, msg_id)
    if ack == "PENDING":
        return View("ACK_PENDING", "Published. Waiting for the device ACK. Physical state is NOT proven.", INFO, False, msg_id)
    if ack == "ACCEPTED":
        if executed == "DEVICE_REPORTED_LOCKDOWN":
            return View("DEVICE_REPORTED_LOCKDOWN",
                        "The device ACKed and reported LOCKDOWN (protocol evidence). Physical disconnection is NOT proven; "
                        "verify with the cable tester.", OK, True, msg_id)
        if executed == "DEVICE_STATUS_CORRELATED":
            return View("DEVICE_STATUS_CORRELATED",
                        "The device ACKed and sent a correlated STATUS, but this Core process did not observe the final state. "
                        "Physical state is NOT proven.", WARN, True, msg_id)
        return View("ACK_ACCEPTED", "The device ACKed. Waiting for its STATUS. Physical state is NOT proven.", INFO, False, msg_id)
    if ack == "OUTCOME_UNKNOWN":
        return View("OUTCOME_UNKNOWN", "The Core cannot tell whether the device received the CUT. Do not assume it happened.",
                    CRITICAL, True, msg_id)
    if isinstance(ack, str) and ack.startswith("REJECTED"):
        return View("REJECTED", f"The device REJECTED the CUT ({ack}). The network was NOT cut by this command.", CRITICAL,
                    True, msg_id)
    return View("OUTCOME_UNKNOWN", f"Unrecognized ACK evidence ({ack!s}). Do not assume the CUT happened.", CRITICAL, True, msg_id)


class ManualCutFlow:
    """One manual CUT at a time: submit, then poll the Core's evidence until a terminal, honest state."""

    def __init__(
        self, socket_path, *, expected_uid: int | None = None, send: Callable[..., dict] = send_request,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.socket_path = str(socket_path)
        self._expected_uid = expected_uid
        self._send = send
        self._monotonic = monotonic
        self._lock = threading.Lock()
        self._submitting = False
        self._tracking: tuple[str, float] | None = None
        self._evidence_errors = 0
        self.view = View("IDLE", "No manual CUT in progress.", INFO, True)

    @property
    def busy(self) -> bool:
        return self._submitting or self._tracking is not None

    def _uid(self) -> int:
        if self._expected_uid is None:
            self._expected_uid = core_uid()
        return self._expected_uid

    def submit(self, reason: str, secret: str) -> View:
        """Send ONE CUT request. Never retries; refuses locally if one is already in flight."""
        with self._lock:
            if self.busy:
                return View("REFUSED_BUSY", "A manual CUT is already in progress. Nothing new was sent.", WARN, False,
                            self._tracking[0] if self._tracking else None)
            problem = reason_problem(reason)
            if problem:
                self.view = View("REFUSED_INPUT", problem + " Nothing was sent.", WARN, True)
                return self.view
            if not isinstance(secret, str) or not secret:
                self.view = View("REFUSED_AUTH", "Operator authentication is required. Nothing was sent.", WARN, True)
                return self.view
            self._submitting = True
        try:
            try:
                response = self._send(self.socket_path, cut_request(reason.strip(), secret), expected_uid=self._uid())
            except OutcomeUnknown:
                view = View("OUTCOME_UNKNOWN", "The result was lost. The CUT may or may not have happened. Do NOT assume either; "
                            "check Core evidence. It was not retried.", CRITICAL, True)
            except ChannelUnavailable as error:
                view = View("CHANNEL_UNAVAILABLE", f"{error}. Nothing was sent.", CRITICAL, True)
            else:
                code, ok = response.get("code"), bool(response.get("ok"))
                msg_id = response.get("msg_id") if isinstance(response.get("msg_id"), str) else None
                view = describe_code(code, ok, msg_id)
                if code == "CUT_PUBLISHED" and msg_id:
                    self._tracking = (msg_id, self._monotonic())
                    self._evidence_errors = 0
                elif code == "CUT_PUBLISHED":
                    view = View("OUTCOME_UNKNOWN", "The Core reported a publish without a command id. Verify with Core evidence.",
                                CRITICAL, True)
        finally:
            secret = None
            with self._lock:
                self._submitting = False
        self.view = view
        return view

    def poll(self) -> View:
        """Advance the evidence lifecycle by one query. Terminal states stop the tracking."""
        with self._lock:
            tracking = self._tracking
        if tracking is None:
            return self.view
        msg_id, started = tracking
        try:
            response = self._send(self.socket_path, evidence_request(msg_id), expected_uid=self._uid())
        except (OutcomeUnknown, ChannelUnavailable):
            self._evidence_errors += 1
            if self._evidence_errors >= MAX_EVIDENCE_ERRORS:
                return self._finish(View("EVIDENCE_UNAVAILABLE", "The Core evidence cannot be read. The CUT was published; its "
                                         "ACK/STATUS is unknown. Do not assume success.", CRITICAL, True, msg_id))
            return self.view
        self._evidence_errors = 0
        if response.get("ok") and isinstance(response.get("evidence"), dict):
            view = describe_evidence(response["evidence"], msg_id)
        else:
            view = View("EVIDENCE_UNAVAILABLE", "The Core did not return evidence for this command.", CRITICAL, True, msg_id)
        if not view.terminal and self._monotonic() - started >= EVIDENCE_TIMEOUT_SEC:
            view = View("NO_ACK_TIMEOUT", f"No device ACK/STATUS within {int(EVIDENCE_TIMEOUT_SEC)} s. The outcome is unknown; "
                        "the CUT was NOT retried. Physical state is NOT proven.", CRITICAL, True, msg_id)
        if view.terminal:
            return self._finish(view)
        self.view = view
        return view

    def _finish(self, view: View) -> View:
        with self._lock:
            self._tracking = None
        self.view = view
        return view
