"""AEGIS IDEA3 protected-host detection agent (Beelink in production; any lab host for testing).

Reads the LOCAL journal only, reusing the Core's own ``graduated_detector`` trust rules (a record counts only if journald
itself says it came from the SSH daemon running as root: ``_COMM`` in {sshd, sshd-session} and ``_UID=0``; a local user writing
look-alike lines with logger(1) is ignored). It reports exactly the SSH observations the detector reports, ``ssh_brute_force``
and ``ssh_login_after_failures``, to the Core as one signed alert each over MQTT with mutual TLS:

    topic    aegis/alert/<source>                     (source defaults to "beelink")
    payload  {at, kind, attacker_ip, detail, source, nonce}, signed with the agent's client certificate key, sent together with
             the certificate (see ``aegis_soc.remote_alert``); the Core verifies both and refuses anything else

The agent never receives a command. It subscribes to nothing, executes nothing from the network, holds no secret other than its
own client key (kept in a file readable by the agent account only), never retries a failed send inside one cooldown (the detector's
own once-per-address-per-rule cooldown, rate limit and transport-failure stop apply unchanged) and stops with a failure status if
the journal follower ends, so a blind agent is visible to systemd rather than silently idle.

Configuration (environment, typically a systemd ``EnvironmentFile``)::

    AEGIS_BEELINK_BROKER_HOST         Core broker host (required)
    AEGIS_BEELINK_BROKER_PORT         default 8883
    AEGIS_BEELINK_CA_FILE             CA that signed the broker certificate (required; the broker is verified, hostname included)
    AEGIS_BEELINK_TLS_SERVER_NAME     optional DNS name to verify the broker against when reached by address
    AEGIS_BEELINK_CLIENT_CERT         this agent's client certificate, PEM (CN must be aegis-alert-<source>)
    AEGIS_BEELINK_CLIENT_KEY          its private key, PEM, mode 0600/0400 (required)
    AEGIS_BEELINK_SOURCE              source id, default "beelink"

``--fixture FILE`` (lab and tests only) replaces ``journalctl`` with a file of journald JSON records; every record still goes
through the same trust check.
"""

from __future__ import annotations

import argparse
import os
import ssl
import subprocess
import sys
import threading
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path

# The project root (or the minimal deployed tree: this file plus aegis_soc/{__init__,alert_sink,ip_containment,
# production_detector,graduated_detector,remote_alert}.py).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aegis_soc import alert_sink
from aegis_soc import graduated_detector as gd
from aegis_soc import production_detector as pd
from aegis_soc import remote_alert as ra

#: SSH records only, root-owned: the kernel/netfilter group of the Core's detector is not used on a protected host.
JOURNAL_ARGV = ("journalctl", "-f", "-n", "0", "-o", "json", "_COMM=sshd", "_COMM=sshd-session", "_UID=0")
REPORTED_KINDS = ra.REMOTE_KINDS
#: One constant sentence per kind: nothing the attacker controls ever reaches the signed payload.
DETAIL = {
    ra.KIND_SSH_BRUTE_FORCE: "repeated failed ssh logins seen in the local sshd journal",
    ra.KIND_SSH_LOGIN_AFTER_FAILURES: "successful ssh login after repeated failures seen in the local sshd journal",
}
PUBLISHED = "PUBLISHED"
CONNECT_WAIT_SEC = 10.0
PUBLISH_WAIT_SEC = 3.0
EXIT_CONFIG = 64


class ConfigError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class AgentConfig:
    host: str
    port: int
    ca_file: str
    cert_file: str
    key_file: str
    source: str
    tls_server_name: str = ""

    @property
    def topic(self) -> str:
        return ra.topic_for(self.source)


