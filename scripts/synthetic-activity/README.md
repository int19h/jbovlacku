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
  `refused: server must be a loopback URL`. Environment proxy
  support (`NODE_USE_ENV_PROXY` or `--use-env-proxy`) is also
  refused. A proxy changes what the loopback name means.
- Redirects must stay on the same origin. The tool follows at most
  five redirects by hand. A redirect to another origin is refused
  with `refused: redirect leaves the loopback server`.
- The server must prove that it holds a disposable copy. Before
  its first request, the tool reads `/synthetic-disposable` from
  the server. It needs a JSON answer with `"disposable": true`.
  Any other answer is refused with `refused: server does not prove
  it holds a disposable copy`.

The test server in `server.ts` provides that proof. It takes the
data-directory lock before it reads or writes the marker. When
the marker check fails, the server releases the lock. It writes
a `disposable.json` marker into a fresh empty data folder. The
marker includes a `server_id`. The server stores the new marker
bytes. It then gives the file its final name. It then stores the
directory update. A marker that already says
`disposable: true` and has no server id gets one at startup, and
that id then stays with the data directory. If a data folder
already holds data and has no marker, the server refuses to
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

If a server stops hard, its data folder keeps a
`.node-data-lock` folder. First make sure that no server
process uses that data folder. Then delete that exact
`.node-data-lock` folder inside the data folder, and nothing
else. The next server start can then take the lock. If a
server process still uses the data, do not delete that folder.

## Setup

Build the core first from the repository root:

```sh
npm run build:core
```

Run every command from the repository root with `tsx`:

```sh
npx tsx scripts/synthetic-activity/cli.ts --server http://127.0.0.1:8795 --state .cache/synthetic/a init
```

One state folder holds one identity. The tool stores the new
identity bytes. It then gives the file its final name. It then
stores the directory update. Use one folder per identity.
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
the counts and digests of all three components of the base
logical inventory: retained events, bodies, and import
selections. Three list files hold the base entries:
`<pin>.ids` for event IDs, `<pin>.bodies` for body hashes, and
`<pin>.selections` for import selections. They go beside the
state folders, or to the paths from `--pin`. Every `init`
reads that same pin. An identity that starts later gets the
same base, even after other identities have written. If no
pin file exists, `init` reads the server and creates the
pin. If it cannot read a base, `init` fails and writes no
identity. It never creates an identity with an empty base.

An explicit `--pin` path that does not exist is refused at
`init`. A wrong path must not create a new pin late in a run.
`init` creates a pin only on the default pin path.

A new base needs a new pin file. When a fresh identity uses
an existing pin, `init` requires every pinned base event ID
on the server. A server that holds the base plus this run's
later events passes. A larger server without the pinned base
IDs is refused. A pin file with no base count or no ID list
is refused. Delete the old pin file, or pass a new `--pin`
path, to start a run on a new base.

The pin also records the server id from the disposable marker.
An empty base has an empty ID list.
An empty list matches every server.
The ID check alone cannot name the server that made the pin.
If the base is empty, `init` requires the server id.
The same server still passes after later events from this run.
A different server is refused with `refused: empty
base pin does not match this server`. A target that holds a
proven copy of this run accepts the same pin. The capture
section tells how restore records that copy. An empty pin with no
server id is refused. That pin was taken before server ids
existed. Take a new pin with `pin-base` before any synthetic
event. Take that pin on the server that will host the run.

### Write lock and crash recovery

The lock is one file named `lock` in the state folder. Its
content is the complete owner record: the process ID, the
process start tick from `/proc`, the start time, and a random
ownership token. A writer builds that record in a private
temp file, then publishes it with `link`. Link is atomic.
If the lock already exists, link fails. So the lock never
exists without its owner record, and no writer can overwrite
another owner's record. A second write while that owner
process runs is refused.

