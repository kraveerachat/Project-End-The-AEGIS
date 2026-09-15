"""
AEGIS IDEA 3 — MQTT client (Protocol v1, PR11 Phase 4, design §6.2 and §8)

- TLS by default: a pinned CA, hostname verification, TLS 1.2 minimum, no
  insecure mode, and no plaintext fallback when TLS cannot be configured.
- MQTT 3.1.1, QoS 0, non-retained publishes, clean session, fixed Core identity.
- Subscribes to exactly the configured device's ACK and STATUS topics.
- Every inbound message passes the InboundVerifier before liveness, relay
  state, pending state, dispatch evidence, or notification.

Callbacks run on the MQTT thread; the GUI wraps them with root.after.
The legacy v0 JSON path exists only in the explicit legacy-v0-lab mode.
"""
import json
import ssl
import time

import paho.mqtt.client as mqtt

from . import config
from . import database as db
from . import protocol_v1 as p1
from .protocol_inbound import InboundVerifier

_UPLINK_STATES = ("LOCKDOWN", "NORMAL")
_LEGACY_DEVICE_STATES = ("LOCKDOWN", "NORMAL", "ONLINE")


def build_mqtt_ssl_context(ca_file: str) -> ssl.SSLContext:
    """A verifying client context: pinned CA, hostname check, TLS 1.2 minimum."""
    if not ca_file:
        raise ValueError("an MQTT CA file is required for TLS")
    context = ssl.create_default_context(ssl.Purpose.SERVER_AUTH, cafile=ca_file)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    return context


def _paho_client():
    return mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id=config.MQTT_CLIENT_ID,
        protocol=mqtt.MQTTv311,
        clean_session=True,
    )


def _subscription_refused(reason_code) -> bool:
    failure = getattr(reason_code, "is_failure", None)
    if failure is not None:
        return bool(failure)
    return int(getattr(reason_code, "value", reason_code)) >= 0x80


