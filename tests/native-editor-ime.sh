#!/usr/bin/env bash
# Isolated IME composition smoke for Folio.
#
# Requires fcitx5 with an engine (mozc) and the GTK input-module bridge. Runs in
# a private D-Bus session and a private Xvfb display so the input method and the
# test window never touch the user's desktop or real fcitx profile.
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

for command in dbus-run-session xvfb-run fcitx5 fcitx5-remote python3; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'SKIP: required command not found: %s\n' "$command" >&2
    exit 2
  fi
done

exec dbus-run-session -- xvfb-run -a -s "-screen 0 1280x900x24" \
  python3 "$repo_root/tests/native-editor-ime.py" "$@"
