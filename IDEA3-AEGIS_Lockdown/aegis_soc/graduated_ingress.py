"""IDEA3 graduated response: the version-2 alert contract on the existing Core-local F1 alert socket.

A separate module on purpose: ``recovery_core.AlertIngress`` (the reviewed production R1 ingress) stays byte-unchanged.
The Core uses this subclass only when ``AEGIS_GRADUATED_RESPONSE=YES``. It accepts everything the reviewed ingress
accepts (version 1) plus version 2, which adds what the detector observed:

    {"v": 2, "attacker_ip": "<IPv4>", "kind": "port_scan" | "ssh_brute_force" | "syn_flood" | "ssh_login_after_failures"}

The kind describes an observation, never an action. Core-side evidence (a failed block, activity after a block,
distributed sources) can never be claimed by a sender. Peer, rate-limit and audit behaviour are inherited unchanged.
"""

from __future__ import annotations

from typing import Any

from . import database as db
from . import local_restore as lr
from . import recovery_core as rc
from . import recovery_protocol as rp
from .ip_containment import ContainmentRejected, validate_block_target

KEYS_V1 = frozenset({"v", "attacker_ip"})
KEYS_V2 = frozenset({"v", "attacker_ip", "kind"})
KINDS_V2 = frozenset({"port_scan", "ssh_brute_force", "syn_flood", "ssh_login_after_failures"})


def parse_alert_with_kind(body: Any) -> tuple[str, str | None]:
    """``(address, None)`` for a version-1 alert, ``(address, kind)`` for version 2; anything else is refused."""
    if not isinstance(body, dict):
        raise rc.AlertRequestError("MALFORMED_REQUEST")
    version = body.get("v")
    if type(version) is not int:
        raise rc.AlertRequestError("MALFORMED_REQUEST")
    if version == 1 and set(body) == KEYS_V1:
        kind = None
    elif version == 2 and set(body) == KEYS_V2:
        kind = body["kind"]
        if type(kind) is not str or kind not in KINDS_V2:
            raise rc.AlertRequestError("MALFORMED_REQUEST")
    else:
        raise rc.AlertRequestError("MALFORMED_REQUEST")
    try:
        # The same address rules as the reviewed ingress and the root helper.
        return str(validate_block_target(body["attacker_ip"], ())), kind
    except ContainmentRejected:
        raise rc.AlertRequestError("BAD_ADDRESS") from None


class GraduatedAlertIngress(rc.AlertIngress):
    """``AlertIngress`` with the version-2 contract and the lab ``OBSERVED`` outcome."""

    @staticmethod
    def _audit_accepted(peer: lr.Peer, address: str, result: dict[str, Any]) -> None:
        if result.get("action") == "OBSERVED":
            try:
                db.log_event("ALERT_ACCEPTED", f"uid={peer.uid} pid={peer.pid} attacker_ip={address} action=OBSERVED", db.INFO)
            except Exception:
                pass
            return
        rc.AlertIngress._audit_accepted(peer, address, result)

    def handle(self, body: Any, peer: lr.Peer, *, allowed_uid: int) -> dict[str, Any]:
        if peer.uid != allowed_uid:
            self._audit_limited("ALERT_PEER_REFUSED", f"uid={peer.uid} pid={peer.pid}")
            return rp.response(False, "PEER_REFUSED", "request is not from the configured alert source")
        if not self._take_token():
            self._audit_limited("ALERT_RATE_LIMITED", "alert rate limit reached; further alerts are dropped")
            return rp.response(False, "RATE_LIMITED", "alert rate limit reached")
        try:
            address, kind = parse_alert_with_kind(body)
        except rc.AlertRequestError as error:
            try:
                db.log_event("ALERT_REFUSED", f"code={error.code} uid={peer.uid} pid={peer.pid}", db.WARN)
            except Exception:
                pass
            return rp.response(False, error.code, "invalid alert request")
        try:
            result = self._on_alert(address) if kind is None else self._on_alert(address, kind)
        except Exception:
            return rp.response(False, "ALERT_FAILED", "the alert could not be recorded; nothing was done")
        action = result.get("action")
        self._audit_accepted(peer, address, result)
        if action == "OBSERVED":
            return rp.response(True, "OBSERVED", "the evidence was recorded by the lab graduated response")
        if action == "SKIPPED":
            return rp.response(False, "NOT_PRODUCTION", "alerts are accepted on a production Core only")
        if action == "REFUSED":
            return rp.response(False, "BAD_ADDRESS", "the address is not an attacker candidate")
        if action == "IGNORED_DIFFERENT_IP":
            return rp.response(False, "IGNORED_DIFFERENT_IP", "an incident is already bound to a different address")
        if result.get("audited") is False:
            return rp.response(False, "AUDIT_UNAVAILABLE", "the incident was bound but its audit row could not be written")
        if action == "EXISTING":
            return rp.response(True, "EXISTING", "the incident is already bound to this address")
        return rp.response(True, "BOUND", "the incident was bound to this address")