def load_config(environ: Mapping[str, str]) -> AgentConfig:
    host = environ.get("AEGIS_BEELINK_BROKER_HOST", "").strip()
    if not host:
        raise ConfigError("BROKER_HOST_MISSING")
    try:
        port = int(environ.get("AEGIS_BEELINK_BROKER_PORT", "8883"))
    except ValueError:
        raise ConfigError("BROKER_PORT_INVALID") from None
    if not 1 <= port <= 65535:
        raise ConfigError("BROKER_PORT_INVALID")
    source = environ.get("AEGIS_BEELINK_SOURCE", "beelink").strip()
    if not ra.valid_source(source):
        raise ConfigError("SOURCE_INVALID")
    files = {}
    for name, code in (("CA_FILE", "CA_FILE_UNREADABLE"), ("CLIENT_CERT", "CLIENT_CERT_UNREADABLE"),
                       ("CLIENT_KEY", "CLIENT_KEY_UNREADABLE")):
        value = environ.get(f"AEGIS_BEELINK_{name}", "").strip()
        if not value or not value.startswith("/") or not os.path.isfile(value) or not os.access(value, os.R_OK):
            raise ConfigError(code)
        files[name] = value
    if os.stat(files["CLIENT_KEY"]).st_mode & 0o077:
        raise ConfigError("CLIENT_KEY_PERMISSIONS")  # a key other accounts can read is not a private key
    return AgentConfig(host, port, files["CA_FILE"], files["CLIENT_CERT"], files["CLIENT_KEY"], source,
                       environ.get("AEGIS_BEELINK_TLS_SERVER_NAME", "").strip())


def build_ssl_context(config: AgentConfig) -> ssl.SSLContext:
    """Verify the broker (pinned CA, hostname, TLS 1.2+) and present this agent's client certificate."""
    context = ssl.create_default_context(ssl.Purpose.SERVER_AUTH, cafile=config.ca_file)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    context.load_cert_chain(config.cert_file, config.key_file)
    if config.tls_server_name:
        wrap_socket = context.wrap_socket

        def _named_wrap_socket(sock, *args, **kwargs):
            kwargs["server_hostname"] = config.tls_server_name
            return wrap_socket(sock, *args[:3], **kwargs)

        context.wrap_socket = _named_wrap_socket
    return context


class AlertPublisher:
    """The detector's ``sender``: sign one alert and publish it once. Every outcome is a stable ``AlertResult`` code."""

    def __init__(self, config: AgentConfig, *, client_factory: Callable[[], object] | None = None,
                 now: Callable[[], float] | None = None) -> None:
        self._config = config
        self._now = now
        self._client_factory = client_factory
        self._client = None
        self._connected = threading.Event()
        self._cert_der, self._key = ra.load_identity(config.cert_file, config.key_file)

    def start(self) -> bool:
        import paho.mqtt.client as mqtt

        client = self._client_factory() if self._client_factory else mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2, client_id=f"aegis-agent-{self._config.source}", protocol=mqtt.MQTTv311,
            clean_session=True,
        )
        client.tls_set_context(build_ssl_context(self._config))
        client.reconnect_delay_set(min_delay=1, max_delay=30)
        client.on_connect = lambda c, u, f, rc, p=None: self._connected.set() if not getattr(rc, "is_failure", rc != 0) else None
        client.on_disconnect = lambda *a, **k: self._connected.clear()
        self._client = client
        client.connect_async(self._config.host, self._config.port, keepalive=30)
        client.loop_start()
        return self._connected.wait(CONNECT_WAIT_SEC)

    def stop(self) -> None:
        client, self._client = self._client, None
        if client is not None:
            try:
                client.loop_stop()
                client.disconnect()
            except Exception:
                pass

    def __call__(self, ip: str, kind: str | None = None) -> alert_sink.AlertResult:
        if kind not in REPORTED_KINDS:
            return alert_sink.AlertResult(False, alert_sink.INVALID_ADDRESS, "kind_not_reported")
        try:
            raw = ra.build_envelope(
                source=self._config.source, kind=kind, attacker_ip=ip, detail=DETAIL[kind], cert_der=self._cert_der,
                private_key=self._key, now=None if self._now is None else self._now(),
            )
        except ra.Refusal as refusal:
            return alert_sink.AlertResult(False, alert_sink.INVALID_ADDRESS, refusal.code)
        client = self._client
        if client is None or not self._connected.is_set():
            return alert_sink.AlertResult(False, alert_sink.SOCKET_REFUSED, "broker_unavailable")
        try:
            info = client.publish(self._config.topic, raw, qos=1, retain=False)
            if getattr(info, "rc", 0) != 0:
                return alert_sink.AlertResult(False, alert_sink.SOCKET_REFUSED, "publish_refused")
            info.wait_for_publish(timeout=PUBLISH_WAIT_SEC)
            if not info.is_published():
                return alert_sink.AlertResult(False, alert_sink.TIMEOUT, "puback_timeout")
        except Exception:
            return alert_sink.AlertResult(False, alert_sink.OUTCOME_UNKNOWN, "publish_failed")
        return alert_sink.AlertResult(True, PUBLISHED)


