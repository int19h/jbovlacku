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

The server and browser builds copy the dependency guide, full notices, Rust standard library notice, and font notices into their `dist/notices` directories.
Each directory includes an HTML index that links to every notice file. Keep this directory with redistributed build output.
The standalone app serves the browser notice index at `/notices/`.

The OCI image includes this guide and [third-party notices](third-party-notices.md) under `/app/docs`.
It also retains the Rust standard library notice and the font notices in the browser assets.
The pinned container base images retain their own upstream terms.
Make sure that every copied dependency notice matches the versions that the package builds.
Do not present this inventory as permission to distribute imported dictionary material.
