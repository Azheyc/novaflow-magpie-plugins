#!/bin/bash
# Remove the locally installed NovaFlow plugin from Magpie, keeping the
# extracted copy so the exact version can be re-registered without repacking.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(python3 - "$repo_root/package.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["version"])
PY
)"
data_root="${NOVAFLOW_PLUGIN_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/novaflow-magpie-plugin}"
target="$data_root/$version"

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

"$magpie_bin" plugin rm "$target" || true
printf 'removed NovaFlow plugin registration for %s (files kept at %s)\n' "$version" "$target"
