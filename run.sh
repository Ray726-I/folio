#!/usr/bin/env bash
set -euo pipefail
folio_project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Always let Cargo decide whether a rebuild is needed; skipping the build when
# a binary exists would run an app that embeds an older UI.
cargo build --locked --release --manifest-path "$folio_project_dir/Cargo.toml"
exec "$folio_project_dir/target/release/folio" "$@"
