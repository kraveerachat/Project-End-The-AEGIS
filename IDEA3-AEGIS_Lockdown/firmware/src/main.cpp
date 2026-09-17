#include <Arduino.h>
#include <Preferences.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_sntp.h>
#include <esp_system.h>
#include <time.h>

#include "aegis_protocol.h"
#include "secrets.h"

constexpr int MQTT_PORT = 8883;
constexpr int RELAY_IN = 27;
constexpr int LED_GREEN = 32;
constexpr int LED_RED = 33;
constexpr int RELAY_RELEASE = HIGH;
constexpr int RELAY_TRIGGER = LOW;
constexpr unsigned long DEADMAN_TIMEOUT_MS = 60000;
constexpr unsigned long BOOT_GRACE_MS = 90000;
constexpr unsigned long TIME_SYNC_FRESH_MS = 60000;
constexpr unsigned long TIME_HOLDOVER_MAX_MS = 300000;
constexpr unsigned long RECONNECT_INTERVAL_MS = 5000;
constexpr unsigned long STATUS_INTERVAL_MS = 30000;
constexpr std::size_t REPLAY_SLOTS = 20;

enum class TimeTrust { SYNCED, HOLDOVER, UNTRUSTED };

Preferences preferences;
WiFiClientSecure tlsClient;
PubSubClient mqtt(tlsClient);

String deviceId;
String wifiSsid;
String wifiPassword;
String mqttHost;
String mqttUser;
String mqttPassword;
String ntpServer;
String topicCommand;
String topicHeartbeat;
String topicAck;
String topicStatus;
std::uint8_t keyC2D[32]{};
std::uint8_t keyD2C[32]{};
std::uint64_t highestSequence = 0;
String heartbeatReplay[REPLAY_SLOTS];
std::size_t heartbeatReplayIndex = 0;

bool provisioned = false;
bool mqttBufferReady = false;
bool ntpConfigured = false;
wl_status_t lastWiFiStatus = WL_NO_SHIELD;
bool isLockedDown = true;
bool deadmanTriggered = false;
unsigned long lastHeartbeatMs = 0;
unsigned long lastReconnectMs = 0;
unsigned long lastStatusMs = 0;
unsigned long lastTimeSyncMs = 0;
unsigned long lastBlinkMs = 0;
bool redBlink = false;

String field(const aegis::p1::Parsed& parsed, std::size_t index) {
  const auto value = parsed.elements[index];
  String out;
  out.reserve(value.size);
  for (std::size_t cursor = 0; cursor < value.size; ++cursor) out += value.data[cursor];
  return out;
}

String unsignedString(std::uint64_t value) {
  char buffer[21];
  snprintf(buffer, sizeof(buffer), "%llu", static_cast<unsigned long long>(value));
  return String(buffer);
}

std::uint64_t integerField(const aegis::p1::Parsed& parsed, std::size_t index) {
  return strtoull(field(parsed, index).c_str(), nullptr, 10);
}

const char* timeTrustName(TimeTrust trust) {
  if (trust == TimeTrust::SYNCED) return "SYNCED";
  if (trust == TimeTrust::HOLDOVER) return "HOLDOVER";
  return "UNTRUSTED";
}

TimeTrust timeTrust() {
  if (lastTimeSyncMs == 0) return TimeTrust::UNTRUSTED;
  const unsigned long age = millis() - lastTimeSyncMs;
  if (age <= TIME_SYNC_FRESH_MS) return TimeTrust::SYNCED;
  if (age <= TIME_HOLDOVER_MAX_MS) return TimeTrust::HOLDOVER;
  return TimeTrust::UNTRUSTED;
}

void onTimeSync(struct timeval*) {
  lastTimeSyncMs = millis();
  if (lastTimeSyncMs == 0) lastTimeSyncMs = 1;
}

bool keysAreIndependent() {
  unsigned char difference = 0;
  unsigned char c2dNonzero = 0;
  unsigned char d2cNonzero = 0;
  for (std::size_t index = 0; index < 32; ++index) {
    difference |= keyC2D[index] ^ keyD2C[index];
    c2dNonzero |= keyC2D[index];
    d2cNonzero |= keyD2C[index];
  }
  return difference != 0 && c2dNonzero != 0 && d2cNonzero != 0;
}

bool loadProvisioning() {
  if (!preferences.begin("aegis-p1", false)) return false;
  if (!(preferences.getUInt("schema", 0) == 1)) return false;
  deviceId = preferences.getString("device_id", "");
  wifiSsid = preferences.getString("wifi_ssid", "");
  wifiPassword = preferences.getString("wifi_psk", "");
  mqttHost = preferences.getString("broker", "");
  mqttUser = preferences.getString("mqtt_user", "");
  mqttPassword = preferences.getString("mqtt_pass", "");
  ntpServer = preferences.getString("ntp", SECRET_NTP_SERVER);
  if (preferences.getBytes("k_c2d", keyC2D, 32) != 32) return false;
  if (preferences.getBytes("k_d2c", keyD2C, 32) != 32) return false;
  highestSequence = preferences.getULong64("seq_hi", 0);
  if (deviceId.length() < 3 || wifiSsid.isEmpty() || mqttHost.isEmpty() || mqttUser.isEmpty() ||
      mqttPassword.isEmpty() || ntpServer.isEmpty() || !keysAreIndependent()) {
    return false;
  }
  const String base = "aegis/idea3/v1/" + deviceId;
  topicCommand = base + "/command";
  topicHeartbeat = base + "/heartbeat";
  topicAck = base + "/ack";
  topicStatus = base + "/status";
  return true;
}

