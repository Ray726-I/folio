# Third-party notices

Folio's original source code is licensed under the [MIT License](LICENSE).
Bundled dependencies retain their own copyright notices and licenses.

| Component | Version | License | Included notices |
| --- | --- | --- | --- |
| KaTeX JavaScript and CSS | 0.19.0 | MIT | [License](ui/vendor/katex/LICENSE) |
| KaTeX fonts | Shipped with KaTeX 0.19.0 | SIL Open Font License 1.1 | [Font license and copyright notices](ui/vendor/katex/fonts/OFL.txt) |
| Mermaid | 11.17.2 | MIT | [License](ui/vendor/mermaid/LICENSE), [bundled dependency licenses](ui/vendor/mermaid/THIRD_PARTY_LICENSES.txt) |
| Mermaid tidy-tree layout | 1.0.1 | MIT | [License](ui/vendor/mermaid-tidy-tree/LICENSE), [bundled dependency license](ui/vendor/mermaid-tidy-tree/THIRD_PARTY_LICENSES.txt) |
| Inter variable | 5.3.0 (Fontsource) | SIL Open Font License 1.1 | [License](ui/fonts/LICENSE-inter) |
| Source Serif 4 variable | 5.3.1 (Fontsource) | SIL Open Font License 1.1 | [License](ui/fonts/LICENSE-source-serif-4) |
| JetBrains Mono variable | 5.3.0 (Fontsource) | SIL Open Font License 1.1 | [License](ui/fonts/LICENSE-jetbrains-mono) |

KaTeX comes from the [official npm package](https://registry.npmjs.org/katex/-/katex-0.19.0.tgz).
Its CSS selects the bundled WOFF2 font format. The font copyright and reserved-name
statements are preserved from the fonts' metadata in `fonts/OFL.txt`.

Mermaid comes from the [official npm package](https://registry.npmjs.org/mermaid/-/mermaid-11.17.2.tgz).
The dependency inventory is taken from that package's published source map.
Its JavaScript license banners are retained, and the exact dependency versions'
license and notice files are reproduced in `THIRD_PARTY_LICENSES.txt`.

The tidy-tree layout comes from the [official npm package](https://registry.npmjs.org/@mermaid-js/layout-tidy-tree/-/layout-tidy-tree-1.0.1.tgz)
and is locally bundled for offline use. Its published source maps identify the
included `non-layered-tidy-tree-layout` 2.0.2 code; that package's MIT license
is reproduced in `ui/vendor/mermaid-tidy-tree/THIRD_PARTY_LICENSES.txt`. Although
the tidy-tree package declares a dependency on D3, its published source maps
do not identify D3 code in the distributed layout used by this bundle.

Inter, Source Serif 4, and JetBrains Mono variable WOFF2 files come from the
Fontsource variable packages and are distributed without modification. The UI,
reading, and code stacks use these local files, with system fonts as fallbacks.

The KaTeX and Mermaid JavaScript bundles and font binaries are distributed without modification.
Rust and development-only npm dependencies are listed in `Cargo.lock` and
`package-lock.json`; their source distributions contain their respective licenses.
# Unified editor dependencies

The offline editor bundle uses pinned ProseMirror, CodeMirror, Markdown-it,
Lezer, diff and their dependencies. Exact package versions and bundled license
texts are generated into `ui/vendor/editor/NOTICE.txt` by
`npm run build:editor`; source and the lockfile are included in this repository.
