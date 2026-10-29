# Dependencies and notices

Jbovlacku does not yet select a software license.
New native definitions use the [CC0 contribution terms](format.md#remaining-body-fields). Imported content retains its separate source rights claim.
Third-party licenses apply to their own components. They do not assign a license to Jbovlacku or imported dictionary content.
The [third-party notices](third-party-notices.md) retain component versions, declared licenses, copyright notices, and full license texts.

## Rust and WebAssembly

`Cargo.lock` pins the resolved Rust packages. `rust-toolchain.toml` selects Rust 1.99.0 and the `wasm32-unknown-unknown` target.
The browser and server adapters load generated `jvc-runtime` WebAssembly and its JavaScript bindings.
`wasm-bindgen` and `wasm-bindgen-cli` must both use version 0.2.105.
The generated bindings live in `packages/core/generated`. The build regenerates this ignored directory.

`jvc-runtime` pins `regex-automata` 0.4.18 and `regex-syntax` 0.8.10 for pattern search.
The linear-time engine runs in the shared WebAssembly module on every host. It adds no npm dependency.
The syntax parser applies headword aliases to literal nodes without changing escapes, named groups, properties, or range endpoints.
The engine uses the Thompson NFA and PikeVM features. An NFA is a graph of matching states.
PikeVM visits each active state at most once per input byte. This gives a direct compiled-state work bound.
The build disables the default engine features and keeps `std`, `syntax`, `nfa-pikevm`, and all Unicode features.
It retains Unicode case folding, character properties, Perl classes, and word boundaries.

It excludes lazy and fully compiled DFA engines, backtracking, capture optimization, and literal-search helpers.
This removes `regex` and the `aho-corasick` runtime dependency. It adds no resolved package.
The notices inventory follows the active WebAssembly dependencies. The lockfile also retains packages for other targets and development tools.
Compilation, per-candidate, and aggregate input limits bound the work. The [search specification](frontend.md#4-search-and-reading) states those limits and errors.

The build uses `npm run build:core`, Rust 1.99.0, and wasm-bindgen 0.2.105 for each comparison below.
Gzip uses `gzip -n -9`. The counts include the generated WebAssembly module, without its JavaScript wrapper.
The compiled-state engine retains all Unicode features. Removing unused engine features reduces the module without narrowing expression syntax.

| Source | Raw bytes | Gzip bytes |
| --- | ---: | ---: |
| Before pattern search, `581b588` | 2,901,727 | 811,062 |
| General regex engine, `f24a89e` | 4,142,890 | 1,188,899 |
| Compiled-state engine, `0852cdf` | 3,590,247 | 1,034,073 |

The compiled-state engine adds 688,520 raw bytes and 223,011 gzip bytes over the build before pattern search.
It removes 552,643 raw bytes and 154,826 gzip bytes from the general regex build.
Unicode character tables remain part of this cost.

The notices inventory follows `jvc-runtime` through its resolved normal and build dependencies for the WebAssembly target.
It includes compile-time helpers. It does not claim that every listed package contributes machine code to the final binary.
The inventory excludes dependency edges that serve only native tests.
The [core dependency record](../crates/jvc-core/DEPENDENCIES.json) includes additional native test dependencies.
The [core dependency explanation](../crates/jvc-core/DEPENDENCIES.md) describes cryptographic libraries and their acceptance boundaries.

Generate the resolved dependency metadata from the repository root:

```sh
cargo metadata --locked --offline --format-version 1 --filter-platform wasm32-unknown-unknown
```

The command requires the locked package sources in the local Cargo cache.
The notices use each package's local license, copyright, and notice files without rewriting their text.
Identical files share one text block. Each block lists every corresponding source package and file.
The SHA-256 digest identifies the original UTF-8 text. A dependency change requires a new inventory and the matching source notices.

`packages/morphology` ports word-form rules from jbotci under the MIT License. Its `THIRD-PARTY-NOTICES.md` keeps that notice and the preset citations.
It also retains the MIT notices for ilmentufa and gencmu, which supply the Peggy grammar and reference rules.
The [text orthography layer](../packages/morphology/src/orthography.ts) derives its rules from six pinned gencmu phoneme grammar documents.
The [experimental corpus fixture](../packages/morphology/evidence/gencmu-corpus.json) adapts gencmu test cases and records their pinned source revision, file digests, and case identifiers.
The [morphology notice](../packages/morphology/THIRD-PARTY-NOTICES.md) names those documents and retains gencmu's MIT notice.
Its [corpus text notices](../packages/morphology/THIRD-PARTY-NOTICES.md#corpus-text-sources) also retain CLL's separate permission notice and identify the inherited literary excerpts.
The gencmu MIT notice does not assign a license to separately authored quotations.
Morphology adds no Rust dependency. Peggy 5.1.1 compiles the committed grammar into the committed parser. Both build outputs retain the exact notice as `notices/morphology-notices.md`. The container also retains it as `/app/docs/morphology-notices.md`.

The Rust standard library also contributes code outside `Cargo.lock`.
Its toolchain provides `share/doc/rust/COPYRIGHT-library.html` under the path from `rustc --print sysroot`.
The core build copies that upstream file into `packages/core/generated/rust-standard-library-notices.html` without changing its bytes.
The container package also retains it as `/app/docs/rust-standard-library-notices.html`.
Keep that file with distributed WebAssembly artifacts, alongside the application dependency notices.

## JavaScript

`package-lock.json` pins npm packages. The lock inventory in the notices includes development tools and optional platform packages.
A lock entry does not prove that the package appears in a runtime bundle.
The browser uses `jose` 6.1.3 for encrypted key backups. Its full MIT license appears in the notices.
The standalone server uses Node.js built-in modules and the generated WebAssembly bindings.
The notices also retain Vite and esbuild license files for generated JavaScript helpers.
Build tools produce the browser and standalone server bundles. They do not select the project software license.

The root manifest selects these direct npm packages:

| Package                     | Version      | Declared license  | Purpose                                               |
| --------------------------- | ------------ | ----------------- | ----------------------------------------------------- |
| `@cloudflare/workers-types` | 5.20261011.1 | MIT OR Apache-2.0 | Worker type declarations.                             |
| `@playwright/test`          | 1.58.2       | Apache-2.0        | Browser tests.                                        |
| `@types/node`               | 24.10.1      | MIT               | Node.js type declarations.                            |
| `esbuild`                   | 0.28.1       | MIT               | Standalone server bundle.                             |
| `jose`                      | 6.1.3        | MIT               | Browser key backup encryption.                        |
| `peggy`                     | 5.1.1        | MIT               | Word grammar compiler.                                |
| `prettier`                  | 3.7.4        | MIT               | Source formatting.                                    |
| `tsx`                       | 4.20.6       | MIT               | TypeScript execution for local development and tests. |
| `typescript`                | 5.9.3        | Apache-2.0        | Type analysis.                                        |
| `vite`                      | 7.3.7        | MIT               | Browser development and bundle.                       |
| `wrangler`                  | 4.149.0      | MIT OR Apache-2.0 | Local Worker development.                             |

Keep upstream legal comments in generated bundles. Keep the full notices with packaged server and browser artifacts.
The container base retains its own Node.js and operating-system notices. These application notices do not replace them.

## Fonts

The browser bundles Noto Sans, STIX Two Math, and Crisa.
All three use the SIL Open Font License, version 1.1.
The [font notice](../apps/web/public/fonts/NOTICE.txt) retains author attribution and the reserved name in Crisa's source license.
The [font license](../apps/web/public/fonts/OFL.txt) contains the full license text.
Vite copies these files with the fonts into the built browser assets. The application notices also include their text.

An interface font license does not grant rights in dictionary content.
Do not remove embedded font notices or rename a font contrary to its reserved name requirements.
Before a font changes, make sure that its replacement license and attribution travel with its files.

## Packaging

The server and browser builds copy the dependency guide and full notices into their `dist/notices` directories.
They also copy the Rust standard library notice, morphology notice, and font notices.
Each directory includes an HTML index that links to every notice file. Keep this directory with redistributed build output.
The standalone app serves the browser notice index at `/notices/`.

The OCI image includes this guide and [third-party notices](third-party-notices.md) under `/app/docs`.
It also retains the Rust standard library notice and the font notices in the browser assets.
The pinned container base images retain their own upstream terms.
Make sure that every copied dependency notice matches the versions that the package builds.
Do not present this inventory as permission to distribute imported dictionary material.
