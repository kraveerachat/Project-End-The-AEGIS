#include "aegis_protocol.h"

#include <openssl/evp.h>

namespace aegis::p1 {

bool hmacSha256(const std::uint8_t key[32], const std::uint8_t* data, std::size_t length, std::uint8_t out[32]) {
  std::size_t written = 0;
  return EVP_Q_mac(nullptr, "HMAC", nullptr, "SHA256", nullptr, key, 32, data, length, out, 32, &written) != nullptr &&
         written == 32;
}

}  // namespace aegis::p1
