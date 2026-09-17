"""Static contracts for the repository-only MQTT broker examples."""

from pathlib import Path

from aegis_soc import protocol_v1 as p1

ROOT = Path(__file__).resolve().parents[1]
CONF = ROOT / "deploy" / "mosquitto" / "aegis-idea3-mosquitto.conf.example"
ACL = ROOT / "deploy" / "mosquitto" / "aegis-idea3-mosquitto.acl.example"
ENV = ROOT / "deploy" / "aegis-idea3-core.env.example"
DEVICE = "device-id"


def _directives(path):
    rows = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line and not line.startswith("#"):
            rows.append(tuple(line.split()))
    return rows


def test_broker_template_has_only_two_tls_8883_listeners():
    rows = _directives(CONF)
    listeners = [row for row in rows if row[0] == "listener"]
    assert listeners == [("listener", "8883", "127.0.0.1"), ("listener", "8883", "<AEGIS_AP_ADDRESS>")]

    forbidden = {"1883", "0.0.0.0", "::", "websockets"}
    assert not forbidden.intersection(token for row in rows for token in row)
    assert sum(row[0] == "cafile" for row in rows) == 2
    assert sum(row[0] == "certfile" for row in rows) == 2
    assert sum(row[0] == "keyfile" for row in rows) == 2
    assert sum(row == ("tls_version", "tlsv1.2") for row in rows) == 2
    assert sum(row == ("require_certificate", "false") for row in rows) == 2


def test_broker_template_disables_anonymous_retained_and_offline_state():
    rows = set(_directives(CONF))
    required = {
        ("per_listener_settings", "false"),
        ("allow_anonymous", "false"),
        ("persistence", "false"),
        ("retain_available", "false"),
        ("queue_qos0_messages", "false"),
        ("allow_zero_length_clientid", "false"),
        ("max_packet_size", "1024"),
        ("max_keepalive", "60"),
        ("password_file", "<AEGIS_MQTT_PASSWORD_FILE>"),
        ("acl_file", "<AEGIS_MQTT_ACL_FILE>"),
    }
    assert required <= rows


def test_acl_is_the_exact_two_identity_topic_matrix():
    rows = _directives(ACL)
    topics = p1.topics(DEVICE)
    assert rows == [
        ("user", "idea3-core"),
        ("topic", "write", topics.command),
        ("topic", "write", topics.heartbeat),
        ("topic", "read", topics.ack),
        ("topic", "read", topics.status),
        ("user", f"idea3-dev-{DEVICE}"),
        ("topic", "read", topics.command),
        ("topic", "read", topics.heartbeat),
        ("topic", "write", topics.ack),
        ("topic", "write", topics.status),
    ]
    forbidden = {"pattern", "readwrite", "$SYS", "aegis/attacker_ip"}
    text = ACL.read_text(encoding="utf-8")
    assert not any(token in text for token in forbidden)
    assert "+" not in text and "#" not in text


def test_core_environment_contains_no_runtime_secret_values_or_credential_paths():
    values = {}
    for raw in ENV.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line and not line.startswith("#") and "=" in line:
            name, value = line.split("=", 1)
            values[name] = value

    assert values["AEGIS_BROKER_PORT"] == "8883"
    assert values["AEGIS_PROTOCOL_MODE"] == "v1"
    assert values["AEGIS_MQTT_CA_FILE"].startswith("/etc/aegis-idea3/")
    assert values["AEGIS_CORE_PROTOCOL_DB_PATH"].startswith("/var/lib/aegis-idea3/data/")
    assert values["AEGIS_MQTT_USER"] == "idea3-core"

    assert "AEGIS_P1_C2D_KEY_FILE" not in values
    assert "AEGIS_P1_D2C_KEY_FILE" not in values
    assert "AEGIS_MQTT_PASS" not in values
    assert "AEGIS_ADMIN_PIN" not in values
    assert "AEGIS_HMAC_SECRET" not in values
