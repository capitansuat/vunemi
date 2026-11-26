/* SHA-256 (FIPS 180-4), written for vunemi-move: the move checks that the
 * file it renames is the file the user approved, byte for byte. */
#ifndef VUNEMI_SHA256_H
#define VUNEMI_SHA256_H
#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint32_t state[8];
  uint64_t length;
  uint8_t block[64];
  size_t used;
} sha256_ctx;

void sha256_init(sha256_ctx *ctx);
void sha256_update(sha256_ctx *ctx, const void *data, size_t size);
/* Writes 64 lowercase hex digits and a NUL into hex. */
void sha256_final_hex(sha256_ctx *ctx, char hex[65]);
#endif
