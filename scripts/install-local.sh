#!/usr/bin/env bash
set -euo pipefail
folio_project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
folio_binary="$folio_project_dir/target/release/folio"
folio_bin_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
folio_data_dir="${XDG_DATA_HOME:-$HOME/.local/share}"
if [[ ! -x "$folio_binary" ]]; then
  printf '%s\n' 'Build Folio first: cargo build --release' >&2
  exit 1
fi
install -Dm755 "$folio_binary" "$folio_bin_dir/folio"
install -Dm644 "$folio_project_dir/assets/icon.svg" "$folio_data_dir/icons/hicolor/scalable/apps/dev.folio.desktop.svg"
mkdir -p "$folio_data_dir/applications"
folio_exec_path=${folio_bin_dir//\\/\\\\}
folio_exec_path=${folio_exec_path//\"/\\\"}
folio_exec_path=${folio_exec_path//\$/\\\$}
folio_exec_path=${folio_exec_path//\`/\\\`}
cat > "$folio_data_dir/applications/folio.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Folio
Comment=Read and edit individual Markdown files
GenericName=Markdown Viewer and Editor
Exec="$folio_exec_path/folio" %F
Icon=dev.folio.desktop
Terminal=false
Categories=Utility;TextEditor;
Keywords=Markdown;Markdown Viewer;Markdown Editor;Notes;Text;
MimeType=text/markdown;text/x-markdown;
StartupWMClass=folio
EOF
if command -v update-desktop-database >/dev/null; then update-desktop-database "$folio_data_dir/applications"; fi
printf 'Installed Folio to %s\nChoose it from your file manager’s Open With menu.\n' "$folio_bin_dir/folio"
