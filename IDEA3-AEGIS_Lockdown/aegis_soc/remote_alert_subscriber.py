"""IDEA3 remote alerts: the Core-side MQTT subscriber and its fail-closed settings.

Inert unless ``AEGIS_REMOTE_ALERTS=YES`` (and the graduated response is enabled; the supervisor checks that). Every setting is
mandatory when enabled: a half-configured ingress does not start, it reports why. The subscriber connects to the broker over
mutual TLS with the Core's OWN client certificate, subscribes to exactly one topic per allowed source (never a wildcard) and
hands each message to ``remote_alert.RemoteAlertVerifier``. It does not trust the broker's word about who published: only an
alert whose own certificate and signature verify is passed on, anything else is reported as a refusal and dropped.

Environment (all read when the ingress starts, never at import)::

    AEGIS_REMOTE_ALERTS=YES
    AEGIS_REMOTE_ALERT_BROKER_HOST, AEGIS_REMOTE_ALERT_BROKER_PORT (default 8883)
    AEGIS_REMOTE_ALERT_CA_FILE            CA that signed the broker certificate (the broker is verified, hostname included)
    AEGIS_REMOTE_ALERT_TLS_SERVER_NAME    optional DNS name to verify the broker against when reached by address
    AEGIS_REMOTE_ALERT_CORE_CERT / _CORE_KEY   the Core's client certificate for the broker (mTLS)
    AEGIS_REMOTE_ALERT_CLIENT_CA_FILE     CA that signs the SENDERS' certificates (may be the same file)
    AEGIS_REMOTE_ALERT_SOURCES            comma list of source ids, e.g. "beelink"
    AEGIS_REMOTE_ALERT_PIN_<SOURCE>       optional lowercase SHA-256 of the sender leaf certificate (comma list allowed)
    AEGIS_REMOTE_RELAY_<SOURCE>           NONE (default) | DRYRUN | LAB_RELAY (lab profile only)
"""

from __future__ import annotations

import os
import ssl
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field

from . import remote_alert as ra
from . import remote_response as rr


class SettingsError(Exception):
    """The remote alert ingress is enabled but cannot be started safely. ``code`` is a stable token."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class RemoteSettings:
    host: str
    port: int
    ca_file: str
    tls_server_name: str
    core_cert: str
    core_key: str
    client_ca_file: str
    sources: Mapping[str, ra.SourcePolicy]
    relays: Mapping[str, str] = field(default_factory=dict)


def enabled(environ: Mapping[str, str]) -> bool:
    return environ.get("AEGIS_REMOTE_ALERTS", "") == "YES"


def _env_suffix(source: str) -> str:
    return source.upper().replace("-", "_")


def load_settings(environ: Mapping[str, str], *, profile: str) -> RemoteSettings | None:
    """``None`` when not enabled. Raises ``SettingsError`` for any missing, unreadable or unsafe setting."""
    if not enabled(environ):
        return None
    host = environ.get("AEGIS_REMOTE_ALERT_BROKER_HOST", "").strip()
    if not host:
        raise SettingsError("BROKER_HOST_MISSING")
    try:
        port = int(environ.get("AEGIS_REMOTE_ALERT_BROKER_PORT", "8883"))
    except ValueError:
        raise SettingsError("BROKER_PORT_INVALID") from None
    if not 1 <= port <= 65535:
        raise SettingsError("BROKER_PORT_INVALID")
    paths = {}
    for name, code in (("CA_FILE", "CA_FILE_UNREADABLE"), ("CORE_CERT", "CORE_CERT_UNREADABLE"),
                       ("CORE_KEY", "CORE_KEY_UNREADABLE"), ("CLIENT_CA_FILE", "CLIENT_CA_UNREADABLE")):
        value = environ.get(f"AEGIS_REMOTE_ALERT_{name}", "").strip()
        if not value or not value.startswith("/") or not os.path.isfile(value) or not os.access(value, os.R_OK):
            raise SettingsError(code)
        paths[name] = value
    if os.stat(paths["CORE_KEY"]).st_mode & 0o077:
        raise SettingsError("CORE_KEY_PERMISSIONS")
    names = [item.strip() for item in environ.get("AEGIS_REMOTE_ALERT_SOURCES", "").split(",") if item.strip()]
    if not names or any(not ra.valid_source(name) for name in names) or len(set(names)) != len(names):
        raise SettingsError("SOURCES_INVALID")
    server_name = environ.get("AEGIS_REMOTE_ALERT_TLS_SERVER_NAME", "").strip()
    sources: dict[str, ra.SourcePolicy] = {}
    relays: dict[str, str] = {}
    for name in names:
        pins = frozenset(
            item.strip().lower() for item in environ.get(f"AEGIS_REMOTE_ALERT_PIN_{_env_suffix(name)}", "").split(",")
            if item.strip()
        )
        if any(len(pin) != 64 or any(ch not in "0123456789abcdef" for ch in pin) for pin in pins):
            raise SettingsError("PIN_INVALID")
        sources[name] = ra.SourcePolicy(identity=ra.identity_for(name), pinned_sha256=pins)
        mode = environ.get(f"AEGIS_REMOTE_RELAY_{_env_suffix(name)}", rr.RELAY_NONE).strip() or rr.RELAY_NONE
        if mode not in rr.RELAY_MODES:
            raise SettingsError("RELAY_MODE_INVALID")
        if mode == rr.RELAY_LAB and profile != "lab":
            raise SettingsError("LAB_RELAY_NOT_ALLOWED")  # the lab relay is never reachable from a remote source in production
        relays[name] = mode
    return RemoteSettings(host, port, paths["CA_FILE"], server_name, paths["CORE_CERT"], paths["CORE_KEY"],
                          paths["CLIENT_CA_FILE"], sources, relays)


def build_ssl_context(settings: RemoteSettings) -> ssl.SSLContext:
    """Verify the broker (pinned CA, hostname, TLS 1.2+) and present the Core's own client certificate."""
    context = ssl.create_default_context(ssl.Purpose.SERVER_AUTH, cafile=settings.ca_file)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    context.load_cert_chain(settings.core_cert, settings.core_key)
    if settings.tls_server_name:
        wrap_socket = context.wrap_socket

        def _named_wrap_socket(sock, *args, **kwargs):
            kwargs["server_hostname"] = settings.tls_server_name
            return wrap_socket(sock, *args[:3], **kwargs)

        context.wrap_socket = _named_wrap_socket  # the broker certificate has no IP SAN: verify the configured name
    return context