The owner check compares the process start tick, not only
the process ID. A new process that reuses an old process ID
has a different start tick, so its lock is stale, not live.
Where `/proc` is absent, the tool cannot compare start
ticks and it treats a running process ID as live. On Linux,
a zombie process is dead. Recovery clears that lock. The
`unlock` command clears it too. An
unreadable lock record is treated as live, never as stale.

Recovery works in steps. A recoverer reads the owner and
judges it stale. It then reads the owner again after the
wait for the process check. If the token changed, a peer
recovered first, and this process renames nothing. If the
token is the same, it claims the stale lock by renaming the
file to a private name. Only one recoverer wins that rename.
It then checks the moved file. If the moved token is not
the stale token it judged, a peer won during the wait. The
file is linked back, and this process starts again. A claim
deletes only the stale record it judged.

The holder checks its own token at the lock path before it
posts. A writer whose lock was claimed stops. It does not
post under another writer's lock. If the token still matches,
the release step removes the lock. The `unlock`
command clears a lock by hand with the same claim check.
It refuses while the owner process still runs, unless
`--force` is given. A real filesystem error, such as no
permission, is reported as an `error:` line. It is not
reported as another writer.

In normal operation this prevents forks. A writer crash or a
kill is included. Under an
adversarial schedule, a fork can still occur: a live writer
held for a long time at an exact point, while another
writer's post is held. A third writer can also slip into the
short gap while a claimed lock is checked and linked back.
A fork is valid data. The format
treats concurrent branches of one identity as valid.
The next write uses all heads. If a merge is required, the
next write adds it.

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
| Publish view | `view --name "Test view" --root ed25519:...=1/1 --import-set "https://source.invalid\|ed25519:...\|sha256:..."` |
| Merge heads | `merge` |
| Capture | `capture --state A --state B --out DIR --pin PIN` |
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
through all of an identity's actions, orders them by receipt
position, and prints the latest ones. Head reads page as well.
With `--full`, `show` prints each definition's complete text.
`show` prints a place node as `x1`, `x2`, and so on. A link, a
code span, and an operand contribute their text. The short form
keeps those place numbers, and then keeps the first 160
characters. If the output pipe closes early, the process exits
quietly. A pipe to `head` closes the pipe early. The process
prints no stack trace. When the error stream works, the
process prints a full-disk error or another output failure.
The process exits with status 1.
A write by an identity with more than 64 heads first combines
them with merge events in batches of 64.

### Trust scope

A trust action has a scope of three fields. `--value` is `heed`,
`shun`, or `clear`. The default value is `heed`.

- `--scope-kind` is `definition`, `rafsi`, or `*`. `*` means every kind. The default is `*`.
- `--scope-word` is `*` or one `jvw1:` word id. The default is `*`.
- `--scope-language` is `*` or one lowercase BCP 47 language tag, such as `en`. The default is `*`.

### Import sets on a view

`--import-set` adds one import set to a `view` command. Repeat
the option for each set. One value has the form
`source|importer|selection`: the source namespace, the importer's
`ed25519:` identity, and the `sha256:` hash of the import
selection. The source must not contain `|`. The tool sorts the
source, the importer, and the selection in UTF-8 byte order.
In that order, uppercase ASCII comes before lowercase ASCII.
The tool refuses a duplicate. A view holds at most 8192 import
sets.

A view with no `--import-set` has an empty import set. An empty
import set excludes every imported base definition. A persona
view of the imported dictionary must repeat the import sets of
the base view. Copy those three fields from the base view's body.

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

Capture is a point-in-time copy. It holds the write lock of
every state folder it captures. The lock starts before the
first read and ends after the files are complete. During
capture, a writer from this kit is refused. That writer retries
later. The capture holds
exactly the synthetic events of one admitted snapshot. The
success line and the manifest name that snapshot as
`capture_snapshot`. An event that a writer outside this kit
admits after the final check is after that snapshot, and so
is not in the capture.

