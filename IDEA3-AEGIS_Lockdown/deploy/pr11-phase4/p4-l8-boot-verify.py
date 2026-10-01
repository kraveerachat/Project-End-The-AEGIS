#!/usr/bin/env python3

"""IDEA3 PR11 Phase 4 L8 boot verification: one signed BOOT STATUS, passively.

Owner-approved contract (2026-09-29):

* ``L8_BOOT_SIGNAL=SIGNED_BOOT_STATUS``
* ``L8_BOOT_PASS_SEMANTICS=AUTHENTICATED_FIRMWARE_REPORTED_LOCKDOWN``: PASS means
  an authenticated, fresh BOOT STATUS reporting LOCKDOWN, carrying the seq_hi of
  the NVS just written, was observed after the flash-tool reset boundary. It is
  NOT electrical proof of the relay (``ELECTRICAL_RELAY_PROOF=OUTSIDE_BOOT_VERIFIER``).
* The verifier is subscribe-only by construction. It has no publish path, so it
  can never send COMMAND, HEARTBEAT, CUT or RESTORE. It reuses the staged Core
  broker credential (no new broker user, no ACL change), TLS on 8883 with the
  pinned CA, and the real Protocol v1 ``InboundVerifier`` over ephemeral
  in-memory state. It never touches the Core replay store.
* Deadline 180 s. A contradictory authenticated state (output_state=NORMAL) is
  FAIL. Anything else short of a valid proof is NOT_PROVEN.
* L9 reuses this BOOT event (``L9_REUSES_L8_BOOT_EVENT=YES``). L8 never reboots
  the device to manufacture another one, and leaves PERIODIC, HEARTBEAT and the
  full negative matrix to L9.

Importing this module has no side effect. paho is imported lazily, and this
module deliberately does not import ``aegis_soc.mqtt_client``, ``config`` or
``database`` (``database`` opens a log file at import time).
"""

from __future__ import annotations

import queue
import re
import ssl
import stat
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path

_REPO_DIR = Path(__file__).resolve().parents[2]
if str(_REPO_DIR) not in sys.path:
    sys.path.insert(0, str(_REPO_DIR))

from aegis_soc import protocol_v1 as p1  # noqa: E402
from aegis_soc.protocol_inbound import InboundVerifier  # noqa: E402

BOOT_DEADLINE_SEC = 180
BROKER_PORT = 8883
# The staged Core broker identity (p4-l7-core-env.py AEGIS_MQTT_USER). Reused on
# purpose: no new broker user and no ACL mutation.
BROKER_USER = "idea3-core"
# A frame may not predate the post-identity arming instant by more than this.
SKEW_LOWER_BOUND_SEC = 2
POLL_SLICE_SEC = 1.0
ARM_TIMEOUT_SEC = 30.0
CLIENT_ID_PREFIX = "aegis-l8-boot-"

_STATUS_TOPIC_RE = re.compile(r"aegis/idea3/v1/([a-z0-9][a-z0-9-]{1,30}[a-z0-9])/status")
_DNS_LABEL = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", re.ASCII)
_RUN_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")


class BootVerifyError(RuntimeError):
    """A fail-closed condition. The message never carries secrets or frames."""


# ---------------------------------------------------------------------------
# ephemeral verification state (never the Core replay store)
# ---------------------------------------------------------------------------

class EphemeralSeenStore:
    """The in-memory ``record_seen`` the InboundVerifier needs. Nothing persists."""

    def __init__(self) -> None:
        self._seen: set[tuple[str, str, str]] = set()

    def record_seen(self, device_id: str, msg_id: str, kind: str) -> bool:
        key = (device_id, msg_id, kind)
        if key in self._seen:
            return False
        self._seen.add(key)
        return True


# ---------------------------------------------------------------------------
# TLS (same properties as the Core client: pinned CA, hostname check, TLS 1.2+)
# ---------------------------------------------------------------------------

def _valid_tls_name(name: str) -> bool:
    if not name or len(name) > 253:
        return False
    if re.fullmatch(r"[0-9.]+", name) or ":" in name:
        return False  # an IP literal: the certificate profile has no IP SAN
    return all(_DNS_LABEL.fullmatch(label) for label in name.split("."))


def build_tls_context(ca_file: str, tls_name: str) -> ssl.SSLContext:
    """A verifying context. ``tls_name`` is verified even if the broker is dialled by IP."""
    if not ca_file:
        raise BootVerifyError("an MQTT CA file is required")
    if not _valid_tls_name(tls_name):
        raise BootVerifyError("the MQTT TLS server name must be a DNS name")
    try:
        context = ssl.create_default_context(ssl.Purpose.SERVER_AUTH, cafile=ca_file)
    except (OSError, ssl.SSLError):
        raise BootVerifyError("the pinned MQTT CA file is missing or invalid") from None
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    wrap_socket = context.wrap_socket

    def _named_wrap_socket(sock, *args, **kwargs):
        kwargs["server_hostname"] = tls_name
        return wrap_socket(sock, *args[:3], **kwargs)

    context.wrap_socket = _named_wrap_socket
    return context