class RemoteAlertSubscriber:
    """paho subscriber. ``on_alert(RemoteAlert)`` runs only for a fully verified alert; ``on_refusal(source_hint, code)`` for
    everything else (``source_hint`` is a validated source id or ``"-"``, never sender text)."""

    GLOBAL_BURST = 60.0
    GLOBAL_PER_SECOND = 20.0
    SOURCE_BURST = 20.0
    SOURCE_PER_SECOND = 0.5

    def __init__(self, settings: RemoteSettings, verifier: ra.RemoteAlertVerifier, *,
                 on_alert: Callable[[ra.RemoteAlert], None], on_refusal: Callable[[str, str], None],
                 client_factory: Callable[[], object] | None = None) -> None:
        self._settings = settings
        self._verifier = verifier
        self._on_alert = on_alert
        self._on_refusal = on_refusal
        self._client_factory = client_factory
        self._client = None
        self._global = ra.TokenBucket(self.GLOBAL_BURST, self.GLOBAL_PER_SECOND)
        self._per_source = {name: ra.TokenBucket(self.SOURCE_BURST, self.SOURCE_PER_SECOND) for name in settings.sources}
        self._lock = threading.Lock()
        self.connected = threading.Event()

    # -- message path (also the unit-test seam: no broker needed) ----------------------------------------------------------
    def handle_message(self, topic: object, payload: object, *, retained: bool = False) -> bool:
        hint = "-"
        if isinstance(topic, str) and topic.startswith(ra.TOPIC_PREFIX) and ra.valid_source(topic[len(ra.TOPIC_PREFIX):]):
            hint = topic[len(ra.TOPIC_PREFIX):]
        if not self._global.take():
            self._on_refusal(hint, ra.RATE_LIMITED)  # cheap drop before any signature work
            return False
        if retained:
            self._on_refusal(hint, ra.RETAINED)  # a retained message is stale by construction: never scored
            return False
        try:
            alert = self._verifier.verify(topic, payload)
        except ra.Refusal as refusal:
            self._on_refusal(hint, refusal.code)
            return False
        except Exception:
            self._on_refusal(hint, ra.MALFORMED)
            return False
        if not self._per_source[alert.source].take():
            self._on_refusal(alert.source, ra.RATE_LIMITED)
            return False
        try:
            self._on_alert(alert)
        except Exception:
            self._on_refusal(alert.source, "HANDLER_FAILED")
            return False
        return True

    # -- broker connection -------------------------------------------------------------------------------------------------
    def start(self) -> None:
        import paho.mqtt.client as mqtt

        with self._lock:
            if self._client is not None:
                return
            if self._client_factory is not None:
                client = self._client_factory()
            else:
                client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="aegis-core-remote-alert",
                                     protocol=mqtt.MQTTv311, clean_session=True)
            client.tls_set_context(build_ssl_context(self._settings))
            client.reconnect_delay_set(min_delay=1, max_delay=30)
            client.on_connect = self._on_connect
            client.on_message = self._on_message
            client.on_disconnect = lambda *args, **kwargs: self.connected.clear()
            self._client = client
            client.connect_async(self._settings.host, self._settings.port, keepalive=30)
            client.loop_start()

    def stop(self) -> None:
        with self._lock:
            client, self._client = self._client, None
        if client is not None:
            try:
                client.loop_stop()
                client.disconnect()
            except Exception:
                pass
        self.connected.clear()

    def _on_connect(self, client, userdata, flags, reason_code, properties=None) -> None:
        if getattr(reason_code, "is_failure", False) or (isinstance(reason_code, int) and reason_code != 0):
            return
        for source in self._settings.sources:
            client.subscribe(ra.topic_for(source), qos=1)  # exactly one topic per allowed source: never a wildcard
        self.connected.set()

    def _on_message(self, client, userdata, message) -> None:
        self.handle_message(message.topic, bytes(message.payload), retained=bool(getattr(message, "retain", False)))
