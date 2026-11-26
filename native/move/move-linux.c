/* vunemi-move for Linux: files_move's native step, the twin of the Mac
 * helper's safeFileMove (native/VunemiHelper/Sources/VunemiHelper/FileMove.swift),
 * step for step. It renames one approved regular file with
 * renameat2(RENAME_NOREPLACE), relative to folder descriptors opened from "/"
 * without following links, so it never replaces anything and a parent folder
 * swapped for a link cannot redirect it.
 *
 *   vunemi-move --move               one JSON request on stdin, one JSON reply on stdout
 *   vunemi-move --journal-lock-fd 3  takes flock on fd 3, as the Mac helper does
 *
 * Everything after a successful rename that fails is "unknown": no rollback,
 * no retry. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#include "request.h"
#include "sha256.h"

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif

#define MOVE_LIMIT ((int64_t)256 * 1024 * 1024)
#define DIR_FLAGS (O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
#define FILE_FLAGS (O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)

static const char *refusal;  /* the reason code of the failed step */
#define REQUIRE(ok, code) do { if (!(ok)) { refusal = (code); goto fail; } } while (0)

static void ns(char out[24], struct timespec t) { snprintf(out, 24, "%" PRId64, (int64_t)t.tv_sec * 1000000000 + (int64_t)t.tv_nsec); }
static void dec(char out[24], uintmax_t v) { snprintf(out, 24, "%ju", v); }

/* The file's identity and hash, read through fd; refuses a file that changes while it is read. */
static int identity(int fd, move_identity *out) {
  struct stat before, after;
  if (fstat(fd, &before) != 0) { refusal = "stat-unavailable"; return -1; }
  if (!S_ISREG(before.st_mode) || before.st_size < 0 || before.st_size > MOVE_LIMIT) { refusal = "source-not-bounded-regular-file"; return -1; }
  if (lseek(fd, 0, SEEK_SET) != 0) { refusal = "read-unavailable"; return -1; }
  sha256_ctx ctx;
  sha256_init(&ctx);
  static unsigned char buf[65536];
  int64_t total = 0;
  for (;;) {
    ssize_t n = read(fd, buf, sizeof buf);
    if (n < 0) { if (errno == EINTR) continue; refusal = "read-unavailable"; return -1; }
    if (n == 0) break;
    total += n;
    if (total > MOVE_LIMIT) { refusal = "source-too-large"; return -1; }
    sha256_update(&ctx, buf, (size_t)n);
  }
  if (fstat(fd, &after) != 0) { refusal = "stat-unavailable"; return -1; }
  if (before.st_dev != after.st_dev || before.st_ino != after.st_ino || before.st_size != after.st_size || before.st_mtim.tv_sec != after.st_mtim.tv_sec ||
      before.st_mtim.tv_nsec != after.st_mtim.tv_nsec || before.st_ctim.tv_sec != after.st_ctim.tv_sec || before.st_ctim.tv_nsec != after.st_ctim.tv_nsec ||
      total != after.st_size) {
    refusal = "source-changed";
    return -1;
  }
  dec(out->device, (uintmax_t)after.st_dev);
  dec(out->inode, (uintmax_t)after.st_ino);
  dec(out->size, (uintmax_t)after.st_size);
  ns(out->mtime_ns, after.st_mtim);
  ns(out->ctime_ns, after.st_ctim);
  sha256_final_hex(&ctx, out->sha256);
  return 0;
}

/* Splits an absolute path into its names: no empty, "." or ".." name, at least one. */
static int split(const char *path, char ***names, size_t *count) {
  size_t len = strlen(path);
  if (path[0] != '/' || len < 2 || len > MOVE_MAX_PATH) return -1;
  char *copy = strdup(path + 1);
  if (!copy) return -1;
  size_t n = 1;
  for (char *p = copy; *p; p++) if (*p == '/') n++;
  char **out = calloc(n, sizeof *out);
  if (!out) { free(copy); return -1; }
  size_t i = 0;
  for (char *start = copy;;) {
    char *slash = strchr(start, '/');
    if (slash) *slash = 0;
    if (!*start || strcmp(start, ".") == 0 || strcmp(start, "..") == 0) { free(copy); free(out); return -1; }
    out[i++] = start;
    if (!slash) break;
    start = slash + 1;
  }
  *names = out;
  *count = n;
  return 0;
}

static int parent_matches(int fd, const char *built, const move_parent *expected) {
  struct stat s;
  if (fstat(fd, &s) != 0 || !S_ISDIR(s.st_mode)) return 0;
  char device[24], inode[24];
  dec(device, (uintmax_t)s.st_dev);
  dec(inode, (uintmax_t)s.st_ino);
  return strcmp(built, expected->path) == 0 && strcmp(device, expected->device) == 0 && strcmp(inode, expected->inode) == 0 &&
         (uint64_t)s.st_uid == expected->uid && (uint64_t)s.st_mode == expected->mode;
}