def _paho_client(client_id: str):
    import paho.mqtt.client as mqtt  # lazy: never at import time

    return mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id=client_id,
        protocol=mqtt.MQTTv311,
        clean_session=True,
    )


def _refused(reason) -> bool:
    failure = getattr(reason, "is_failure", None)
    if failure is not None:
        return bool(failure)
    return int(getattr(reason, "value", reason)) >= 0x80


# ---------------------------------------------------------------------------
# subscribe-only message source
# ---------------------------------------------------------------------------

class SubscribeOnlySource:
    """Connects, subscribes to ONE status topic, and yields frames. Nothing else.

    The MQTT client is private to this object and only connect, subscribe, loop
    and disconnect are ever called on it: there is no publish method to reach.
    """

    def __init__(
        self,
        *,
        client_factory: Callable[[str], object] | None = None,
        context_factory: Callable[[str, str], object] | None = None,
        address: str,
        tls_name: str,
        ca_file: str,
        username: str,
        password: str,
        topic: str,
        client_id: str,
        port: int = BROKER_PORT,
    ) -> None:
        if port != BROKER_PORT:
            raise BootVerifyError("the boot verifier speaks TLS on 8883 only")
        if _STATUS_TOPIC_RE.fullmatch(topic or "") is None:
            raise BootVerifyError("the boot verifier subscribes to one device status topic only")
        for label, value in (("address", address), ("tls name", tls_name), ("CA file", ca_file),
                             ("username", username), ("credential", password), ("client id", client_id)):
            if not value:
                raise BootVerifyError(f"the boot verifier requires a {label}")
        self._factory = client_factory or _paho_client
        self._context_factory = context_factory or build_tls_context
        self._address = address
        self._tls_name = tls_name
        self._ca_file = ca_file
        self._username = username
        self._password = password
        self._topic = topic
        self._client_id = client_id
        self._port = port
        self._link = None
        self._frames: queue.Queue = queue.Queue()
        self._connected = threading.Event()
        self._subscribed = threading.Event()
        self._error: str | None = None

    # paho VERSION2 callbacks -------------------------------------------------
    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        if _refused(reason_code) or int(getattr(reason_code, "value", reason_code)) != 0:
            self._error = "the broker refused the connection"
        self._connected.set()

    def _on_subscribe(self, client, userdata, mid, reason_codes, properties=None):
        if any(_refused(code) for code in reason_codes):
            self._error = "the broker refused the status subscription"
        self._subscribed.set()

    def _on_message(self, client, userdata, msg):
        if msg.topic == self._topic:
            self._frames.put((msg.topic, bytes(msg.payload), bool(getattr(msg, "retain", False))))

    def arm(self) -> None:
        """Connect and subscribe. Any failure aborts before the first device write."""
        context = self._context_factory(self._ca_file, self._tls_name)
        link = self._factory(self._client_id)
        self._link = link
        link.on_connect = self._on_connect
        link.on_subscribe = self._on_subscribe
        link.on_message = self._on_message
        link.tls_set_context(context)
        link.username_pw_set(self._username, self._password)
        try:
            link.connect(self._address, self._port, 60)
            link.loop_start()
        except Exception:
            self.close()
            raise BootVerifyError("could not connect to the broker") from None
        if not self._connected.wait(ARM_TIMEOUT_SEC) or self._error:
            self.close()
            raise BootVerifyError(self._error or "timed out connecting to the broker")
        link.subscribe([(self._topic, 0)])
        if not self._subscribed.wait(ARM_TIMEOUT_SEC) or self._error:
            self.close()
            raise BootVerifyError(self._error or "timed out subscribing to the status topic")

    def next_message(self, timeout: float):
        try:
            return self._frames.get(timeout=max(timeout, 0.0))
        except queue.Empty:
            return None

    def close(self) -> None:
        link, self._link = self._link, None
        if link is None:
            return
        for step in ("loop_stop", "disconnect"):
            try:
                getattr(link, step)()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# the verifier
# ---------------------------------------------------------------------------

