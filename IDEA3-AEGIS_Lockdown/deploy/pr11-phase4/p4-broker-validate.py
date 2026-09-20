#!/usr/bin/env python3
from __future__ import annotations

import argparse
import contextlib
import json
import os
import queue
import shutil
import socket
import ssl
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path

import paho.mqtt.client as mqtt


LOOPBACK_ADDRESSES = {"127.0.0.1", "::1"}
PRODUCTION_TLS_PORT = 8883
BROKER_HOSTNAME = "mqtt.aegis.home.arpa"
CURRENT_CONNECT_HOST = BROKER_HOSTNAME
_tls_version_printed = False


@contextlib.contextmanager
def scoped_dns_override(hostname: str, target_ip: str):
    orig_getaddrinfo = socket.getaddrinfo

    def patched_getaddrinfo(host, port, *args, **kwargs):
        if host == hostname:
            return orig_getaddrinfo(target_ip, port, *args, **kwargs)
        raise socket.gaierror(f"External DNS resolution forbidden during L6a: {host}")

    socket.getaddrinfo = patched_getaddrinfo
    try:
        yield
    finally:
        socket.getaddrinfo = orig_getaddrinfo


def connect_broker(
    client: mqtt.Client,
    address: str,
    port: int,
) -> None:
    if CURRENT_CONNECT_HOST == BROKER_HOSTNAME:
        with scoped_dns_override(BROKER_HOSTNAME, address):
            client.connect(
                BROKER_HOSTNAME,
                port,
                keepalive=10,
            )
    else:
        client.connect(
            address,
            port,
            keepalive=10,
        )


def read_secret(path: Path) -> str:
    if path.is_symlink():
        raise ValueError(f"secret path must not be a symlink: {path}")

    metadata = path.stat()

    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"secret path must be a regular file: {path}")

    mode = stat.S_IMODE(metadata.st_mode)
    if mode not in (0o600, 0o400):
        raise ValueError(
            f"secret file mode {oct(mode)} invalid: must be exact mode 0600 or 0400"
        )

    value = path.read_text(encoding="utf-8")

    if value.endswith("\n"):
        value = value[:-1]

    if not value:
        raise ValueError("secret file must not be empty")

    if "\n" in value or "\r" in value or "\x00" in value:
        raise ValueError(
            "secret file must contain exactly one non-empty line"
        )

    return value


def validate_isolated_listener(
    config: Path,
) -> tuple[str, int, Path, bool]:
    listener: tuple[str, int] | None = None
    directives: dict[str, list[tuple[str, ...]]] = {}

    for raw in config.read_text(encoding="utf-8").splitlines():
        line = raw.strip()

        if not line or line.startswith("#"):
            continue

        parts = line.split()

        directives.setdefault(
            parts[0],
            [],
        ).append(tuple(parts[1:]))

        if parts[0] != "listener":
            continue

        if listener is not None:
            raise ValueError(
                "isolated validation config must contain exactly one listener"
            )

        if len(parts) != 3:
            raise ValueError(
                "isolated validation requires an explicit loopback listener address"
            )

        try:
            port = int(parts[1])
        except ValueError as exc:
            raise ValueError(
                "listener port must be an integer"
            ) from exc

        if not 1 <= port <= 65535:
            raise ValueError(
                "listener port is outside the valid TCP range"
            )

        if port == 1883:
            raise ValueError(
                "refusing plaintext MQTT port 1883 during isolated validation"
            )

        if port == PRODUCTION_TLS_PORT:
            raise ValueError(
                "refusing production MQTT TLS port 8883 during isolated validation"
            )

        address = parts[2]

        if address not in LOOPBACK_ADDRESSES:
            raise ValueError(
                "isolated validation listener must bind only to loopback"
            )

        listener = (address, port)

    if listener is None:
        raise ValueError(
            "isolated validation config must contain exactly one listener"
        )

    for directive in (
        "cafile",
        "certfile",
        "keyfile",
    ):
        values = directives.get(directive, [])

        if len(values) != 1 or len(values[0]) != 1:
            raise ValueError(
                f"broker TLS validation requires exactly one {directive} directive"
            )

    tls_versions = directives.get(
        "tls_version",
        [],
    )

    if tls_versions != [("tlsv1.2",)]:
        raise ValueError(
            "broker TLS validation requires tls_version tlsv1.2"
        )

    ca_file = Path(
        directives["cafile"][0][0]
    )

    if not ca_file.is_absolute():
        ca_file = config.parent / ca_file

    cert_file = Path(directives["certfile"][0][0])
    if not cert_file.is_absolute():
        cert_file = config.parent / cert_file

    global CURRENT_CONNECT_HOST
    CURRENT_CONNECT_HOST = address
    if cert_file.is_file():
        try:
            res = subprocess.run(
                ["openssl", "x509", "-in", str(cert_file), "-noout", "-ext", "subjectAltName"],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                check=False,
            )
            if f"DNS:{BROKER_HOSTNAME}" in res.stdout:
                CURRENT_CONNECT_HOST = BROKER_HOSTNAME
        except Exception:
            pass

    has_password_file = bool(
        directives.get("password_file")
    )

    address, port = listener

    return (
        address,
        port,
        ca_file,
        has_password_file,
    )