class MQTTManager:
    def __init__(self, *, protocol=None, client_factory=None, protocol_mode=None):
        mode = config.PROTOCOL_MODE if protocol_mode is None else protocol_mode
        # Anything other than the explicit lab opt-in is strict Protocol v1.
        self.legacy = mode == config.PROTOCOL_MODE_LEGACY_LAB
        self.protocol = None if self.legacy else protocol
        self.verifier = None
        if self.protocol is not None:
            self.verifier = InboundVerifier(
                keys=self.protocol.keys,
                device_id=self.protocol.device_id,
                store=self.protocol.store,
                clock=self.protocol.clock,
                audit=lambda *args: db.log_event(*args),
                audit_level=db.WARN,
            )
        self.client = (client_factory or _paho_client)()
        self.is_connected = False
        self.last_device_msg_ts = None   # last authenticated, fresh, non-replayed device message
        self.last_attacker_ip = None
        self.last_notified_uplink_state = None

        # callbacks (set by the GUI or supervisor)
        self.log_callback = None          # (message: str, level: str)
        self.status_callback = None       # (state, rssi, heap, command_nonce)
        self.connection_callback = None   # (connected: bool)
        self.ack_callback = None          # (ack, detail, nonce)
        self.attacker_callback = None     # legacy lab mode only
        self.client.on_message = self._on_message
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.on_subscribe = self._on_subscribe

    # ---------- connection ----------
    def _subscriptions(self):
        if self.legacy:
            return [(config.TOPIC_ACK, 0), (config.TOPIC_STATUS, 0), (config.TOPIC_ATTACKER_IP, 0)]
        if self.protocol is None:
            return []
        topics = self.protocol.topics
        return [(topics.ack, 0), (topics.status, 0)]

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        if reason_code != 0:
            self.is_connected = False
            db.log_event("SYSTEM", f"MQTT connection rejected: {reason_code}", db.WARN)
            if self.connection_callback:
                self.connection_callback(False)
            return
        self.is_connected = True
        subscriptions = self._subscriptions()
        if subscriptions:
            client.subscribe(subscriptions)
        db.log_event("SYSTEM", "MQTT connected", db.INFO)
        if self.connection_callback:
            self.connection_callback(True)

    def _on_subscribe(self, client, userdata, mid, reason_code_list, properties=None):
        if any(_subscription_refused(code) for code in reason_code_list):
            # A refused subscription is broker misconfiguration, never "ready".
            self.is_connected = False
            db.log_event("SYSTEM", "MQTT subscription refused by the broker ACL or configuration", db.WARN)
            if self.connection_callback:
                self.connection_callback(False)

    def _on_disconnect(self, client, userdata, *args):
        self.is_connected = False
        if self.connection_callback:
            self.connection_callback(False)

    # ---------- inbound ----------
    def _mark_device_seen(self):
        self.last_device_msg_ts = time.time()

    def _on_message(self, client, userdata, msg):
        try:
            if self.legacy:
                self._on_legacy_message(msg)
            else:
                self._on_v1_message(msg.topic, msg.payload, bool(getattr(msg, "retain", False)))
        except Exception as error:
            print(f"MQTT message handling error: {type(error).__name__}")

    def _on_v1_message(self, topic, payload, retain):
        if self.verifier is None:
            return
        result = self.verifier.process(topic, payload, retain)
        if not result.accepted:
            return
        message = result.message
        self._mark_device_seen()
        if message.kind == p1.ACK:
            self._handle_ack(message)
        else:
            self._handle_status(message)

    def _handle_ack(self, message):
        fields = message.fields
        consumed = self.protocol.store.consume_ack(
            self.protocol.device_id,
            fields["ack_for_msg_id"],
            int(fields["ack_for_seq"]),
            fields["result"],
            fields["msg_id"],
        )
        if not consumed:
            db.log_event("P1_ACK_UNCORRELATED", f"result={fields['result']}", db.WARN)
            return
        ack = "OK" if fields["result"] == "ACCEPTED" else fields["result"]
        level = db.INFO if ack == "OK" else db.WARN
        self._log(f"[{time.strftime('%H:%M:%S')}] [ACK] {ack} | seq {fields['ack_for_seq']}", level)
        db.log_event("ACK_RECEIVED", f"{ack} - seq {fields['ack_for_seq']}", level)
        if self.ack_callback:
            self.ack_callback(ack, fields["result"], fields["ack_for_msg_id"])

    def _handle_status(self, message):
        fields = message.fields
        state = fields["output_state"]
        reason = fields["reason"]
        rssi = int(fields["rssi_dbm"])
        heap = int(fields["heap_free"])
        store = self.protocol.store
        device_id = self.protocol.device_id
        command_nonce = ""
        if reason == "COMMAND":
            if store.correlate_status(device_id, fields["cmd_msg_id"], int(fields["cmd_seq"])):
                command_nonce = fields["cmd_msg_id"]
            else:
                db.log_event("P1_STATUS_UNCORRELATED", f"reason={reason} state={state}", db.WARN)
        elif reason == "SEQUENCE_REJECTED" and store.resync_forward(
            device_id,
            device_hwm=int(fields["device_seq_hwm"]),
            cmd_msg_id=fields["cmd_msg_id"],
            cmd_seq=int(fields["cmd_seq"]),
        ):
            db.log_event(
                "P1_SEQUENCE_RESYNC", f"allocator moved forward to device_seq_hwm={fields['device_seq_hwm']}", db.WARN,
            )

        level = db.CRITICAL if state == "LOCKDOWN" else db.INFO
        self._log(f"[{time.strftime('%H:%M:%S')}] [STATUS] {state} | {reason} | RSSI:{rssi}dBm | Heap:{heap}B", level)
        if self.status_callback:
            self.status_callback(state, rssi, heap, command_nonce)
        db.log_event("DEVICE_STATUS", f"{state} ({reason})", level)
        self._notify_uplink_transition(state, reason, rssi, heap)

    def _notify_uplink_transition(self, state, reason, rssi, heap):
        if state in _UPLINK_STATES and state != self.last_notified_uplink_state:
            attacker_ip = self.last_attacker_ip if state == "LOCKDOWN" else None
            self.last_notified_uplink_state = state
            # Telegram (imported here to avoid a cycle) is never tied to ACK/physical evidence.
            from . import comms
            try:
                comms.send_webhook_alert(state, reason, rssi, heap, attacker_ip=attacker_ip)
            except Exception:
                print("Telegram notification scheduling failed")
        if state == "LOCKDOWN":
            self.last_attacker_ip = None

    def _on_legacy_message(self, msg):
        """legacy-v0-lab only: the historical unsigned JSON contract, minus the NORMAL fallback."""
        payload_str = msg.payload.decode("utf-8")
        t = time.strftime('%H:%M:%S')

        if msg.topic == config.TOPIC_ACK:
            data = json.loads(payload_str)
            if not isinstance(data, dict):
                return
            self._mark_device_seen()
            ack = data.get("ack", "")
            detail = data.get("detail", "")
            nonce = data.get("nonce", "")
            level = db.INFO if ack == "OK" else db.WARN
            self._log(f"[{t}] [ACK] {ack} | {detail}", level)
            db.log_event("ACK_RECEIVED", f"{ack} - {detail}", level)
            if self.ack_callback:
                self.ack_callback(ack, detail, nonce)

        elif msg.topic == config.TOPIC_ATTACKER_IP:
            ip = payload_str.strip()
            if ip:
                self.last_attacker_ip = ip
                self._log(f"[{t}] [DETECTOR] พบ IP ต้องสงสัย: {ip}", db.WARN)
                if self.attacker_callback:
                    self.attacker_callback(ip)

        elif msg.topic == config.TOPIC_STATUS:
            data = json.loads(payload_str)
            state = data.get("state") if isinstance(data, dict) else None
            if state not in _LEGACY_DEVICE_STATES:
                # A malformed STATUS is dropped; it never becomes NORMAL.
                db.log_event("DEVICE_STATUS_REJECTED", "legacy STATUS without a valid state", db.WARN)
                return
            self._mark_device_seen()
            reason = data.get("reason", "")
            rssi = data.get("rssi", 0)
            heap = data.get("heap", 0)
            command_nonce = data.get("command_nonce", "")
            level = db.CRITICAL if state == "LOCKDOWN" else db.INFO
            self._log(f"[{t}] [STATUS] {state} | {reason} | RSSI:{rssi}dBm | Heap:{heap}B", level)
            if self.status_callback:
                self.status_callback(state, rssi, heap, command_nonce)
            db.log_event("DEVICE_STATUS", f"{state} ({reason})", level)
            self._notify_uplink_transition(state, reason, rssi, heap)

    def _log(self, message, level):
        if self.log_callback:
            self.log_callback(message, level)

    # ---------- helpers ----------
    def seconds_since_device(self):
        """Seconds since the last accepted device message (None = never)."""
        if self.last_device_msg_ts is None:
            return None
        return time.time() - self.last_device_msg_ts

    def device_online(self):
        s = self.seconds_since_device()
        return s is not None and s <= config.DEVICE_OFFLINE_SEC

    # ---------- lifecycle ----------
    def start(self):
        if not config.BROKER_CONFIGURED:
            self._log("MQTT broker is not configured; connection disabled", db.WARN)
            return
        if not self.legacy and self.protocol is None:
            self._log("Protocol v1 is not configured; MQTT connection disabled", db.WARN)
            return
        try:
            if config.MQTT_TLS:
                self.client.tls_set_context(build_mqtt_ssl_context(config.MQTT_CA_FILE))
        except (OSError, ValueError, ssl.SSLError):
            self._log("MQTT TLS is unavailable; not connecting (no plaintext fallback)", db.WARN)
            return
        try:
            if config.MQTT_USER:
                self.client.username_pw_set(config.MQTT_USER, config.MQTT_PASS)
            self.client.connect_async(config.BROKER_IP, config.PORT, 60)
            self.client.loop_start()
        except Exception as e:
            print(f"[MQTT] start error: {type(e).__name__}")

    def stop(self):
        try:
            self.client.loop_stop()
            self.client.disconnect()
        except Exception:
            pass

    def publish(self, topic, payload):
        """QoS 0, never retained; True only when the client accepted the frame."""
        if not self.is_connected:
            return False
        info = self.client.publish(topic, payload, qos=0, retain=False)
        return getattr(info, "rc", mqtt.MQTT_ERR_SUCCESS) == mqtt.MQTT_ERR_SUCCESS