class BootVerifier:
    """Arm before the first write; collect the verdict after the reboot boundary."""

    def __init__(
        self,
        source,
        *,
        keys: p1.ProtocolKeys,
        device_id: str,
        expected_seq_hi: int,
        clock,
        monotonic: Callable[[], float] = time.monotonic,
        deadline_sec: float = BOOT_DEADLINE_SEC,
    ) -> None:
        self._source = source
        self._device_id = device_id
        self._clock = clock
        self._monotonic = monotonic
        self._deadline = deadline_sec
        self.expected_seq_hi = int(expected_seq_hi)
        self._seen = EphemeralSeenStore()
        self._inbound = InboundVerifier(
            keys=keys, device_id=device_id, store=self._seen, clock=clock
        )
        self._t0: int | None = None
        self.detail = "NOT_RUN"

    def arm(self) -> None:
        """Subscribe and fix T0, the lower time bound of the post-flash window."""
        t0 = self._clock.trusted_now()
        if t0 is None:
            raise BootVerifyError("the Core trusted clock is not trusted; refusing to arm")
        self._source.arm()
        self._t0 = int(t0)

    def collect(self) -> str:
        if self._t0 is None:
            self.detail = "NOT_ARMED"
            return "NOT_PROVEN"
        try:
            return self._collect()
        except Exception:
            self.detail = "VERIFIER_ERROR"
            return "NOT_PROVEN"
        finally:
            self._source.close()

    __call__ = collect

    def close(self) -> None:
        """Release the connection on any path that never reached collect()."""
        self._source.close()

    def _collect(self) -> str:
        end = self._monotonic() + self._deadline
        while True:
            remaining = end - self._monotonic()
            if remaining <= 0:
                self.detail = "NO_VALID_FRAME_BEFORE_DEADLINE"
                return "NOT_PROVEN"
            item = self._source.next_message(min(remaining, POLL_SLICE_SEC))
            if item is None:
                continue
            topic, payload, retain = item
            # Real Protocol v1 semantics: transport, schema, payload, Core time,
            # MAC (k_d2c), authenticated skew, then replay. Ephemeral store.
            result = self._inbound.process(topic, payload, retain)
            if not result.accepted:
                continue  # unauthenticated or stale noise can never decide a verdict
            fields = result.message.fields
            if int(fields["device_time"]) < self._t0 - SKEW_LOWER_BOUND_SEC:
                continue  # authenticated, but not from the post-flash window
            if fields["output_state"] == "NORMAL":
                self.detail = "CONTRADICTORY_OUTPUT_STATE"
                return "FAIL"
            if (
                fields["reason"] == "BOOT"
                and fields["output_state"] == "LOCKDOWN"
                and fields["time_trust"] == "SYNCED"
                and fields["cmd_msg_id"] == ""
                and int(fields["cmd_seq"]) == 0
                and int(fields["device_seq_hwm"]) == self.expected_seq_hi
            ):
                self.detail = "PASS_BOOT_LOCKDOWN"
                return "PASS"


# ---------------------------------------------------------------------------
# live construction from owner-supplied private inputs (no I/O until arm())
# ---------------------------------------------------------------------------

def _read_private(path: Path, label: str) -> str:
    path = Path(path)
    try:
        metadata = path.lstat()
    except OSError:
        raise BootVerifyError(f"{label} is missing or unreadable") from None
    if not stat.S_ISREG(metadata.st_mode):
        raise BootVerifyError(f"{label} must be a regular file, not a symlink")
    if metadata.st_mode & 0o077:
        raise BootVerifyError(f"{label} must be owner-only (0600 or 0400)")
    return path.read_text(encoding="utf-8")


def build_live_boot_verifier(
    *,
    input_dir: Path,
    device_id: str,
    expected_seq_hi: int,
    broker_address: str,
    tls_name: str,
    ca_file: str,
    credential_file: Path,
    run_id: str,
    client_factory: Callable[[str], object] | None = None,
    clock=None,
) -> BootVerifier:
    """Build the verifier. Reads private inputs only; opens no connection."""
    if _RUN_ID_RE.fullmatch(str(run_id)) is None:
        raise BootVerifyError("run id is not a safe client-id suffix")
    input_dir = Path(input_dir)
    try:
        keys = p1.load_protocol_keys(input_dir / "k_c2d", input_dir / "k_d2c")
    except p1.ProtocolKeyError as exc:
        raise BootVerifyError(f"protocol keys refused: {exc}") from None
    password = _read_private(Path(credential_file), "broker credential").strip()
    if not password or not password.isascii() or not password.isprintable():
        raise BootVerifyError("broker credential is empty or not printable ASCII")
    if clock is None:
        from aegis_soc.trusted_time import TrustedClock

        clock = TrustedClock()
    source = SubscribeOnlySource(
        client_factory=client_factory,
        address=broker_address,
        tls_name=tls_name,
        ca_file=str(ca_file),
        username=BROKER_USER,
        password=password,
        topic=p1.topics(device_id).status,
        client_id=f"{CLIENT_ID_PREFIX}{run_id}",
    )
    return BootVerifier(
        source,
        keys=keys,
        device_id=device_id,
        expected_seq_hi=expected_seq_hi,
        clock=clock,
    )
