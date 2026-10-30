#!/usr/bin/env bash
set -euo pipefail
folio_project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cargo build --locked --manifest-path "$folio_project_dir/Cargo.toml"
exec "$folio_project_dir/target/debug/folio" "$@"
