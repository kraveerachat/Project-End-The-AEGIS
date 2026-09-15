#include "aegis_protocol.h"

#include <array>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <string>
#include <string_view>
#include <vector>

namespace {

bool decodeHex(std::string_view text, std::vector<std::uint8_t>& out) {
  if (text.size() % 2 != 0) return false;
  out.clear(); out.reserve(text.size() / 2);
  auto nibble = [](char ch) -> int {
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
    return -1;
  };
  for (std::size_t index = 0; index < text.size(); index += 2) {
    const int high = nibble(text[index]), low = nibble(text[index + 1]);
    if (high < 0 || low < 0) return false;
    out.push_back(static_cast<std::uint8_t>((high << 4) | low));
  }
  return true;
}

std::string hex(const std::uint8_t* data, std::size_t size) {
  static constexpr char digits[] = "0123456789abcdef";
  std::string out(size * 2, '0');
  for (std::size_t index = 0; index < size; ++index) {
    out[index * 2] = digits[data[index] >> 4]; out[index * 2 + 1] = digits[data[index] & 15];
  }
  return out;
}

int sign(int argc, char** argv) {
  if (argc != 6) return 2;
  std::vector<std::uint8_t> keyBytes;
  if (!decodeHex(argv[2], keyBytes) || keyBytes.size() != 32) return 2;
  std::vector<std::string> storage;
  std::string packed = argv[5];
  std::size_t start = 0;
  while (start <= packed.size()) {
    const auto end = packed.find(',', start);
    std::vector<std::uint8_t> decoded;
    if (!decodeHex(packed.substr(start, end == std::string::npos ? end : end - start), decoded)) return 2;
    storage.emplace_back(decoded.begin(), decoded.end());
    if (end == std::string::npos) break;
    start = end + 1;
  }
  std::vector<aegis::p1::Span> spans;
  for (const auto& value : storage) spans.push_back({value.data(), value.size()});
  std::array<std::uint8_t, aegis::p1::MAX_SIGNING_BYTES> input{};
  std::size_t inputLength = 0;
  if (!aegis::p1::buildSigningInput(argv[3], argv[4], spans.data(), spans.size(), input.data(), input.size(), inputLength))
    return 2;
  std::array<std::uint8_t, 32> mac{};
  if (!aegis::p1::hmacSha256(keyBytes.data(), input.data(), inputLength, mac.data())) return 2;
  std::cout << hex(input.data(), inputLength) << '\t' << hex(mac.data(), mac.size()) << '\n';
  return 0;
}

aegis::p1::Result parseOne(std::vector<std::uint8_t>& raw, std::string_view topic,
                           std::string_view device, std::string_view receiver, bool retained) {
  aegis::p1::Parsed parsed{};
  return aegis::p1::parse(raw.data(), raw.size(), topic, device, receiver, retained, parsed);
}

int parse(int argc, char** argv) {
  if (argc != 7) return 2;
  std::vector<std::uint8_t> raw;
  if (!decodeHex(argv[2], raw)) return 2;
  const auto result = parseOne(raw, argv[3], argv[4], argv[5], std::string_view(argv[6]) == "1");
  std::cout << aegis::p1::stageName(result.stage) << '\t' << result.code << '\n';
  return 0;
}

int fuzz(int argc, char** argv) {
  if (argc != 6) return 2;
  std::vector<std::uint8_t> seed;
  if (!decodeHex(argv[2], seed) || seed.empty()) return 2;
  std::uint32_t state = 0x5eed1234U;
  const int rounds = std::atoi(argv[5]);
  for (int round = 0; round < rounds; ++round) {
    auto raw = seed;
    state = state * 1664525U + 1013904223U;
    const std::size_t index = state % raw.size();
    state = state * 1664525U + 1013904223U;
    raw[index] ^= static_cast<std::uint8_t>(1U << (state % 8));
    (void)parseOne(raw, argv[3], argv[4], "device", false);
  }
  std::cout << "OK\n";
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) return 2;
  const std::string_view operation = argv[1];
  if (operation == "sign") return sign(argc, argv);
  if (operation == "parse") return parse(argc, argv);
  if (operation == "fuzz") return fuzz(argc, argv);
  return 2;
}
