#include "request.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* A small JSON reader: values are parsed into a tree, depth and sizes bounded. */
enum kind { J_NULL, J_BOOL, J_NUMBER, J_STRING, J_ARRAY, J_OBJECT };
typedef struct jvalue jvalue;
struct jvalue {
  enum kind kind;
  char *string; size_t length;  /* J_STRING; J_NUMBER keeps its text here */
  jvalue *items; char **keys; size_t count;  /* J_ARRAY, J_OBJECT */
};

typedef struct { const char *p, *end; int depth; } reader;

#define MAX_DEPTH 4
#define MAX_ITEMS 4096

static void jfree(jvalue *v) {
  if (!v) return;
  free(v->string);
  for (size_t i = 0; i < v->count; i++) {
    jfree(&v->items[i]);
    if (v->keys) free(v->keys[i]);
  }
  free(v->items);
  free(v->keys);
}

static void ws(reader *r) { while (r->p < r->end && (*r->p == ' ' || *r->p == '\t' || *r->p == '\n' || *r->p == '\r')) r->p++; }

static int hex4(reader *r, unsigned *out) {
  if (r->end - r->p < 4) return -1;
  unsigned v = 0;
  for (int i = 0; i < 4; i++) {
    char c = *r->p++;
    v <<= 4;
    if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
    else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
    else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
    else return -1;
  }
  *out = v;
  return 0;
}

static int put(char **buf, size_t *len, size_t *cap, unsigned char c) {
  if (*len + 1 >= *cap) {
    size_t next = *cap ? *cap * 2 : 64;
    char *grown = realloc(*buf, next);
    if (!grown) return -1;
    *buf = grown; *cap = next;
  }
  (*buf)[(*len)++] = (char)c;
  (*buf)[*len] = 0;
  return 0;
}

/* A string: escapes decoded to UTF-8; NUL, lone surrogates and raw control characters refused. */
static int jstring(reader *r, char **out, size_t *outlen) {
  if (r->p >= r->end || *r->p != '"') return -1;
  r->p++;
  char *buf = NULL; size_t len = 0, cap = 0;
  if (put(&buf, &len, &cap, 0) < 0) return -1;
  len = 0;
  while (r->p < r->end && *r->p != '"') {
    unsigned char c = (unsigned char)*r->p++;
    if (c < 0x20) goto bad;
    if (c != '\\') { if (put(&buf, &len, &cap, c) < 0) goto bad; continue; }
    if (r->p >= r->end) goto bad;
    char e = *r->p++;
    unsigned u;
    switch (e) {
      case '"': case '\\': case '/': u = (unsigned char)e; break;
      case 'b': u = 8; break; case 'f': u = 12; break; case 'n': u = 10; break; case 'r': u = 13; break; case 't': u = 9; break;
      case 'u': {
        if (hex4(r, &u) < 0) goto bad;
        if (u >= 0xD800 && u <= 0xDBFF) {
          unsigned lo;
          if (r->end - r->p < 6 || r->p[0] != '\\' || r->p[1] != 'u') goto bad;
          r->p += 2;
          if (hex4(r, &lo) < 0 || lo < 0xDC00 || lo > 0xDFFF) goto bad;
          u = 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00);
        } else if (u >= 0xDC00 && u <= 0xDFFF) goto bad;
        break;
      }
      default: goto bad;
    }
    if (u == 0) goto bad;
    if (u < 0x80) { if (put(&buf, &len, &cap, (unsigned char)u) < 0) goto bad; }
    else if (u < 0x800) { if (put(&buf, &len, &cap, (unsigned char)(0xC0 | u >> 6)) < 0 || put(&buf, &len, &cap, (unsigned char)(0x80 | (u & 63))) < 0) goto bad; }
    else if (u < 0x10000) { if (put(&buf, &len, &cap, (unsigned char)(0xE0 | u >> 12)) < 0 || put(&buf, &len, &cap, (unsigned char)(0x80 | (u >> 6 & 63))) < 0 || put(&buf, &len, &cap, (unsigned char)(0x80 | (u & 63))) < 0) goto bad; }
    else { if (put(&buf, &len, &cap, (unsigned char)(0xF0 | u >> 18)) < 0 || put(&buf, &len, &cap, (unsigned char)(0x80 | (u >> 12 & 63))) < 0 || put(&buf, &len, &cap, (unsigned char)(0x80 | (u >> 6 & 63))) < 0 || put(&buf, &len, &cap, (unsigned char)(0x80 | (u & 63))) < 0) goto bad; }
  }
  if (r->p >= r->end) goto bad;
  r->p++;
  *out = buf; *outlen = len;
  return 0;
