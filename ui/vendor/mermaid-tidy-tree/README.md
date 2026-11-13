# Mermaid tidy-tree layout

`tidy-tree.min.js` is a locally bundled copy of `@mermaid-js/layout-tidy-tree`
1.0.1 (npm integrity `sha512-suZgFgQQHYuaxiEiNVgPJwOoXi/keXV6DghCL3rT4K9DmX7xYQ2XZI2suiBVs/fj1gn/OoXIWB2DFSmeY7trvw==`).
Its license is in `LICENSE`. It registers the official layout with the already
loaded Mermaid global; no network access or dynamic external scripts are needed.

To reproduce, unpack that npm package in a temporary directory, create an ESM
entry importing its `dist/mermaid-layout-tidy-tree.esm.mjs` default export and
calling `window.mermaid.registerLayoutLoaders(layouts)`, then bundle that entry
with esbuild 0.28.2 using `--bundle --minify --format=iife`. The published
distribution includes its layout code; the bundle includes no separate Mermaid.

The published ESM source maps identify `non-layered-tidy-tree-layout` 2.0.2
as the only bundled third-party source. Its MIT license is reproduced verbatim in
`THIRD_PARTY_LICENSES.txt`. D3 is declared in the layout package's dependencies,
but is not present in those source maps or imported by the bundled ESM files.
