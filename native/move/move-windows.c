/* vunemi-move for Windows: files_move's native step, the twin of the Mac
 * helper's safeFileMove (native/VunemiHelper/Sources/VunemiHelper/FileMove.swift).
 *
 * Every folder of both chains, from the drive root, is opened without
 * following a junction or link and kept open without FILE_SHARE_DELETE until
 * the end: while they are held, none of them can be renamed, deleted or
 * swapped for a junction. The file is then renamed with
 * SetFileInformationByHandle(FileRenameInfoEx) to the destination's full path,
 * which the held chain pins to the approved folder, and without the replace
 * flag, so it never replaces anything.
 *
 *   vunemi-move --move   one JSON request on stdin, one JSON reply on stdout
 *
 * The journal lock is the app's own on Windows (journal-windows.ts).
 * Everything after a successful rename that fails is "unknown". */
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "request.h"
#include "sha256.h"

#define MOVE_LIMIT ((int64_t)256 * 1024 * 1024)
#define DIR_SHARE (FILE_SHARE_READ | FILE_SHARE_WRITE)

static const char *refusal;
#define REQUIRE(ok, code) do { if (!(ok)) { refusal = (code); goto fail; } } while (0)

/* Node's numbers for a handle: the 32-bit volume serial, the 64-bit file index,
 * and times as nanoseconds since 1970 in steps of 100. */
typedef struct { uint64_t device, inode, size, mtime, ctime; DWORD attributes; } win_stat;

static uint64_t unix_ns(LARGE_INTEGER t) { return (uint64_t)(t.QuadPart - 116444736000000000LL) * 100; }

static int stat_handle(HANDLE h, win_stat *out) {
  BY_HANDLE_FILE_INFORMATION info;
  FILE_BASIC_INFO basic;
  if (!GetFileInformationByHandle(h, &info) || !GetFileInformationByHandleEx(h, FileBasicInfo, &basic, sizeof basic)) return -1;
  out->device = info.dwVolumeSerialNumber;
  out->inode = (uint64_t)info.nFileIndexHigh << 32 | info.nFileIndexLow;
  out->size = (uint64_t)info.nFileSizeHigh << 32 | info.nFileSizeLow;
  out->mtime = unix_ns(basic.LastWriteTime);
  out->ctime = unix_ns(basic.ChangeTime);
  out->attributes = info.dwFileAttributes;
  return 0;
}

static void dec(char out[24], uint64_t v) { snprintf(out, 24, "%llu", (unsigned long long)v); }

/* UTF-8 to a \\?\ path, so no name is reinterpreted (no trailing-dot trimming, no device names). */
static wchar_t *wide(const char *path) {
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, NULL, 0);
  if (n <= 0) return NULL;
  wchar_t *out = malloc((size_t)(n + 4) * sizeof *out);
  if (!out) return NULL;
  wcscpy(out, L"\\\\?\\");
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, out + 4, n);
  return out;
}

static int reserved(const char *name) {
  static const char *const devices[] = {"CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
                                        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "CONIN$", "CONOUT$"};
  size_t stem = strcspn(name, ".");
  for (size_t i = 0; i < sizeof devices / sizeof *devices; i++)
    if (strlen(devices[i]) == stem && _strnicmp(name, devices[i], stem) == 0) return 1;
  return 0;
}

/* A drive path: "X:\" and names split by "\", none empty, ".", "..", a device
 * name, ending in a dot or space, or holding a character Windows refuses. */