/* Opens the folder holding the path's last name, one folder at a time from
 * "/", never through a link, checking each against the request. */
static int open_parent(char **names, size_t count, const move_parent *expected, size_t expected_count) {
  if (expected_count != count) { refusal = "parent-binding-invalid"; return -1; }
  int fd = open("/", DIR_FLAGS);
  if (fd < 0) { refusal = "parent-unavailable"; return -1; }
  if (!parent_matches(fd, "/", &expected[0])) { close(fd); refusal = "parent-changed"; return -1; }
  char built[MOVE_MAX_PATH + 2] = "";
  for (size_t i = 0; i + 1 < count; i++) {
    size_t used = strlen(built);
    snprintf(built + used, sizeof built - used, "/%s", names[i]);
    int next = openat(fd, names[i], DIR_FLAGS);
    close(fd);
    if (next < 0) { refusal = "parent-changed"; return -1; }
    fd = next;
    if (!parent_matches(fd, built, &expected[i + 1])) { close(fd); refusal = "parent-changed"; return -1; }
  }
  return fd;
}

static int no_entry(int dirfd, const char *name, const char *code) {
  struct stat s;
  if (fstatat(dirfd, name, &s, AT_SYMLINK_NOFOLLOW) == 0) { refusal = code; return -1; }
  if (errno != ENOENT) { refusal = "destination-unavailable"; return -1; }
  return 0;
}

/* A hook for the tests only: waits, right before the rename, until the named file exists. */
static int test_gate(void) {
  const char *gate = getenv("VUNEMI_MOVE_TEST_GATE");
  if (!gate || !*gate) return 0;
  fputs("gate\n", stderr);
  fflush(stderr);
  for (int i = 0; i < 1000; i++) {
    if (access(gate, F_OK) == 0) return 0;
    usleep(10000);
  }
  refusal = "test-gate-timeout";
  return -1;
}

static void free_names(char **names) {
  if (!names) return;
  free(names[0]);  /* the copy every name points into */
  free(names);
}

static int same_identity(const move_identity *a, const move_identity *b) {
  return strcmp(a->device, b->device) == 0 && strcmp(a->inode, b->inode) == 0 && strcmp(a->size, b->size) == 0 && strcmp(a->mtime_ns, b->mtime_ns) == 0 &&
         strcmp(a->ctime_ns, b->ctime_ns) == 0 && strcmp(a->sha256, b->sha256) == 0;
}