def listener_accepts_connections(
    address: str,
    port: int,
) -> bool:
    try:
        with socket.create_connection(
            (address, port),
            timeout=0.15,
        ):
            return True
    except OSError:
        return False


def open_identity_client(
    address: str,
    port: int,
    ca_file: Path,
    username: str,
    password_file: Path,
    client_id: str,
) -> mqtt.Client:
    password = read_secret(
        password_file
    )

    connected = threading.Event()
    state: dict[str, int] = {}

    def on_connect(
        client,
        userdata,
        flags,
        reason_code,
        properties,
    ) -> None:
        del client
        del userdata
        del flags
        del properties

        value = getattr(
            reason_code,
            "value",
            reason_code,
        )

        state["reason_code"] = int(value)
        connected.set()

    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id=client_id,
        protocol=mqtt.MQTTv311,
        reconnect_on_failure=False,
    )

    client.on_connect = on_connect

    client.username_pw_set(
        username,
        password,
    )

    client.tls_set(
        ca_certs=str(ca_file),
        cert_reqs=ssl.CERT_REQUIRED,
    )
    client.tls_insecure_set(False)

    loop_started = False

    try:
        connect_broker(client, address, port)
        client.loop_start()
        loop_started = True

        if not connected.wait(timeout=5):
            raise RuntimeError(
                f"MQTT authentication timed out for {username}"
            )

        if state.get("reason_code") != 0:
            raise RuntimeError(
                f"MQTT authentication failed for {username}"
            )

        ssl_sock = client.socket()
        version = ssl_sock.version() if ssl_sock else None
        if version not in ("TLSv1.2", "TLSv1.3"):
            raise RuntimeError(f"Forbidden negotiated TLS version: {version}")

        global _tls_version_printed
        if not _tls_version_printed:
            print("TLS_RUNTIME_VERSION=PASS")
            _tls_version_printed = True

        return client

    except Exception:
        try:
            client.disconnect()
        except Exception:
            pass

        if loop_started:
            client.loop_stop()

        raise


def close_client(client: mqtt.Client) -> None:
    try:
        client.disconnect()
    except Exception:
        pass

    client.loop_stop()


def authenticate_identity(
    address: str,
    port: int,
    ca_file: Path,
    username: str,
    password_file: Path,
    client_id: str,
    pass_marker: str,
) -> None:
    client = open_identity_client(
        address,
        port,
        ca_file,
        username,
        password_file,
        client_id,
    )

    try:
        print(pass_marker)
    finally:
        close_client(client)