bad:
  free(buf);
  return -1;
}

static int jvalue_read(reader *r, jvalue *v);

static int grow(jvalue *v, int object) {
  if (v->count >= MAX_ITEMS) return -1;
  jvalue *items = realloc(v->items, (v->count + 1) * sizeof *items);
  if (!items) return -1;
  v->items = items;
  memset(&v->items[v->count], 0, sizeof *items);
  if (object) {
    char **keys = realloc(v->keys, (v->count + 1) * sizeof *keys);
    if (!keys) return -1;
    v->keys = keys;
    v->keys[v->count] = NULL;
  }
  return 0;
}

static int jvalue_read(reader *r, jvalue *v) {
  memset(v, 0, sizeof *v);
  ws(r);
  if (r->p >= r->end) return -1;
  char c = *r->p;
  if (c == '"') { v->kind = J_STRING; return jstring(r, &v->string, &v->length); }
  if (c == '{' || c == '[') {
    int object = c == '{';
    if (++r->depth > MAX_DEPTH) return -1;
    v->kind = object ? J_OBJECT : J_ARRAY;
    r->p++;
    ws(r);
    if (r->p < r->end && *r->p == (object ? '}' : ']')) { r->p++; r->depth--; return 0; }
    for (;;) {
      if (grow(v, object) < 0) return -1;
      size_t i = v->count++;
      if (object) {
        ws(r);
        size_t klen;
        if (jstring(r, &v->keys[i], &klen) < 0) return -1;
        for (size_t k = 0; k < i; k++) if (strcmp(v->keys[k], v->keys[i]) == 0) return -1;
        ws(r);
        if (r->p >= r->end || *r->p != ':') return -1;
        r->p++;
      }
      if (jvalue_read(r, &v->items[i]) < 0) return -1;
      ws(r);
      if (r->p >= r->end) return -1;
      if (*r->p == ',') { r->p++; continue; }
      if (*r->p == (object ? '}' : ']')) { r->p++; r->depth--; return 0; }
      return -1;
    }
  }
  if (c >= '0' && c <= '9') {
    /* Only what the request holds: non-negative integers, no leading zeros. */
    const char *start = r->p;
    while (r->p < r->end && *r->p >= '0' && *r->p <= '9') r->p++;
    size_t n = (size_t)(r->p - start);
    if (n > 15 || (n > 1 && *start == '0')) return -1;
    v->kind = J_NUMBER;
    v->string = malloc(n + 1);
    if (!v->string) return -1;
    memcpy(v->string, start, n);
    v->string[n] = 0;
    v->length = n;
    return 0;
  }
  return -1;
}

static const jvalue *field(const jvalue *o, const char *key) {
  for (size_t i = 0; i < o->count; i++) if (strcmp(o->keys[i], key) == 0) return &o->items[i];
  return NULL;
}

/* An object with exactly these keys. */
static int exactly(const jvalue *o, const char *const *keys, size_t n) {
  if (!o || o->kind != J_OBJECT || o->count != n) return -1;
  for (size_t i = 0; i < n; i++) if (!field(o, keys[i])) return -1;
  return 0;
}

static int decimal(const jvalue *v, char *out, size_t cap) {
  if (!v || v->kind != J_STRING || v->length == 0 || v->length >= cap) return -1;
  if (v->length > 1 && v->string[0] == '0') return -1;
  for (size_t i = 0; i < v->length; i++) if (v->string[i] < '0' || v->string[i] > '9') return -1;
  memcpy(out, v->string, v->length + 1);
  return 0;
}

static int number(const jvalue *v, uint64_t *out) {
  if (!v || v->kind != J_NUMBER) return -1;
  *out = strtoull(v->string, NULL, 10);
  return 0;
}

static int text(const jvalue *v, size_t max, char **out) {
  if (!v || v->kind != J_STRING || v->length == 0 || v->length > max || strlen(v->string) != v->length) return -1;
  *out = strdup(v->string);
  return *out ? 0 : -1;
}

