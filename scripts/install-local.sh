#!/bin/bash
# Install the packed NovaFlow plugin into Magpie from a local tarball.
#
# Magpie 0.1.2032 accepts a directory (or a single JS file) as a local plugin
# spec; it does not import a .tgz directly. This script extracts the packed
# artifact into a stable, versioned directory and registers that directory so
# upgrades are a re-run and rollbacks are just the previous version directory.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(python3 - "$repo_root/package.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["version"])
PY
)"
archive="${1:-$repo_root/novaflow-magpie-plugins-$version.tgz}"
data_root="${NOVAFLOW_PLUGIN_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/novaflow-magpie-plugin}"
target="$data_root/$version"

if [[ ! -f "$archive" ]]; then
  printf 'missing plugin archive: %s\nrun `npm pack` first\n' "$archive" >&2
  exit 1
fi

find_magpie() {
  if [[ -n "${MAGPIE_BIN:-}" ]]; then
    printf '%s\n' "$MAGPIE_BIN"
    return
  fi
  if command -v magpie >/dev/null 2>&1; then
    command -v magpie
    return
  fi
  if [[ -x /Applications/magpie.app/Contents/MacOS/magpie ]]; then
    printf '%s\n' /Applications/magpie.app/Contents/MacOS/magpie
    return
  fi
  printf 'magpie not found; set MAGPIE_BIN to the magpie executable\n' >&2
  exit 1
}

magpie_bin="$(find_magpie)"

mkdir -p "$target"
tar -xzf "$archive" -C "$target" --strip-components=1
chmod 700 "$data_root" "$target" 2>/dev/null || true

"$magpie_bin" plugin add "$target"
printf '\ninstalled NovaFlow plugin %s from %s\n' "$version" "$target"
printf 'sign in: %s plugin login novaflow\n' "$magpie_bin"