def wait_for_subscription(
    client: mqtt.Client,
    topic: str,
) -> None:
    subscribed = threading.Event()

    def on_subscribe(
        callback_client,
        userdata,
        mid,
        reason_code_list,
        properties,
    ) -> None:
        del callback_client
        del userdata
        del mid
        del reason_code_list
        del properties
        subscribed.set()

    client.on_subscribe = on_subscribe

    result, _mid = client.subscribe(
        topic,
        qos=1,
    )

    if result != mqtt.MQTT_ERR_SUCCESS:
        raise RuntimeError(
            f"MQTT subscribe request failed for {topic}"
        )

    if not subscribed.wait(timeout=3):
        raise RuntimeError(
            f"MQTT subscribe timed out for {topic}"
        )


def drain_messages(
    messages: queue.Queue[tuple[str, str]],
) -> None:
    while True:
        try:
            messages.get_nowait()
        except queue.Empty:
            return


def wait_for_matching_message(
    messages: queue.Queue[tuple[str, str]],
    topic: str,
    payload: str,
    timeout: float,
) -> bool:
    deadline = time.monotonic() + timeout

    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()

        try:
            received_topic, received_payload = messages.get(
                timeout=max(0.01, remaining)
            )
        except queue.Empty:
            return False

        if (
            received_topic == topic
            and received_payload == payload
        ):
            return True

    return False


def publish_and_expect(
    publisher: mqtt.Client,
    observer_messages: queue.Queue[tuple[str, str]],
    topic: str,
    should_deliver: bool,
    label: str,
) -> None:
    drain_messages(
        observer_messages
    )

    payload = (
        f"aegis-pr11-{label}-{time.monotonic_ns()}"
    )

    info = publisher.publish(
        topic,
        payload=payload,
        qos=1,
        retain=False,
    )

    if info.rc != mqtt.MQTT_ERR_SUCCESS:
        raise RuntimeError(
            f"MQTT publish request failed for {label}"
        )

    info.wait_for_publish(
        timeout=3,
    )

    delivered = wait_for_matching_message(
        observer_messages,
        topic,
        payload,
        1.2 if should_deliver else 0.45,
    )

    if should_deliver and not delivered:
        raise RuntimeError(
            f"ACL matrix denied expected delivery: {label}"
        )

    if not should_deliver and delivered:
        raise RuntimeError(
            f"ACL matrix allowed forbidden delivery: {label}"
        )


def validate_acl_matrix(
    address: str,
    port: int,
    ca_file: Path,
    core_password_file: Path,
    device_password_file: Path,
    device_id: str,
) -> None:
    core = open_identity_client(
        address,
        port,
        ca_file,
        "idea3-core",
        core_password_file,
        "aegis-pr11-acl-core",
    )

    device = open_identity_client(
        address,
        port,
        ca_file,
        f"idea3-dev-{device_id}",
        device_password_file,
        "aegis-pr11-acl-device",
    )

    core_messages: queue.Queue[tuple[str, str]] = queue.Queue()
    device_messages: queue.Queue[tuple[str, str]] = queue.Queue()

    def core_message(
        client,
        userdata,
        message,
    ) -> None:
        del client
        del userdata

        core_messages.put(
            (
                message.topic,
                message.payload.decode(
                    "utf-8",
                    errors="strict",
                ),
            )
        )

    def device_message(
        client,
        userdata,
        message,
    ) -> None:
        del client
        del userdata

        device_messages.put(
            (
                message.topic,
                message.payload.decode(
                    "utf-8",
                    errors="strict",
                ),
            )
        )

    core.on_message = core_message
    device.on_message = device_message

    prefix = (
        f"aegis/idea3/v1/{device_id}"
    )

    topics = {
        "command": f"{prefix}/command",
        "heartbeat": f"{prefix}/heartbeat",
        "ack": f"{prefix}/ack",
        "status": f"{prefix}/status",
    }

    try:
        for topic in topics.values():
            wait_for_subscription(
                core,
                topic,
            )
            wait_for_subscription(
                device,
                topic,
            )

        # Positive half of the exact matrix:
        # Core writes command/heartbeat; Device reads.
        for name in (
            "command",
            "heartbeat",
        ):
            publish_and_expect(
                core,
                device_messages,
                topics[name],
                True,
                f"core-write-device-read-{name}",
            )

        # Device writes ack/status; Core reads.
        for name in (
            "ack",
            "status",
        ):
            publish_and_expect(
                device,
                core_messages,
                topics[name],
                True,
                f"device-write-core-read-{name}",
            )

        # Core must not read command/heartbeat.
        # Core is allowed to write them, so publish to itself.
        for name in (
            "command",
            "heartbeat",
        ):
            publish_and_expect(
                core,
                core_messages,
                topics[name],
                False,
                f"core-denied-read-{name}",
            )

        # Device must not read ack/status.
        # Device is allowed to write them, so publish to itself.
        for name in (
            "ack",
            "status",
        ):
            publish_and_expect(
                device,
                device_messages,
                topics[name],
                False,
                f"device-denied-read-{name}",
            )

        # Core may read ack/status but must not write them.
        for name in (
            "ack",
            "status",
        ):
            publish_and_expect(
                core,
                core_messages,
                topics[name],
                False,
                f"core-denied-write-{name}",
            )

        # Device may read command/heartbeat but must not write them.
        for name in (
            "command",
            "heartbeat",
        ):
            publish_and_expect(
                device,
                device_messages,
                topics[name],
                False,
                f"device-denied-write-{name}",
            )

        print("ACL_MATRIX=PASS")

    finally:
        close_client(core)
        close_client(device)




