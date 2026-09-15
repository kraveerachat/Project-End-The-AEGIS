#include "aegis_protocol.h"

#include <algorithm>
#include <array>
#include <charconv>
#include <cstring>
#include <limits>
#include <string_view>

namespace aegis::p1 {
namespace {

constexpr std::string_view LABEL = "AEGIS-IDEA3-PROTOCOL";
constexpr std::string_view C2D = "CORE_TO_DEVICE";
constexpr std::string_view D2C = "DEVICE_TO_CORE";
constexpr std::uint64_t TIME_FLOOR = 1789430400ULL;

bool appendLp(std::uint8_t* out, std::size_t capacity, std::size_t& used, Span value) {
  if (value.size > std::numeric_limits<std::uint32_t>::max() || capacity - used < 4 + value.size) return false;
  const auto size = static_cast<std::uint32_t>(value.size);
  out[used++] = static_cast<std::uint8_t>(size >> 24);
  out[used++] = static_cast<std::uint8_t>(size >> 16);
  out[used++] = static_cast<std::uint8_t>(size >> 8);
  out[used++] = static_cast<std::uint8_t>(size);
  std::memcpy(out + used, value.data, value.size);
  used += value.size;
  return true;
}

Span span(std::string_view value) { return {value.data(), value.size()}; }
std::string_view view(Span value) { return {value.data, value.size}; }

bool asciiFieldByte(std::uint8_t value) {
  return value == 0x20 || value == 0x21 || (value >= 0x23 && value <= 0x5b) || (value >= 0x5d && value <= 0x7e);
}

bool allDigits(std::string_view text) {
  return !text.empty() && std::all_of(text.begin(), text.end(), [](char ch) { return ch >= '0' && ch <= '9'; });
}

bool canonicalUnsigned(std::string_view text, std::uint64_t& value) {
  if (!allDigits(text) || (text.size() > 1 && text.front() == '0')) return false;
  const auto result = std::from_chars(text.data(), text.data() + text.size(), value);
  return result.ec == std::errc{} && result.ptr == text.data() + text.size();
}

bool messageId(std::string_view text, bool optional = false) {
  if (optional && text.empty()) return true;
  if (text.size() != 32) return false;
  bool nonzero = false;
  for (char ch : text) {
    if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) return false;
    nonzero = nonzero || ch != '0';
  }
  return nonzero;
}

bool macHex(std::string_view text) {
  return text.size() == 64 && std::all_of(text.begin(), text.end(), [](char ch) {
    return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f');
  });
}

bool deviceGrammar(std::string_view text) {
  if (text.size() < 3 || text.size() > 32 || text.front() == '-' || text.back() == '-') return false;
  return std::all_of(text.begin(), text.end(), [](char ch) { return (ch >= 'a' && ch <= 'z') ||
                                                                (ch >= '0' && ch <= '9') || ch == '-'; });
}

bool kindGrammar(std::string_view text) {
  return !text.empty() && text.size() <= 16 && std::all_of(text.begin(), text.end(), [](char ch) {
    return (ch >= 'A' && ch <= 'Z') || ch == '_';
  });
}

bool oneOf(std::string_view value, std::initializer_list<std::string_view> allowed) {
  return std::find(allowed.begin(), allowed.end(), value) != allowed.end();
}

struct TopicInfo { std::string_view kind; std::size_t arity; bool c2d; };

bool topicInfo(std::string_view topic, std::string_view device, TopicInfo& info) {
  std::array<char, 96> base{};
  constexpr std::string_view prefix = "aegis/idea3/v1/";
  if (prefix.size() + device.size() + 1 > base.size()) return false;
  std::size_t used = 0;
  std::memcpy(base.data() + used, prefix.data(), prefix.size()); used += prefix.size();
  std::memcpy(base.data() + used, device.data(), device.size()); used += device.size();
  base[used++] = '/';
  const std::string_view start(base.data(), used);
  if (topic.size() <= start.size() || topic.substr(0, start.size()) != start) return false;
  const auto suffix = topic.substr(start.size());
  if (suffix == "command") info = {"COMMAND", 9, true};
  else if (suffix == "heartbeat") info = {"HEARTBEAT", 6, true};
  else if (suffix == "ack") info = {"ACK", 9, false};
  else if (suffix == "status") info = {"STATUS", 14, false};
  else return false;
  return true;
}

bool validRssi(std::string_view text) {
  if (text == "0") return true;
  if (text.size() < 2 || text.front() != '-' || text[1] == '0') return false;
  std::uint64_t magnitude = 0;
  return canonicalUnsigned(text.substr(1), magnitude) && magnitude >= 1 && magnitude <= 127;
}

bool validateFields(const Parsed& parsed, const TopicInfo& info) {
  const auto at = [&](std::size_t index) { return view(parsed.elements[index]); };
  if (!kindGrammar(at(1)) || !deviceGrammar(at(2)) || !macHex(at(parsed.count - 1))) return false;
  std::uint64_t value = 0;
  if (info.kind == "COMMAND") {
    return messageId(at(3)) && canonicalUnsigned(at(4), value) && value >= 1 &&
           canonicalUnsigned(at(5), value) && canonicalUnsigned(at(6), value) &&
           oneOf(at(7), {"CUT_UPLINK", "RESTORE_UPLINK"});
  }
  if (info.kind == "HEARTBEAT") return messageId(at(3)) && canonicalUnsigned(at(4), value);
  if (info.kind == "ACK") {
    return messageId(at(3)) && canonicalUnsigned(at(4), value) && messageId(at(5)) &&
           canonicalUnsigned(at(6), value) && value >= 1 &&
           oneOf(at(7), {"ACCEPTED", "REJECTED_EXPIRED", "REJECTED_SEQUENCE", "REJECTED_PERSIST"});
  }
  return messageId(at(3)) && canonicalUnsigned(at(4), value) &&
         oneOf(at(5), {"SYNCED", "HOLDOVER", "UNTRUSTED"}) &&
         oneOf(at(6), {"NORMAL", "LOCKDOWN"}) &&
         oneOf(at(7), {"BOOT", "PERIODIC", "COMMAND", "DEADMAN", "BOOT_GRACE", "SEQUENCE_REJECTED"}) &&
         messageId(at(8), true) && canonicalUnsigned(at(9), value) && canonicalUnsigned(at(10), value) &&
         validRssi(at(11)) && canonicalUnsigned(at(12), value) && value <= 0xffffffffULL;
}

bool consistency(const Parsed& parsed, const TopicInfo& info) {
  const auto at = [&](std::size_t index) { return view(parsed.elements[index]); };
  std::uint64_t a = 0, b = 0, c = 0;
  if (info.kind == "COMMAND") {
    canonicalUnsigned(at(5), a); canonicalUnsigned(at(6), b);
    return a >= TIME_FLOOR && a < b && b - a <= 30;
  }
  if (info.kind == "HEARTBEAT") { canonicalUnsigned(at(4), a); return a >= TIME_FLOOR; }
  if (info.kind == "ACK") { canonicalUnsigned(at(4), a); return a >= TIME_FLOOR; }
  canonicalUnsigned(at(4), a); canonicalUnsigned(at(9), b); canonicalUnsigned(at(10), c);
  const bool untrusted = at(5) == "UNTRUSTED";
  if (untrusted != (a == 0) || (!untrusted && a < TIME_FLOOR)) return false;
  const bool correlated = !at(8).empty();
  const bool correlationReason = at(7) == "COMMAND" || at(7) == "SEQUENCE_REJECTED";
  if (correlated != correlationReason || correlated != (b >= 1)) return false;
  return at(7) != "SEQUENCE_REJECTED" || c >= b;
}

bool fromHex(char high, char low, std::uint8_t& value) {
  const auto nibble = [](char ch) -> int {
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
    return -1;
  };
  const int h = nibble(high), l = nibble(low);
  if (h < 0 || l < 0) return false;
  value = static_cast<std::uint8_t>((h << 4) | l);
  return true;
}

}  // namespace

