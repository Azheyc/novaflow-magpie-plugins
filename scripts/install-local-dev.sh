#!/bin/bash
# Build a local-development package; registration requires --register.
# Production source remains pinned to https://www.ycnovaflow.vip.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
target="$(NOVAFLOW_DEV_ARTIFACT=stock-company node "$repo_root/scripts/build-local-dev.mjs")"

if [[ "${1:-}" != "--register" ]]; then
  printf 'built stock-Magpie development plugin: %s\n' "$target"
  printf 'install it from Magpie → Plugins → Discover; pass --register to modify Magpie configuration with the CLI\n'
  exit 0
fi

if [[ -n "${MAGPIE_BIN:-}" ]]; then
  magpie_bin="$MAGPIE_BIN"
elif command -v magpie >/dev/null 2>&1; then
  magpie_bin="$(command -v magpie)"
elif [[ -x /Applications/magpie.app/Contents/MacOS/magpie ]]; then
  magpie_bin=/Applications/magpie.app/Contents/MacOS/magpie
else
  printf 'magpie not found; set MAGPIE_BIN to the magpie executable\n' >&2
  exit 1
fi

"$magpie_bin" plugin add "$target"
printf '\ninstalled local-development NovaFlow plugin from %s\n' "$target"
printf 'development origin: http://localhost:15173\n'
