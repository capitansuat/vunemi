#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
pnpm --dir "$here/packages/agent-core" exec esbuild "$here/scripts/bench-task-routing.ts" --bundle --platform=node --format=esm --outfile="$tmp/bench.mjs" >/dev/null
node "$tmp/bench.mjs" "$@"