const char* stageName(Stage stage) {
  switch (stage) {
    case Stage::ACCEPTED: return "ACCEPTED"; case Stage::TRANSPORT: return "TRANSPORT";
    case Stage::SCHEMA: return "SCHEMA"; case Stage::PAYLOAD: return "PAYLOAD"; case Stage::TIME: return "TIME";
    case Stage::AUTH: return "AUTH"; case Stage::SKEW: return "SKEW"; case Stage::REPLAY: return "REPLAY";
    case Stage::PERSIST: return "PERSIST";
  }
  return "SCHEMA";
}

bool buildSigningInput(std::string_view domain, std::string_view topic, const Span* elements,
                       std::size_t count, std::uint8_t* out, std::size_t capacity, std::size_t& written) {
  written = 0;
  if (!appendLp(out, capacity, written, span(LABEL)) || !appendLp(out, capacity, written, span(domain)) ||
      !appendLp(out, capacity, written, span(topic))) return false;
  for (std::size_t index = 0; index < count; ++index) {
    if (!appendLp(out, capacity, written, elements[index])) return false;
  }
  return true;
}

Result parse(const std::uint8_t* raw, std::size_t length, std::string_view topic, std::string_view deviceId,
             std::string_view receiver, bool retained, Parsed& parsed) {
  parsed = {};
  if (retained) return {Stage::TRANSPORT, "RETAINED"};
  if (length == 0 || length > MAX_WIRE_BYTES) return {Stage::TRANSPORT, "SIZE"};
  TopicInfo info{};
  if (!topicInfo(topic, deviceId, info) || (receiver == "device") != info.c2d) return {Stage::TRANSPORT, "TOPIC"};
  if (raw[0] != '[' || raw[length - 1] != ']') return {Stage::SCHEMA, "SYNTAX"};
  std::size_t cursor = 1;
  const std::size_t versionStart = cursor;
  while (cursor < length && raw[cursor] >= '0' && raw[cursor] <= '9') ++cursor;
  if (cursor == versionStart || (cursor - versionStart > 1 && raw[versionStart] == '0')) return {Stage::SCHEMA, "SYNTAX"};
  parsed.elements[parsed.count++] = {reinterpret_cast<const char*>(raw + versionStart), cursor - versionStart};
  while (cursor < length - 1) {
    if (parsed.count >= MAX_ELEMENTS || cursor + 3 > length || raw[cursor++] != ',' || raw[cursor++] != '"')
      return {Stage::SCHEMA, "SYNTAX"};
    const std::size_t start = cursor;
    while (cursor < length && raw[cursor] != '"') {
      if (!asciiFieldByte(raw[cursor])) return {Stage::SCHEMA, "SYNTAX"};
      ++cursor;
    }
    if (cursor >= length || raw[cursor] != '"') return {Stage::SCHEMA, "SYNTAX"};
    parsed.elements[parsed.count++] = {reinterpret_cast<const char*>(raw + start), cursor - start};
    ++cursor;
  }
  if (cursor != length - 1) return {Stage::SCHEMA, "SYNTAX"};
  parsed.topic = topic;
  if (parsed.count != info.arity) return {Stage::SCHEMA, "ARITY"};
  if (!validateFields(parsed, info)) return {Stage::SCHEMA, "FIELD"};
  if (view(parsed.elements[0]) != "1") return {Stage::PAYLOAD, "VERSION"};
  if (view(parsed.elements[1]) != info.kind) return {Stage::PAYLOAD, "KIND"};
  if (view(parsed.elements[2]) != deviceId) return {Stage::PAYLOAD, "DEVICE"};
  if (!consistency(parsed, info)) return {Stage::PAYLOAD, "CONSISTENCY"};
  return {Stage::ACCEPTED, "OK"};
}

bool ctEqual32(const std::uint8_t* left, const std::uint8_t* right) {
  std::uint8_t difference = 0;
  for (std::size_t index = 0; index < 32; ++index) difference |= left[index] ^ right[index];
  return difference == 0;
}

bool verify(const Parsed& parsed, const std::uint8_t key[32]) {
  if (parsed.count < 2) return false;
  std::array<std::uint8_t, MAX_SIGNING_BYTES> input{};
  std::size_t length = 0;
  const auto kind = view(parsed.elements[1]);
  const auto domain = (kind == "COMMAND" || kind == "HEARTBEAT") ? C2D : D2C;
  if (!buildSigningInput(domain, parsed.topic, parsed.elements.data(), parsed.count - 1,
                         input.data(), input.size(), length)) return false;
  std::array<std::uint8_t, 32> expected{}, supplied{};
  const auto mac = view(parsed.elements[parsed.count - 1]);
  if (mac.size() != 64 || !hmacSha256(key, input.data(), length, expected.data())) return false;
  for (std::size_t index = 0; index < 32; ++index) {
    if (!fromHex(mac[index * 2], mac[index * 2 + 1], supplied[index])) return false;
  }
  return ctEqual32(expected.data(), supplied.data());
}

}  // namespace aegis::p1
