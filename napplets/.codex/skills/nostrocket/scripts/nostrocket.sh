#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)

if [[ ${1:-} == connect ]]; then
  [[ $# == 1 ]] || { echo "usage: nostrocket.sh connect" >&2; exit 2; }
  [[ -t 0 ]] || { echo "error: connect requires an interactive terminal" >&2; exit 1; }
  read -r -s -p "Notary bunker URI: " bunker_uri
  printf '\n' >&2
  printf '%s\n' "$bunker_uri" | node "$script_dir/nostrocket.mjs" connect
  unset bunker_uri
else
  exec node "$script_dir/nostrocket.mjs" "$@"
fi
