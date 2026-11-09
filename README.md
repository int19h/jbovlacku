# Jbovlacku

Jbovlacku is a distributed Lojban dictionary. Contributors publish signed definitions, rafsi assignments, and editorial decisions, and readers choose which identities to heed. A rafsi is a short form used in compounds. Independent servers exchange records without a central editorial authority.

This repository holds an early local prototype, and it is not ready for public use. The specifications describe the full target product, and the prototype implements part of it. A public release needs a complete implementation, measured performance, and separate authorization. That restriction covers live dictionary contributions and public deployment. It does not restrict expressly authorized work on private GitHub issues and pull requests.

## What the prototype does

A shared Rust core implements canonical records, SSHSIG signatures, causal state, identity continuity, imported account controls, and exact ranking bounds. It builds both natively and to WebAssembly, so the server, the browser, and the native `jvc` command apply the same format rules.

The Node.js server stores records in local object files and SQLite. It admits signed records, issues receipts, evaluates snapshots, builds search packages, and serves the dictionary API. The `jvc` command reads, writes, validates, and merges dictionary carriers.

The browser app covers reading, contributing, and personal ranking:

- Anonymous lookup through server search or downloaded language packages, with Lojban morphology, compound cmavo matching, and glob and regular-expression patterns.
- Word pages that show every definition under the selected view, with revision comparisons, source evidence, rafsi pairs, and reviewer details.
- Local keys with encrypted backups, signed delivery with per-server receipts, and flows that hand a key over to a successor or mark it as compromised.
- A guided authoring wizard and a full editor with accessible rich-text fields, a lujvo builder, and a gismu generator.
- A personal view that verifies the snapshot records in a Web Worker and ranks words locally with the reader's private trust choices.

The importer turns pinned Lensisku JSON captures and SQL snapshots into signed proposals and keeps their source evidence. Optional AI assistance suggests types, components, places, glosses, and existing words, and it can run meaning search over embeddings. It is off by default, the server operator controls it, and the browser asks for consent before it sends draft text.

Some target features have no implementation yet. The status and transfer editors, wizard meaning search, and Lensisku cross-posting are among them. So are model-assisted import conversion, offline meaning search in the browser, and the full `jvc` command catalog. The measurements so far establish neither ranking performance on real community trust graphs nor a latency guarantee.

[Implemented scope](docs/implemented-scope.md) records the behavior of each area, its limits, and the current measurements.

## Local setup

The build needs Node.js 24 or newer, the pinned Rust toolchain, and `wasm-bindgen-cli` 0.2.105. The [development guide](docs/development.md) explains those tools and the local test commands. With the tools in place, run these commands from the repository root:

```sh
npm ci
npm run build
JVC_DATA_DIR="$PWD/.cache/node" npm run start:built
```

The standalone app listens at [http://127.0.0.1:8789](http://127.0.0.1:8789). A new data directory starts empty. Stop the foreground process with Ctrl+C. The guide also covers browser development and container tests. No command in this setup deploys a service.

## Documentation

- [Implemented scope](docs/implemented-scope.md): what the prototype does today, with its limits and measurements.
- [Format specification](docs/format.md): target signed records, causal state, identities, imports, and ranking.
- [Frontend specification](docs/frontend.md): target browser behavior, server contracts, authoring, and optional inference.
- [Web UI design](docs/ui-design.md): target screens, visual rules, and publication flow.
- [AI prompts](prompts/README.md): public prompts, answer rules, and the correction loop for the optional AI actions.
- [Prototype plan](docs/prototype-plan.md): required implementation stages and demonstrations.
- [Handover cases](docs/handover-cases.md): required account-control outcomes.
- [Development guide](docs/development.md): local builds, tests, resource limits, and review requirements.
- [Dependency guide](docs/dependencies.md): resolved dependencies and distribution notices.
- [Agent instructions](AGENTS.md): rules for agents that work in this repository.

## Rights and release

In the target contribution flow, new native definitions use CC0 1.0. The client shows the [CC0 notice](https://creativecommons.org/publicdomain/zero/1.0/) before publication, and selecting Publish is explicit agreement. There is no separate box to tick. The [format specification](docs/format.md#remaining-body-fields) defines the fixed fields and the convention for imported source rights.

Under that target convention, imported Lensisku dictionary text keeps its public-domain source claim, its original attribution, and its pinned notice evidence. It does not become a historical CC0 submission. Existing signed imports stay unchanged. A contributor who revises imported text releases only their own contribution under CC0, and the revision keeps the source evidence. Imports whose rights are not established stay marked as unknown, and third-party images need their own rights evidence.

The software license is still a prelaunch decision, and this repository does not imply one. The [third-party notices](docs/third-party-notices.md) preserve the licenses of dependencies and bundled fonts. A public launch must also state its trust roots, account witnesses, accepted imports, retention rules, and optional inference policies.