static int uuid(const jvalue *v, char out[37]) {
  if (!v || v->kind != J_STRING || v->length != 36) return -1;
  for (int i = 0; i < 36; i++) {
    char c = v->string[i];
    int dash = i == 8 || i == 13 || i == 18 || i == 23;
    if (dash ? c != '-' : !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return -1;
  }
  memcpy(out, v->string, 37);
  return 0;
}

static int parents(const jvalue *a, move_parent **out, size_t *count) {
  static const char *const keys[] = {"path", "device", "inode", "uid", "mode"};
  if (!a || a->kind != J_ARRAY || a->count == 0 || a->count > MOVE_MAX_PATH) return -1;
  *out = calloc(a->count, sizeof **out);
  if (!*out) return -1;
  *count = a->count;
  for (size_t i = 0; i < a->count; i++) {
    const jvalue *p = &a->items[i];
    move_parent *m = &(*out)[i];
    if (exactly(p, keys, 5) < 0 || text(field(p, "path"), MOVE_MAX_PATH, &m->path) < 0 || decimal(field(p, "device"), m->device, sizeof m->device) < 0 ||
        decimal(field(p, "inode"), m->inode, sizeof m->inode) < 0 || number(field(p, "uid"), &m->uid) < 0 || number(field(p, "mode"), &m->mode) < 0)
      return -1;
  }
  return 0;
}

int move_parse_request(const char *data, size_t size, move_request *out) {
  static const char *const keys[] = {"operationId", "ownerId", "source", "destination", "sourceIdentity", "sourceParents", "destinationParents"};
  static const char *const ids[] = {"device", "inode", "size", "mtimeNs", "ctimeNs", "sha256"};
  memset(out, 0, sizeof *out);
  if (size == 0 || size > MOVE_MAX_REQUEST || memchr(data, 0, size)) return -1;
  reader r = {data, data + size, 0};
  jvalue root;
  int ok = -1;
  if (jvalue_read(&r, &root) < 0) goto done;
  ws(&r);
  if (r.p != r.end) goto done;
  if (exactly(&root, keys, 7) < 0 || uuid(field(&root, "operationId"), out->operation_id) < 0) goto done;
  const jvalue *owner = field(&root, "ownerId");
  if (!owner || owner->kind != J_STRING || owner->length == 0 || owner->length > MOVE_MAX_OWNER || strlen(owner->string) != owner->length) goto done;
  for (size_t i = 0; i < owner->length; i++) if ((unsigned char)owner->string[i] < 0x20) goto done;
  memcpy(out->owner_id, owner->string, owner->length + 1);
  if (text(field(&root, "source"), MOVE_MAX_PATH, &out->source) < 0 || text(field(&root, "destination"), MOVE_MAX_PATH, &out->destination) < 0) goto done;
  const jvalue *id = field(&root, "sourceIdentity");
  move_identity *si = &out->source_identity;
  if (exactly(id, ids, 6) < 0 || decimal(field(id, "device"), si->device, sizeof si->device) < 0 || decimal(field(id, "inode"), si->inode, sizeof si->inode) < 0 ||
      decimal(field(id, "size"), si->size, sizeof si->size) < 0 || decimal(field(id, "mtimeNs"), si->mtime_ns, sizeof si->mtime_ns) < 0 ||
      decimal(field(id, "ctimeNs"), si->ctime_ns, sizeof si->ctime_ns) < 0)
    goto done;
  const jvalue *hash = field(id, "sha256");
  if (!hash || hash->kind != J_STRING || hash->length != 64) goto done;
  for (int i = 0; i < 64; i++) if (!((hash->string[i] >= '0' && hash->string[i] <= '9') || (hash->string[i] >= 'a' && hash->string[i] <= 'f'))) goto done;
  memcpy(si->sha256, hash->string, 65);
  if (parents(field(&root, "sourceParents"), &out->source_parents, &out->source_parent_count) < 0 ||
      parents(field(&root, "destinationParents"), &out->destination_parents, &out->destination_parent_count) < 0)
    goto done;
  ok = 0;
done:
  jfree(&root);
  if (ok < 0) move_free_request(out);
  return ok;
}

void move_free_request(move_request *req) {
  free(req->source); free(req->destination);
  for (size_t i = 0; i < req->source_parent_count; i++) free(req->source_parents[i].path);
  for (size_t i = 0; i < req->destination_parent_count; i++) free(req->destination_parents[i].path);
  free(req->source_parents); free(req->destination_parents);
  memset(req, 0, sizeof *req);
}

void move_reply(const char *status, const char *code) {
  if (code) printf("{\"status\":\"%s\",\"reasonCode\":\"%s\"}\n", status, code);
  else printf("{\"status\":\"%s\"}\n", status);
  fflush(stdout);
}