static int move(const move_request *req) {
  char **sn = NULL, **dn = NULL;
  size_t sc = 0, dc = 0;
  int source_fd = -1, destination_fd = -1, file_fd = -1, renamed = 0;
  REQUIRE(split(req->source, &sn, &sc) == 0 && split(req->destination, &dn, &dc) == 0, "invalid-path");
  REQUIRE(strcmp(req->source, req->destination) != 0, "same-path");
  if ((source_fd = open_parent(sn, sc, req->source_parents, req->source_parent_count)) < 0) goto fail;
  if ((destination_fd = open_parent(dn, dc, req->destination_parents, req->destination_parent_count)) < 0) goto fail;
  const char *sname = sn[sc - 1], *dname = dn[dc - 1];
  file_fd = openat(source_fd, sname, FILE_FLAGS);
  REQUIRE(file_fd >= 0, "source-unavailable");
  move_identity seen;
  if (identity(file_fd, &seen) < 0) goto fail;
  REQUIRE(same_identity(&seen, &req->source_identity), "source-changed");
  struct stat ds, fs;
  REQUIRE(fstat(destination_fd, &ds) == 0 && fstat(file_fd, &fs) == 0, "stat-unavailable");
  REQUIRE(ds.st_dev == fs.st_dev, "cross-volume-unsupported");
  if (no_entry(destination_fd, dname, "destination-exists") < 0) goto fail;
  /* The chains again, from "/", right before the rename; the descriptors already held cannot be redirected. */
  int again = open_parent(sn, sc, req->source_parents, req->source_parent_count);
  if (again < 0) goto fail;
  close(again);
  if ((again = open_parent(dn, dc, req->destination_parents, req->destination_parent_count)) < 0) goto fail;
  close(again);
  struct stat entry;
  char device[24], inode[24], size[24], mtime[24], ctime[24];
  REQUIRE(fstatat(source_fd, sname, &entry, AT_SYMLINK_NOFOLLOW) == 0, "source-changed");
  dec(device, (uintmax_t)entry.st_dev); dec(inode, (uintmax_t)entry.st_ino); dec(size, (uintmax_t)entry.st_size);
  ns(mtime, entry.st_mtim); ns(ctime, entry.st_ctim);
  REQUIRE(strcmp(device, req->source_identity.device) == 0 && strcmp(inode, req->source_identity.inode) == 0 && strcmp(size, req->source_identity.size) == 0 &&
          strcmp(mtime, req->source_identity.mtime_ns) == 0 && strcmp(ctime, req->source_identity.ctime_ns) == 0, "source-changed");
  if (test_gate() < 0) goto fail;
  if (syscall(SYS_renameat2, source_fd, sname, destination_fd, dname, RENAME_NOREPLACE) != 0) {
    int e = errno;
    refusal = e == EEXIST ? "destination-exists" : e == EXDEV ? "cross-volume-unsupported" : (e == EINVAL || e == ENOSYS) ? "noreplace-unsupported" : "rename-refused";
    goto fail;
  }
  renamed = 1;
  int moved = openat(destination_fd, dname, FILE_FLAGS);
  REQUIRE(moved >= 0, "postcondition-unavailable");
  move_identity actual;
  int same = identity(moved, &actual);
  close(moved);
  if (same < 0) goto fail;
  REQUIRE(strcmp(actual.device, req->source_identity.device) == 0 && strcmp(actual.inode, req->source_identity.inode) == 0 &&
          strcmp(actual.size, req->source_identity.size) == 0 && strcmp(actual.sha256, req->source_identity.sha256) == 0, "postcondition-mismatch");
  if (no_entry(source_fd, sname, "source-still-present") < 0) goto fail;
  if ((again = open_parent(sn, sc, req->source_parents, req->source_parent_count)) < 0) goto fail;
  close(again);
  if ((again = open_parent(dn, dc, req->destination_parents, req->destination_parent_count)) < 0) goto fail;
  close(again);
  REQUIRE(fsync(source_fd) == 0 && fsync(destination_fd) == 0, "postcommit-durability-unavailable");
  move_reply("moved", NULL);
  close(file_fd); close(source_fd); close(destination_fd);
  free_names(sn); free_names(dn);
  return 0;
fail:
  move_reply(renamed ? "unknown" : "not-moved", refusal ? refusal : "move-failed");
  if (file_fd >= 0) close(file_fd);
  if (source_fd >= 0) close(source_fd);
  if (destination_fd >= 0) close(destination_fd);
  free_names(sn); free_names(dn);
  return 1;
}

/* The Mac helper's --journal-lock-fd 3, unchanged: the lock belongs to the
 * open file the app shares with this process, so it outlives it. */
static int journal_lock(int argc, char **argv) {
  struct stat info;
  if (argc != 3 || strcmp(argv[2], "3") != 0 || fstat(3, &info) != 0 || !S_ISREG(info.st_mode) || info.st_uid != geteuid() || (info.st_mode & 077) != 0 ||
      info.st_nlink != 1) {
    fputs("{\"protocol\":1,\"locked\":false,\"reason\":\"invalid-fd\"}\n", stdout);
    return 64;
  }
  int result = flock(3, LOCK_EX | LOCK_NB);
  int code = errno;
  if (result == 0) { fputs("{\"protocol\":1,\"locked\":true}\n", stdout); return 0; }
  fprintf(stdout, "{\"protocol\":1,\"locked\":false,\"reason\":\"%s\"}\n", code == EWOULDBLOCK ? "busy" : "unavailable");
  return code == EWOULDBLOCK ? 75 : 74;
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "--journal-lock-fd") == 0) return journal_lock(argc, argv);
  if (argc == 2 && strcmp(argv[1], "--version") == 0) { puts("vunemi-move 1"); return 0; }
  if (argc != 2 || strcmp(argv[1], "--move") != 0) {
    move_reply("not-moved", "invalid-request");
    return 2;
  }
  static char input[MOVE_MAX_REQUEST + 2];
  size_t size = 0;
  for (;;) {
    ssize_t n = read(0, input + size, sizeof input - 1 - size);
    if (n < 0) { if (errno == EINTR) continue; move_reply("not-moved", "invalid-request"); return 2; }
    if (n == 0) break;
    size += (size_t)n;
    if (size > MOVE_MAX_REQUEST) { move_reply("not-moved", "invalid-request"); return 2; }
  }
  while (size > 0 && (input[size - 1] == '\n' || input[size - 1] == '\r')) size--;
  move_request req;
  if (move_parse_request(input, size, &req) < 0) { move_reply("not-moved", "invalid-request"); return 2; }
  int code = move(&req);
  move_free_request(&req);
  return code;
}
