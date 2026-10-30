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

The definition validator accepts omitted [optional definition fields](docs/format.md#absent-fields-and-compatibility) and their explicit default values.
Readers and editors apply defaults to separate interpreted values. Stored bodies, exports, hashes, signatures, and event IDs retain the original signed content.
New definitions omit optional fields with default values. Required fields and imported source evidence remain required.
The signed lexical kind for fu'ivla is `fuhivla`. The browser uses one shared label helper to display "fu'ivla".
Raw JSON inspectors retain the signed label.
The validator rejects the earlier `fuivla` label without an alias.
A new version of each private projection forces backfill of stored validation results under the current schema.
Formation sources accept an omitted or null `word_ipa`. They reject `stem` and `ipa`, including null and empty values.

The shared core accepts `entity`, `mass`, and `tuple` as retired tags in signed version 1 bodies.
Sorting and uniqueness compare signed tag strings. A retired tag can appear beside its current equivalent without an automatic merge.
`entity` means `referent`. `tuple` means `sequence`.
`mass` is an opaque legacy annotation outside the current tag tree and has no current alias.

The draft model preserves these hints for review.
Before a new signature, the author must replace retired tags with current standard or custom HTTPS tags, or remove them.
Explicit alias replacement preserves the note, abstractor, and relation arity. After that action, identical tags and alternatives appear once.

The Node.js server uses local object files and SQLite for admission, receipts, snapshots, search packages, and dictionary API reads.
The search index retains the current copy, one rollback copy, active staged copies, and copies that retained aliases reference.
An alias points to unchanged entries without copying them. Index publication removes obsolete copies and aliases in the same transaction as the current pointer.
The native `jvc` command reads, writes, validates, and merges dictionary carriers. It also reads exact committed Git trees locally.
The [carrier guide](crates/jvc-carrier/README.md) describes canonical files, import selections, retention policies, and read limits.

The browser supports anonymous lookup, verified definition pages, encrypted key backups with a recovery test, and signed delivery with per-server receipts.
Search sits in the header of every page. Result rows show the headword, rafsi, type, highlighted definition text, attribution, and a net score with Endorse and Oppose arrows.
Word pages show every definition under the selected view, with place strips, revision notices, comparisons, source evidence, rafsi pair cards, and reviewer details.
After an HTTP 503 read failure, word and search pages offer Retry reading with the same URL and selected view.
A failed retry shows its retry number and announces the current error reason, including HTTP 500 and connection failures.
Untouched rich-text fields keep their exact stored values. Edited fields normalize line endings, string fragments, trailing whitespace, and paragraph breaks. Ordinary TeX and backslashes stay literal. Code and links stay within one paragraph. The editor shows blank lines inside stored code and labels as single line breaks.
Word-link and derivation spelling advice never blocks a format-valid reference. Invalid references show plain error sentences.
Revision comparisons group changes by readable fields and numbered places, with rich text and complete place and source details.
They align inserted and removed list items and keep exact structured values in closed disclosures.
Import evidence changes use a short presence or absence line. Comparisons still detect every change in the interpreted body.
Comparison fields follow reader order and show invisible controls as escapes. Nested lists align their changed items, with bounded alignment work and batches of 50 displayed changes. Sparse edits in long lists retain alignment within the edit budget. Keyboard batches focus the first new row, including the final batch.
Direct revision reads retry unavailable bodies on the next visit. A known missing body stays missing within its pinned snapshot.
Settings can show Zbalermorna beside Latin headwords on word and search pages. A local preference puts definitions with your judgments first without changing scores.
Public identity pages show the signed profile, counts, and activity. Trust actions offer a private rule or a public signed record.
Private trust and Ignore controls apply each addition or removal in one storage transaction, so concurrent unrelated choices remain saved.
The local key edits its public profile, with a signed preview of the name, biography, and HTTPS links under the format limits. A rafsi pair link opens the pair's word and rafsi from the local search packages.
The browser keeps the key's own records that it fetched from a server, so later signatures read them locally. It handles at most 4,096 own events per key and 64 concurrent branches. Above those limits it refuses to sign in this browser and says so.
The Not delivered page lists waiting and stopped records. The header marker counts both, and stopped rows offer Resume and Save as file.
Stopped records stay in the browser until the author resumes delivery. The page describes retry reasons only for waiting records.
Discard asks first and removes an unfinished stopped record only when no later local own record depends on it.
Compromise, transfer, and acceptance records must be delivered and cannot be discarded. Fully delivered records keep their signed bytes and receipts.
The storage transaction checks these rules again and restores retained predecessors to the frontier after a discard.
If authenticated server history later includes a discarded record, the browser restores its history and permits later signatures to follow it.
The app tells the author once that the record reached a server. The notice stays through navigation until dismissed.
Delivery supports receipt lookup before retry, identical retries, Retry-After, and Stop retrying. A first online publication shows neutral progress until delivery returns an outcome.
Saved publication pages keep receiving delivery updates after a reload and stop listening when the author leaves the page.
Updates keep focus on delivery controls and announce only short status changes. Try now stays disabled through the group retry and final refresh.
If storage cannot be read, the saved page keeps known records and offers Retry reading. It reports missing records only after a successful read.
Delivered records leave the list but keep their receipts in retained history. With no waiting or stopped records, the page shows a short empty state.

The search page uses one box and separate Lojban word, definition, and optional meaning groups.
Each group has its own pages and show all action. Known complete dictionary spellings put word matches first. Other queries put definitions first.
Pause periods, commas, and the `h` apostrophe alias count as the same complete dictionary spellings.

Version 2 packages store their ordering view once, with a status per entry. Older packages without evidence ask for a refresh.
A chosen view that differs from the package view keeps Definitions first and explains that limit without asking for another download.

Meaning search uses inline consent for the named provider and scope. It stays absent when AI is off or the service is unavailable.
“Not now” stops meaning search for this page, including a pending consent save. Stored provider consent stays available for later pages.
Pending and failed indexing remain visible beside meaning results. The meaning snapshot and view stay visible in local mode.
Back restores saved meaning results without another provider request. A failed matched-definition read retries without repeating inference.

A visible notice explains meaning uploads. The notice and the consent box offer a lasting off choice. That choice keeps consent and other AI choices.
When AI and a query profile are available, the on control returns beside search. Lexical counts and controls do not wait for meaning requests or definition reads.

One screen-reader count region announces lexical groups in displayed order. Local counts include the full total and the shown count when rows remain hidden.
A settled meaning update includes those lexical counts before its meaning count. Group counts stay visible without a second status line.
Each expansion preserves keyboard focus.
Downloaded search packages permit local search without a request for each query. Version 2 packages carry authors, notes, and rafsi for result rows.

Local and server search share TypeScript morphology and match ranking. Compound cmavo match exact component sequences, contiguous runs, and ordered subsequences.
For example, `i seri'a bo`, `ise ri'abo`, and `iseri'abo` find the same compound. `i bo` also finds `iseri'abo`.

Exact and contiguous compounds keep cards for uncovered query words. With `ije` present, `ijebo klama` keeps cards for `bo` and `klama`.
Without a joined compound, `ijebo` shows `i`, `je`, and `bo`. Subsequence matches keep individual cards, and repeated words share one card.

Punctuation, digits, and `h` aliases also find a single recognized word. One-word prefix families precede containing compounds.
Long lists offer “show all”. Case and acute headword stress marks do not change match classes.

Queries permit 512 recognized words and 300,000 parser steps, with 128 phonemes per run. The index covers dictionary headwords through 256 bytes.
A limit notice preserves ordinary text search and states incomplete sequence coverage.

Saved-package validation and search run in a static module worker. Search pages, nearby lookup, and lujvo part lookup share two prepared package revisions.
Local search transfers references for 20 results per group initially. Show all fetches only the remaining results through the 1,000-word browser limit.
Nearby lookup ignores late results after meaning or language edits and recovers when the current language package returns.

The server prepares lexical indexes during package materialization, before completed snapshots become readable.
Storage reads check durable revision markers, so same-snapshot changes and another tab's writes invalidate retained data.
The [search specification](docs/frontend.md#4-search-and-reading) defines the bounds, ranking, and fallback rules.

Local and server search also share bounded pattern matching in WebAssembly.
`/.../` searches by an unanchored, case-insensitive regular expression. Globs use `*`, `?`, `@` for a vowel, and `$` for a consonant.
Globs match the whole spelling. `*` and `?` consume any character, including spaces and punctuation.
Literal `h` reads as an apostrophe. Matching ignores capitals and acute stress marks.
Meaning retrieval and rafsi claim previews use literal search. Natural-language questions keep ordinary text search with a short punctuation note.
Patterns return headword matches before retained rafsi matches, with normalized spelling order and a final word-ID tie break and the usual “show all” behavior.

The rafsi page accepts the same patterns and keeps each matched assignment separate.
Version 1 packages expose headword patterns only. Version 2 packages supply bounded rafsi metadata.
The shared engine caps compilation, per-candidate work, and total work by compiled state count.

Node reuses two initialized workers and starts each task deadline after initialization.
The Node server admits two active pattern scans and eight waiting requests. Excess requests return HTTP 503 with a retry hint.
The browser retains its worker deadline.

Plain local cancellation preserves prepared packages. Canceling a running pattern stops its worker.
Invalid patterns and exhausted limits give explicit errors without partial results or a silent remote fallback.

A download keeps its requested language even when the language selector changes before it finishes.
Signing needs localhost or HTTPS. A plain HTTP Tailscale address supports reading only.

The importer prepares signed proposals from pinned local Lensisku JSON captures and SQL snapshots. Repeat imports reuse signed records and retain source evidence.
It keeps definitions literal and preserves unknown fields as unknown. It does not infer places or individual votes.
New SQL and REST publications omit derived vectors and caches with explicit source limitations.
REST publications also omit viewer-specific values.
The current importer records unknown rights. The source-notice convention below remains a target change.

The committed Node adapter test uses one signed profile event. Importer tests include a two-row fixture derived from a pinned 2,429-row API capture.

The SQL fixture retains four source definitions in English, French, and Russian, with available version history and numbered keywords.
SQL extraction streams COPY blocks and joins source rows on disk. It retains separate language tags and separate word-level and definition-level rafsi evidence.
Every table that the importer reads needs a complete COPY block.
Present tables without declared counts are accepted with an unknown-count notice. The importer does not change the archived manifest.
Absent tables and declared logical row deficits leave dependent definitions unresolved and preserve their selected publications and known baselines.
Grouped split records count once, so extra physical lines cannot hide a missing record.
If a keyword table contains malformed rows, definitions without well-formed mapping rows remain unresolved instead of acquiring known empty glosses.
A mapping with missing or extra fields, or a split mapping, keeps the whole table incomplete.
This also applies when a fragment names an existing definition.
If a damaged mapping has no owner in the capture, the whole mapping table remains incomplete even when its row count matches.
A complete empty table can still establish a real source change.
Unsupported rows receive unresolved notices. The source archive keeps the original manifest and records the digest and path of the external dump.
Split rows retain their owner across breaks in different fields. The size estimate counts new publications separately from staged observations.
The SQL `--check-existing` mode requires a copied journal in fresh scratch output and refuses an existing proposal.

An offline command loads signed carriers, their selection, and their view into a Node data directory. Repeat loads preserve receipt positions.
Node startup restores the loaded view and its explicit state work budget. The server and loader require exclusive access to that directory.
Full-capture runs remain separate development evidence, not part of the committed fixture tests.
The [importer guide](packages/importer/README.md) describes its input, journal, signing command, and limits.

The guided wizard has five steps: Meaning, Type, Form, Places, and Publish. The full editor opens every field section and permits manual headword and type entry.
Manual authoring works without AI. Publish signs the definition, a separate author blessing, selected rafsi claims, and their pair blessings as one locally persisted group.
Meaning placeholders restart at 1 after each semicolon. Explicit circled numbers and `{place N}` reserve their numbers within each part.
Blanks take the free numbers in order. The count is the highest place number, and the Places step previews each part before approval.
Meaning treats only a backslash before a circled numeral as an escape. It preserves every other backslash.
The Places step and the full editor offer hideable advice above three declared places, with firmer text above five.
A repeating tail counts once. The advice applies to every word type and never blocks publication or enters signed records.
Revise copies a publication into a new draft with its exact parent and keeps every field: links, code, operands, literal circled characters, every gloss with its language and sense, every derivation, and the frame role. The page names the only changes a native revision makes. A revision of imported text cites the imported publication and copies the source-rights reference once.
Each rich text field of a draft holds its exact value, and only an edit of that field parses text, so an untouched field never changes. In structured editing every rich text node has a text form, and a backslash keeps a circled numeral or a token character literal. Pasted circled numbers stay literal unless the author chooses references. Removing a place keeps the referent of every other reference. The shared core checks the finished body before Publish is enabled, and every blocking problem names its field.
Editing beside multiline code or link labels keeps their node types, literal circled numbers, and edge spacing. Runs of blank lines become single line breaks. All rich-text controls support multiple lines.
URL targets remove only characters ignored by URL parsing, so edited links keep their destination. Rafsi rationales publish blank lines as separate paragraphs.
Word links and place derivations use the shared format rules. Valid uppercase references retain their exact targets and do not block publication.
A draft saved by the earlier prototype opens a choice to export it, convert it into a wizard draft, or discard it. The old license and attribution fields stay in the export only, because new definitions publish under CC0 1.0.
Remote lexical search, word pages, and downloaded language packages exclude definitions whose receipts are not effective.
Word pages and language packages retain effective deprecated definitions.
Remote search includes them through its retired-results filter and shows each publication's status.
Reads pinned to an earlier retained snapshot use that snapshot's state. Word pages and remote searches also use their requested view.
Core definition rankings exclude definitions without effective receipts.
Rafsi eligibility uses effective publication evidence and preserves missing-data uncertainty.
Resolved cutoffs and transfers keep their publication exclusions when another cutoff is pending.
Otherwise, pending compromise cutoffs suspend definition and rafsi receipts. Suspended publications do not prove an inactive rafsi assignment.
When evaluation reaches a resource limit, the manifest keeps raw synchronization and signed view inspection available and marks package downloads unavailable.
The browser does not load or save an unconfigured server view as a signed policy.
The lujvo builder says whether a candidate spelling is taken in the local package and on the server.
The rafsi page lists known assignments across words from version 2 packages, and the claim page signs a claim with its pair blessing.
The lujvo builder offers short rafsi, gismu stems, whole gismu, whole-word parts under the extended profile, locks, CLL scores, recovered parts, and every competing rafsi claim from the local package.
A combination above 128 bytes leaves shorter candidates available.
The bounded rejected list shows parse failures before examples of overlong spellings.
If several parts share the same competing rafsi claim, the builder shows one acknowledgment for that claim.
A word entered on Meaning gets local form detection and an exact identity lookup in the selected language package.
Headword analysis lowercases author input, so capitals do not mark stress. Authors must write word breaks explicitly.
Acute accents mark cmevla display stress on vowels or consonants, as in `dján`, `ĺénan`, and `ḿa'an`.
Definitions and imported source records keep their accented spelling. Identity, search, matching, and morphology ignore those marks.
Different definitions of one name can retain different display stress. Their shared word ID does not merge the definitions or their judgments.
The wizard and `zei` builder preserve accented names and check the plain identity for existing definitions.
Automatic `zei` construction normalizes case, commas, apostrophe aliases, and edge periods while retaining acute marks.
Restored compounds and rafsi pages group accent variants by word ID. Rafsi claim bodies use plain source spellings.
The wizard blocks accented rafsi before signing and keeps the entered text until the author changes it.
Zbalermorna display converts the plain spelling. Foreign text without a word parse stays literal.
Accents on other recognized words block authoring. They do not change the grammar or make a vowel-final form into a name.
A remote exact-word check requires consent for that word and language. Missing coverage stays visible.
Type confirmation opens Places for a typed gismu or fu'ivla, source linking for a lujvo, and Form for the other kinds.
The typed lujvo path locks the exact analyzed parts and joins, including [optional hyphens and experimental forms](docs/morphology.md).
It preserves the entered spelling through publication, including case, commas, and framing periods. Source choices and exact definitions stay editable.
Unknown source fields stay blank. Authors can link every source to save compound evidence, or continue with no compound metadata.

Typed `zei` chains use whole component words as source links. The source form stays fixed, and authors can select an exact definition.
Components before the last `zei` can include one word followed by `bu`, as in `denpa bu zei sance`.
The final component must be one word, so `sance zei denpa bu` is not a lujvo.
These links need no rafsi and carry no construction score. Publication and revision preserve the selected definitions and entered spelling.
The imported spelling `zo si si zei fa'o` remains unsupported because it falls outside the [component rules](docs/morphology.md#zei-lujvo-linking).

A changed or cleared typed spelling restores ordinary builder rows. A generated replacement reopens with editable rows.
A replacement typed lujvo starts fresh analysis, including a return to an earlier spelling before the builder reopens.
A private origin marker distinguishes typed analysis from ordinary rafsi locks. Meaning visits and evidence removal preserve ordinary row editing.

Saved rows with unknown origin stay editable and keep their signed version, boundaries, and matching joins.
Spelling corrections preserve restored joins and compatible author-linked sources, exact definitions, and claims.
Restored older profiles preserve accepted case, commas, and apostrophe variants after an exact match with the core construction.
Released restoration stays released through reopening, reload, and rafsi relocking.
Removing every row from a published revision starts a complete signed restoration on the next matching builder visit.
It restores sources, locks, profile, and exact joins together, including `bangu'y'ismu` and `sairzba`.

Fresh typed analysis uses matching signed or restored profile evidence instead of a private ordinary profile choice.
Profile history survives visits to other typed words and removal of compound evidence.
An unsupported historical reading keeps ordinary profile choices across reopening and reload.
AI component acceptance creates clean ordinary rows. Conditional Undo restores prior construction and preserves later author edits.
Component-only suggestions and evidence-only gismu Use preserve typed identity and the later replacement confirmation.
Replaced evidence does not create a new spelling review. Retained annotations and earlier review marks stay intact.

A [state model](docs/typed-headword-state.md) defines the shared transitions and their invariants.
Seeded event sequences exercise those transitions with typed, legacy, and published-revision drafts.
The event model inventories all production writers. Its seeded sequences include AI component and source apply and Undo.
They also include gismu Use, manual Form Use, source synchronization, and all rafsi choices.
Its preservation checks compare interpreted definition defaults while keeping real evidence edits and signed source bytes distinct.

Historical fallback rows follow the current word and retry missing sources after a package download. Unresolved retries keep an authored ordinary profile.

Unconfirmed type detection follows spelling corrections after confirmation of any evidence loss.
Forward wizard links and direct Form or builder entry confirm the selected type. Cancellation keeps the previous type and evidence.
A confirmed type stays selected, and completed type review clears its notice.

New lujvo builders use the extended profile. Manual boundary controls for a generated spelling remain a target change.
The CLL profile retains required-only construction and version 2. New extended construction and recognition use version 4.
Saved extended versions 2 and 3 reopen with their original rules and component boundaries. Unknown versions stay unsupported.
The extended profile permits `mz`, consonantal-syllable borrowings, and the experimental rafsi rules. The CLL and extended version 2 profiles retain their earlier rules.
Source-language evidence scores a normalized gismu while its headword and evidence binding keep the typed bytes.
The gismu generator offers the CLL 1987, CLL 1995, and Ilmen presets with pinned sources, custom weights, exact scores, tied ranks, per-language contributions, root and rafsi conflicts, and manual forms without fabricated evidence.
The core and builders keep the optional full pronunciation, `word_ipa`, in signed formation sources.
Draft reload preserves private `stem` and `ipa` values. Neither enters a signed formation source.
Publication keeps each source row's word, `word_ipa`, scoring input, weight, and notes.
New signatures omit unknown `word_ipa` values. Retained signed bodies and private revision markers preserve original field presence without copying it into fresh source rows.
Known weights, including zero, survive regardless of private `stem` or `ipa` values.
Revise also keeps a signed source that names only a language, including an empty or whitespace-only word with null input and weight.
The gismu source editor has seven readable columns inside its own scrolling region at 360 and 1280 CSS pixels.
Each Remove action includes a row number and names its source language when known, including after a custom language edit.
The names stay unique for alternatives and rows with no language yet.
It keeps pronunciation and stem evidence separate from scoring letters.
It preserves original IPA inputs and shows that conversion to scoring letters is unavailable.
Source notes stay editable when assistance is off. The publication review shows all signed source evidence.
Source edits also update the publication copy after form selection. Descriptive edits keep the recorded scores.
Changes to scoring inputs block publication until the author selects the form again or removes its evidence.
Unrelated suggestions remain usable, and pending calculations cannot attach an older score to new inputs.
Reopening a signed source with a null algorithm input preserves that evidence.
The [morphology profiles](docs/morphology.md) name the rules and versions that the metadata records.
Word recognition, segmentation, lujvo construction, and gismu generation run in TypeScript without WebAssembly initialization.
New authoring uses a committed Peggy grammar and generated parser. The earlier profiles retain their exact recognizer in TypeScript.
The parser reads `y`, pure `y` runs, and `ie'o` as ordinary cmavo. It splits compound cmavo without dictionary matching.
For example, `taia` is `tai .a`, and `i'ecu'i` is `i'e cu'i`. Magic words do not execute word operations.
Accepted CgV names and borrowings carry a warning about current BPFK morphology from the same parse.
The Form, Type, and full editor screens report selected-kind mismatches as the author types.
A mismatch blocks client signing unless the author selects a matching type, Other, or an explicit experimental classification.
Dictionary admission keeps word shape outside record validity.

Optional AI assistance offers suggestions for type, components, lujvo, cmavo class, source words, definition text, places, and glosses.
The browser asks for consent before it sends draft fields. Suggestions need manual acceptance and support undo.
Type suggestions can ask one question without changing the selected type, or name another possible type with its own reason.
The server finds up to 30 related public definitions through lexical search and checks existing-word suggestions against the same snapshot.
An existing-word suggestion can start an additional definition or a revision with an improved definition and undo.
Both actions preserve the earlier draft. A place conversion opens the existing word page with its converted form and creates no publication.
Adding a definition preserves every current field and marks spelling-dependent evidence for review.
Revision actions show the ordinary notice about license and origin changes. Their exact parent and improved text keep the usual acceptance and undo flow.
Saved-draft links survive wizard navigation and reload. Atomic returns consume the restored row and keep all other saved drafts reachable.
Leaving a restore before its storage transaction starts cancels the switch and keeps both drafts.
A newer navigation takes priority while a save waits. A refused Back keeps the current page, its URL, and unsaved edits.
If a later navigation also refuses, it restores the shown URL. A cancelled kind dialog keeps the editor saving later edits.
The saver stops only when navigation commits. If a concurrent edit blocks a restore, the URL keeps its `resume` request while the saved row remains available.
An ordinary step link leaves that request without retrying it. The saved-draft link can retry it and preserves the newer current draft.
An independent saved index also keeps those links after publication, replacement, discard, and ordinary revisions.
Meaning can restore a saved draft without creating a new current draft first. Earlier orphaned saved rows migrate into the index.
Existing-word actions also remain available after type acceptance.
Related retrieval keeps up to three exact-spelling senses in editorial order and scans each lexical query once.
Query cleanup keeps inner apostrophes. Logs distinguish lexical, semantic-profile, and absent retrieval.
Related public definitions do not expand remembered consent. Semantic retrieval for type suggestions remains pending.
Type requests use the shared word analysis API to send compound cmavo parts. Their private logs record the morphology profile and version.
Source acceptance replaces earlier AI notes and preserves authored notes. A changed suggested word requires review of retained source evidence.
Marked fields stay read-only until Keep or Clear. A type change that removes the formation also removes its review marks.
Explicit evidence removal keeps the marks for reused source values. Undo restores required marks with returned values and preserves later review choices.
Keep never overwrites a different Notes paragraph.
Source previews read current rows after a weight preset change. Private note ownership choices do not mark suggestions stale.
Component suggestions keep selected exact source definitions.
Place mappings also preserve exact definitions for repeated component words.
The model keeps studied names such as `klama[2]`. Ambiguous repeated definitions require an `unclear` mapping.
Turning assistance off reaches other open tabs and cancels their active jobs.
Settings shows when the assistance choice reaches browser storage and reports a failed save.
The assistance checkbox keeps keyboard focus and ignores repeated input while its save runs.
Internal navigation waits up to two seconds for pending preference writes, then continues while storage keeps working.
A visible notice explains a pending save. The app announces late success and every save failure after navigation too.
Reload or exit warns while a write remains pending. A failed save keeps the committed preference and permits navigation.
A late save keeps the page that the reader chose. Earlier save completions preserve newer control choices.
The empty shell announcement region stays available to assistive software. Fast assistance saves use inline feedback without a toast.
The inline assistance status also stays available while empty and announces a fast save.
A failed assistance save uses one live status region. A result after navigation uses the shell status.
The first-signature dialog shows storage errors inside the dialog and permits another attempt.
Browser tests cover these outcomes, focus, saved off-state reloads, and receipt waits before personal recomputation.
The assistance tests bind delayed capability responses to held requests and cover an older response that finishes during a newer hold.

The private attempt log offers Markdown and JSON export. Signed publications omit AI logs.
The Node server offers operator-controlled assistance, off by default, with server-held keys and bounded private jobs.
It reserves costs before admission and enforces server and network spending limits that survive a restart.
IPv6 limits also count /48 prefixes. The Node server stores spending ledgers in SQLite.
The host service also admits bounded embedding batches through the same spending ledger and execution slots.
Caller cancellation during embedding admission prevents dispatch and removes any unsent reservation.
Its provider adapter pins `qwen/qwen3-embedding-8b` to the Nebius route through OpenRouter, with fallback and redirects disabled.
Invalid embedding configuration disables embedding alone and preserves generation.
Interrupted operations retain unknown-cost charges after restart. Errors after reservation carry their operation IDs.
Completed operator batches with known costs share hourly ledger rows, while recent diagnostics retain their individual charges.
Mocked capacity tests cover two 59,129-input index runs, 8,192 assistance history rows, and a subsequent generation job.
Mocked tests cover provider validation, caller departure, unknown charges, deadlines, and interrupted reservations after restart.
The host can create fresh application profiles and derive bounded `definition-json-v1` and `literal-query-v1` inputs.
Separate private semantic rows retain complete interpreted evidence and bind each input to its original event and body hash.
Admission commits semantic rows and compact evaluation rows together. Evaluation and checkpoint restore never load semantic rows.
Recipe inputs preserve literal imported markers and mathematics. They exclude top-level notes, etymology, and import evidence.
The codecs encode unit vectors as little-endian float32.
They reject invalid dimensions, nonfinite values, incorrect byte lengths, and vectors outside the unit norm tolerance.
Only provider output receives normalization.
The Node host stores vectors and exact event, envelope, body, input, and extraction bindings in a separate SQLite database.
Its [operator command](docs/semantic-search.md) prepares eligible definitions in bounded pages and resumes fresh indexing through the shared embedding budget.
Equal inputs share a vector under the same complete profile. Distinct publications retain their own associations.
The job saves each operation link before dispatch. Interrupted sent batches need an explicit linked retry and keep their earlier charges.
Saved claim positions avoid scans of completed inputs. Active batches reserve vector capacity before provider admission.
Over-limit inputs retain their exclusion reasons while the remaining generation can complete.
HTTP 429 responses use bounded backoff that respects `Retry-After` and retains each earlier charge.
The saved profile cooldown survives restart and has a one-hour cap. Operators can clear it without changing batches or charges.
Known usage remains available even when a returned model or vector is invalid.
Mocked tests cover partial progress, restart, failures, retirement, atomic publication, rollback, and explicit removal of current pointers.
The Node host serves meaning searches from compatible published vectors with exact event bindings in the requested snapshot and view.
New definitions remain pending while unchanged definitions stay searchable. Optional background indexing uses the same host budgets without stopping dictionary reads.
Background jobs retry transient failures with bounded backoff and linked retries. They preserve earlier charges and wait for provider cooldowns and budget windows.
Paid or unknown probe failures receive three retries, then a one-hour cooldown. Their counts and deadlines survive server restarts.
Exhausted batches split into individual inputs. Failing inputs wait one hour while healthy inputs and newer snapshots proceed.
Input holds preserve retry counts, prior batch links, and deadlines across restarts and snapshots. Due inputs return without a new snapshot.
An unsettled earlier transport does not restart a completed pass. Other ready inputs and newer snapshots can still proceed.
Oversized requests split before dispatch. Permanent refusals use long cooldowns and log only state changes. Operator CLI recovery remains manual.
Cold coverage yields between bounded metadata pages. Concurrent requests share coverage work, and partial coverage stays cached until index progress changes.
Ordinary generation and public profile reads do not scan parked inputs. Operator diagnostics yield between pages of at most 128 holds.
Generation retirement yields between bounded deletion transactions and resumes interrupted cleanup.
Operators can unpublish and retire an idle background generation, including a suspended profile, without retaining its background pointer.
Each client network can hold at most one scan worker. Empty or absent networks share that same limit.
The API rejects malformed language tags and retains the required coverage fields.
`GET /embedding-profiles` reports coverage and query availability. `POST /search/semantic` returns definition events with cosine distances.
Two worker threads scan bounded vector pages and keep only the requested best results. Lexical reads remain available during inference and scans.
The persistent query cache stores complete profile hashes, exact input hashes, and vectors. Concurrent cache misses share one computation.
Cache hits require no provider request or spending reservation. Each search still filters the selected view and excludes inert definitions.
Public reference probes detect model drift before new query computations. A detected mismatch suspends that profile, including its cached queries.
Cancellation stops the caller's wait. Admitted embedding work still settles and can fill the shared cache without a replacement request.
Offline browser meaning search remains unfinished. An unconfigured host reports meaning search as unavailable.
A discarded result returns a clear status. Spending failures distinguish pending costs, timed limits, and requests that cannot fit.
The default spending share admits every enabled operation at each reasoning effort, with decision reports enabled or disabled.
Each task uses an output cap based on recorded prompt tests. An explicit operator limit replaces the automatic caps.
Every output limit stays at or below 20,480 tokens, including explicit limits and decision reports.
Mocked providers cover the request and correction loop. These tests do not establish live model accuracy.
The [development guide](docs/development.md#optional-ai-assistance) gives the configuration and retention limits.

The status editor, transfer editor, wizard meaning search, and Lensisku cross-posting remain target features.
The site view is the server's selected signed view, and the Trust page can use another retained signed view by its event ID. A signed view names its calculation profile, `simple-routes-bounds-v1` or `simple-routes-shun-v1`; the pages name the profile of each result and its route rule, and an unknown profile leaves scores unavailable.
Site calculation metadata uses the digest of canonical JSON null for its absent overlay. An explicit empty overlay keeps its own digest.
The personal view downloads the snapshot records, verifies each envelope and body in a Web Worker, and ranks words locally with the private overlay.
It adds the current identity with allocation 1 only when its continuity group has no allocation or private root change.
Zero allocations and removals also prevent that addition. It applies private blocks and public shuns as local blocks.
A cancelled or incomplete local calculation keeps personal scores unavailable and offers the site view. "Recompute from records" compares a local site-view calculation with the server scores.
A planned handover creates and tests a successor key, shows the old key's heads from every configured peer, searches for an existing transfer, and saves the transfer, the acceptance, and the encrypted successor key in one transaction before upload. Partial upload reads "Old key retired, acceptance waiting", and retries reuse the stored events.
Canceling an unlock discards its pending key after decryption. Lock, page closure, and identity replacement also invalidate pending unlocks.
Authenticated own history also disables ordinary signing after a backup restore or discovery in another tab.
Malformed lifecycle actions do not disable signing.
A compromise notice previews the retained and excluded records of a chosen causal frontier, blocks on missing history, and needs explicit approval for an empty frontier. Ordinary signing from a retired or compromised key is refused.

Before lifecycle signatures, peer history scans include accepted records that still wait for evaluation.
The browser pins each scan to the peer's accepted snapshot and authenticates its signed lifecycle evidence.
These raw history reads start no evaluation. Final handover, compromise, and recovery scans also load accepted own history.
Ordinary own-history loads on word, person, and trust pages use the last completed snapshot.
If an accepted snapshot expires, the browser starts the scan again, with at most three attempts under the original limits.
Repeated expiry leaves the peer scan incomplete and blocks the signature.
Only a successful scan restores discarded server records. Lifecycle commits compare its stored heads and reject discarded predecessors or later head changes.

The [web UI design](docs/ui-design.md) defines the layouts. The reading, identity, trust, delivery, authoring, and builder screens follow it.
The built Node app keeps Type and trust card labels separate from their descriptions.
Draft placeholders have no extra underline, and helper text does not shift neighboring controls.
Each custom place alternative keeps its hint below the Tags field and shows a separate boundary.

Page completion preserves explicit control focus and the reader's focus choices during loading.
The Edit public profile link focuses Name unless the reader first chooses another control.
Activity completion preserves the editor or reader focus.

One shared rule gives links and interactive controls a target of at least 44 by 44 CSS pixels.
It covers buttons, fields, disclosure summaries, focusable regions, editable regions, and the app's ARIA actions.
Source code marks complete prose sentences and structured place markers with the reason for their inline exception.
Compact checkbox and radio glyphs use their enclosing labels as targets. The audit requires one label for each such input.
Native inputs with external labels keep their own full target.

A static test reads all web source files and rejects unapproved target overrides and prose markers without reasons.
It accepts direct DOM helpers and literal styles.
It rejects opaque style changes, hidden interactive classes, and aliases of the prose helper.
Its failing fixtures cover CSS and inline overrides, raw markup, hidden prose, and inputs without labels.
It rejects table rows and cells as target display types, and direct style assignments.

The rich text renderer marks a paragraph only when each link has visible words in its own complete sentence.
The sentence test keeps `e.g.` and `cf.` inside their sentences and rejects links after a separate sentence.
Other rich text links keep the default target.
Place circles keep equal dimensions of 1.45em beside word links. Numeric badges can be wider.
The audit measures linked and unlinked place markers in body text and 21px definition prose.

Browser tests measure controls at 1280 and 360 CSS pixels, including new controls without a target class.
They cover populated builders, key states, delivery records, expanded place fields, compound words, rafsi claims, record comparisons, public profiles, and key handovers.
They measure retired-key reporting, trust without a key, delivered outbox links, and the untested-backup action on Publish.
They check sentences in the first-signature dialog, identity continuity, and Publish root, component, and competing claim notices.

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
The guide also covers browser development and container tests.
No command in this setup deploys a service.

## Evidence and limits

The [ranking measurements](crates/jvc-rank/README.md) cover eleven synthetic scenarios in native Rust and WebAssembly.
The weighted sixteen-actor case takes 8.119 seconds in WebAssembly despite zero completed expansion work.
The expansion budget does not bound total CPU time. These measurements do not establish performance for real community graphs.

The current default state work budget can run out at roughly 4,500 events in a flat history.
This is an approximate limit. Histories with more edges can reach it sooner, and the requested state also affects the work.
The Node loader can retain a larger explicit traversal budget for a local import.

The Node adapter serves the revised SQL import with 59,125 definitions in 44 languages.
The extraction omits derived vectors and cache fields from signed bodies.

HTTP admission rejects body values other than objects or null before it stores a record.
Schema-invalid objects remain available as signed content, and null keeps its missing-body meaning.

The server stores private compact records in the same transaction as admission, including offline loads and late bodies.
Cold evaluation, view changes, core upgrades, and checkpoint fallback reuse those records without another signature check or body hash.
A versioned backfill parses existing private data once. The browser still verifies original records independently.
The first write after restart reconstructs retained envelopes from private event fields without reading their original objects.
A versioned golden fixture guards extraction changes. Undecodable derived rows emit diagnostics and trigger parse-only repair.
The SQL loader stages changed projections in bounded batches and commits them with accepted events.

The [development guide](docs/development.md#initial-lensisku-data) explains the trust assumption and the offline backfill command.

The evaluated checkpoint contains results and search packages. Its record inputs come from the separate compact store on restore.
The adapter uses separate Node worker threads for completed reads and new evaluation.
A worker thread runs code independently within the same process. At most two evaluation runtimes remain live.
After publication, the host releases the older runtime when its active calls finish.

It keeps that snapshot's completed state and packages in the bounded cache.
Pinned reads use those results without restarting evaluation. Word scores remain unavailable after the older runtime stops.
The next evaluation can evict the older cached result when it needs the slot.
A failed unpublished package job releases its configured-view protection while active calls keep their cache entries.
An alternate view can then use that slot after those calls finish. The completed snapshot keeps its protection.
Recomputing an older retained snapshot does not give it newer protection than the completed snapshot.
This also applies after a late body changes the snapshot without advancing the event position.
The cache uses the saved coordinator revision, including after restart, with snapshot ID as a fixed tie breaker.
Pinned reads load this revision before any unpinned current read.
Node also retains this order when newer accepted records wait behind a completed checkpoint.

Evaluation threads transfer state bytes without retaining another parsed JavaScript state. Judgment updates share unchanged result objects on the main thread.

The adapter normally captures at most one checkpoint per minute. A failed live export can retry once immediately.
Shutdown closes idle connections and grants up to ten seconds for evaluation.
It saves the latest completed checkpoint before stopping its worker, without waiting for the capture interval.
Durable handlers and file operations can extend shutdown beyond that limit.

A faulted worker leaves completed results available on the main thread.
Word responses can report unavailable scores while a replacement restores in the background.

After publication, the browser shows a pending notice until the accepted records reach the evaluated word view.
After a profile publication, the profile page waits for that evaluated view before it requests the new claim.
Personal recomputation also waits for locally accepted records before it downloads the next snapshot.
These waits stop after fifteen seconds and preserve accepted delivery evidence for another refresh.
A full-dictionary evaluation can outlast that wait. A refresh reuses the accepted record without another signature.

The server, worker, and Wasm artifacts at `fedfec3` match the earlier measurement at `b6c0354`.
That run restored its checkpoint in 22.68 seconds. A later restart took 29.33 seconds.
The repaired host measurement uses `5aefd15`, with 59,125 imported definitions in 44 languages.
Its checkpoint restart took 7.07 seconds. Recovery after the core digest changed took 70.72 seconds.

| Visible write      | Reviewed host, `b6c0354` | Repaired host, `5aefd15` |
| ------------------ | -----------------------: | -----------------------: |
| Trust choice       |                  30.37 s |                   8.38 s |
| Native publication |                  46.71 s |                   9.53 s |
| Judgment           |                  35.51 s |                   5.39 s |

The reviewed host peaked at 4.25 GiB. Three of 91 sampled word reads reached their three-second deadline.
Twelve health probes reached their one-second deadline.

The repaired host peaked at 3.94 GiB. All 96 sampled dictionary reads completed within three seconds.
Between its first write and final visible result, 89 of 90 health probes succeeded. One reached its one-second deadline.

These runs differ in inventory and concurrent work. They do not isolate the effect of one fix.
Admission, package construction, and enclosing checkpoint serialization still use the main thread.
Dense ancestry and overlapping runtimes still require several GiB. These measurements do not establish a latency guarantee.

After a crash, the adapter can restore an older valid checkpoint and evaluate the later records.
If the checkpoint predates the stored materialized snapshot, interpreted reads wait for catch-up.
Recovery does not expose that older checkpoint as the current public snapshot.
The [development guide](docs/development.md#initial-lensisku-data) describes state reuse, checkpoint costs, and the measurement limits.
A larger traversal budget does not remove memory limits.

[Issue 9](https://github.com/int19h/jbovlacku/issues/9) tracks ranking CPU limits.
[Issue 11](https://github.com/int19h/jbovlacku/issues/11) tracks state evaluation beyond the local corpus.
[Issue 10](https://github.com/int19h/jbovlacku/issues/10) tracks URL serialization and invisible headword characters.
The browser tests wait for the shared core before they prepare signed fixtures.
Controlled tests keep delivery acceptance, word-view readiness, and AI control readiness separate.
Saved-draft return tests wait for the restore transaction and retain the original prose through reload.
Revision comparison tests wait for the rendered word page and initialized core, including delayed startup.
The calculator race tests use their own browser database.
The development guide lists local tests. Their scope does not establish full specification conformance or public deployment readiness.

## Documentation

The documentation defines the product, its records, and the development process:

- [Format specification](docs/format.md): Target signed records, causal state, identities, imports, and ranking.
- [Frontend specification](docs/frontend.md): Target browser behavior, server contracts, authoring, and optional inference.
- [Web UI design](docs/ui-design.md): Target screens, visual rules, and publication flow.
- [AI prompts](prompts/README.md): Public prompts, answer rules, and the correction loop for the optional AI actions.
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