Capture collects only events by the identities in the given
state folders. Naming one folder twice is the same folder. A
relative path, an absolute path, and a symlink of that folder
are one lock, and capture does not refuse itself. The tool
compares the device and the inode. Two names of one folder
are one lock. Capture needs
the run's pin file: pass `--pin`,
or keep `base-pin.json` beside the first state folder. It
writes `events.jsonl`, `manifest.json`, and
`keys.json`. The event file uses canonical JSON, one event per
line. The manifest holds the base snapshot and the base
inventory value. It holds counts and digests for the three
base components. Those components are retained events, bodies,
and import selections. It holds a digest of the base bodies
that the capture does not carry. It holds the expected final
counts and digests of all three components. It holds the
expected final logical inventory. It holds the kit revision,
counts by kind and by issuer, the public keys, and the SHA-256
of the event file. For an empty base, it holds the source server
id from the original pin. Each captured identity records that
same id with its base. Restore refuses a capture whose identity
records disagree with its manifest, and a capture from an older
kit must be captured again. The keys file holds
private keys. Keep a capture folder private.

Capture files and the local disposable server are trusted
operator storage, like other checkpoints in this project. A
fully consistent capture and a direct request to the loopback
server are outside the disagreement check.

When restore finishes on a capture that names a source server
id, it writes `restored-runs.json` in the target data folder.
The file names that source server id and the event ids of the
proven inventory. The target keeps its own server id. A later
`init` can use the original empty pin on that target. When
every recorded event is still on the target, init accepts the
pin. The target can hold more events than the record and still
accept the pin. A different server, with no such proven copy,
is refused.

Restore and the reuse check enforce the pinned base. They
prove the whole logical inventory, not only event IDs, before
they post anything: the retained events, bodies, and import
selections are read at one pinned admitted snapshot. A body
that a captured event shares with a base event counts once.
That count is in the captured set. A missing captured body
stays repairable. A missing base body is refused. An added
base body is refused. The manifest can lag behind the admitted
inventory, so it never decides the case. Three cases pass.

- Fresh copy: the inventory is exactly the pinned base. The
  manifest must also reach the pin. The tool waits at most ten
  seconds for that (`--wait-ms` changes the bound).
- Already restored copy: the inventory is exactly the pinned
  base plus the capture.
- Partial restore: some captured events are present, and the
  rest of the inventory is exactly the pinned base. The same
  command resumes a stopped restore.

Any other inventory is refused before any post. A foreign
event is refused. A missing or added base body is refused. A
missing or added import selection is refused. A tampered base
value in the manifest is refused. The first mismatch is the
reason.

A fresh target must match the pinned base in all three
components. If a captured event shares that hash, a missing
base body is still refused. Missing captured bodies are
repaired only in the partial and already-restored cases, where
a restore already started on a correct base.

After the proof, restore posts every captured transport, not
only the missing ones. A repost is idempotent. It makes the
server check each captured representation again. It supplies
any body that an earlier admission left out. At the end, all
three components must equal the expected final values. The
final logical inventory must equal its expected value. Each
restored envelope must equal the captured envelope. Every
captured body must be present. An event ID alone is never
enough for `reusable`.

The reuse check does the same work on a fresh disposable copy.
If every event still passes the current code, it prints
`reusable`. If an event does not pass, it prints `not reusable:`
and the first reason. That result is the signal to create the
data again. This tool has no migration code.

`reusable` proves two facts. The current code accepts each
captured event and each captured body. The restored copy holds
exactly the pinned base plus the capture. The envelopes are
equal. The bodies are equal.
It does not prove that an event keeps the same interpretation,
such as a score or a status effect, under the selected view.
The `accepted` line of a write prints the receipt's
`interpretation` and any `reasons`, so a single action shows
that difference at write time.

## Tests

```sh
npx tsx --test scripts/synthetic-activity/smoke.test.ts
```
