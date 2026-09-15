#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace aegis::p1 {

constexpr std::size_t MAX_WIRE_BYTES = 512;
constexpr std::size_t MAX_ELEMENTS = 16;
constexpr std::size_t MAX_SIGNING_BYTES = 1024;

enum class Stage { ACCEPTED, TRANSPORT, SCHEMA, PAYLOAD, TIME, AUTH, SKEW, REPLAY, PERSIST };

struct Result {
  Stage stage;
  const char* code;
};

struct Span {
  const char* data;
  std::size_t size;
};

struct Parsed {
  std::array<Span, MAX_ELEMENTS> elements{};
  std::size_t count = 0;
  std::string_view topic;
};

const char* stageName(Stage stage);
bool buildSigningInput(std::string_view domain, std::string_view topic,
                       const Span* elements, std::size_t count,
                       std::uint8_t* out, std::size_t capacity, std::size_t& written);
Result parse(const std::uint8_t* raw, std::size_t length, std::string_view topic,
             std::string_view deviceId, std::string_view receiver, bool retained, Parsed& parsed);
bool ctEqual32(const std::uint8_t* left, const std::uint8_t* right);
bool verify(const Parsed& parsed, const std::uint8_t key[32]);

// Implemented once per target: OpenSSL in host tests, mbedTLS in firmware.
bool hmacSha256(const std::uint8_t key[32], const std::uint8_t* data,
                std::size_t length, std::uint8_t out[32]);

}  // namespace aegis::p1
