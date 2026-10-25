# Third-party notices

Folio's original source code is licensed under the [MIT License](LICENSE).
Bundled dependencies retain their own copyright notices and licenses.

| Component | Version | License | Included notices |
| --- | --- | --- | --- |
| KaTeX JavaScript and CSS | 0.19.0 | MIT | [License](ui/vendor/katex/LICENSE) |
| KaTeX fonts | Shipped with KaTeX 0.19.0 | SIL Open Font License 1.1 | [Font license and copyright notices](ui/vendor/katex/fonts/OFL.txt) |
| Mermaid | 11.17.2 | MIT | [License](ui/vendor/mermaid/LICENSE), [bundled dependency licenses](ui/vendor/mermaid/THIRD_PARTY_LICENSES.txt) |
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

Inter, Source Serif 4, and JetBrains Mono variable WOFF2 files come from the
Fontsource variable packages and are distributed without modification. The UI,
reading, and code stacks use these local files, with system fonts as fallbacks.

The JavaScript bundles and font binaries are distributed without modification.
Rust and development-only npm dependencies are listed in `Cargo.lock` and
`package-lock.json`; their source distributions contain their respective licenses.
