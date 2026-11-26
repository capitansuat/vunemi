/* The move request, as files_move sends it (AtomicMoveRequest in
 * packages/files/src/safe-move.ts without signal and assertActive), read from
 * one line of JSON with fixed limits, and the one-line reply. */
#ifndef VUNEMI_REQUEST_H
#define VUNEMI_REQUEST_H
#include <stddef.h>
#include <stdint.h>

#define MOVE_MAX_REQUEST 65536
#define MOVE_MAX_PATH 4096
#define MOVE_MAX_OWNER 160

typedef struct {
  char device[24], inode[24], size[24], mtime_ns[24], ctime_ns[24];
  char sha256[65];
} move_identity;

typedef struct {
  char *path;
  char device[24], inode[24];
  uint64_t uid, mode;
} move_parent;

typedef struct {
  char operation_id[37];
  char owner_id[MOVE_MAX_OWNER + 1];
  char *source, *destination;
  move_identity source_identity;
  move_parent *source_parents, *destination_parents;
  size_t source_parent_count, destination_parent_count;
} move_request;

/* Parses and checks the request's shape: exactly its keys, the right types,
 * decimal strings where Node writes them, a UUID operation id, paths no
 * longer than MOVE_MAX_PATH and without NUL. Returns 0, or -1 (invalid). */
int move_parse_request(const char *text, size_t size, move_request *out);
void move_free_request(move_request *req);

/* Writes {"status":"moved"} or {"status":"<status>","reasonCode":"<code>"} and a newline to stdout. */
void move_reply(const char *status, const char *code);
#endif