String randomMessageId() {
  std::uint8_t random[16];
  esp_fill_random(random, sizeof(random));
  static constexpr char hex[] = "0123456789abcdef";
  String out;
  out.reserve(32);
  for (std::uint8_t value : random) {
    out += hex[value >> 4];
    out += hex[value & 0x0f];
  }
  return out;
}

String signWire(const char* kind, const String& topic, const String* fields, std::size_t fieldCount) {
  std::array<String, aegis::p1::MAX_ELEMENTS> values;
  std::array<aegis::p1::Span, aegis::p1::MAX_ELEMENTS> spans{};
  values[0] = "1";
  values[1] = kind;
  values[2] = deviceId;
  for (std::size_t index = 0; index < fieldCount; ++index) values[index + 3] = fields[index];
  const std::size_t count = fieldCount + 3;
  for (std::size_t index = 0; index < count; ++index) spans[index] = {values[index].c_str(), values[index].length()};

  std::array<std::uint8_t, aegis::p1::MAX_SIGNING_BYTES> input{};
  std::size_t inputLength = 0;
  if (!aegis::p1::buildSigningInput("DEVICE_TO_CORE", topic.c_str(), spans.data(), count,
                                    input.data(), input.size(), inputLength)) return "";
  std::uint8_t digest[32];
  if (!aegis::p1::hmacSha256(keyD2C, input.data(), inputLength, digest)) return "";
  static constexpr char hex[] = "0123456789abcdef";
  String mac;
  mac.reserve(64);
  for (std::uint8_t value : digest) {
    mac += hex[value >> 4];
    mac += hex[value & 0x0f];
  }
  String wire = "[1";
  for (std::size_t index = 1; index < count; ++index) wire += ",\"" + values[index] + "\"";
  wire += ",\"" + mac + "\"]";
  return wire;
}

bool publishSigned(const String& topic, const String& wire) {
  return !wire.isEmpty() && wire.length() <= aegis::p1::MAX_WIRE_BYTES &&
         mqtt.publish(topic.c_str(), reinterpret_cast<const std::uint8_t*>(wire.c_str()), wire.length(), false);
}

void sendAck(const String& commandId, std::uint64_t sequence, const char* result) {
  const String fields[] = {
      randomMessageId(), unsignedString(static_cast<std::uint64_t>(time(nullptr))), commandId,
      unsignedString(sequence), result,
  };
  const String wire = signWire("ACK", topicAck, fields, 5);  // DEVICE_TO_CORE, keyD2C
  publishSigned(topicAck, wire);
}

void publishStatus(const char* reason, const String& commandId = "", std::uint64_t commandSequence = 0) {
  if (timeTrust() == TimeTrust::UNTRUSTED) return;
  long rssi = WiFi.RSSI();
  if (rssi < -127 || rssi > 0) rssi = 0;
  const String fields[] = {
      randomMessageId(), unsignedString(static_cast<std::uint64_t>(time(nullptr))), timeTrustName(timeTrust()),
      isLockedDown ? "LOCKDOWN" : "NORMAL", reason, commandId,
      unsignedString(commandSequence), unsignedString(highestSequence), String(rssi), String(ESP.getFreeHeap()),
  };
  const String wire = signWire("STATUS", topicStatus, fields, 10);  // DEVICE_TO_CORE, keyD2C
  publishSigned(topicStatus, wire);
}

void setLockdown(bool lock) {
  isLockedDown = lock;
  digitalWrite(RELAY_IN, lock ? RELAY_TRIGGER : RELAY_RELEASE);
  digitalWrite(LED_GREEN, lock ? LOW : HIGH);
  if (lock) {
    redBlink = true;
    digitalWrite(LED_RED, HIGH);
    lastBlinkMs = millis();
  } else {
    redBlink = false;
    digitalWrite(LED_RED, LOW);
  }
}

bool checkAuthenticatedSkew(std::uint64_t timestamp) {
  const std::uint64_t now = static_cast<std::uint64_t>(time(nullptr));
  return timestamp <= now + 2 && now <= timestamp + 30;
}

bool acceptedSequence(std::uint64_t sequence) {
  return sequence > highestSequence;
}

bool heartbeatSeen(const String& messageId) {
  for (const auto& seen : heartbeatReplay) {
    if (seen == messageId) return true;
  }
  return false;
}

