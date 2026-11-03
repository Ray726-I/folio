#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
probe_log=$(mktemp /tmp/folio-native-palette-XXXXXX.log)
trap 'rm -f "$probe_log"' EXIT
for zoom in 1 1.2; do
  if ! dbus-run-session -- xvfb-run -a env GDK_BACKEND=x11 NO_AT_BRIDGE=1 \
    /usr/bin/python3 "$repo_root/tests/native-palette.py" "$zoom" 2>>"$probe_log"; then
    tail -60 "$probe_log"
    exit 1
  fi
done