def validate_anonymous_rejected(
    address: str,
    port: int,
    ca_file: Path,
) -> None:
    connected = threading.Event()
    state: dict[str, int] = {}

    def on_connect(
        client,
        userdata,
        flags,
        reason_code,
        properties,
    ) -> None:
        del client
        del userdata
        del flags
        del properties

        value = getattr(
            reason_code,
            "value",
            reason_code,
        )
        state["reason_code"] = int(value)
        connected.set()

    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id="aegis-pr11-validator-anonymous",
        protocol=mqtt.MQTTv311,
        reconnect_on_failure=False,
    )
    client.on_connect = on_connect
    client.tls_set(
        ca_certs=str(ca_file),
        cert_reqs=ssl.CERT_REQUIRED,
    )
    client.tls_insecure_set(False)

    loop_started = False

    try:
        connect_broker(client, address, port)
        client.loop_start()
        loop_started = True

        if not connected.wait(timeout=5):
            raise RuntimeError(
                "anonymous MQTT authentication probe timed out"
            )

        if state.get("reason_code") == 0:
            raise RuntimeError(
                "anonymous MQTT authentication unexpectedly succeeded"
            )

        print("ANONYMOUS_REJECTED=PASS")

    finally:
        try:
            client.disconnect()
        except Exception:
            pass

        if loop_started:
            client.loop_stop()


