#!/usr/bin/env bash
set -euo pipefail
folio_project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ ! -x "$folio_project_dir/target/release/folio" ]]; then
  cargo build --release --manifest-path "$folio_project_dir/Cargo.toml"
fi
exec "$folio_project_dir/target/release/folio" "$@"
