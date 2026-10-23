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
The current definition validator still requires explicit empty or null fields.
Support for [omitted optional definition fields](docs/format.md#absent-fields-and-compatibility) remains a target change.
The Node.js adapter uses local object files and SQLite. The local Worker adapter uses R2, D1, and a Durable Object.
The Worker currently serves the API only.
Both adapters share admission, receipts, snapshots, search packages, and dictionary API logic.
The native `jvc` command reads, writes, validates, and merges dictionary carriers. It also reads exact committed Git trees locally.
The [carrier guide](crates/jvc-carrier/README.md) describes canonical files, import selections, retention policies, and read limits.

The browser supports anonymous lookup, verified definition pages, encrypted key backups with a recovery test, and signed delivery with per-server receipts.
Search sits in the header of every page. Result rows show the headword, rafsi, type, highlighted definition text, attribution, and a net score with Endorse and Oppose arrows.
Word pages show every definition under the selected view, with place strips, revision notices, comparisons, source evidence, rafsi pair cards, and reviewer details.
Settings can show Zbalermorna beside Latin headwords on word and search pages. A local preference puts definitions with your judgments first without changing scores.
Public identity pages show the signed profile, counts, and activity. Trust actions offer a private rule or a public signed record.
The local key edits its public profile, with a signed preview of the name, biography, and HTTPS links under the format limits. A rafsi pair link opens the pair's word and rafsi from the local search packages.
The browser keeps the key's own records that it fetched from a server, so later signatures read them locally. It handles at most 4,096 own events per key and 64 concurrent branches. Above those limits it refuses to sign in this browser and says so.
The Not delivered page lists unfinished delivery only. It supports receipt lookup before retry, identical retries, Retry-After, Stop retrying, export, and Resume delivery.
Downloaded search packages permit local search without a request for each query. Version 2 packages carry authors, notes, and rafsi for result rows.
Signing needs localhost or HTTPS. A plain HTTP Tailscale address supports reading only.

The importer prepares signed proposals from pinned local Lensisku JSON captures and SQL snapshots. Repeat imports reuse signed records and retain source evidence.
It keeps definitions literal and preserves unknown fields as unknown. It does not infer places or individual votes.
New SQL and REST publications omit derived vectors and caches with explicit source limitations.
REST publications also omit viewer-specific values.
The current importer records unknown rights. The source-notice convention below remains a target change.

The committed adapter comparison uses one signed profile event. Importer tests include a two-row fixture derived from a pinned 2,429-row API capture.

The SQL fixture retains four source definitions in English, French, and Russian, with available version history and numbered keywords.
SQL extraction streams COPY blocks and joins source rows on disk. It retains separate language tags and separate word-level and definition-level rafsi evidence.
Unsupported rows receive unresolved notices. The source archive keeps the original manifest and records the digest and path of the external dump.
Split rows retain their owner across breaks in different fields. The size estimate counts new publications separately from staged observations.
The SQL `--check-existing` mode requires a copied journal in fresh scratch output and refuses an existing proposal.

An offline command loads signed carriers, their selection, and their view into a Node data directory. Repeat loads preserve receipt positions.
Node startup restores the loaded view and its explicit state work budget. The server and loader require exclusive access to that directory.
Full-capture runs remain separate development evidence, not part of the committed fixture tests.
The [importer guide](packages/importer/README.md) describes its input, journal, signing command, and limits.

The guided wizard has five steps: Meaning, Type, Form, Places, and Publish. The full editor opens every field section and permits manual headword and type entry.
Manual authoring works without AI. Publish signs the definition, a separate author blessing, selected rafsi claims, and their pair blessings as one locally persisted group.
Revise copies a publication into a new draft with its exact parent and keeps every field: links, code, operands, literal circled characters, every gloss with its language and sense, every derivation, and the frame role. The page names the only changes a native revision makes. A revision of imported text cites the imported publication and copies the source-rights reference once.
Each rich text field of a draft holds its exact value, and only an edit of that field parses text, so an untouched field never changes. In structured editing every rich text node has a text form, and a backslash keeps a circled numeral or a token character literal. Pasted circled numbers stay literal unless the author chooses references. Removing a place keeps the referent of every other reference. The shared core checks the finished body before Publish is enabled, and every blocking problem names its field.
A draft saved by the earlier prototype opens a choice to export it, convert it into a wizard draft, or discard it. The old license and attribution fields stay in the export only, because new definitions publish under CC0 1.0.
Remote search offers a retired-results filter that shows each publication's status. The lujvo builder says whether a candidate spelling is taken in the local package and on the server.
The rafsi page lists known assignments across words from version 2 packages, and the claim page signs a claim with its pair blessing.
The lujvo builder offers short rafsi, gismu stems, whole gismu, whole-word parts under the extended profile, locks, CLL scores, recovered parts, and every competing rafsi claim from the local package.
Choosing [optional hyphens](docs/morphology.md) in the lujvo builder remains a target change. The builder adds only the required hyphens.
The gismu generator offers the CLL 1987, CLL 1995, and Ilmen presets with pinned sources, custom weights, exact scores, tied ranks, per-language contributions, root and rafsi conflicts, and manual forms without fabricated evidence.
The [morphology profiles](docs/morphology.md) name the rules and versions that the metadata records.
The status editor, transfer editor, semantic search, AI, and Lensisku cross-posting remain target features.
The site view is the server's selected signed view, and the Trust page can use another retained signed view by its event ID. A signed view names its calculation profile, `simple-routes-bounds-v1` or `simple-routes-shun-v1`; the pages name the profile of each result and its route rule, and an unknown profile leaves scores unavailable.
The personal view downloads the snapshot records, verifies each envelope and body in a Web Worker, and ranks words locally with the private overlay.
It adds the current identity with allocation 1 only when its continuity group has no allocation or private root change.
Zero allocations and removals also prevent that addition. It applies private blocks and public shuns as local blocks.
A cancelled or incomplete local calculation keeps personal scores unavailable and offers the site view. "Recompute from records" compares a local site-view calculation with the server scores.
A planned handover creates and tests a successor key, shows the old key's heads from every configured peer, searches for an existing transfer, and saves the transfer, the acceptance, and the encrypted successor key in one transaction before upload. Partial upload reads "Old key retired, acceptance waiting", and retries reuse the stored events.
A compromise notice previews the retained and excluded records of a chosen causal frontier, blocks on missing history, and needs explicit approval for an empty frontier. Ordinary signing from a retired or compromised key is refused.
The [web UI design](docs/ui-design.md) defines the layouts. The reading, identity, trust, delivery, authoring, and builder screens follow it.
Automatic rafsi publications and structured import conversion remain unfinished.
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
The Node loader can retain a larger explicit traversal budget for a local import.
That configuration does not remove memory limits or establish performance for the full corpus.
The first full SQL evaluation reached WebAssembly's 4 GiB memory limit with derived source vectors in every body.
The current extraction omits derived vectors and caches. Full dictionary serving with that extraction remains untested.

[Issue 9](https://github.com/int19h/jbovlacku/issues/9) tracks ranking CPU limits.
[Issue 11](https://github.com/int19h/jbovlacku/issues/11) tracks state evaluation beyond the local corpus.
[Issue 10](https://github.com/int19h/jbovlacku/issues/10) tracks URL serialization and invisible headword characters.
The development guide lists local tests. Their scope does not establish full specification conformance or public deployment readiness.

## Documentation

The documentation defines the product, its records, and the development process:

- [Format specification](docs/format.md): Target signed records, causal state, identities, imports, and ranking.
- [Frontend specification](docs/frontend.md): Target browser behavior, server contracts, authoring, and optional inference.
- [Web UI design](docs/ui-design.md): Target screens, visual rules, and publication flow.
- [AI prompts](prompts/README.md): Draft prompts for the optional AI actions. No application code uses them yet.
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
