# Synthetic local activity

This tool generates synthetic local activity for measurement and tests.
It creates disposable identities, reads a local dictionary server, and
submits signed events through the server HTTP admission path.
It never writes server store files directly.

## Setup

Build the core first from the repository root:

```sh
npm run build:core
```

Run every command from the repository root with `tsx`:

```sh
npx tsx scripts/synthetic-activity/cli.ts --server http://127.0.0.1:8795 --state .cache/synthetic/a init
```

One state folder holds one identity. Use one folder per identity.
Several identities can write at the same time to one server.
The server serializes admission. One identity must use one state
folder at a time. The tool locks the state folder during a write.
If two processes use the same folder, the second write is refused.
Run parallel writers with separate state folders.

## Commands

| Command | Example |
| --- | --- |
| Create identity | `init` |
| Show identity | `whoami` |
| Search words | `search klama` |
| Show entry | `show klama` |
| Recent events | `recent --limit 10` |
| Own history | `history` |
| Publish definition | `define --word smokeword --text "x1 is a test" --gloss test` |
| Revise definition | `define --word smokeword --text "x1 is revised" --parents jve1:...` |
| Publish rafsi claim | `rafsi --word smokeword --rafsi smo` |
| Judge definition | `judge --target jve1:... --value bless` |
| Judge virtual | `judge --base jve1:... --conversion te --value bless` |
| Judge rafsi pair | `judge --target jvr1:... --value curse` |
| Clear judgment | `judge --target jve1:... --value clear` |
| Trust | `trust --subject ed25519:... --value heed --scope-kind "*" --scope-word "*" --scope-language "*"` |
| Status | `status --target jve1:... --value deprecated` |
| Profile | `profile --name "Test user" --bio "Local test"` |
| Report | `report --subject ed25519:... --category spam-flooding --value report --text "Test"` |
| Publish view | `view --name "Test view" --root ed25519:...=1/1` |
| Merge heads | `merge` |
| Capture | `capture --state A --state B --out DIR` |
| Restore | `restore --capture DIR` |
| Reuse check | `reuse-check --capture DIR` |

Global options come before the command: `--server`, `--state`,
`--view`, `--limit`, and `--full`. The default output is short.
`--full` prints full JSON where a read supports it.

A refused write prints one line on standard error. It starts with
`refused:` and keeps the server or validator message exact. The
process exits with code 3. Fix the input and run the command again.

## Actions not included

| Action | Reason |
| --- | --- |
| `import.status` | It controls imported publications through source-author links. It is not a normal local user action. |
| `account.set` and `account.observe` | They need an external account and a witness service. The local server reports that service as unavailable. |
| `bridge.set` | It needs an external account bridge. The local server reports it as unavailable. |
| `identity.transfer`, `identity.accept`, and `identity.compromise` | They retire or recover keys. A disposable test identity does not need them. Create a new identity instead. |

## Capture and restore

Capture collects only events by the identities in the given state
folders. It writes `events.jsonl`, `manifest.json`, and `keys.json`.
The event file uses canonical JSON, one event per line. The manifest
holds the base snapshot, the base inventory value, the kit revision,
counts by kind and by issuer, the public keys, and the SHA-256 of
the event file. The keys file holds private keys. Keep a capture
folder private.

Restore posts every event to a fresh server copy of the same base
snapshot through the normal admission path. It then checks the
final inventory against the base inventory plus the captured events.

The reuse check does the same work on a fresh disposable copy. It
prints `reusable` when every event still passes the current code.
It prints `not reusable:` and the first reason when it does not.
That result is the signal to create the data again. This tool has
no migration code.

## Tests

```sh
npx tsx --test scripts/synthetic-activity/smoke.test.ts
```
