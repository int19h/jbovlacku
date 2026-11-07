# Synthetic local activity

This tool generates synthetic local activity for measurement and tests.
It creates disposable identities, reads a local dictionary server, and
submits signed events through the server HTTP admission path.
It never writes server store files directly.

## Safety rules

The tool refuses unsafe targets in code, before it sends any request.

- The server URL must be a loopback URL. The host must be
  `127.0.0.1`, `::1`, or `localhost`. A URL with a user name or a
  password is refused. Any other host is refused with
  `refused: server must be a loopback URL`.
- Redirects must stay on the same origin. The tool follows at most
  five redirects by hand. A redirect to another origin is refused
  with `refused: redirect leaves the loopback server`.
- The server must prove that it holds a disposable copy. Before
  its first request, the tool reads `/synthetic-disposable` from
  the server. It needs a JSON answer with `"disposable": true`.
  Any other answer is refused with `refused: server does not prove
  it holds a disposable copy`.

The test server in `server.ts` provides that proof. It writes a
`disposable.json` marker into a fresh empty data folder. If a data
folder already holds data and has no marker, the server refuses to
start. To serve a disposable copy of existing data, put a
`disposable.json` file with `{"disposable": true}` into the copy
first. Never put that marker into data that must stay live. A
plain dictionary server has no marker endpoint, so this tool
refuses it. That refusal is intended.

The test server holds the same data-directory lock as the
standalone server. A second server on the same data folder is
refused. On shutdown it flushes materialization and saves its
evaluation state before it closes its stores and releases the
lock. A `loaded-view.json` file that exists and is bad, or that
names a view the data does not retain, also refuses startup. It
never falls back to a reduced server.

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
Run parallel writers with separate state folders.

### One base pin for the whole run

A run starts from one pinned base snapshot. Take the pin before
any synthetic event exists:

```sh
npx tsx scripts/synthetic-activity/cli.ts --server http://127.0.0.1:8795 --state .cache/synthetic/a pin-base
```

The pin holds the server snapshot, its logical inventory, and
its event count. It goes to a `base-pin.json` file beside the
state folders, or to the path given with `--pin`. Every `init`
reads that same pin file. An identity that starts later gets
the same base, even after other identities have written. If no
pin file exists, `init` reads the server manifest and creates
the pin. If it cannot read a base, `init` fails and writes no
identity. It never creates an identity with an empty base.

A new base needs a new pin file. When a fresh identity uses an
existing pin, `init` compares the pin with the server. A server
that has not grown past the pin must match it. A server that
has grown past it holds this run's later events, which the
capture checks prove. If the pin does not match and the server
has not grown past it, `init` refuses. Delete the old pin
file, or pass a new `--pin` path, to start a run on a new
base.

### Write lock and crash recovery

A write creates a `lock` folder inside the state folder. The
folder holds `owner.json` with the process ID, the process
start tick from `/proc`, the start time, and a random ownership
token. A second write while that owner process runs is refused.

The owner check compares the process start tick, not only the
process ID. A new process that reuses an old process ID has a
different start tick, so its lock is stale, not live. Where
`/proc` is absent, the tool cannot compare start ticks and it
treats a running process ID as live.

Recovery claims a stale lock by renaming its folder to a
private name. Rename is atomic, so only one recoverer wins.
The others loop and then see the winner's live lock. A lock
with no owner file is treated as stale after ten seconds. The
release step removes the lock only when the token still
matches. The `unlock` command clears a lock by hand. It
refuses while the owner process still runs, unless `--force`
is given. A real filesystem error, such as no permission, is
reported as an `error:` line. It is not reported as another
writer.

## Commands

| Command | Example |
| --- | --- |
| Pin the base | `pin-base` |
| Create identity | `init` |
| Clear a stale lock | `unlock` |
| Show identity | `whoami` |
| Search words | `search klama` |
| Show entry | `show klama` |
| Recent events | `recent --limit 10` |
| Own history | `history` |
| Publish definition | `define --word smokeword --text "x1 is a test" --gloss test` |
| Revise definition | `define --word smokeword --text "x1 is revised" --parents jve1:...` |
| Publish rafsi claim | `rafsi --word smokeword --rafsi smo` |
| Judge definition | `judge --target jve1:... --value bless` |
| Judge virtual | `judge --base jve1:... --conversion te --value bless` (refused by the current product, see below) |
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
`--view`, `--limit`, `--full`, and `--pin`. The default output
is short. `--full` prints full JSON where a read supports it.

Read output prints complete event IDs. A printed ID can go
straight into `--parents`, `--target`, or `--base`. Search
prints the preview event ID, the spelling, the word ID, the
definition IDs, and the preview text of each hit. The `recent`
command pages through the whole event journal and prints the
latest events last admitted. The `history` command pages
through all of an identity's actions. Head reads page as well.
A write by an identity with more than 64 heads first combines
them with merge events in batches of 64.

A refused write prints one line on standard error. It starts
with `refused:` and keeps the server or validator message
exact. The process exits with code 3. Fix the input and run the
command again.

### Virtual judgments

The format allows a judgment on a virtual target. The current
product refuses it. The validator accepts only `jve1:` and
`jvr1:` judgment targets, and it does not accept the `virtual`
field. The tool builds the format form, and the write is refused
with `refused: Draft does not satisfy version 1 action and body
rules.` Do not treat the virtual judge command as working until
the product accepts it.

## Actions not included

| Action | Reason |
| --- | --- |
| `import.status` | It controls imported publications through source-author links. It is not a normal local user action. |
| `account.set` and `account.observe` | They need an external account and a witness service. The local server reports that service as unavailable. |
| `bridge.set` | It needs an external account bridge. The local server reports it as unavailable. |
| `identity.transfer`, `identity.accept`, and `identity.compromise` | They retire or recover keys. A disposable test identity does not need them. Create a new identity instead. |

## Capture and restore

Capture collects only events by the identities in the given
state folders. It writes `events.jsonl`, `manifest.json`, and
`keys.json`. The event file uses canonical JSON, one event per
line. The manifest holds the base snapshot, the base inventory
value, the base event count, a digest of the base event IDs,
the expected final event count and inventory digest, the kit
revision, counts by kind and by issuer, the public keys, and
the SHA-256 of the event file. The keys file holds private
keys. Keep a capture folder private.

Restore and the reuse check enforce the pinned base. They
prove the exact inventory from event IDs before they post
anything. The manifest can lag behind the admitted inventory,
so it never decides the case. Three cases pass:

- Fresh copy: the event IDs are exactly the pinned base IDs.
  The manifest must also reach the pin. The tool waits at most
  ten seconds for that (`--wait-ms` changes the bound).
- Already restored copy: the event IDs are exactly the pinned
  base plus the capture.
- Partial restore: some captured events are present, and the
  other IDs are exactly the pinned base IDs. The same command
  resumes a stopped restore.

Any other inventory is refused before any post. A foreign
event, a missing base event, or a tampered base value in the
manifest is refused with the first mismatch as the reason.

After the proof, restore posts every captured transport, not
only the missing ones. A repost is idempotent. It makes the
server validate each captured representation again, and it
supplies any body that an earlier admission left out. At the
end, the inventory must equal the expected final digest, each
restored envelope must equal the captured envelope, and every
captured body must be present. An event ID alone is never
enough for `reusable`.

The reuse check does the same work on a fresh disposable copy.
It prints `reusable` when every event still passes the current
code. It prints `not reusable:` and the first reason when it
does not. That result is the signal to create the data again.
This tool has no migration code.

## Tests

```sh
npx tsx --test scripts/synthetic-activity/smoke.test.ts
```
