#include "aegis_protocol.h"

#include <mbedtls/md.h>

namespace aegis::p1 {

bool hmacSha256(const std::uint8_t key[32], const std::uint8_t* data, std::size_t length, std::uint8_t out[32]) {
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  return info != nullptr && mbedtls_md_hmac(info, key, 32, data, length, out) == 0;
}

}  // namespace aegis::p1