def trusted_ssh_records(records: Iterable[str]) -> Iterable[str]:
    """Only records the Core's own trust rule accepts AND that come from the SSH daemon: nothing else is ever processed."""
    for raw in records:
        found = gd.trusted_record(raw)
        if found is not None and found[0] == gd.SOURCE_SSHD:
            yield raw


def run(records: Iterable[str], detector: gd.GraduatedDetector) -> int:
    """Process a record stream. A stream that ends is a failure (exit 3) unless the detector already stopped (exit 2)."""
    for raw in trusted_ssh_records(records):
        detector.process_trusted(raw)
        if detector.stopped:
            return pd.EXIT_TRANSPORT_UNAVAILABLE
    return pd.EXIT_JOURNAL_SOURCE_UNAVAILABLE


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="AEGIS IDEA3 protected-host detection agent")
    parser.add_argument("--fixture", metavar="FILE", help="lab/tests: read journald JSON records from FILE instead of journalctl")
    return parser.parse_args(argv)


def main(argv=None, environ: Mapping[str, str] | None = None) -> int:
    args = parse_args(argv)
    try:
        config = load_config(os.environ if environ is None else environ)
        publisher = AlertPublisher(config)
    except ConfigError as error:
        pd._log("stopping", reason="CONFIG_INVALID", code=error.code)
        return EXIT_CONFIG
    except (OSError, ssl.SSLError, ra.Refusal, ValueError):
        pd._log("stopping", reason="IDENTITY_UNUSABLE")
        return EXIT_CONFIG
    if not publisher.start():
        pd._log("stopping", reason="BROKER_UNAVAILABLE", source=config.source)
        publisher.stop()
        return pd.EXIT_TRANSPORT_UNAVAILABLE
    detector = gd.GraduatedDetector(publisher)
    pd._log("started", sink="MQTT-mTLS", source=config.source, mode="remote-alert-v1",
            input="fixture" if args.fixture else "journal")
    try:
        if args.fixture:
            with open(args.fixture, encoding="utf-8") as handle:
                status = run(handle, detector)
            # A fixture that simply ends is the normal end of a test run, not a blind agent.
            return 0 if status == pd.EXIT_JOURNAL_SOURCE_UNAVAILABLE else status
        try:
            process = subprocess.Popen(list(JOURNAL_ARGV), stdout=subprocess.PIPE, text=True, errors="replace")
        except OSError:
            pd._log("stopping", reason="JOURNAL_SOURCE_UNAVAILABLE", journal_exit="not_started")
            return pd.EXIT_JOURNAL_SOURCE_UNAVAILABLE
        try:
            assert process.stdout is not None
            status = run(process.stdout, detector)
            if status == pd.EXIT_JOURNAL_SOURCE_UNAVAILABLE:
                pd._log("stopping", reason="JOURNAL_SOURCE_UNAVAILABLE", journal_exit=pd._journal_exit_status(process))
            return status
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
    finally:
        publisher.stop()


if __name__ == "__main__":
    sys.exit(main())