static int split(const char *path, char ***names, size_t *count) {
  size_t len = strlen(path);
  if (len < 4 || len > MOVE_MAX_PATH || !((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) || path[1] != ':' || path[2] != '\\') return -1;
  char *copy = _strdup(path + 3);
  if (!copy) return -1;
  size_t n = 1;
  for (char *p = copy; *p; p++) {
    unsigned char c = (unsigned char)*p;
    if (c == '\\') n++;
    else if (c < 0x20 || strchr("<>:\"/|?*", c)) { free(copy); return -1; }
  }
  char **out = calloc(n, sizeof *out);
  if (!out) { free(copy); return -1; }
  size_t i = 0;
  for (char *start = copy;;) {
    char *slash = strchr(start, '\\');
    if (slash) *slash = 0;
    size_t l = strlen(start);
    if (!l || strcmp(start, ".") == 0 || strcmp(start, "..") == 0 || start[l - 1] == '.' || start[l - 1] == ' ' || reserved(start)) { free(copy); free(out); return -1; }
    out[i++] = start;
    if (!slash) break;
    start = slash + 1;
  }
  *names = out;
  *count = n;
  return 0;
}

static void free_names(char **names) { if (names) { free(names[0]); free(names); } }

typedef struct { HANDLE *handles; size_t count; } chain;

static void close_chain(chain *c) {
  for (size_t i = 0; i < c->count; i++) if (c->handles[i] != INVALID_HANDLE_VALUE) CloseHandle(c->handles[i]);
  free(c->handles);
  c->handles = NULL;
  c->count = 0;
}

static HANDLE open_dir(const char *path) {
  wchar_t *w = wide(path);
  if (!w) return INVALID_HANDLE_VALUE;
  HANDLE h = CreateFileW(w, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE, DIR_SHARE, NULL, OPEN_EXISTING,
                         FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  free(w);
  return h;
}

/* Opens and holds every folder of the path's chain, from the drive root, checking each against the request. */
static int open_chain(const char *path, char **names, size_t count, const move_parent *expected, size_t expected_count, chain *out) {
  out->handles = NULL; out->count = 0;
  if (expected_count != count) { refusal = "parent-binding-invalid"; return -1; }
  out->handles = malloc(count * sizeof *out->handles);
  if (!out->handles) { refusal = "parent-unavailable"; return -1; }
  char built[MOVE_MAX_PATH + 2];
  snprintf(built, sizeof built, "%c:\\", path[0]);
  for (size_t i = 0; i < count; i++) {
    if (i > 0) {
      size_t used = strlen(built);
      snprintf(built + used, sizeof built - used, "%s%s", i > 1 ? "\\" : "", names[i - 1]);
    }
    HANDLE h = open_dir(built);
    out->handles[out->count++] = h;
    win_stat s;
    if (h == INVALID_HANDLE_VALUE || stat_handle(h, &s) < 0 || !(s.attributes & FILE_ATTRIBUTE_DIRECTORY) || (s.attributes & FILE_ATTRIBUTE_REPARSE_POINT)) { refusal = "parent-changed"; return -1; }
    char device[24], inode[24];
    dec(device, s.device);
    dec(inode, s.inode);
    /* Node makes up uid and mode on Windows: only the path, volume and file index say which folder this is. */
    if (_stricmp(built, expected[i].path) != 0 || strcmp(device, expected[i].device) != 0 || strcmp(inode, expected[i].inode) != 0) { refusal = "parent-changed"; return -1; }
  }
  return 0;
}

static HANDLE open_file(const char *path, DWORD access) {
  wchar_t *w = wide(path);
  if (!w) return INVALID_HANDLE_VALUE;
  HANDLE h = CreateFileW(w, access, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, NULL);
  free(w);
  return h;
}

static int identity(HANDLE h, move_identity *out) {
  win_stat before, after;
  if (stat_handle(h, &before) < 0) { refusal = "stat-unavailable"; return -1; }
  if ((before.attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DEVICE)) || before.size > (uint64_t)MOVE_LIMIT) { refusal = "source-not-bounded-regular-file"; return -1; }
  LARGE_INTEGER zero = {0};
  if (!SetFilePointerEx(h, zero, NULL, FILE_BEGIN)) { refusal = "read-unavailable"; return -1; }
  sha256_ctx ctx;
  sha256_init(&ctx);
  static unsigned char buf[65536];
  uint64_t total = 0;
  for (;;) {
    DWORD n = 0;
    if (!ReadFile(h, buf, sizeof buf, &n, NULL)) { refusal = "read-unavailable"; return -1; }
    if (n == 0) break;
    total += n;
    if (total > (uint64_t)MOVE_LIMIT) { refusal = "source-too-large"; return -1; }
    sha256_update(&ctx, buf, n);
  }
  if (stat_handle(h, &after) < 0) { refusal = "stat-unavailable"; return -1; }
  if (before.device != after.device || before.inode != after.inode || before.size != after.size || before.mtime != after.mtime || before.ctime != after.ctime || total != after.size) {
    refusal = "source-changed";
    return -1;
  }
  dec(out->device, after.device); dec(out->inode, after.inode); dec(out->size, after.size);
  dec(out->mtime_ns, after.mtime); dec(out->ctime_ns, after.ctime);
  sha256_final_hex(&ctx, out->sha256);
  return 0;
}

static int same_identity(const move_identity *a, const move_identity *b) {
  return strcmp(a->device, b->device) == 0 && strcmp(a->inode, b->inode) == 0 && strcmp(a->size, b->size) == 0 && strcmp(a->mtime_ns, b->mtime_ns) == 0 &&
         strcmp(a->ctime_ns, b->ctime_ns) == 0 && strcmp(a->sha256, b->sha256) == 0;
}

static int absent(const char *path, const char *code) {
  wchar_t *w = wide(path);
  if (!w) { refusal = "destination-unavailable"; return -1; }
  DWORD attributes = GetFileAttributesW(w);
  DWORD e = GetLastError();
  free(w);
  if (attributes != INVALID_FILE_ATTRIBUTES) { refusal = code; return -1; }
  if (e != ERROR_FILE_NOT_FOUND) { refusal = "destination-unavailable"; return -1; }
  return 0;
}

static int test_gate(void) {
  const char *gate = getenv("VUNEMI_MOVE_TEST_GATE");
  if (!gate || !*gate) return 0;
  fputs("gate\n", stderr);
  fflush(stderr);
  for (int i = 0; i < 1000; i++) {
    if (GetFileAttributesA(gate) != INVALID_FILE_ATTRIBUTES) return 0;
    Sleep(10);
  }
  refusal = "test-gate-timeout";
  return -1;
}

static int move(const move_request *req) {
  char **sn = NULL, **dn = NULL;
  size_t sc = 0, dc = 0;
  chain sources = {0}, destinations = {0};
  HANDLE file = INVALID_HANDLE_VALUE;
  int renamed = 0;
  FILE_RENAME_INFO *rename = NULL;
  REQUIRE(split(req->source, &sn, &sc) == 0 && split(req->destination, &dn, &dc) == 0, "invalid-path");
  REQUIRE(_stricmp(req->source, req->destination) != 0, "same-path");
  if (open_chain(req->source, sn, sc, req->source_parents, req->source_parent_count, &sources) < 0) goto fail;
  if (open_chain(req->destination, dn, dc, req->destination_parents, req->destination_parent_count, &destinations) < 0) goto fail;
  file = open_file(req->source, DELETE | FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE);
  REQUIRE(file != INVALID_HANDLE_VALUE, "source-unavailable");
  /* A link in the source's place is not followed (the Linux program's O_NOFOLLOW refuses it the same way). */
  win_stat first;
  REQUIRE(stat_handle(file, &first) == 0 && !(first.attributes & FILE_ATTRIBUTE_REPARSE_POINT), "source-unavailable");
  move_identity seen;
  if (identity(file, &seen) < 0) goto fail;
  REQUIRE(same_identity(&seen, &req->source_identity), "source-changed");
  win_stat into;
  REQUIRE(stat_handle(destinations.handles[destinations.count - 1], &into) == 0, "stat-unavailable");
  char device[24];
  dec(device, into.device);
  REQUIRE(strcmp(device, req->source_identity.device) == 0, "cross-volume-unsupported");
  if (absent(req->destination, "destination-exists") < 0) goto fail;
  if (test_gate() < 0) goto fail;
  /* The Win32 call refuses a RootDirectory (ERROR_INVALID_PARAMETER, tried on Windows 11 24H2), so the
   * target is the full path; with every folder of its chain held without FILE_SHARE_DELETE, no name in it
   * can be renamed, removed or replaced meanwhile, so that path reaches only the approved folder. */
  wchar_t *target = wide(req->destination);
  REQUIRE(target != NULL, "invalid-path");
  size_t length = wcslen(target) * sizeof(wchar_t);
  size_t bytes = sizeof(FILE_RENAME_INFO) + length;
  rename = calloc(1, bytes);
  if (!rename) { free(target); refusal = "rename-refused"; goto fail; }
  rename->Flags = 0;  /* no FILE_RENAME_FLAG_REPLACE_IF_EXISTS: an existing name is refused */
  rename->RootDirectory = NULL;
  rename->FileNameLength = (DWORD)length;
  memcpy(rename->FileName, target, length);
  free(target);
  if (!SetFileInformationByHandle(file, FileRenameInfoEx, rename, (DWORD)bytes)) {
    DWORD e = GetLastError();
    refusal = (e == ERROR_ALREADY_EXISTS || e == ERROR_FILE_EXISTS) ? "destination-exists" : e == ERROR_NOT_SAME_DEVICE ? "cross-volume-unsupported" : "rename-refused";
    goto fail;
  }
  renamed = 1;
  CloseHandle(file);
  file = INVALID_HANDLE_VALUE;
  /* Both chains are still held: the destination's full path can only reach the folder approved. */
  HANDLE moved = open_file(req->destination, FILE_READ_DATA | FILE_READ_ATTRIBUTES | FILE_WRITE_DATA | SYNCHRONIZE);
  REQUIRE(moved != INVALID_HANDLE_VALUE, "postcondition-unavailable");
  move_identity actual;
  int checked = identity(moved, &actual);
  BOOL flushed = checked == 0 && FlushFileBuffers(moved);
  CloseHandle(moved);
  if (checked < 0) goto fail;
  REQUIRE(strcmp(actual.device, req->source_identity.device) == 0 && strcmp(actual.inode, req->source_identity.inode) == 0 &&
          strcmp(actual.size, req->source_identity.size) == 0 && strcmp(actual.sha256, req->source_identity.sha256) == 0, "postcondition-mismatch");
  if (absent(req->source, "source-still-present") < 0) goto fail;
  REQUIRE(flushed, "postcommit-durability-unavailable");
  move_reply("moved", NULL);
  free(rename);
  close_chain(&sources); close_chain(&destinations);
  free_names(sn); free_names(dn);
  return 0;
fail:
  move_reply(renamed ? "unknown" : "not-moved", refusal ? refusal : "move-failed");
  if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
  free(rename);
  close_chain(&sources); close_chain(&destinations);
  free_names(sn); free_names(dn);
  return 1;
}

int main(int argc, char **argv) {
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
  if (argc == 2 && strcmp(argv[1], "--version") == 0) { puts("vunemi-move 1"); return 0; }
  if (argc != 2 || strcmp(argv[1], "--move") != 0) {
    /* No journal mode here: Windows lets a process's locks go when it exits. */
    if (argc >= 2 && strcmp(argv[1], "--journal-lock-fd") == 0) { fputs("{\"protocol\":1,\"locked\":false,\"reason\":\"invalid-fd\"}\n", stdout); return 64; }
    move_reply("not-moved", "invalid-request");
    return 2;
  }
  static char input[MOVE_MAX_REQUEST + 2];
  size_t size = 0;
  for (;;) {
    size_t n = fread(input + size, 1, sizeof input - 1 - size, stdin);
    if (n == 0) break;
    size += n;
    if (size > MOVE_MAX_REQUEST) { move_reply("not-moved", "invalid-request"); return 2; }
  }
  while (size > 0 && (input[size - 1] == '\n' || input[size - 1] == '\r')) size--;
  move_request req;
  if (move_parse_request(input, size, &req) < 0) { move_reply("not-moved", "invalid-request"); return 2; }
  int code = move(&req);
  move_free_request(&req);
  return code;
}