def validate_retained_rejected(
    address: str,
    port: int,
    ca_file: Path,
    username: str,
    password_file: Path,
    topic: str,
) -> None:
    password = read_secret(password_file)
    connected = threading.Event()
    disconnected = threading.Event()
    state: dict[str, int] = {}

    def on_connect(
        client,
        userdata,
        flags,
        reason_code,
        properties,
    ) -> None:
        del client
        del userdata
        del flags
        del properties

        value = getattr(
            reason_code,
            "value",
            reason_code,
        )
        state["connect_reason"] = int(value)
        connected.set()

    def on_disconnect(
        client,
        userdata,
        disconnect_flags,
        reason_code,
        properties,
    ) -> None:
        del client
        del userdata
        del disconnect_flags
        del properties

        value = getattr(
            reason_code,
            "value",
            reason_code,
        )
        state["disconnect_reason"] = int(value)
        disconnected.set()

    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id="aegis-pr11-validator-retained",
        protocol=mqtt.MQTTv5,
        reconnect_on_failure=False,
    )
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.username_pw_set(
        username,
        password,
    )
    client.tls_set(
        ca_certs=str(ca_file),
        cert_reqs=ssl.CERT_REQUIRED,
    )
    client.tls_insecure_set(False)

    loop_started = False

    try:
        connect_broker(client, address, port)
        client.loop_start()
        loop_started = True

        if not connected.wait(timeout=5):
            raise RuntimeError(
                "retained-message authentication probe timed out"
            )

        if state.get("connect_reason") != 0:
            raise RuntimeError(
                "retained-message probe could not authenticate"
            )

        info = client.publish(
            topic,
            payload="aegis-pr11-retained-negative-probe",
            qos=1,
            retain=True,
        )

        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            raise RuntimeError(
                "retained-message probe could not issue publish"
            )

        deadline = time.monotonic() + 5.0

        while time.monotonic() < deadline:
            if info.is_published():
                raise RuntimeError(
                    "retained MQTT publish unexpectedly succeeded"
                )

            if disconnected.wait(timeout=0.05):
                print("RETAINED_REJECTED=PASS")
                return

        raise RuntimeError(
            "retained MQTT publish rejection was not observed"
        )

    finally:
        try:
            client.disconnect()
        except Exception:
            pass

        if loop_started:
            client.loop_stop()


def validate_wrong_password_rejected(
    address: str,
    port: int,
    ca_file: Path,
    username: str,
    wrong_password: str,
    token: str,
) -> None:
    connected = threading.Event()
    state: dict[str, int] = {}

    def on_connect(
        client,
        userdata,
        flags,
        reason_code,
        properties=None,
    ) -> None:
        del client
        del userdata
        del flags
        del properties

        value = getattr(
            reason_code,
            "value",
            reason_code,
        )
        state["reason_code"] = int(value)
        connected.set()

    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id=f"aegis-pr11-wrong-pw-{username}",
        protocol=mqtt.MQTTv5,
        reconnect_on_failure=False,
    )
    client.on_connect = on_connect
    client.username_pw_set(
        username,
        wrong_password,
    )
    client.tls_set(
        ca_certs=str(ca_file),
        cert_reqs=ssl.CERT_REQUIRED,
    )
    client.tls_insecure_set(False)

    loop_started = False

    try:
        connect_broker(client, address, port)
        client.loop_start()
        loop_started = True

        if not connected.wait(timeout=5):
            raise RuntimeError(
                f"wrong-password authentication probe for {username} timed out"
            )

        if state.get("reason_code") == 0:
            raise RuntimeError(
                f"wrong-password authentication probe unexpectedly succeeded for {username}"
            )

        print(token)

    finally:
        try:
            client.disconnect()
        except Exception:
            pass

        if loop_started:
            client.loop_stop()


def validate_negative_security(
    address: str,
    port: int,
    ca_file: Path,
    core_password_file: Path,
    device_id: str,
) -> None:
    validate_anonymous_rejected(
        address,
        port,
        ca_file,
    )

    validate_wrong_password_rejected(
        address,
        port,
        ca_file,
        "idea3-core",
        "canary-wrong-core-password-12345",
        "WRONG_CORE_PASSWORD_REJECTED=PASS",
    )

    validate_wrong_password_rejected(
        address,
        port,
        ca_file,
        f"idea3-dev-{device_id}",
        "canary-wrong-device-password-12345",
        "WRONG_DEVICE_PASSWORD_REJECTED=PASS",
    )

    validate_retained_rejected(
        address,
        port,
        ca_file,
        "idea3-core",
        core_password_file,
        f"aegis/idea3/v1/{device_id}/command",
    )

    print("NEGATIVE_SECURITY=PASS")

