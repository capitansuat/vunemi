#!/usr/bin/env bash
# Synthetic agent evaluation against a local model, e.g.:
#   scripts/eval-agent.sh --model lmstudio:qwen/qwen3.6-35b-a3b --out /tmp/eval.json
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
pnpm --dir "$here/packages/agent-core" exec esbuild "$here/scripts/eval-agent.ts" --bundle --platform=node --format=esm --outfile="$tmp/eval.mjs" >/dev/null
node "$tmp/eval.mjs" "$@"
