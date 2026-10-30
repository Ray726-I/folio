#!/usr/bin/env bash
# Isolated Linux native keyboard smoke for Folio.
#
# A private D-Bus session is required so Tauri's single-instance plugin cannot
# forward the disposable file to a user's existing Folio process. The private
# Xvfb display keeps XTest focus and input away from the user's desktop.
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

for command in dbus-run-session xvfb-run python3; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'FAIL: required command not found: %s\n' "$command" >&2
    exit 2
  fi
done

export FOLIO_NATIVE_KEYBOARD_ISOLATED=1
exec dbus-run-session -- xvfb-run -a -s "-screen 0 1280x900x24" \
  python3 "$repo_root/tests/native-editor-keyboard.py" "$@"