void handleCommand(const aegis::p1::Parsed& parsed) {
  if (!aegis::p1::verify(parsed, keyC2D)) return;
  const std::uint64_t issuedAt = integerField(parsed, 5);
  const std::uint64_t expiresAt = integerField(parsed, 6);
  const String commandId = field(parsed, 3);
  const std::uint64_t sequence = integerField(parsed, 4);
  if (!checkAuthenticatedSkew(issuedAt) || static_cast<std::uint64_t>(time(nullptr)) > expiresAt) {
    sendAck(commandId, sequence, "REJECTED_EXPIRED");
    return;
  }
  if (!acceptedSequence(sequence)) {
    sendAck(commandId, sequence, "REJECTED_SEQUENCE");
    publishStatus("SEQUENCE_REJECTED", commandId, sequence);
    return;
  }
  if (!preferences.putULong64("seq_hi", sequence)) {
    sendAck(commandId, sequence, "REJECTED_PERSIST");
    return;
  }
  highestSequence = sequence;
  const String action = field(parsed, 7);
  setLockdown(action == "CUT_UPLINK");
  sendAck(commandId, sequence, "ACCEPTED");
  publishStatus("COMMAND", commandId, sequence);
}

void handleHeartbeat(const aegis::p1::Parsed& parsed) {
  if (!aegis::p1::verify(parsed, keyC2D)) return;
  const String messageId = field(parsed, 3);
  if (!checkAuthenticatedSkew(integerField(parsed, 4)) || heartbeatSeen(messageId)) return;
  heartbeatReplay[heartbeatReplayIndex] = messageId;
  heartbeatReplayIndex = (heartbeatReplayIndex + 1) % REPLAY_SLOTS;
  lastHeartbeatMs = millis();
  deadmanTriggered = false;
}

void onMqttMessage(char* topic, std::uint8_t* payload, unsigned int length) {
  if (timeTrust() == TimeTrust::UNTRUSTED) return;
  aegis::p1::Parsed parsed{};
  const auto result = aegis::p1::parse(payload, length, topic, deviceId.c_str(), "device", false, parsed);
  if (result.stage != aegis::p1::Stage::ACCEPTED) return;
  const String kind = field(parsed, 1);
  if (kind == "COMMAND") handleCommand(parsed);
  else if (kind == "HEARTBEAT") handleHeartbeat(parsed);
}

void startWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());
}

void syncTimeNTP() {
  if (ntpConfigured) return;
  sntp_set_time_sync_notification_cb(onTimeSync);
  sntp_set_sync_interval(60000);
  configTime(0, 0, ntpServer.c_str());
  ntpConfigured = true;
}

void serviceNetworkBootstrap() {
  const wl_status_t status = WiFi.status();
  if (status == WL_CONNECTED) syncTimeNTP();
  if (status != lastWiFiStatus) lastWiFiStatus = status;
}

void connectMQTT() {
  if (!mqttBufferReady) return;
  if (WiFi.status() != WL_CONNECTED) return;
  if (timeTrust() == TimeTrust::UNTRUSTED) return;
  if (millis() - lastReconnectMs < RECONNECT_INTERVAL_MS) return;
  lastReconnectMs = millis();
  if (mqtt.connect(deviceId.c_str(), mqttUser.c_str(), mqttPassword.c_str())) {
    mqtt.subscribe(topicCommand.c_str(), 0);
    mqtt.subscribe(topicHeartbeat.c_str(), 0);
    publishStatus("BOOT");
  }
}

void checkDeadman() {
  if (lastHeartbeatMs == 0) {
    if (millis() > BOOT_GRACE_MS && !isLockedDown) setLockdown(true);
    return;
  }
  if (millis() - lastHeartbeatMs > DEADMAN_TIMEOUT_MS && !deadmanTriggered) {
    deadmanTriggered = true;
    setLockdown(true);
    publishStatus("DEADMAN");
  }
}

void updateLedBlink() {
  if (!isLockedDown) return;
  if (millis() - lastBlinkMs >= 300) {
    lastBlinkMs = millis();
    redBlink = !redBlink;
    digitalWrite(LED_RED, redBlink ? HIGH : LOW);
  }
}

void setup() {
  Serial.begin(115200);
  digitalWrite(RELAY_IN, RELAY_TRIGGER);
  pinMode(RELAY_IN, OUTPUT);
  pinMode(LED_GREEN, OUTPUT);
  pinMode(LED_RED, OUTPUT);
  digitalWrite(LED_GREEN, LOW);
  digitalWrite(LED_RED, HIGH);
  if (!(provisioned = loadProvisioning())) return;
  startWiFi();
  tlsClient.setCACert(SECRET_MQTT_CA_CERT);
  mqttBufferReady = mqtt.setBufferSize(768);
  if (!mqttBufferReady) return;
  mqtt.setServer(mqttHost.c_str(), MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
  connectMQTT();
}

void loop() {
  if (!provisioned || !mqttBufferReady) {
    delay(100);
    return;
  }
  serviceNetworkBootstrap();
  if (!mqtt.connected()) connectMQTT();
  mqtt.loop();
  checkDeadman();
  updateLedBlink();
  if (mqtt.connected() && timeTrust() != TimeTrust::UNTRUSTED && millis() - lastStatusMs >= STATUS_INTERVAL_MS) {
    lastStatusMs = millis();
    publishStatus("PERIODIC");
  }
  delay(10);
}
