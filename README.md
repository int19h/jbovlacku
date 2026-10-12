# Jbovlacku

Jbovlacku is a distributed Lojban dictionary. Contributors publish signed definitions, rafsi assignments, and editorial decisions.
Readers choose which identities to heed. Independent servers exchange records without a central editorial authority.
A rafsi is a short form used in compounds.

This repository contains an early local prototype. It is not ready for public use.
The specifications describe the full target product. The prototype implements only the scope below.
Public release needs complete implementation, measured performance, and separate authorization.
This restriction covers live dictionary contributions and public deployment.
It does not restrict expressly authorized work on private GitHub issues and pull requests.

## Implemented prototype

The Rust libraries implement canonical records, SSHSIG signatures, causal state, identity continuity, imported account controls, and exact ranking bounds.
Native and WebAssembly builds share the format rules. The TypeScript application uses generated WebAssembly bindings.
The Node.js adapter uses local object files and SQLite. The local Worker adapter uses R2, D1, and a Durable Object.
The Worker currently serves the API only.
Both adapters share admission, receipts, snapshots, search packages, and dictionary API logic.
The native `jvc` command reads, writes, validates, and merges dictionary carriers. It also reads exact committed Git trees locally.
The [carrier guide](crates/jvc-carrier/README.md) describes canonical files, import selections, retention policies, and read limits.

The browser supports anonymous lookup, verified definition pages, encrypted key backups, drafts, and an exact signed outbox.
It supports public scoped trust decisions and definition judgments. Downloaded search packages permit local search without a request for each query.
Signing needs localhost or HTTPS. A plain HTTP Tailscale address supports reading only.

The importer prepares signed proposals from pinned local Lensisku JSON captures. Repeat imports reuse signed records and retain source evidence.
It keeps definitions literal and preserves unknown fields as unknown. It does not infer places or individual votes.
The current importer records unknown rights. The source-notice convention below remains a target change.
The committed adapter comparison uses one signed profile event. Importer tests include a two-row fixture derived from a pinned 2,429-row API capture.
Full-capture runs are separate development evidence, not part of these committed tests. This capture does not represent the general SQL migration.
The [importer guide](packages/importer/README.md) describes its input, journal, signing command, and limits.

The guided wizard, word builders, transfer editor, status editor, semantic search, AI, and Lensisku cross-posting remain target features.
The [web UI design](docs/ui-design.md) also remains a target. The prototype does not implement that redesign.
The general SQL migration, automatic rafsi publications, and structured import conversion also remain unfinished.
The complete `jvc` command catalog in the format specification remains a target interface.
The [development guide](docs/development.md) describes the implemented native commands.

## Local setup

The build requires Node.js 24 or newer, the pinned Rust toolchain, and `wasm-bindgen-cli` 0.2.105.
The [development guide](docs/development.md) explains those tools and the local test commands.
Run these commands from the repository root after the tools are available:

```sh
npm ci
npm run build
JVC_DATA_DIR="$PWD/.cache/node" npm run start:built
```

The standalone app listens at [http://127.0.0.1:8789](http://127.0.0.1:8789).
A new data directory starts empty. Stop the foreground process with Ctrl+C.
The guide also covers browser development, the local Worker API, and container tests.
No command in this setup deploys a service.

## Evidence and limits

The [ranking measurements](crates/jvc-rank/README.md) cover eleven synthetic scenarios in native Rust and WebAssembly.
The weighted sixteen-actor case takes 8.119 seconds in WebAssembly despite zero completed expansion work.
The expansion budget does not bound total CPU time. These measurements do not establish performance for real community graphs.

A local 2,430-event batch uses 17,010 R2 operations. Cold search uses 9,727 R2 operations before D1 and Durable Object work.
Local Wrangler success does not prove deployed quota, memory, or CPU compliance. Larger imports need bounded incremental jobs.
The current default state work budget can run out at roughly 4,500 events in a flat history.
This is an approximate limit. Histories with more edges can reach it sooner, and the requested state also affects the work.

[Issue 9](https://github.com/int19h/jbovlacku/issues/9) tracks ranking CPU limits.
[Issue 11](https://github.com/int19h/jbovlacku/issues/11) tracks state evaluation beyond the local corpus.
[Issue 10](https://github.com/int19h/jbovlacku/issues/10) tracks URL serialization and invisible headword characters.
The development guide lists local tests. Their scope does not establish full specification conformance or public deployment readiness.

## Documentation

The documentation defines the product, its records, and the development process:

- [Format specification](docs/format.md): Target signed records, causal state, identities, imports, and ranking.
- [Frontend specification](docs/frontend.md): Target browser behavior, server contracts, authoring, and optional inference.
- [Web UI design](docs/ui-design.md): Target screens, visual rules, and publication flow.
- [Prototype plan](docs/prototype-plan.md): Required implementation stages and demonstrations.
- [Handover cases](docs/handover-cases.md): Required account-control outcomes.
- [Development guide](docs/development.md): Local builds, tests, shared VM work, and review requirements.
- [Dependency guide](docs/dependencies.md): Resolved dependencies and distribution notices.
- [Agent instructions](AGENTS.md): Rules for agents that work in this repository.

## Rights and release

New native definitions use CC0 1.0 in the target contribution flow.
The client shows the [CC0 notice](https://creativecommons.org/publicdomain/zero/1.0/) before publication. Selecting Publish is explicit agreement, without a separate checkbox.
The [format specification](docs/format.md#remaining-body-fields) defines the fixed fields and imported source-rights convention.
In the target convention, imported Lensisku dictionary text retains its public-domain source claim, original attribution, and pinned notice evidence.
It does not become a historical CC0 submission.
Existing signed imports remain unchanged. A contributor who revises imported text releases only their own contribution under CC0 and retains the source evidence.
Imports with unestablished rights remain explicitly unknown. Third-party images need their own rights evidence.
The software license remains a prelaunch decision. This repository does not assign a software license by implication.
The [third-party notices](docs/third-party-notices.md) preserve the licenses of dependencies and bundled fonts.
A public launch must also state trust roots, account witnesses, accepted imports, retention rules, and optional inference policies.