def write_broker_process_metadata(
    state_dir: Path,
    pid: int,
    config_path: Path,
) -> None:
    boot_id = ""
    boot_id_file = Path("/proc/sys/kernel/random/boot_id")
    if boot_id_file.is_file():
        try:
            boot_id = boot_id_file.read_text(encoding="utf-8").strip()
        except Exception:
            pass

    start_time = ""
    stat_file = Path(f"/proc/{pid}/stat")
    if stat_file.is_file():
        try:
            content = stat_file.read_text(encoding="utf-8")
            after_comm = content.split(")")[-1].split()
            start_time = after_comm[19]
        except Exception:
            pass

    executable = shutil.which("mosquitto") or "/usr/sbin/mosquitto"

    metadata = {
        "pid": pid,
        "start_time": start_time,
        "boot_id": boot_id,
        "config_path": str(config_path.resolve()),
        "executable": executable,
    }

    state_dir.mkdir(parents=True, exist_ok=True)
    process_file = state_dir / "broker-process.json"
    process_file.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    os.chmod(process_file, 0o600)


def run_isolated_broker(
    config: Path,
    address: str,
    port: int,
    ca_file: Path,
    core_password_file: Path,
    device_password_file: Path,
    device_id: str,
    authenticate: bool,
    state_dir: Path | None = None,
) -> None:
    process = subprocess.Popen(
        [
            "mosquitto",
            "-c",
            str(config),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    if state_dir is not None:
        write_broker_process_metadata(state_dir, process.pid, config)

    started = False

    try:
        deadline = time.monotonic() + 5.0

        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(
                    "mosquitto broker exited before isolated listener became ready"
                )

            if listener_accepts_connections(
                address,
                port,
            ):
                started = True
                break

            time.sleep(0.05)

        if not started:
            raise RuntimeError(
                "mosquitto broker did not open isolated listener"
            )

        print("BROKER_PROCESS_STARTED=YES")

        if authenticate:
            authenticate_identity(
                address,
                port,
                ca_file,
                "idea3-core",
                core_password_file,
                "aegis-pr11-validator-core",
                "CORE_AUTH=PASS",
            )

            authenticate_identity(
                address,
                port,
                ca_file,
                f"idea3-dev-{device_id}",
                device_password_file,
                "aegis-pr11-validator-device",
                "DEVICE_AUTH=PASS",
            )

            validate_acl_matrix(
                address,
                port,
                ca_file,
                core_password_file,
                device_password_file,
                device_id,
            )

            validate_negative_security(
                address,
                port,
                ca_file,
                core_password_file,
                device_id,
            )

    finally:
        if process.poll() is None:
            process.terminate()

            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)

        if started:
            deadline = time.monotonic() + 2.0

            while time.monotonic() < deadline:
                if not listener_accepts_connections(
                    address,
                    port,
                ):
                    print("BROKER_RESIDUE=NO")
                    break

                time.sleep(0.05)
            else:
                raise RuntimeError(
                    "isolated mosquitto broker listener residue remains"
                )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="AEGIS IDEA3 PR11 isolated MQTT broker validator"
    )

    subparsers = parser.add_subparsers(
        dest="command",
        required=True,
    )

    validate = subparsers.add_parser(
        "validate"
    )

    validate.add_argument(
        "--config",
        type=Path,
        required=True,
    )
    validate.add_argument(
        "--core-password-file",
        type=Path,
        required=True,
    )
    validate.add_argument(
        "--device-password-file",
        type=Path,
        required=True,
    )
    validate.add_argument(
        "--device-id",
        required=True,
    )
    validate.add_argument(
        "--state-dir",
        type=Path,
        default=None,
        help="Optional directory to record broker process metadata",
    )

    args = parser.parse_args()

    try:
        if args.command == "validate":
            read_secret(args.core_password_file)
            read_secret(args.device_password_file)

            (
                address,
                port,
                ca_file,
                has_password_file,
            ) = validate_isolated_listener(
                args.config
            )

            run_isolated_broker(
                args.config,
                address,
                port,
                ca_file,
                args.core_password_file,
                args.device_password_file,
                args.device_id,
                has_password_file,
                state_dir=args.state_dir,
            )

            return 0

    except (
        OSError,
        RuntimeError,
        ValueError,
        ssl.SSLError,
    ) as exc:
        print(
            f"ERROR: {exc}",
            file=sys.stderr,
        )
        return 2

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
