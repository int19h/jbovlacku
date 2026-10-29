# Jbovlacku web frontend

This specification defines target behavior for the web app and both server adapters.
The [README](../README.md) describes the implemented scope.
The [repository specification](format.md) defines signed events, structured content, identity continuity, and ranking.
Its field names and authority rules take precedence over illustrative interface copy here.
The [UI design](ui-design.md) defines the visual system and twelve screen layouts.
These documents define target behavior, not completed frontend implementation.

## 1. Product boundary

The app supports dictionary lookup, submissions, revisions, rafsi claims, and editorial trust.
A reader can search and browse without an identity. Public actions require a key controlled by that contributor.
The app never asks a server to hold or generate the contributor's private signing key.
It provides no phrasebooks, collections, wiki pages, or mailing-list archives.

The first release must make ordinary lookup and a short definition easy.
Structured places are available during creation, but unknown types and defaults never block a literal definition.
Public trust is visible and inspectable. It does not become a required account-creation ceremony.

## 2. Shared application and hosting design

The browser contains the interface, signer, local drafts, local search, and shared format core.
The project ships two server adapters: a standalone server and a Cloudflare Workers service. Both expose the same dictionary API.
Neither the dictionary format nor the standalone server requires a Cloudflare account.

The application uses a Rust core with native and WebAssembly builds, plus a shared TypeScript HTTP service layer.
The Rust core contains canonical records, signatures, causal state, and ranking.
A shared TypeScript package provides word recognition and deterministic word builders.
The browser and Workers consume its WebAssembly build. The CLI can use the native build.
Thin host adapters supply storage, transaction coordination, queues, secrets, clocks, and outbound HTTP.
The implementer must establish dependency licenses and runtime compatibility before reusing jbotci code.

Behavioral compatibility does not grant permission to copy a dependency. Preserve the license of every reused component.

The standalone adapter runs on a supported Node.js release and ships as a Docker image, plus a direct installation package.
It serves the web assets and API, stores immutable content on a persistent volume, and uses local SQLite for indexes and receipts.
The operator supplies a data directory, listen address, public origin, peers, selected view, and optional inference configuration.
A single-instance deployment needs no Redis, object-storage service, or cloud database.
An optional S3-compatible adapter can replace local object files. It is not required for basic operation.

The SQLite coordinator owns receipt order and snapshot-pointer updates. Its database and files use the same persistent deployment volume.
A backup captures immutable objects, the receipt journal, configuration, and a consistent SQLite snapshot. Search indexes remain rebuildable.
Shutdown stops admission, completes or rolls back local transactions, and checkpoints pending jobs for restart.
Health endpoints distinguish process liveness from readiness after migrations and state recovery.

The Cloudflare adapter uses Workers Static Assets, R2 content storage, and D1 rebuildable indexes.
A Durable Object with SQLite storage coordinates admission receipts and the current snapshot pointer.
Neither adapter holds contributor signing keys. An operator key can sign service statements and derived-artifact manifests.
R2 or local storage can deduplicate bodies independently of the Git carrier's inline representation.

Envelope objects use representation hashes. Each snapshot maps event IDs to the exact envelope variants committed by its manifest.

Both adapters use the same admission, snapshot-building, import, peer-sync, and inference job logic.
The job store persists inputs, checkpoints, cancellation requests, and outcomes. Retries reuse immutable input IDs.
A builder writes all new immutable objects before it advances the snapshot pointer.
Failed builds leave the preceding complete snapshot current. Search and word responses never mix snapshot versions silently.

Indexes can lag accepted writes. The API exposes accepted and materialized cursors separately.
Durable receipt journals survive an index rebuild. Local arrival order never becomes dictionary chronology.

Peer lists remain operator choices. Scheduled jobs exchange canonical records and selected optional derived artifacts.
Native Git publication is an optional mirror job. Standard Workers cannot run a native Git process.
The standalone host can run that mirror locally. Workers can send its canonical snapshot to a separate mirror process.

A mirror that shares its source storage is not an independent replica.

Static hosting supports reading, local signing, drafts, and deterministic word builders.
Persistent shared submissions require a writable peer or file export. The app remains usable with AI and semantic search disabled.
Long calculations use bounded jobs and explicit resource errors. Moving a job to another adapter never changes the signed format.

### Host service contracts

| Port                  | Required behavior                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| Object storage        | Read by hash, retain immutable bytes, and report missing or locally withheld objects separately. |
| Admission coordinator | Deduplicate event IDs and commit receipts atomically before acknowledging storage.               |
| Snapshot pointer      | Publish one complete snapshot through a compare-and-swap transaction.                            |
| Index storage         | Rebuild from retained records and identify the snapshot indexed.                                 |
| Job storage           | Persist work and retries without repeating an already acknowledged external write.               |
| Vector index          | Search one named embedding profile and expose its coverage.                                      |
| Provider adapter      | Make bounded inference requests with server-held provider credentials.                           |

The standalone vector backend can scan retained vectors exactly or use a bundled local index.
Workers can use Vectorize or another configured backend. Backend indexes are disposable, host-specific accelerators.
The portable vector artifacts remain available independently of that backend. A cloud index is never the only retained vector copy.
The release tests exchange snapshots and vector artifacts between both adapters and compare their logical results.

## 3. Interface structure and appearance

The search column has a maximum width of 40rem. Word pages use 44rem, and the wizard uses 64rem.
The header and footer use a centered 64rem container.
A comparison can use the wider wizard container when its content needs it.
A desktop comparison can use two columns. A narrow screen stacks those columns without horizontal page scrolling.
At 360 CSS pixels, ordinary controls and prose must fit the viewport.

Use Noto Sans for all ordinary controls, metadata, and definition prose. Do not use Noto Serif for definitions.
The reference font stack is Noto Sans, STIX Two Math, Crisa, Verdana, sans-serif.
Dedicated mathematical symbols put STIX Two Math first. This prevents a prose font from taking precedence over mathematical glyphs.

Zbalermorna text puts Crisa first, followed by Noto Sans and the math fallback. Ordinary interface text keeps Noto Sans first.
An orthography preference changes rendering, not signed word spellings. Preserve accessible Latin text and an explicit copy-format choice.
Self-host the required font files, script subsets, and symbol glyphs. Include each font's license with its files.
The gismu generator includes Noto Sans Devanagari, Noto Sans Arabic, and Noto Sans SC for native source words.
Do not fetch fonts from a third party during ordinary page use.

Use 16px body text, 1.5 line spacing, and a restrained size scale.
Use neutral surfaces, thin separators, and one accent color. Support light and dark themes from the system preference.
Do not rely on color to distinguish support, opposition, withdrawal, or conflicts.

Search stays prominent. Metadata remains secondary. Notes, source details, and history use named disclosure buttons.
Advanced fields appear on demand. They remain reachable by keyboard and visible in the full publication preview.
No modal dialog is required for ordinary reading, expanding notes, or switching definition language.

Every page includes the wordmark, labeled search field, “Add a word,” delivery marker when needed, and local identity link.
With an existing key, the identity link shows the lock state with an accessible label.
Without a key, it reads “Your key” and opens `/identity` for creation or import. Navigation alone never generates a key.
The delivery marker counts distinct waiting and stopped records listed on Not delivered, never attempts or network requests.
Waiting records include offline failure, refusal, and unknown delivery. Stopped records stay in the list and count.
Ordinary transient sends and accepted index lag remain excluded.
One record with unfinished delivery at several peers counts once. Its per-peer outcomes remain separately visible.
The footer links to the active trust view, Settings, About, and Source. Settings opens `/preferences`.
The search page starts with results for the current query, without an introduction.
There is no general activity feed, chat, discussion control, or icon-only navigation.
Short explanations appear where the user takes the relevant action. Critical state, conflicts, and errors remain visible.

The app provides these addressable routes:

| Route                       | Surface                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `/search?q=...&lang=en`     | Search results and filters.                                                                                                                |
| `/word/<word-id>?lang=en`   | All definitions and rafsi claims for a word.                                                                                               |
| `/definition/<event-id>`    | One immutable definition revision.                                                                                                         |
| `/rafsi/<encoded-spelling>` | Assignments and conflicts for a rafsi.                                                                                                     |
| `/identity/<encoded-key>`   | Public identity claims and activity.                                                                                                       |
| `/new`                      | New definition editor.                                                                                                                     |
| `/review`                   | Optional review queue.                                                                                                                     |
| `/trust`                    | Public decisions and private view controls.                                                                                                |
| `/identity`                 | Local key, backup, transfer, and loss controls.                                                                                            |
| `/outbox`                   | “Not delivered,” with waiting and stopped records. The header marker counts both. A direct visit shows an empty state when neither exists. |
| `/preferences`              | Settings, in groups: Languages, Assistance, Search, Appearance, Servers, and Your data.                                                    |

Every route preserves browser back and forward behavior. Query changes use replace-state while typing, then a stable navigation state when selected.
Links to a publication always retain its exact event ID. A default word link does not pretend to pin a particular revision.

## 4. Search and reading

The header provides search on every page. The initial page shows the current results and a quiet definition-language selector above them.
The initial definition language is English. The active view link appears in the footer.
The interface language and definition language are separate preferences.
A user can read English definitions through a Russian interface, for example.
Search begins without identity generation, cookie consent for optional tracking, or a key prompt.
The baseline includes no third-party analytics.

The browser downloads a compact search package for the selected language from a stated snapshot.
It performs ordinary headword, gloss, and text searches locally after that download.
A remote search mode remains available for large languages or limited devices. Settings contains the local or remote mode choice.
Before its first remote query, the app states that queries reach the named server.
A change of mode does not silently upload previously local query history.

Search normalization affects lookup only. It never rewrites signed spellings or definition text.
Use NFC, case folding, and explicit apostrophe aliases in search indexes.
Case differences do not change match classes or their order.
Headword matching ignores acute cmevla stress marks. Accented and plain queries find the same word identity.
Each result keeps the display spelling of its selected definition. Alternative definitions can retain different stress marks.
A normalized exact headword match uses the same class as its display spelling.
Rank result classes in this order: exact headword, exact gloss, exact component sequence, contiguous sequence, headword prefix, gloss prefix, ordered subsequence, then token matches.
Ordinary text queries keep their existing lexical class order.

Both local and server search split the query with the TypeScript text segmenter in `packages/morphology`.
Each search index derives a component array for every headword that parses entirely as two or more cmavo.
For example, `iseri'abo` has components `[i, se, ri'a, bo]`.
The queries `i seri'a bo`, `ise ri'abo`, and `iseri'abo` find that exact sequence.
A contiguous match contains every headword component in one uninterrupted run of a longer query.
For example, `mi klama i seri'a bo` finds `iseri'abo`.
An ordered subsequence keeps the query components in order within a longer compound, with gaps allowed.
For example, `i bo` and `se ri'a` find `iseri'abo`. Reversed or missing repeated components do not match.
A shorter query inside a compound uses this class even when its components are adjacent.
Ordinary prefix families precede compounds that contain a one-word query such as `se`.
A complete component relation keeps the subsequence class even when the compound starts with the query.
For example, `se'a` and `selbri` precede `sefa'e` for `se`. A literal headword prefix never promotes that compound.
A partial query without a full component relation still uses ordinary prefix matching, including `sef` for `sefa'e`.
A foreign or invalid run breaks a contiguous match. It never joins recognized words across that run.
Only a complete query of cmavo can supply the shorter sequence or an ordered subsequence.

Search returns exact headword cards for recognized query words outside matched exact or contiguous compound spans.
For example, with `ije` present, `ijebo` shows `ije` and a card for `bo`.
The query `ijebo klama` also keeps `klama`. The query `le nu klama` keeps `klama` after `lenu`.
If no compound joins, `ijebo` shows `i`, `je`, and `bo`, and `taia` shows `tai` and `a`.
Subsequence matches never suppress individual word cards.
This fallback includes a single recognized word beside a foreign run, brivla, and names.
It keeps query order and groups repeated word identities into one card, including repeated words outside a covered span.
It keeps alternative matching definitions and never creates a definition for an absent headword.
A complete single-word query uses the segmenter's canonical reading as an exact headword alias.
Thus `klama.`, `(klama)`, `.i`, `1`, and `riha` find `klama`, `klama`, `i`, `pa`, and `ri'a` respectively.
Ordinary whole-query matches precede fallback cards. Canonical aliases apply only to exact matches.
Prefix lookup uses the typed spelling after normal case, stress, and apostrophe normalization. It can ignore pause and comma characters, but never rewrites digits or `h`.
Both modes use the same matcher. Server eligibility, language, and retirement filters apply before query-span coverage.
Local packages retain their stated status limits.

The shared search box can read short English phrases as Lojban cmavo.
For example, `to go` can also return cards for `to` and `go`, and `so no` can find `sono`.
An exact headword or gloss for the whole query always precedes those sequence hits.

The component index exists only in memory. Package entries and persistent server index rows keep their existing formats.
The shared matcher rejects impossible cmavo shapes before parsing. It retains at most 4,096 parsed normalized spellings in a process-local LRU cache.
An LRU cache removes the least recently used item when it reaches its limit.

Each immutable server package array also retains its prepared entry index through a weak reference.
A changed definition snapshot uses new entries and rebuilds its text and component index during package materialization.
Package construction and rebasing complete that index before publication. Checkpoint restore prepares recovered entries before readiness.

The first search of a completed package does no headword parsing. Preparation still consumes CPU once during materialization.
Inline or historical reads that must construct a package still include that work. Completed-package timings do not promise total HTTP latency. Unchanged spellings reuse the bounded morphology cache.
The server's existing package and evaluation lifetimes bound those prepared indexes.

Browser storage version 4 records a revision marker beside each language package in the same transaction as its write or deletion.
Every package read checks that marker, including reads from another connection or tab.
Each connection retains at most two package objects. A changed revision invalidates that connection's retained data, even when the snapshot ID stays equal.
A failed download leaves the saved package and revision unchanged.

One static module worker validates and searches saved packages outside the main thread.
Download hashing and entry checks retain their existing download path.
It retains two prepared packages, keyed by database name, language, and durable revision. Separate connections can reuse the same prepared revision.
Page reload closes that worker and its caches. The first search after reload reads, transfers, validates, and prepares the saved package again.

Nearby lookup in the meaning step and part lookup in the lujvo builder use the same worker and prepared index.
Each nearby call reads the package for its current language, including an empty meaning. A missing package never disables later local lookups.
Changes to the meaning or language invalidate pending results and errors before the next debounced lookup starts.
The worker ranks all nearby query lists before selecting six rows.

Ordinary local search transfers 20 rows initially. Show all requests only the remaining rows within the browser's 1,000-word limit.
Replies include total counts and entry references into the exact package captured by that request. They never copy full definition records back to the page.
These references preserve matching alternatives, definition order, selected previews, and display spellings.

An empty search page validates its saved package before displaying its snapshot.
If queued cache churn removes a worker package, the client retries once with its captured package. Rejected packages keep their validation error.
Worker startup or execution failure reports an error without sending a local query to a server.
An invalid saved package retains the earlier disclosed remote fallback.

Part lookup failures keep “Add as entered” available for recognized forms.
The interface marks the dictionary lookup as unavailable.

A query permits 16,384 UTF-8 bytes, 512 recognized words, and 300,000 parser steps.
Each query run permits 128 normalized phonemes. The headword index permits 256 bytes and 256 phonemes, with 300,000 parser steps per headword.
These bounds support full-size dictionary headwords without raising the ordinary text segmenter's default run limit.
If query segmentation reaches a limit, search uses ordinary text matching without partial component results.
If a headword reaches its indexing limit, ordinary matching remains available and sequence coverage is incomplete.

The response and interface expose either limit through `segmentation: "limited"`.
The interface preserves that notice through pagination and browser Back.

Sequence matching never enumerates query subsets.
For E entries, Q query tokens, and H maximum headword components, its comparison cost is O(E × (Q + H)).
Tokens include foreign barriers. Consecutive barriers count once, so Q is at most 1,025 under the word limit.
H is at most 256 under the headword byte limit. Linear prefix tables find contiguous matches, and one forward pass finds ordered subsequences.
Index construction has at most 300,000 parser steps per candidate headword. Warm searches reuse the prepared package index.
Fresh server snapshot objects can reuse only the bounded spelling cache, while unchanged package objects reuse the full index.
The [sequence measurement script](../scripts/measure-segmented-search.ts) reports linear comparison counts with 100 query words.
The [package measurement script](../scripts/measure-package-search.ts) measures server lexical search after materialization, including filtering and grouping.
The optional [browser measurement](../apps/web/test/search-measure.test.ts) measures actual search and nearby routes with stored packages and main-thread CPU counters.

Within a class, use lexical relevance and stable word-ID order. Search ordering does not consume editorial scores.
The word page uses the format's definition layers and attributed score calculations. Show alternative definitions instead of collapsing them into one word-level score.
Typo suggestions and rafsi decomposition are labeled suggestions, not silent spelling corrections.

Each result uses a dense row with three content lines and a thin separator.
The first line contains the linked headword, italic rafsi, type, and selma'o when applicable.
The second line contains definition prose, place markers, and highlighted matches.
The third line contains linked author attribution, a known date, and the judgment arrows with net score.
Signed headers contain no creation timestamp. Source dates require provenance.
A receipt date reads “Seen …” and identifies the receiving server in its details.
It never implies the original creation date. Unknown dates remain omitted.
Identity activity can use receipt chronology for navigation, never causal conflict resolution.
A text link labeled “notes” opens existing notes. An “also:” link exposes another matching definition of the same word.
Language filters never erase the existence of alternatives. Search classes have no visible group headings.

The list offers “show all” with the remaining count, “Missing a word for this? Add it,” and a retired-results filter.
One click reveals all remaining local hits or fetches remote pages in sequence, up to the browser limit of 1,000 hits.
Only one expansion runs at once. Navigation cancels it, and repeated cursors or results stop it.
A rafsi lookup identifies the related word, for example “cku ← cukta,” and exposes competing assignments when present.
Rafsi lookup does not silently pick an unresolved assignment.
A single unreviewed definition remains visible. A lack of endorsements is not a negative judgment.
A rejected or deprecated result remains available through an explicit filter and its permanent publication link.

A word page groups definitions by language. Each publication retains its own frame and attribution.
Ranking selects a presentation layer, not one universal meaning. The UI does not call a lower-ranked sense false because another sense exists.
The full definition block shows notes, etymology, glosses, places, examples, sources, parent revisions, and history.
Language tabs show counts. Each block includes a permanent revision link, reviewer disclosure, place strip, and “Revise” action.
A proposed revision includes a notice and “Compare.” A place strip without descriptions offers “Add descriptions.”
After the definitions, offer “Add a definition,” “Add a translation,” and related word links.
Source disclosures retain original text, Lensisku attribution, numeric account evidence when known, and the importer signer.
No “official” badge appears. Organizations use ordinary identities and endorsements.
The intended baseline curator uses an ordinary key and actual signed endorsements of baseline publications.
Its inclusion in the initial site view requires an approved roster, allocation, and identity name.
A placeholder such as “LLG” never establishes authorship, endorsements, or an approved trust root.
An importer never signs an endorsement as that curator or changes original source-author attribution.

The client renders all imported text as inert content. It never evaluates HTML, remote scripts, or executable TeX.

Circled place markers link to their place rows, under the inline target rules in section 13.
Screen readers hear “place 1” rather than an unexplained symbol.
For indices above 20, render an outlined numeric badge. Its accessible name uses the same rule.
A marker's numeric identity comes from the token, not its glyph or position in the sentence.

Literal circled characters remain literal text. A reader can inspect the structured representation when needed.

## 5. Add a definition

The app offers a guided wizard and an advanced editor over the same local draft.
The wizard exposes ordinary language and previews. The advanced editor exposes structured fields, without requiring raw JSON editing.
Switching modes preserves every field. It never flattens structured values into prose or discards an unsupported annotation.
An optional JSON inspector remains read-only until the user deliberately enters a raw-edit mode.

The editor uses the [definition field defaults](format.md#absent-fields-and-compatibility) when it opens a publication or restores a draft.
An omitted optional field produces its defined empty or unspecified value. The app never fills it from another definition or a parent revision.
The raw inspector and source export preserve the authenticated body, including its original field presence.
Before signing, the writer omits optional fields whose interpreted values equal their defaults unless explicit evidence rules require them.
Receipt retries resend the exact stored record. They never add or remove fields from an already signed body.

A reader can draft before generating an identity. Only publication requires the signing key.
The step bar reads Meaning, Type, Form, Places, Publish.
“Skip to the full editor” opens step 4 with every field section open.
That editor also permits manual headword and type entry. Skipping a builder never skips publication validation.
Each step saves the draft in this browser and exposes its save state.

### Step 1: meaning and nearby definitions

The first step asks for a freeform definition and its language. A headword is optional at this point.
The optional “Lojban word” field keeps a spelling that the author already chose.
The app normalizes the spelling to NFC and uses the format's plain spelling for word identity.
It analyses that plain form locally with `analyzeWord`. Analysis lowercases input, while the draft keeps the entered display spelling.
Acute stress marks are permitted only on cmevla, including name components of a `zei` lujvo.
An acute on a recognized nonname or a misplaced acute blocks signing, including an experimental classification.
An unknown spelling with a valid name mark follows the ordinary experimental classification rules.
An accented spelling requires the `cmevla` classification, or `lujvo` under the format's [bounded `zei` rule](format.md#definition-payload).
The app compares its `wordId` with the local language package. Remote lookup requires explicit consent for that word and language.
An existing word shows “Already exists”, its linked word page, its definitions, and “Add a definition”.
The author can continue with another definition of that word. An unavailable check says that the word could not be checked.
A local package only establishes presence or absence in its named language and snapshot.

The author can use `___` for argument placeholders, but ordinary prose also works.
Underscores are an editor convention. The draft retains their spans without assigning final place numbers automatically.
The app preserves this original meaning draft separately from the current editable definition.
Each `;` restarts placeholder numbering at 1. The place count is the highest number used in any part.
Unescaped circled numerals `①` through `⑳` and `{place N}` name explicit place numbers.
Within each part, blanks take the free numbers in order, including when explicit numbers appear after the blanks.
Only a backslash before a circled numeral is an escape in Meaning. It keeps that numeral literal.
Every other backslash stays as typed, including doubled backslashes and backslashes before brackets, braces, or backticks.
A backslash before `{place N}` stays literal and does not escape that place reference.
The “N placeholders found” message reports places, rather than placeholder occurrences.
Before approval on the Places step, the author sees each part and the places that it uses.

The nearby-definition panel uses its local lexical package by default. It does not inherit remote upload from the ordinary search setting.
If the package is missing, offer a download or continue manually. No private draft uploads passively.
An explicit remote lexical request requires disclosure and consent for the text sent.
A “by meaning” choice enables the selected semantic-search profile after consent.
The panel shows exact words, definitions, and languages beside each result.
Its best match offers “Add a definition” and “Revise this one.” Other matches offer “Use this word.”
Similarity is a suggestion, not proof that the meaning already exists. The author can choose an existing word or continue with a new word.
Choosing an existing word offers adding a sense or revising a particular definition. It never silently overwrites that definition.

The primary button reads “New word” and remains available even when similar entries exist.

A remote semantic query sends draft text outside the browser. Before the first request, disclose the selected server and embedding provider.
The author can use lexical search instead. An unavailable semantic service never blocks the wizard.
The app does not automatically transmit old local drafts after the operator enables a new provider.
Remote draft searches use POST bodies, not draft text embedded in navigable URLs.

### Step 2: word type

Ask which word type the author wants. Explain all eight types: gismu, lujvo, cmavo, fu'ivla, cmevla, compound cmavo, letteral, and other.
Other covers a fixed phrase or another form. The Other card exposes compound cmavo and letteral as separate choices.
“Recommend a type” is an optional AI action. Its result includes a short explanation and does not select the type without acceptance.
The explanation uses the language of the meaning. A meaning in Lojban gets an English explanation.
A second possible type has its own reason after “Also possible: TYPE.” Acceptance applies only the main type.
When the meaning gives too little information, the suggestion asks one question and offers Try again without Use this.
That question keeps the selected card and every formation field.

The server finds related public definitions inside the type job from the original meaning, independently of Step 1 searches.
The lexical fallback uses up to six distinct query words. It removes whole-token place marks and punctuation at token ends and keeps inner apostrophes.
It ranks words by matching query count, then summed search positions, then stable word ID.
Each query scans the dictionary once with the same match tiers and order as ordinary lexical search.
Up to three current definitions of the trimmed, NFC-normalized typed spelling come first.
They follow ordinary editorial layers when available. Within one layer, exact gloss matches count three, gloss prefixes two, and definition-text matches one.
The sum over query words decides relevance. Equal relevance uses stable event ID order.
These exact senses keep separate records. Later lexical hits omit their spellings and every other duplicate spelling.
The list excludes selected context events and holds at most 30 records in total.
Each entry supplies its type and definition text without notes. A definition above 500 Unicode code points is cut and marked as truncated.
The inference log records the snapshot and exact events in list order.
It records lexical retrieval with its query words, semantic retrieval with its profile ID, or none when no search runs.
The service sends its own spelling analysis when a spelling is present and records the morphology version in the log.
The type prompt retains its approved `fuivla` identifier. The service translates between it and the app's `fuhivla` identifier at the type boundary.

An existing-word block links to the word and offers Add a definition when the current definition fits.
An improved definition appears with Revise this one. This action creates a local revision with the exact publication as its parent.
The editor shows the same notice as ordinary Revise about changes to CC0, imported legacy content, and native origin.
The improved text starts as a separate suggestion. Use this applies it with persistent Undo.
For a conversion, such as `te vecnu`, the block offers Use te vecnu instead of Add a definition.
That action opens the existing word page and shows the converted form. It creates no draft or publication.
A conversion with an improved definition also offers Revise this one for the existing word in its own place order.
Adding or revising saves the previous draft separately and offers Return to the saved draft.
Add a definition copies every current field and uses the Step 1 spelling-change action. It preserves notes, places, glosses, sources, and evidence for review.
An independent private `saved-index` row holds saved-draft links through every wizard route and reload.
Current drafts hold a display copy only. Publication, replacement, discard, and ordinary revisions preserve the independent index in their transaction.
Without a current draft, Meaning shows the saved links and an explicit Start a new definition action.
Resuming in that state consumes the saved row without creating a blank archive. It requires that no other tab started a current draft.
The first index read migrates earlier `saved:` rows, including orphaned rows with no current draft or backlink.
Export drafts excludes the tagged index metadata and preserves earlier draft export formats.
Returning also saves the draft that it leaves and consumes the restored saved row in one transaction.
Other saved drafts remain linked. A failed or conflicting switch leaves every stored draft unchanged.
No existing-word action publishes content.
Use this for the proposed type remains available so that the author can continue with a new word.
After type acceptance and reload, the existing-word block and its actions remain available beside Undo.
A typed spelling preselects its detected type. The author confirms it with one action or selects another type.
Word form alone cannot distinguish cmavo, compound cmavo, letterals, and experimental classifications.
Unknown analysis shows its diagnostics and permits an experimental type.

With a typed gismu or fu'ivla, type confirmation opens Places.
A typed gismu shows nonblocking identical, final-vowel, and similar-consonant warnings beside confirmation, with links to every known conflicting word.
Publish repeats that conflict review. Missing inventory coverage remains visible.
An optional link opens the gismu builder for source-language evidence without replacing an equivalent typed spelling.
Scoring uses the normalized form. The headword and its evidence binding keep the exact typed bytes.
A different normalized candidate requires replacement confirmation.
A typed lujvo opens the component builder. Cmavo, compound cmavo, letterals, cmevla, and other kinds open Form with the spelling filled in.
The author can also enter an existing or custom spelling and continue manually.
Changing the spelling updates detection and marks incompatible retained evidence for review.
It preserves the type the author chose. An unconfirmed automatic type follows the new detection after the usual evidence-loss confirmation.
Cancellation keeps the previous type and evidence, and marks the type for review.
Selecting or confirming a type clears the type-review notice.
Forward step links, the full-editor link, and direct Form or builder entry confirm the selected type too.

A changed or cleared spelling exits the previous typed-lujvo mode.
A replacement lujvo starts a fresh analysis, even when the author restores an earlier spelling before reopening the builder.
Fresh analysis uses the morphology profile from matching signed or restored evidence.
A private ordinary profile choice does not change that typed profile.

That analysis preserves author-linked sources, exact definitions, and claims for compatible rafsi.
Matching compound evidence supplies missing sources before dictionary suggestions do.
The [headword state model](typed-headword-state.md) defines the private fields, events, and invariants.

Changing type preserves the prose and annotations. The app identifies formation fields that no longer apply and asks before removing them.

### Step 3A: lujvo builder

The builder contains ordered component rows, a candidate spelling, the current definition, and the preserved original meaning.
For a typed lujvo, analysis supplies one component sequence.
When a rafsi has several known source assignments, the author chooses its intended source word.
A missing source stays blank. The author must link every source to save compound metadata.
“Continue without compound metadata” preserves the spelling and saves no compound attribution.

Every rafsi locks to its exact typed form, including full forms. Every boundary locks to its exact typed join, including optional hyphens.
The only candidate is the typed spelling. The builder links source words and exact definitions without changing that spelling.
Fixed typed layout requires an exact construction under the selected evidence profile.
If a historical profile cannot construct that spelling, ordinary profile controls remain available.

The fallback shows the current word's analyzed parts. Missing sources permit another analysis after a local package becomes available.
Repeated unresolved analysis preserves an ordinary profile that the author already chose.

A spelling accepted from the ordinary builder keeps editable component rows when the builder reopens.
An explicit private marker identifies rows that typed analysis created. Rafsi locks and Meaning edits never create that marker.

Saved rows without this origin marker stay editable, including after removal of compound evidence.
They retain the signed morphology version, source boundaries, and matching joins.
On first restoration without compound metadata, saved joins require matching spelling, locked parts, and complete analyzed boundaries.
After restoration, joins and the exact spelling belong to their original rows, rafsi, and morphology profile.
A spelling edit or removal of metadata keeps that association.
A corrected headword can therefore recover its exact candidate, including case, commas, framing periods, and optional joins.

Changing those rows, their order, their rafsi, or their morphology profile returns restored construction to automatic choices.
That release persists through later builder visits and reloads.
It remains released if the author restores an earlier lock or replaces rows with identical rafsi.
If every row is removed from a published revision, the next builder visit starts a complete restoration from matching signed evidence.
That restoration recovers sources, locks, profile, and exact joins together. It clears the former release and ordinary profile choice.
Partial rows do not start that restoration. A spelling mismatch defers it until the signed spelling returns.
The builder asks before an accepted candidate replaces a different entered headword.

Accepted AI component suggestions create ordinary editable rows without inherited typed or restored construction.
A suggested lujvo spelling uses ordinary selection semantics.
Component-only suggestions keep the current headword's typed identity. A later Use still asks before replacing that headword.
Undo restores the prior rows and their construction while the affected fields still match the accepted suggestion.
It preserves later author edits under the same conditional Undo rules.
Gismu acceptance also updates headword state before it binds generation evidence.
Evidence-only gismu acceptance keeps equivalent typed bytes and their typed identity across repeated visits.
Form replacements mark retained evidence and annotations for review. Evidence discarded by that same action cannot add a new spelling review.

The typed path must reproduce every valid analyzed lujvo byte for byte, including extended `'y'` joins and irregular forms.
The gismu and lujvo builders ask before replacing any spelling that the author typed.
Authors can add dictionary words, enter recognized fu'ivla, reorder components, remove rows, or lock a particular rafsi.
Component search includes cmavo and fu'ivla. It never filters the inventory to gismu alone.
Each row shows source definitions and distinguishes listed assignments from automatically available long forms.
A component can name a specific source definition without claiming that every sense of that word contributes the same meaning.

The default chooses the lowest score under CLL's lujvo scoring algorithm for forms that its table covers.
Equal scores use lexical order for stable presentation, with no claim of linguistic superiority.
Show the numerical construction score separately from editorial support for rafsi assignments.
A locked rafsi remains locked when another component changes. The app explains any resulting invalid combination.

Required joining characters come from the selected morphology rules. The builder defaults to automatic joins, without optional hyphens.
The author can choose an optional hyphen at each boundary where the selected profile permits it.
The boundary control offers automatic joins and each permitted explicit choice, including no optional hyphen.
An explicit choice cannot remove a required hyphen or add a join that the selected profile rejects.
The preview separates joining characters from component rafsi and identifies each required or optional hyphen.

An optional hyphen can increase the construction score. The builder accepts that choice and scores the exact selected spelling.
It never substitutes a shorter spelling during selection, draft restoration, or publication.
The lowest-score default remains available through the automatic join controls.

Optional hyphens follow the selected parser rules, such as the [PEG morphology rules](https://mw.lojban.org/papri/BPFK_Section:_PEG_Morphology_Algorithm).
The app never describes an optional variant as output from the original [CLL 4.11 algorithm](https://lojban.github.io/cll/4/11/).
That algorithm adds only required hyphens. A profile that adds optional construction choices needs a new version.
Existing profile versions retain their construction rules.

The draft stores explicit join choices separately from rafsi choices.
Back navigation, reloads, and editor changes preserve each choice while the same adjacent components remain compatible.
A component change or reorder can invalidate a join choice. The app marks that boundary for review and explains the incompatible choice.
It requires a new explicit choice or a return to automatic joins before the builder accepts that candidate.
It never silently removes an invalidated choice or changes the author's prose.

Every gismu row offers its permitted long forms as well as listed short rafsi.
A complete five-letter gismu belongs in a final position under the classic rules. A nonfinal long form uses the appropriate stem.
Fu'ivla rows offer the valid long form even when short assigned rafsi also exist.
The builder also accepts recognized fu'ivla without an existing dictionary entry. Invalid or uncertain analysis remains visible.

A cmavo needs a supported combining form. Its classification alone does not create one.

Arbitrary long fu'ivla forms use an explicitly named extended morphology profile, based on the audited jbotci behavior.
That profile must specify its joins, segmentation rules, and treatment of forms outside the CLL scoring table.
The initial extended scorer uses the CLL formula and rank zero for an otherwise unlisted component shape, as jbotci does.
It labels that extension. It never presents the extra rank rule as text from CLL.
The implementation records pinned morphology and scorer versions in the formation metadata and ships fixtures for each supported extended form.

The builder must analyse its output as one word and recover the intended component sequence under the same profile.

An unresolved or conflicting short rafsi requires an explicit choice. A low construction score does not establish that its assignment is accepted.
Show all known competing assignments, including lower-ranked claims. Never copy jbotci's strongest-standing-only summary as a complete conflict list.
The author can choose another form, keep the intended conflict with acknowledgment, or return to component selection.
A proposed new rafsi assignment is a separate optional signed action.

“Suggest components” and “Suggest a lujvo” are separate optional AI actions.
Suggestions use the current meaning and declared component constraints. Deterministic tools still generate, score, and analyse proposed spellings.
“Draft definition for this form” sends the original meaning, current prose, selected components, source definitions, and chosen spelling after consent.
The returned text appears beside the existing text. The author accepts a replacement or selected edits, with undo.

Changing the lujvo never silently regenerates a human-edited definition or transfers endorsements from another revision.

### Step 3B: gismu generator

The generator shows a language profile with editable source-word and weight rows.
Authors can choose a documented preset or supply their own languages and nonnegative weights. At least one weight must be positive.
A profile name never hides the resolved numerical weights. Zero-weight rows remain visible but contribute nothing.
The default new-run scorer uses CLL letter matching and normalizes positive weights by their sum.

The structured metadata retains the entered weights, the normalization rule, and the exact inputs used for scoring.
Historical profiles preserve their own normalization semantics. The UI never compares differently scaled raw scores without a label.

Each source row separates native spelling from the Lojbanized input used by the letter scorer.

The table shows these columns: Language, Weight, Word, Said, Stem, Stem said, and Letters. Word is the native spelling. Said is the pronunciation of the whole word with its stress. Stem is the part of the word that the letters come from. Stem said is the pronunciation of the stem. Letters is the scoring input.

The pronunciation is there so that speakers of the language can check the word later and propose a better one. Only the letters count toward the score. Stress is shown and is never scored.

The signed formation source keeps Word as `word` and Said as `word_ipa`.
Language and Weight use `language` and `weight`. Accepted Notes enter the signed `notes` field.
Stem and Stem said stay private as `stem` and `ipa` in the draft and AI log. Neither enters the signed body.

If `input` is null, Letters stays empty. For `format: "lojbanized"`, Letters shows the exact `input.text`.

For `format: "ipa"`, Letters shows a preview from the recorded versioned conversion rule when the app supports that rule.
Otherwise, Letters stays empty and the app shows that conversion is unavailable. The app keeps the original IPA algorithm input visible beside Letters.
That input stays distinct from the stem pronunciation `ipa`. The app never guesses or fills `ipa` from it.
The preview preserves the original stored `input` bytes.

The signed `word_ipa` field is optional. An absent or null value means unknown and stays empty when a signed record opens.
The private `stem` and `ipa` fields are optional and survive draft reload and export.
When a signed record opens, Stem and Stem said start empty.
The app never guesses a missing stem or pronunciation from the scoring input.

The scoring input, `word_ipa`, `stem`, and `ipa` stay independent in draft rows.
An author can keep known scoring letters without a stem or either pronunciation.

IPA input requires an explicit, versioned conversion and a preview of the resulting scoring input.
One source word per language is the simple-mode default. Advanced mode can add alternatives under an explicitly selected aggregation rule.
An unfinished row does not acquire an invented source word or weight.

“Suggest source words” is optional AI assistance for the selected profile.
The profile action selects every source row, including every alternative and rows with filled or empty Word fields.
The app makes exactly one request per selected row. The individual row action selects only the row that the author chose.
The model returns the word, its sense, its stem, the pronunciation of the word and of the stem, the scoring letters, and a note.

The `sources` answer check requires `ipa` whenever the model gives non-null `sounds`.
Step 7 in `sources.task.txt` derives scoring letters from the stem IPA.
If the model cannot give `ipa`, `sounds` must be null and the note must explain why.
A null model answer never clears a value that the author entered.

The author accepts each row or a reviewed set. Missing suggestions keep existing rows and values rather than dropping a language.
A language with no single word for the meaning keeps its row and its Word field unchanged, or empty when it had no word.
The assistant's explanatory note appears under the row before acceptance.
Sources remain attributed suggestions until the author accepts them. The model cannot claim dictionary evidence that the app did not retrieve.

The deterministic generator returns candidate spellings, total scores, per-source contributions, potential rafsi, and conflict information.
Authors can select a lower-scoring candidate or enter a form manually. The UI never requires the top-ranked result.
An optional explanation can record pronunciation, ergonomics, a preferred rafsi, or another reason for the selection.
Manual or nonalgorithmic gismu remain possible without fabricated generation metadata.

The conflict view reports every known identical gismu, final-vowel conflict, and CLL similar-consonant conflict, with the source snapshot and rule.
It also reports every known competing assignment for each proposed short rafsi, across all word types.
Missing coverage is labeled unknown. Existing code that returns one collision is insufficient for this interface.
A collision does not reject the word. Before submission, the author explicitly acknowledges each group of unresolved conflicts.

A new collision discovered after a refreshed snapshot invalidates the corresponding acknowledgment.
A possible rafsi is not a reserved or assigned rafsi. The author selects any desired assignment actions separately.

### Step 3C: cmavo and other words

The manual Form screen provides spelling, attributed morphology notes, Back, and “Use <form>.”
For cmavo, ask for selma'o and offer an optional AI suggestion with its explanation.
Direct navigation from type selection to Places preserves manually entered spelling, classification, and notes.
An unknown or proposed selma'o is permitted as an attributed claim. It is not a parser installation request.
The advanced details distinguish grammatical operands from the numbered places of a relation that a construction forms.

Fu'ivla, cmevla, and other word types allow manual spelling and notes, with attributed morphology assistance when available.
A morphology disagreement remains a warning rather than a protocol rejection. The author can proceed with an explicit experimental classification.
The wizard does not pretend that all word types use the gismu or lujvo algorithms.

### Step 4: places, glosses, and supporting fields

The author edits the current definition alongside a place table. All structured fields remain available without AI.
Each place row provides Description, Gloss, Kind of thing, and From.
Kind of thing edits the complete type_hints format, including alternatives, custom tags, abstractors, relation arity, and notes.

The example choices anything (referent), event, property, number, and unspecified are shortcuts, not a closed schema.
Anything (referent) writes `referent`, which includes events, numbers, and other referents.
A place with several alternatives shows them together in the field, such as “event or number”.

An older signed hint can contain retired tags. The reader and draft preserve its alternatives without rewriting them.
Before a new signature, the editor names each retired tag and requires deliberate replacement with a current tag, or removal.
This also applies to saved custom hints.

`entity` means `referent`. `tuple` means `sequence`.
`mass` is an opaque legacy annotation outside the current tag tree and has no current alias.
The problem offers “Replace entity with referent” or “Replace tuple with sequence” as an explicit action.
These actions preserve the hint's abstractor, relation arity, and note. After replacement, identical tags or alternatives appear once.

For `mass`, the author chooses a current tag or removes the annotation. The editor does not choose a replacement.
The reassurance about the original signed body appears only for an unchanged alternative retained from that body's hint.

From edits derivation entries with a source word, optional exact source definition, source place, and explanation.
The frame controls support fixed, variadic, context-dependent, and unspecified structure.
Defaults and constraints, Notes, Examples, Etymology, and Sources use named disclosures.
The full editor also exposes grammatical operands, classification, labels, and every other publication field.
Fixed license values, derived identifiers, and generated provenance remain read-only.
Showing every field does not permit changing import origin or claiming another author's evidence.
The app offers numbered place insertion, descriptions, glosses, expected values, defaults, constraints, examples, notes, and etymology.
The wizard can suggest placeholder mappings, but the author approves numbering before publication.
Repeated references can name the same place. Textual order does not determine final place order.

In structured editing, typed circled numerals insert integer place references. Pasting offers literal text or explicit token conversion.
Structured editing uses `①` or `{place N}` for a place reference, `{operand ID}` for an operand reference, `[[spelling|label]]` for a word link, `[[https://host/path|label]]` for a web link, and backticks for code.
A backslash before `\`, `[`, `{`, a backtick, or a circled numeral keeps that character literal. Code and links also escape their own delimiters.
Every other backslash stays literal, including TeX commands and a backslash before whitespace or a raw blank line.
Blank lines always separate paragraphs, so code and links never cross them and unmatched delimiters stay literal within their paragraph. When the editor shows stored code or a link label, each run of blank lines becomes one line break and the node keeps its type.
Ordinary URL targets remove only characters ignored by [URL parsing](https://url.spec.whatwg.org/#concept-basic-url-parser): ASCII tab, CR, LF, and C0 controls or space at the edges. Spaces inside paths or queries, non-ASCII whitespace, and Unicode spelling stay significant. A link whose label equals its original URL keeps the short form with that normalized target. If a stored target lacks `//`, the writer uses its parsed URL and keeps the original label explicit.
When a field is edited, CRLF and CR become LF, adjacent strings merge, and trailing plain whitespace is trimmed. Whitespace-only paragraphs disappear.
The draft holds each rich text field as its exact rich text value. The editor shows a field in its text form and parses the text back only when the author edits that field, so an untouched value never changes. Literal mode turns the place references of every field into circled characters after a confirmation, and structured mode reads circled characters in text as references again. Links and code stay in both modes; a field edited in literal mode becomes plain text.
Literal mode preserves circled characters and underscores as text. Both modes produce the same compact rich-text schema.
In literal mode, removing or moving a place updates the visible circled characters in unchanged fields to keep their saved references aligned.
Removing a declared place requires removal, replacement, or literalization of every reference to it.

A null frame means unspecified structure. The wizard never substitutes a guessed zero-place frame.

The Places step and the full editor show a place-count note for every word type with more than three declared places.
Count the declared numbered places. A repeating tail counts as one place.
Null frames and operand places of constructed predicates do not count.
The note never blocks Next or Publish and asks for no acknowledgment.
The author can hide it for the current draft. This choice and the note leave no trace in signed records.

For four or five places, the heading is “Does every place belong?” and the text is:

> A place stays in the meaning even when nobody says it. Only zi'o removes it. That is why a container with no lid is not a botpi, whose x4 is the lid. Keep the places that the idea cannot do without, and add other details when needed with a tag such as sepi'o ("using tool").

For six or more places, substitute the count for N in “Are all N places needed?” and use this text:

> Few good definitions have more than five places, because a word with that many is hard to use. A place stays in the meaning even when nobody says it, and only zi'o removes it. Keep the places that the idea cannot do without, and add other details when needed with a tag such as sepi'o ("using tool").

“More about places” explains that an omitted place is zo'e, the value that the speaker means.
It cites CLL 7.7 and explains that zbasu still has a maker. zi'o makes a different relation, also under CLL 7.7.
A modal adds a place to any bridi without changing the numbered ones, under CLL 9.5.
Examples include BAI tags sepi'o, ma'e, and bau, and fi'o with any selbri.
The help gives bamri as a good four-place example: x1 buys x2 from x3 for price x4.

“Suggest places and glosses” is an optional AI action based on the current meaning, word form, component evidence, and existing draft annotations.
The AI keeps every explicit participant with its number and order. It proposes additional places only when every use implies them.
If an explicit participant fails that test, the AI keeps it and flags the doubt in `reason`.
It puts modal tag offers and reasons for each place after the third in `reason`, outside place descriptions and definition text.
When the request supplies no tag name, the AI describes the detail and says that a modal tag can add it.
It names only Lojban words and tags that the request supplies.
The result proposes typed fields and identifies unresolved mappings. The author reviews the rendered text and table before accepting changes.
The definition of the whole word decides the meaning and the types. Component definitions only identify which role a place plays. Any word form that follows the selected morphology rules is accepted, including lower-scoring rafsi and optional hyphens.
A type suggestion gives one to three alternatives for a place, each with a short reason. A line under the row lists each alternative and its reason. `unclear` means that the definition does not describe the place. An empty hint then reads “unspecified”. An existing hint stays unchanged.

For the AI type list, keep a broader entry with its own reason and drop a narrower entry beside it.
For example, keep `referent` over `event`. This rule does not merge signed alternatives or discard their abstractors or relation arity.
AI suggestions never create retired tags.

A mapping suggestion lists, for each place, the component places that it corresponds to. Each has a kind and a one-sentence reason.
The `reason` must start with `direct: `, `merged: `, `distributed: `, or `functional: `, followed by its explanation.
The `none` and `unclear` sentinels instead require `none: ` and `unclear: `.

The answer check requires this prefix to match the entry. There is no separate `kind` field.
The From field reads the prefix and shows the kind, such as “klama 2 · direct”.
The line under the row offers Add for a component place that the row does not name yet.

AI suggestions never manufacture historical source attribution, exact quotations, accepted rafsi, or endorsements.
Accepted suggestions remain ordinary author-controlled draft data. The app does not assign them automatic trust weight.

Accepting a suggestion writes these fields only after the author reviews their values:

| Answer value                   | Draft field or panel behavior                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source `word`, `word_ipa`      | The matching signed source fields in the draft. A null answer never clears an existing value. Unknown pronunciation stays omitted.               |
| Source `stem`, `ipa`           | Private source fields in the draft and AI log. Neither enters a signed formation source. A null answer never clears an existing value.           |
| Source `sounds`                | `input: {format: "lojbanized", text: sounds}`. A null answer preserves an existing input and leaves an unknown input null.                       |
| Source `sense` and `note`      | On row acceptance, replace the earlier accepted AI paragraph group with new nonempty `Sense: ` and `Note: ` paragraphs. Preserve authored notes. |
| Hint `type` and `reason`       | One alternative per current type, with null abstractor and relation arity. Hint `note` keeps one `type: reason` paragraph per alternative.       |
| Hint `unclear`                 | Panel only. Accepting it preserves an existing hint and leaves an empty hint unspecified.                                                        |
| Mapping component and `reason` | Add its word, exact supplied definition, and place to `derivation`. Keep the full kind prefix in `explanation`.                                  |
| Mapping `none` or `unclear`    | Panel only. Do not clear existing derivations.                                                                                                   |

The publication preview shows accepted source notes as the author's contribution, not as retrieved source evidence.
For a null `word`, show the note under the row before acceptance. It enters `notes` only when the author accepts that row.

Null source answers also preserve authored notes. Acceptance applies only `word`, `word_ipa`, `stem`, `ipa`, `input`, and the AI group in `notes`.
It never changes the row's language, weight, or provenance. Null answers preserve existing values, including scoring input, without weakening the model's answer checks.

The source preview shows before and after values for every proposed field, including fresh values and the new AI note group.
It also shows each value that acceptance retains.
If an accepted non-null suggested word changes Word or fills an empty Word field, retained nonempty evidence needs review.
The app marks every nonempty old value that remains, even when the proposal repeats it.

These marks name Letters, Said, Stem, and Stem said. Letters review includes a retained scoring input even when its conversion is unavailable.
Each retained Notes paragraph also needs review, including word-specific authored notes.
Each marked field or paragraph shows its earlier word and value beside explicit Keep and Clear actions.

Acceptance retains these values until the author chooses an action. Clear removes only that field or paragraph, and Keep records approval for the new word.
Marked Letters, Said, Stem, and Stem said remain read-only until Keep or Clear. Keep preserves the marked value, and Clear permits new input.
Generation waits until every row has usable, unmarked Letters. Clearing Letters keeps generation waiting until the author fills them.
Unresolved marks block signing only while their formation exists. A type change that removes the formation also removes its marks.
Explicit evidence removal keeps the row marks. Retained Letters still block generation.
Any unresolved mark blocks signing when a new formation exists.

Review marks and choices stay private in the draft. They survive reload and mode changes, and undo restores them with the values.
A partial undo preserves later review choices and restores required marks with the retained values that it restores.
Keep never overwrites a different paragraph or a changed field when its mark no longer matches.
A later accepted suggested word that changes Word starts a new review for every retained nonempty value.
A later proposal that replaces a marked value removes its old mark. Repeating that value preserves its mark.

The draft privately tracks which paragraphs form the last accepted AI note group for each source row.
The app initializes new source rows with a known empty AI note group.
Rows copied from signed records start with a known empty AI group because their signed notes are authored text.
This group information survives reload and mode changes, and undo restores it with the notes.

New AI paragraphs replace that group, rather than append to it. Replacement starts at the earlier group's first position and preserves the order of authored paragraphs.
Without an earlier group, the new group follows the authored notes. An empty new group removes only the earlier AI group.
An author edit to an AI paragraph removes that paragraph from the group, so later suggestions preserve it as authored text.
An unrelated edit preserves ownership of identical AI paragraphs when their copy count stays unchanged.
Adding or removing identical copies makes their ownership ambiguous, so the app treats those paragraphs as authored text.

If group information is absent, the preview requires the author to identify the earlier AI paragraphs or choose “No earlier AI notes”.
Acceptance waits for that choice. The app never infers paragraph ownership from a `Sense: ` or `Note: ` prefix.
The choice establishes private group information for this draft. Group information and review marks never enter signed records or assistance requests and responses.
That private choice alone never marks a suggestion stale. Row comparisons use current values after a weight preset change.

The From field reads a recognized kind prefix from the derivation explanation after reload.
A human explanation without such a prefix shows no kind label. The app never infers a kind from its prose.

### Step 5: review and publication

Show the complete spelling, definition, place table, formation evidence, sources, license, selected identity, and any conflict acknowledgments.
Signing requires valid structured references and schema fields. Linguistic disagreement alone does not make the record structurally invalid.
The author can correct a typed reference or convert it to literal text after a preview.
New native definitions use fixed `license.expression: "CC0-1.0"` and the official CC0 URL.
Their interpreted `license.attribution` is an empty string, so new bodies omit that field. The signed header issuer identifies the contributor.
These license fields remain read-only. Imported author attribution stays in its separate source evidence and parent references.
The notice reads: “New definitions use CC0 1.0. By publishing, you release your contribution under CC0 1.0.”
Link “CC0 1.0” to https://creativecommons.org/publicdomain/zero/1.0/. The Publish action expresses agreement, without a separate checkbox.
Imported text retains its source rights statement and provenance. This notice does not claim that legacy authors selected CC0.

The preview uses the word page layout and names the selected signing identity and delivery recipients.
It says “Signed with your key, with your endorsement.” There is no endorsement checkbox.
An untested backup warning appears above Publish until the local backup test passes.

Publish signs the definition and a separate author judgment with `value: "bless"`.
Each selected rafsi creates a separate claim and a separate blessing of its word and rafsi pair.
The app persists the whole intended group, complete immutable envelopes, bodies, IDs, and recipient choices before any dispatch.
It then sends those records in dependency order. Every record and peer has an independent receipt.
This group does not form an atomic network transaction. Retry reuses the stored records, never replacement signatures.

After a receipt confirms the definition envelope and its matching required body, navigate to the word page.
Report unfinished outcomes separately.
Accepted records with pending dependencies or index lag never appear as fully interpreted, published results.
Index lag alone never triggers redelivery.
On delivery failure, show a clearly labeled local pending preview and the “Not delivered” marker.
The retained group remains available for retry or export. Section 10 defines delivery handling.

Optional Lensisku publication is another explicit action with its own result. It cannot roll back an accepted jvc publication.

### Draft state and invalidation

The draft preserves original meaning, current prose, word type, builder inputs, chosen form, structured fields, source references, and accepted suggestions.
It also preserves field edit history and conflict acknowledgments. Unsigned private draft state never enters ordinary peer synchronization.
Changing a component or weight invalidates dependent candidate scores and cached suggestions, while retaining human prose and place annotations.
For gismu sources, language, algorithm input, and weight determine the scores. Notes, native words, and pronunciation fields do not change those scores.
Source edits update the copy used for publication. An empty alternative row does not change the formation.
A source reopened from signed evidence remains present even when its algorithm input is null.
Validation preserves the draft. Loading an older draft synchronizes descriptive source edits once.
Source synchronization preserves the formation's headword binding, including after AI source acceptance or conditional Undo.
If scoring inputs change, publication waits for a new form selection or removal of the old evidence.
Using manual Form with changed scoring inputs replaces the stale scores with manual evidence bound to the current headword.
Unrelated definition and place suggestions remain usable. Acceptance refuses any new blocking frame or reference problem.
The form action stays disabled while the generator recalculates. A chosen score must describe the exact current scoring inputs.
Changing the chosen form invalidates morphology and conflict review. It marks formation-dependent annotations for review rather than deleting them.

A language change marks translations and language-specific glosses for review. It never relabels their text silently.
Back navigation, mode changes, reloads, and failed provider calls preserve the draft. The author can export it at any step.

## 6. Revisions, retirement, and rafsi

“Revise” copies a publication into a new local draft with its exact parent ID.
A reviewed revision uses native origin and omits legacy. An imported parent keeps its original legacy evidence unchanged.
The draft preserves attribution through source references to that imported publication and its source. It does not claim to be the original extraction.

Anyone can propose a revision. The resulting card identifies its signer and whether accepted continuity connects that signer to the original author.
The UI never says that a proposal replaced its parent merely because it has a later timestamp.
It shows branching revisions and lets readers compare text, places, defaults, sources, and other changed fields.
Comparison fields show changes in batches of 50. Each requested batch moves keyboard focus to its first new row, including the final batch.

Publishing a revision creates its own author endorsement. It inherits no judgments from its parent.
If its body is unavailable, the parent still shows that a proposed revision exists.
An unavailable child never makes its parent the silently declared latest revision. The first release offers “Watch for revisions” as a local notification preference only.
For imports, the view's current choice reads “selected source revision.” Other versions read “other imported revisions of this source record.”
Parent links never establish which imported state is current after a source reversion.

It does not offer automatic blessing of future edits. That feature needs a later protocol extension.
An author can separately deprecate an old native definition. The preview explains that this makes its stored judgments inactive while deprecated.
Restoration reactivates those judgments. It does not notify readers that everyone endorsed the content again.

Retire and restore controls appear for controlled native definitions and imported definitions authorized through a source-account link.
Imported controls require the selected view to enable account_authority and require numeric source-author evidence. A username match never enables them.
The preview identifies the exact publication, source account, controller period, and witnesses. The app signs import.status with that period's claim ID.

Retirement affects that publication only. Later source revisions start with their own status, while source reversions reuse existing publication status.
Batch retirement lists every affected publication and signs separate actions. Partial delivery remains visible.
The status page distinguishes the publication's state from disputes or missing evidence about its controller.

A controller dispute disables new author commands. Equal complete status results from the candidate periods remain visible with the dispute.
A new status action follows every known own branch for its target. The client never attempts cross-period replacement of stale former-key records.
A successor's claim fixes the adopted history. Later records outside that boundary cannot reopen its status.

Imported bytes, attribution, and importer signatures remain unchanged. Restoration reactivates existing judgments.
Publishing a native revision adds its author endorsement but inherits no other endorsements.

For other authors, offer “Oppose” and “Propose a revision.” Neither action pretends to change another author's status.
A word with only known deprecated definitions reads “No active definitions in this snapshot.”
It never claims that every server considers the word deprecated.

Rafsi claims appear in a separate section on the word page.
“Assign a rafsi” asks for the spelling, rationale, and optional source references.
It shows current claims for that spelling across words before signing.
A conflict is permitted and prominently labeled.
Publishing a rafsi claim also signs a separate author blessing of the pair. Both records persist before dispatch.
An inactive pair shows whether its claims or its word definitions caused inactivity, with links to the relevant status events.
Each pair card groups its claim publications and offers Endorse, Oppose, and Clear my judgment.

The preview states that one judgment applies to the pair across all its publishers. Duplicate claims never multiply that reviewer's influence. The app does not treat a rafsi as reserved by the first server to receive it.
A generation tool uses only a uniquely preferred assignment under the selected view, or asks the user to choose explicitly.

## 7. Endorsements and trust

The visible judgment actions are “Endorse,” “Oppose,” and “Clear my judgment.”
Their help text maps them to bless, curse, and clear. Definition judgments apply to the exact revision shown. Rafsi judgments apply to the exact word and rafsi pair.
A reason is optional. The UI does not demand prose for every curator action.
A changed judgment follows the contributor's known event frontier and replaces their earlier causally ordered judgment.

A card shows one net score between Endorse and Oppose arrows.
The title and accessible name expose support, opposition, and direct reviewer count.
A keyboard- and tap-accessible disclosure exposes the same breakdown without hover.
The word page also provides an “N reviewers” disclosure with identities, their routes, and influence units.
The interface uses “score,” not “votes.” Display rounding changes presentation only, never ranking or the calculation profile.
An exact nonzero score never rounds to zero. Use sufficient precision, scientific notation, or a signed small-value indicator with exact details.
“No judgments yet” requires a known zero direct-reviewer count. A zero net score or unknown evidence does not establish that state.
Exact details retain the underlying values. A bounded score shows an honest range or “Order unresolved.”
An unavailable score reads “Unavailable,” never an invented zero.

Selecting an unpressed arrow sets that judgment. Selecting the pressed arrow clears it.
The controls expose accessible names and `aria-pressed` for an unambiguous known judgment.
A known clear or absent judgment leaves both arrows unpressed. Unknown evidence is not a known absence.
Conflicted judgments show conflict without arbitrarily pressing either arrow.
A pending local action remains distinct from known accepted state.
With an unlocked key, an arrow takes one action from the result row.
The first action creates or unlocks a key, then resumes the exact revision or pair that the user selected.
The client never substitutes a newer revision while that flow runs.
“One reviewer, 20 influence units” is valid. “20 people agree” is not an acceptable substitution.
Numbers are not percentages, probabilities, or proof that a definition is correct.
Every card also shows the current user's own judgment separately. A personal “My judgments first” toggle applies an explicit local presentation preference.

The details panel shows the view, major sources of influence, and whether the calculation is exact or bounded.
It names the calculation profile from the result metadata and states that profile's route rule.
Under `simple-routes-shun-v1`, an unfinished result says that its upper endpoint can include routes that effective shuns forbid. No upper endpoint is called received support.
Incoming trust in the reviewer list is a list of public declarations. It does not show which routes delivered weight.
A reviewer with weight 0 counts as a reviewer. A profile the client does not know leaves scores unavailable, with the profile named. Nothing substitutes another calculation or a cached site score.
A bounded result exposes its interval and unresolved comparisons.
If a layer contains more than five candidates, show its size and a shared banner. Do not number them as ranked winners. The ordinary card can use “Order unresolved” without presenting mathematical notation first.

An identity page shows its name claim, fingerprint, known successor state, and its dictionary actions.
“Edit public profile” opens name, biography, and HTTPS link fields for the current identity.
Its preview states that this is a public signed claim with retained history.
The full fingerprint appears on the local and public identity pages.
Elsewhere, each identity name links to its public page, and the link title contains its fingerprint.
Authority previews provide that fingerprint link so that a display name alone never establishes authority.
Wrap names in `<bdi>`. Display-name equality never merges identities.
An imported author without a proven key binding links to source-account evidence rather than an invented signing identity or fingerprint.
The importer signer remains separately inspectable.

Recent contributions can help discovery. They do not become an automatic reputation score.
The app offers no global popularity leaderboard.

“Trust reviews from this identity” opens a short choice between a private preference and a public heed.
The explanation states that this also follows the people that identity trusts, within matching scopes.
The default scope is all dictionary judgments. Advanced controls narrow it by definition language, word, or definition versus rafsi claims.
Before publishing, the user sees the subject identity link with its fingerprint and the selected scope.
A public decision states that its history is public even after a later clear.

“Ignore influence from this identity” creates an `overlay.blocked` entry with the selected identity and scope by default.
It removes that identity and routes through it from the personal view.
It does not use an `overlay.trust` shun. Under `simple-routes-bounds-v1` a shun removes only the issuer's own trust edge. Under `simple-routes-shun-v1` a route is also refused where any earlier actor on it effectively shuns the next person, while independent routes and the person's own starting allocation stay.
A separate choice signs `trust.set` with `value: "shun"` to publish an editorial shun.
Other readers interpret that as this user's refusal to heed, not a universal veto.
The personal view also applies the current user's effective public shuns as local blocks, as the format specifies. The browser keeps its saved private preferences as a version 1 overlay. For each personal calculation it builds a version 2 overlay with the same fields and `public_shun_issuer`, the current session identity or null for an anonymous session. The core resolves that issuer's public shuns with the scope, continuity, clear, and conflict rules of the calculation's snapshot. The browser derives no block from its own registers, and it stores no derived block list or issuer.
A narrower public heed or a public clear can lift such a block in its context. A private Trust rule does not cancel a block from the user's own public shun. A private Ignore is a separate block that stays until the user removes it, also after a public clear. The interface says both where it offers the private choice and on the Trust page.
The reviewer list labels a block with the reasons that the calculation result supplies: `public_shun_block`, `private_block`, both, or a generic block when the result gives no reason. The client infers no reason from a different snapshot.
The public preview tells a signed view that did not load apart from a loaded profile this client does not know. For a failed load it says that the route rule is unavailable and names the error. After Make public or Undo the status reports the first delivery outcome, as on the identity page. An accepted record says that others can build on it. An unfinished delivery says that the record is saved locally and points to Not delivered. A receipt never proves that the shown snapshot includes the record.
A newly signed public trust choice changes a personal calculation only in a snapshot that holds it. After the signature the status says that the personal view includes it after delivery and a recompute for that snapshot. An older snapshot's scores do not claim to include it.
The public preview explains the effect of a shun under the calculation profile of the signed view in use. It does not claim that a public shun removes every influence of that person in every reader's view.
The UI never labels an ordinary shun as an allegation of malice.

“Report identity abuse” is a separate action. It requires a category, explanation, and explicit public preview.
Linguistic disagreement routes to “Oppose” instead. Evidence links never trigger automatic external downloads.
Reports do not automatically ban identities in the first release. A view publisher can adopt a documented exclusion through a new view.

A storage operator can separately refuse content under its published admission policy.

The trust page provides “Mine: site view + my choices” and “Site view only” modes.
It lists “People I trust” and “People I ignore,” with explicit public or private labels and their scopes.
“Make public” opens a deliberate signed preview. Undo of a public choice signs clear and retains its history.
Clearing a public choice does not clear a separate private block.
Removing a root removes its starting allocation, but independent incoming routes can still supply influence.
Ignore blocks the identity and routes through it in the personal view.
The trust page distinguishes public records, private overrides, and the active public view.
The site view is the server's selected signed view by default. The reader can choose another retained signed view by its event ID, and can return to the server's view. Each signed view names its calculation profile, so this explicit choice is the only way to change the profile. The page names the profile of the view in use and its route rule. No view is rewritten and no view ID changes.
A result from a calculation profile this client does not know gives no scores and no order. The word page then shows definitions in event order and says so, with the profile name. Nothing substitutes another profile or a number.
Remembered search results belong to the view choice that produced them: a signed view ID, or the server's view. After a different choice, browser Back starts a new search under the current choice instead of restoring old hits and cursors. Under the same choice the results are restored without a request, with their fixed snapshot and view for later pages.
Private preferences remain local unless the user explicitly exports them. A public publish button never appears as an automatic save for private changes.
The view detail shows roots, allocations, rafsi_threshold, H, alpha, exclusions, accepted import selections, and the calculation budget.
It also shows account_authority and the selected account witnesses. A policy change explains its effect on imported status before adoption.

A witness update needs certificates from its new witness set. The preview shows affected controls and status.
The inherited policy history supplies an availability guard, not a substitute current controller. A parentless reset previews discarded history and changed status.
Each import entry exposes its source, importer, and exact publication selection. Each publication exposes its original snapshot and extraction version.

It labels H as “Outward allowance,” not reach or a depth limit.
It labels H=3 and alpha=1/2 as initial values for real-use tuning.
Users can pin a retained view version by choosing its exact event ID, or create a personal overlay. Browsing a view's history and following the later changes of another view need a view history endpoint.
Results always name an exact view event. If a known newer view body is unavailable, label the older selection explicitly.

The reference personal overlay adds the current identity with `q=1` only when no allocation already names its continuity group.
It retains the chosen public view's other roots and applies the user's local blocks and trust decisions.
This change affects that personal view only. It never registers the identity as a public participant.
The public view remains available beside it for comparison.
A view update shows changed roots, allocations, and exclusions before adoption when the user pinned a version.

The operator's live default can update automatically, but the app records and exposes each change.
An exclusion is the view publisher's moderation choice. It is not a protocol verdict, even when the view is the site default.
If cited evidence is unavailable, show that fact and offer an explicit copied view without the exclusion.

## 8. Key generation, storage, and backup

An identity is one Ed25519 key pair. The private key signs events. The public key identifies the contributor.
The browser generates the pair with its cryptographic random source and a supported Ed25519 implementation.
Feature detection selects WebCrypto or an established compatible library. Unsupported environments remain read-only and retain exportable drafts.

Do not describe an unaudited fallback as audited merely because it is popular.

Before the first public signature, the app states: “Keep a backup. Losing this key can make this identity unusable.”
It also states: “This website supplies the code that uses your key. A compromised website can misuse it.”
The same explanation states that judgments and public trust choices are signed public records.
It says: “Undo adds a record. It does not erase the earlier public record.”
This one-time explanation covers direct actions without a preview. It adds no per-action modal or checkbox.
A copied name cannot impersonate the key. A stolen private key can sign as that identity.
There is no email reset, server recovery, or custodial signing mode.

Generate an exportable key, create its encrypted backup, then import a non-exportable working copy when the platform supports that distinction.
The encrypted backup remains in local storage. The unlocked working copy stays in memory for the session.
Do not store the passphrase or an unencrypted private-key export in IndexedDB, logs, telemetry, URLs, or service-worker caches.
Non-exportability limits extraction through the API. It does not stop hostile same-origin code from requesting signatures.

Unlock once per active editing session. Lock after 15 minutes without a signing action, when the user selects Lock, or when the page closes.
An explicit “Stay unlocked this session” option suits review work and shows its current state.
Per-action unlocking is optional. The UI does not claim that it defeats a hostile origin.
If locking discards an in-memory key, the user unlocks the encrypted local copy again.

### Backup file contract

The backup is a UTF-8 JSON file with exactly these fields:

```json
{
  "format": "jbovlacku-key-backup",
  "version": 1,
  "identity": "ed25519:<64 hex digits>",
  "jwe": "<compact JWE string>"
}
```

The JWE plaintext is the private key's PKCS8 DER bytes. Use an established JWE library with this restricted profile.
The file identity is not authenticated by the outer JSON. Matching it against the decrypted key is mandatory. Its protected header contains exactly `alg`, `enc`, `p2c`, and `p2s`.
Use `alg: "PBES2-HS256+A128KW"`, `enc: "A256GCM"`, and `p2c: 600000`.

`p2s` encodes 16 random bytes as unpadded base64url.
The PBKDF2 salt concatenates UTF-8 `PBES2-HS256+A128KW`, one zero byte, and those 16 bytes. The derived wrapping key has 16 bytes.
Use a fresh random content-encryption key and 96-bit IV for each export. The authentication tag contains 128 bits.

The JWE uses compact serialization with five canonical base64url segments. Compression, external key URLs, alternate algorithms, and extra headers are forbidden.
Passphrases use their exact UTF-8 bytes without normalization or trimming. The UI offers reveal and repeat controls.

Reject backup files above 16 KiB before cryptographic work. Reject unsupported versions and any iteration count other than 600,000 in version 1.
Limit concurrent decryptions to one. A failed password attempt never starts an unbounded retry loop.
This profile is an initial engineering choice, not a promise of permanent password strength.

A later profile can change its work factor or standard container. Old files remain explicitly identifiable by version.

Import decrypts locally and parses PKCS8 strictly as an Ed25519 private key. Reject other algorithms and malformed DER.
The client derives the public key from that private key.
Decryption and private-key parse failures show one message: “This file did not unlock with that passphrase.”
It must match the file's identity before the client accepts the key. A mismatched file never replaces an existing identity.
A duplicate import selects the existing identity and merges no unsigned claims about current event heads.

Public keys and OpenSSH public-key lines can import as contacts, never as signing identities.
The CLI can convert a private key through established tools. The first browser release does not promise arbitrary OpenSSH private-file imports.

Export offers a download and asks the user to reopen that file for a local recovery test.
A successful test records only a local backup indicator. It does not prove that the user kept a durable copy.
The user can skip the test after an explicit loss warning. A persistent backup reminder remains visible until a successful test.
Passwords and key bytes never leave the browser during this flow.

### Passkeys and origin changes

A passkey is an optional convenience for unlocking a separate encrypted Ed25519 key.
It is not the dictionary identity and does not directly replace its signature format.
Version 1 requires the portable backup path even if a client later adds a WebAuthn PRF wrapper.
PRF support and cross-device availability need feature detection. A credential for one origin does not automatically unlock another mirror.
PRF outputs must never enter server-bound credential JSON, logs, or telemetry.

A PWA does not pin trusted application code against a hostile origin update.
A separately distributed signer or browser extension is a possible later component with a different update boundary.
The first release does not claim that boundary. Its signing review shows the exact content, but cannot protect against malicious client code.
Changing servers changes data access. Importing a key into another web origin also changes who supplies its signer code.

The UI states that distinction before key import on a new origin.

## 9. Planned handover and compromise

Planned handover requires the old key and a fresh new key. The app generates and backs up the new key first.
It then retrieves current old-key heads from configured peers and shows any known conflicts.
The preview states that transfer retires the old key and that conflicting transfers suspend automatic continuity.
It also states that unseen concurrent old-key actions lose ordinary authority. The client searches local history and configured peers before signing lifecycle events.

A retry uses stored events. If the acceptance is lost, the app searches by transfer ID before offering any new signature.
A second acceptance can freeze continuity. The app never presents reconstruction with a new nonce as a safe retry.
If all configured peers answer and none has an acceptance, an advanced recovery flow can offer signing one acceptance with the successor key.

The user must acknowledge that an undiscovered acceptance can later freeze continuity. Negative peer responses do not prove global absence.
An unanswered peer blocks this recovery flow. The flow never signs another transfer or restores ordinary old-key signing.
The user approves the successor fingerprint before the app signs either event.

After a successful handover, offer explicit migration of public heeds and root allocations. The user approves those actions separately.
Explain that retired-key possession can still disrupt inherited references and contested status authority.
The app signs the old-key transfer and the new-key acceptance locally, then stores both in the outbox before upload.
Upload can be partial. The UI shows “Old key retired, acceptance waiting” until both events arrive at the selected peer.

It retains the new encrypted key and the acceptance event for retry.
If new evidence withdraws known continuity, show that change and the responsible event IDs. Recompute inherited judgments and trust.
The old key remains available for archive access or a compromise notice, but ordinary actions from it are disabled.
No grace-period undo appears in the interface.

A compromise notice is distinct from an abuse report about someone else's key.
The notice flow asks the holder to choose the last trusted causal frontier. The UI previews the retained and excluded actions.
It warns that the notice cannot prove which holder is legitimate and that a stolen key can publish another cutoff.
An empty safe frontier disables all old-key authority. The user must explicitly approve that outcome.

Missing history blocks a confident preview and is shown as missing, not treated as safe automatically.

If the key is lost, the app offers backup import or creation of a new identity.
It never presents a successor as recoverable when no transfer was signed.
Contacts can endorse the new identity socially. That does not rewrite old signatures or hide the loss.

## 10. Offline work, conflicts, and delivery

The local store separates cached public records, encrypted keys, private preferences, unsigned drafts, and signed outbox events.
It also retains known latest event references for each local signing identity.
These references identify accepted history through predecessor links. They do not require a complete local copy of that history.
Language search packages contain searchable dictionary data, not the complete event graph.
The browser retrieves missing signing or handover evidence from configured peers and exposes unresolved dependencies before proceeding.

It never discards a remembered own branch merely because a peer omits it.
Device synchronization exchanges known history references and uploads pending events. A handover includes every known relevant device branch.
The app requests persistent storage after an intentional write and shows whether the browser grants it.
Persistence reduces some eviction risks. Browser clearing or eviction can still destroy local work.

A key backup does not contain drafts or outbox events. Each has a separate export action.

A signed outbox event is immutable. Retry sends the identical bytes and ID.
Editing a signed publication creates a new draft or revision. It never mutates a queued signed body.
The outbox records independent receipts for each peer.
Internal delivery states distinguish signed and queued, accepted, accepted pending dependencies, refused by this server, and delivery unknown.
Unsigned drafts remain separate local draft state.
The page title is “Not delivered,” and its path remains `/outbox`.
It shows waiting records after offline delivery, failure, refusal, or an unknown outcome, together with stopped records.
An ordinary transient send does not create a header warning. Each waiting row states the last attempt and next retry.
“Try now” follows the same receipt lookup and immutable retry rules.
Each waiting row also offers “Stop retrying.” It stops future attempts to every still-unfinished selected peer for that record.
The app retains signed bytes and receipts. The row stays with the status word “Stopped” in place of the next-retry sentence.
Stopping does not retract a public record or guarantee that an in-flight request stopped.

A stopped record stays on the Not delivered page with Resume and Save as file. Discard follows the dependency restriction below.
The header marker counts waiting and stopped records and stays while either exists.

Discard is available only for an unfinished stopped record when no later local own record reaches it through predecessor links.
When later records depend on it, the row explains this restriction and offers Resume and Save as file.
Compromise notices, handover transfers, and handover acceptances must be delivered. Their stopped rows offer Resume and Save as file, without Discard.
The discard transaction refuses these lifecycle records and records that every recipient already accepted. It keeps their signed bytes, receipts, and lifecycle markers.
This restriction also applies when a server already holds the stopped record.
Discard asks first, then deletes the local signed bytes and receipts. It does not retract a copy that a server already holds.

The app removes the discarded ID from its local frontier and recomputes maximal own references from the remaining local graph.
Its retained predecessors return to that frontier when no remaining own record succeeds them.

Resume uses the same stored bytes, selected recipients, and receipt lookup before retry.
No new signature or silent recipient change occurs.

Accepted dependency waits and index lag remain visible where they affect publication, without being mislabeled delivery failures.
When no waiting or stopped records remain, remove the header marker. A direct visit to `/outbox` shows a short empty state.
Keep delivered records and receipts after the page empties. “Save them as a file” exports waiting and stopped records with their bodies.

A timeout means delivery unknown. The client queries by ID before retrying and can safely resend identical bytes.
Delivery completes only when the peer receipt confirms the submitted envelope and every required submitted body with matching hash.
Header-only acceptance does not complete delivery of a publication body.
If lookup finds the envelope but its required body is missing, resend the identical complete stored submission.
A peer body refusal remains an unfinished delivery outcome with its reason.
An accepted matching body with pending dependencies or index lag is delivered, with interpretation still pending.
Retain every record and independent per-peer receipt after delivery completes.

The app persists bounded retry state and backoff with each event and peer.
While the app is active, connectivity return or reload resumes eligible retries automatically.
The client respects Retry-After and avoids an automatic refusal loop.
A known permanent refusal stays auto-paused until corrective action or explicit retry.
The page reports the next attempt accurately. A closed browser does not guarantee background delivery.

The client overlays its queued events only in a clearly labeled personal preview.
It never presents that preview as the selected server's current public state.
Sending a signed event to another peer is publication to that peer. Do not describe it as a private backup or promise delayed disclosure.
Settings holds the choice of delivery peers. The publish preview names every selected recipient.
With one configured recipient, publication needs no peer picker.
Changing stored peer settings never silently republishes old records to another peer.
Explicit redelivery shows the affected records and recipient before sending. No unsigned drafts upload automatically.

Two devices can create concurrent branches with the same key. This is not automatically evidence of theft.
After synchronization, a neutral merge event can combine heads without resolving contradictory judgments.
If a register conflicts, show both values and ask the user to state a new value after both branches.
Do not select a winner from timestamps, device names, upload order, or event IDs.

For independent publications, preserve both. For agreeing judgments, show one effective opinion with two historical branches.

A browser crash after signing but before local persistence is a possible loss window.
The signer must persist the complete intended group before any send or successful preparation message.
A failed local write leaves the draft visible and offers file export. It never shows a successful queue state.
After every session with undelivered events, expose a one-click outbox export.
An export is a portable package of signed events and retained bodies, not a promise that another server accepted them.

## 11. Common server API contract

The base path is `/api/v1`. JSON errors contain `code`, `message`, `event`, and `field`, with null for inapplicable fields.
The API never accepts a private key or passphrase. Transport authentication, when an operator requires it, remains separate from signing identity.
Public reads need no account. Public event admission follows published quotas and content policy.

| Method and path                                                   | Contract                                                                                                                                                                                                             |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /capabilities`                                               | Format version, size limits, accepted body types, optional service capabilities, CORS policy, peer identity, and admission-policy link.                                                                              |
| `GET /manifest`                                                   | Current snapshot, declared view, inventory manifest, cursors, and package availability. Raw discovery remains available when evaluation fails.                                                                       |
| `GET /inventory?kind=K&snapshot=S&after=ID&limit=N`               | Sorted event, body, or import-selection IDs from one immutable snapshot, with next cursor.                                                                                                                           |
| `GET /events/ID?snapshot=S`                                       | Exact envelope representation from the named snapshot, or explicit missing/withheld result.                                                                                                                          |
| `GET /identity-heads/KEY?snapshot=S&after=ID&limit=N`             | Known maximal own event IDs for that key, from one snapshot.                                                                                                                                                         |
| `GET /account-control?origin=O&account=A&view=V&snapshot=S`       | Controller candidates, claim chains, witness contributions, and certificate evidence.                                                                                                                                |
| `GET /import-selections/HASH`                                     | Canonical accepted-publication inventory, limited to 16 MiB.                                                                                                                                                         |
| `POST /import-selections`                                         | One canonical publication-ID array. Return its hash. Admission grants no trust.                                                                                                                                      |
| `GET /bodies/HASH`                                                | Immutable canonical body, or explicit missing/withheld result.                                                                                                                                                       |
| `GET /changes?after=CURSOR&limit=N`                               | Local receipt positions and event IDs, without causal-order claims.                                                                                                                                                  |
| `POST /events`                                                    | One envelope plus a canonical body object or null, encoded as UTF-8 JSON.                                                                                                                                            |
| `GET /receipts/ID`                                                | This server's receipt and interpretation outcome for that event.                                                                                                                                                     |
| `GET /package-parts/HASH`                                         | Canonical derived search-part bytes, with a 4 MiB uncompressed limit.                                                                                                                                                |
| `GET /packages/LANGUAGE?snapshot=S&version=N`                     | Search package manifest and content hashes. Version 1 is the default. Version 2 adds row metadata.                                                                                                                   |
| `POST /search`                                                    | Remote draft search. The JSON body carries the GET search fields and returns the same `SearchResponse`.                                                                                                              |
| `GET /search?q=Q&language=L&view=V&snapshot=S&retired=1`          | Optional remote results with view and snapshot metadata. Without `retired=1` the results hold active publications only. With it, each preview carries the publication status. Any other `retired` value is HTTP 400. |
| `GET /words/WORD_ID?view=V&snapshot=S&reviewers=1`                | Candidate IDs, rafsi claims, and attributed ranking summary. `reviewers=1` adds bounded reviewer details to each score. Any other `reviewers` value is HTTP 400.                                                     |
| `GET /identities/KEY?view=V&snapshot=S`                           | Effective profile claims, continuity state, and activity counts for one signing key.                                                                                                                                 |
| `GET /identities/KEY/activity?view=V&snapshot=S&after=ID&limit=N` | Events signed by that key in event-ID order, with their interpretation and local receipt position.                                                                                                                   |
| `GET /records?snapshot=S&after=ID&limit=N`                        | Snapshot records for local calculation: envelope, body, and body status, bounded by count and bytes. The limit ranges from 1 through 200.                                                                            |

The `POST /search` body requires string fields `q` and `language`.
Optional fields are `snapshot`, `view`, `after`, `retired`, and `limit`.
The first four use the same strings as GET. `limit` accepts a positive integer or its decimal string.
Unknown fields and query parameters on a POST search return HTTP 400.
Both search methods apply the same bounds, cursor rules, and result selection. Draft text stays in the POST body.

The POST /events body contains exactly `envelope` and `body`. Canonicalize the enclosed body and compare its hash and byte length before acceptance.
Transport whitespace outside canonical objects does not alter signed bytes. The server preserves canonical signed meaning and never changes a field to make a signature pass.
Transport `body:null` means no supplied body, even when the header contains a content descriptor.

A canonical null body is not a body type in version 1. If header content is null, a non-null transport body is rejected.
A repeated envelope with a matching newly supplied body completes availability without creating a second event.
Missing bodies are permitted for already meaningful control headers and replication. New user publication flows send the body with the envelope.

A stored new envelope returns HTTP 201 with admission `accepted`. Interpretation separately reports effective, pending, suspended, inert, or unavailable.
Its receipt includes the local position and stored-object hashes. A missing or refused body remains a separate availability state.
An existing event, including an equivalent valid signature variant, returns HTTP 200 with admission `duplicate`. A body arriving later can complete that event.

HTTP 400 reports malformed transport. HTTP 422 reports a rejected envelope or body with a field-specific code.
HTTP 413 reports size limits. HTTP 429 reports a quota and retry interval.
HTTP 403 reports local admission refusal. HTTP 503 reports temporary service failure or unavailable computation.
After an HTTP 503 read failure, a word or search page keeps the reason visible and offers “Retry reading”.
The retry preserves the route, language, and selected view. It replaces the current history entry and performs no signed write.
If a retry fails, the page shows its retry number and keeps the current error reason visible.
It announces the retry number and reason through the shell status region, even when the new failure differs from HTTP 503.

A semantic no-op or unauthorized action inside a signature-valid causal header is retained as `inert`, not misreported as a bad signature.

Different canonical headers with the same event ID return HTTP 409 and trigger quarantine.
Alternate valid signatures over an identical header are equivalent variants, not collisions. Invalid signature variants never displace a valid event.
A deprecated target does not make a judgment upload fail. The receipt describes its current lack of scoring effect.

Dependencies can arrive later. The server revisits pending events without changing their IDs.

Materialized word and search responses name their snapshot and view. Immutable-object reads carry no ranking context. Scores also name the local-overlay digest, calculation profile, work count, and exact or bounded status.
An API score is a server assertion until a client recomputes it. The UI calls the action “Recompute from records,” not “Prove correctness.”
Local recomputation needs all relevant trust and lifecycle events for the chosen inventory, not just a definition and its blessings.
The app identifies incomplete input instead of treating unrequested events as absent.

Known history gaps suspend affected identities under the format rules. Exact arithmetic over that reduced graph does not mean complete historical knowledge.

A language package contains a hashed index, body references, and the snapshot ID. Compression is transport-level and outside content hashes.
The browser makes sure that downloaded bytes match the package hashes before activating a cache version.
A package manifest from one server does not prove network-wide completeness.
The service can expose CORS to configured client origins without cookies. Never combine wildcard origins with credentialed requests.

A generic CORS proxy is not part of the baseline.

Identity-heads queries use the inventory pagination limits and event-ID order. Their response contains exactly snapshot, identity, heads, and next.
Heads contains event IDs. Next is the next cursor or null. Missing predecessors remain disclosed through the ordinary event responses.

This endpoint reports the server's known branches, not proof of complete device history. Clients union its results with their remembered own references.
They retrieve and authenticate headers before using those references for signing or a handover.

Account-control queries require a canonical HTTPS origin and a positive numeric account ID. Invalid inputs return HTTP 400.
AccountControlResponse contains exactly snapshot, view, origin, account, state, controller_candidates, contributions, certificates, chain, and reasons.
State is unclaimed, controlled, disputed, or unavailable. Controlled identifies one selected period, not a promise that its key can still issue commands.

Controller_candidates is the sorted candidate claim list. Contributions uses the witness_contributions shape defined below.
Certificates is sorted by policy ID and then claim ID. Each entry contains exactly policy, claim, and observations.
Observations contains one usable present observation per witness group of that policy, with event IDs sorted and duplicate-free.

Chain contains the sorted distinct claim IDs needed to interpret the candidate chains. Reasons is an array of stable codes.
The response includes evidence for current eligibility, closure, and any historical availability guard that affects its result.
With only historical evidence, state is unavailable and controller_candidates is empty. Reasons includes policy_history_unavailable.

PublicationStatus then has unavailable state and null claim, deciding_claim, and controller. Its authority is none.
A pending certified candidate also gives unavailable selection, with reason claim_pending. Its known candidate IDs remain visible.
State unclaimed requires no current or historical certificate. It preserves the initial active default.

The response has a 16 MiB uncompressed limit. An exceeded response or evaluation limit returns HTTP 503 with code resource_unavailable.
It never returns a silently truncated certificate list. The client can also retrieve the underlying snapshot through ordinary inventory and event routes.
These summaries remain server assertions until reconstructed from the signed records. They do not prove network-wide completeness.

### Response objects and pagination

Version 1 of this API exposes only the exact reference calculation profile. It returns unavailable scores if it cannot compute that profile.
Future derived profiles need an explicit API capability and distinct result metadata. They cannot enter the reference algorithm field below.
AssistanceProfile contains exactly id, label, provider, model, operations, and disclosure.

Its ID is an opaque configuration name. Operations lists the supported assist operations from section 16. Other values are display strings.
Public capability metadata never contains provider credentials or private endpoint URLs.
The following objects define required response fields. Optional values use null rather than omitted fields, except the fields marked with `?`, which appear only when the request asks for them or when the server supports them.

An `ID` means its prefixed string from the format specification. A cursor is an opaque ASCII string of at most 256 bytes.
Snapshot IDs, logical-inventory digests, and package hashes use the `sha256:` form. Field paths in errors use JSON Pointer syntax.
The query limit ranges from 1 through 1,000, with default 200, except where a route states a lower bound. Search returns at most 100 hits per page, and records at most 200 per page.

Transport requests have a 1 MiB uncompressed limit, except import-selection uploads with their separate 16 MiB limit. Object limits still apply after decoding and decompression.

```text
Capabilities = {
  versions: [1], max_envelope_bytes: integer, max_body_bytes: integer,
  max_request_bytes: integer, server_id: string, policy_url: HTTPS-string,
  cors_origins: [origin-string], body_kinds: [action-kind-string],
  features: {semantic_search: boolean, assistance: boolean, account_observation: boolean,
             lensisku_bridge: boolean, derived_exchange: boolean},
  embedding_profiles: [profile-ID], assistance_profiles: [AssistanceProfile],
  git_mirror: HTTPS-string | null, account_witness_service: HTTPS-string | null
}
ManifestResponse = {
  snapshot: ID, logical_inventory: ID, manifest: FormatManifest,
  view: event-ID, packages_available: boolean,
  accepted_cursor: cursor, materialized_cursor: cursor,
  packages: [{language: string, hash: ID, bytes: integer}],
  package_versions: [{language: string, version: integer, hash: ID, bytes: integer}]
}
InventoryResponse = {
  snapshot: ID, kind: "events" | "bodies" | "import_selections", ids: [ID], next: ID | null
}
ChangesResponse = {
  items: [{cursor: cursor, id: event-ID}], next: cursor,
  caught_up: boolean, materialized_cursor: cursor
}
Receipt = {
  id: event-ID, admission: "accepted" | "duplicate" | "refused",
  interpretation: "effective" | "pending" | "suspended" | "inert" | "unavailable",
  body_status: "none" | "present" | "missing" | "withheld" | "invalid",
  cursor: cursor | null, snapshot: ID | null, view: event-ID, reasons: [code-string],
  envelope_hash: ID | null, body_hash: ID | null
}
Calculation = {
  incomplete_identities: [identity-string],
  suspensions: [{identity: identity-string, cause: event-ID, reason: code-string}],
  algorithm: "simple-routes-bounds-v1", budget: integer, completed: integer,
  exact: boolean, overlay: ID, inventory: ID, logical_inventory: ID
}
Score = {
  target: event-ID | rafsi-pair-ID, support: [rational, rational],
  opposition: [rational, rational], net: [rational, rational],
  direct_reviewers: integer, status: "active" | "deprecated" | "conflicted" | "unavailable",
  reviewers?: [ReviewerDetail], reviewers_complete?: boolean
}
ReviewerDetail = {
  identity: identity-string, verdict: "bless" | "curse", weight: [rational, rational] | null,
  root: rational | null, blocked: boolean, incoming: [identity-string],
  incoming_count: integer, incoming_complete: boolean, multiple_routes: boolean
}
IdentityResponse = {
  snapshot: ID, view: event-ID, identity: identity-string, actor: identity-string,
  successor: identity-string | null, retired: boolean, compromised: boolean, suspended: boolean,
  profile: {state: "none" | "known" | "conflicted" | "unavailable",
            claims: [{event: event-ID, issuer: identity-string | null, body_hash: ID | null,
                      body: ProfileBody | null, body_status: "present" | "missing" | "invalid" | "unavailable" | "omitted"}],
            claims_count: integer, claims_complete: boolean},
  counts: {definitions: integer, rafsi: integer, judgments: integer, trust: integer, reports: integer, other: integer}
}
ActivityResponse = {
  snapshot: ID, view: event-ID, identity: identity-string,
  items: [{id: event-ID, action: action-object, interpretation: interpretation-string, seen: cursor | null}],
  next: event-ID | null
}
AcceptedActivityResponse = {
  snapshot: ID, identity: identity-string, history: "accepted",
  items: [{id: event-ID, action: action-object, interpretation: "unavailable", seen: cursor | null}],
  next: event-ID | null
}
RecordsResponse = {
  snapshot: ID, logical_inventory: ID,
  items: [{id: event-ID, envelope: envelope-object, body: canonical-object | null,
           body_status: "present" | "missing" | "unavailable" | "none"}],
  next: event-ID | null
}
PublicationStatus = {
  event: event-ID,
  state: "active" | "deprecated" | "conflicted" | "uncertain" | "unavailable",
  frontier: [event-ID], reasons: [code-string],
  controller_candidates: [event-ID], deciding_claim: event-ID | null,
  witness_contributions: [{witness: identity-string, claims: [event-ID], observations: [event-ID]}],
  authority: "native" | "source-account" | "none" | "uncertain",
  controller: identity-string | null, claim: event-ID | null, observations: [event-ID]
}
WordResponse = {
  snapshot: ID, view: event-ID, calculation: Calculation | null,
  word: WordObject | null, definitions: [event-ID], rafsi: [event-ID],
  assignments: [{id: rafsi-pair-ID, claims: [event-ID], status: pair-status}],
  scores: [Score], statuses: [PublicationStatus], layers: [[event-ID]],
  unavailable_scores: [event-ID | rafsi-pair-ID]
}
SearchResponse = {
  snapshot: ID, view: event-ID, query: string, language: string,
  segmentation?: "complete" | "limited",
  hits: [{word: WordObject, word_id: word-ID, match: match-kind,
          definitions: [event-ID]}], next: cursor | null
}
Error = {code: string, message: string, event: event-ID | null, field: string | null}
```

Reviewer details appear only when the request asks for them. Each list is bounded to 64 entries, and `reviewers_complete` says whether the list is complete.
A detail names the resolved actor, its effective verdict, and its influence interval under the same graph that produced the score.
`root` is the actor's starting allowance when it is a root of the view. `incoming` lists the actors whose resolved heeds reach it directly, bounded to 16.
`multiple_routes` is true when the actor has more than one direct source of influence in the effective graph: its direct incoming heeds plus its root allowance, when it has one. It does not count indirect routes. The response never states a per-route share, because the bounded calculation does not derive one.
The shared core materializes the details only for a request that asks for them, bounded to 64 before serialization. A request without the flag does no reviewer-detail work.
An older server omits the field. A client distinguishes that omission from an empty list, which means that no reviewer exists.

Identity responses resolve the profile register under the effective continuity rules. Concurrent profile claims appear together with state `conflicted`.
A response lists at most 16 claims in event-ID order with at most 1 MiB of claim bodies in total. `claims_count` is the number of concurrent heads, and `claims_complete` is false when the list or a body was cut. A cut body has `body_status` `omitted`.

A body absent from the snapshot has `missing`. Returned bytes that fail body validation have `invalid`. These claims keep state `known` unless concurrent heads conflict. A retained body or envelope that storage did not return has `unavailable`. Only that storage failure sets profile state `unavailable`.

If the selected view cannot be evaluated, the identity route returns HTTP 503 with code `resource_unavailable`, like the search and word routes. It never asserts that an identity has no profile, successor, or compromise notice without an evaluation. The activity route still answers, with interpretation `unavailable` per item.
`/identities/KEY` and `/identities/KEY/activity` are the only identity paths. A longer path is HTTP 404.
The counts describe events signed by that exact key in the snapshot. They are raw authorship, not imported source attribution.
Activity items use event-ID order, which is stable but not chronological. `seen` is this server's receipt position, for navigation only.

Lifecycle safety reads must include accepted records that still wait for evaluation.
Without a snapshot parameter, `/identity-heads/KEY` names the latest accepted snapshot.
The client pins later head pages, activity pages, and envelope reads to that snapshot.

`/identities/KEY/activity?accepted=1` lists raw history from its requested snapshot without evaluating state or requiring an available view.
Without a snapshot parameter, this mode uses the latest accepted snapshot.
Its response includes `history: "accepted"`, and every item has interpretation `unavailable`.
It omits `view` because it supplies no evaluated result.
Other values of `accepted` return HTTP 400.
Ordinary activity responses keep their completed-view behavior and omit this marker.

A lifecycle scan must require the accepted-history marker and its pinned snapshot on every activity page.
An ignored mode, incomplete page sequence, unavailable record, or invalid signature cannot establish an empty history.
The client authenticates listed lifecycle claims from their signed envelopes before it uses them.

The records transport returns the committed envelope representation of the snapshot with its body when retained. Pages hold at most 200 records, and the encoded `items` bytes, as the response carries them before any transport compression, stay under 4 MiB. A page always holds at least one item, so one item can exceed that bound alone.
`body_status` `missing` means that the snapshot never retained the body. `unavailable` means that the snapshot retained it and storage did not return it now. A client keeps the two apart: a missing body is a fact of the snapshot, and an unavailable one deserves another request.
A client authenticates each envelope and body through the shared core and compares the complete set with the snapshot inventory before claiming a complete local calculation.

Word layers contain definition IDs only. Assignment status is `eligible`, `inactive`, or `unknown`, with distinct pair scores.
Statuses contains one entry for each returned definition, sorted by event ID. It uses the response's exact snapshot and view.
Frontier lists the deciding maximal status actions, or their union during a controller dispute. Event-ID arrays are sorted and duplicate-free.

Controller_candidates contains the candidate period claim IDs. Deciding_claim names the period that supplies the value, or null for a default, dispute, or unavailable selection.
Each candidate claim exposes its signed previous and carry fields through the ordinary event API. The client fetches these records to inspect inheritance.
Witness_contributions identifies each current witness group, its contributed claims, and the maximal retained observations that explain those contributions.

It sorts by witness identity. A full certificate can also require older observations, exposed through the account-control endpoint.
Reasons uses stable codes, including controller_dispute, binding_unavailable, witness_history_incomplete, policy_history_unavailable, carry_history_pending, current_authority_lost, and claim_pending.
Authority describes permission for a new command independently of the displayed state. A dispute or lost controller authority disables commands.

Controller identifies the unique retained controlling identity group when available. Otherwise it is null.
Claim names the unique selected controller period even when its key authority is unavailable. It is null during a controller dispute or when no eligible controller is selected.
Observations gives one usable certificate observation per current witness group for that unique claim, sorted by event ID.

Choose a causally maximal matching present observation for each group. If several agree, use the smallest event ID for representation only.
The choice of equivalent evidence never orders claims or status values.
Native status uses empty controller_candidates, witness_contributions, and observations, with null claim and deciding_claim. Its controller follows native author rules.

An uncertain or unavailable definition status receives no numerical Score. Its ID appears in unavailable_scores instead.
All server-derived fields remain assertions until recomputed. An API response alone never proves account control or authorizes a signature.
Only eligible pairs receive a Score, with status active. Inactive pairs expose no numerical score and retain their historical judgments.

Unknown pairs appear in unavailable_scores. A claim publisher never controls the whole pair's status alone.
Rationals use the numerator and denominator object from the format specification. Score endpoints are ordered from lower to upper.
Score numerators can be negative. Calculated rational sizes are not restricted to the configuration's billion-unit input bound.

Serialize calculated numerators and denominators as decimal strings to preserve arbitrary precision.
This output distinction never changes signed configuration encodings.

The budget applies separately to each distinct comparison-context graph.
`completed` sums completed expansion work across those distinct graphs, so it can exceed one budget.
Reusing the same graph counts its completed work once.
`exact` is true only when every required graph completes exactly.
An unavailable graph prevents `exact` from being true.
Individual unavailable scores remain listed as unavailable.

The response never invents zero scores for unavailable targets.

Receipt admission describes storage, interpretation describes action effect, and body status describes availability. These dimensions do not substitute for each other.
Receipt view identifies the server's selected interpretation policy. Admission does not depend on whether that policy enables imported author controls.
The receipt endpoint returns current derived state. A prior receipt position remains stable when interpretation changes after synchronization.

An envelope hash covers the complete canonical stored envelope. It can change when the service selects another equivalent valid signature variant.
Its event ID and signed header remain unchanged. Use the envelope hash as the HTTP ETag for that representation.
A client can retain either valid variant indefinitely without changing logical state.

Replication supplies snapshot=S when fetching envelopes. The server returns that snapshot's committed representation, even after its current preferred variant changes.
Without a snapshot parameter, GET events returns the current retained representation. It does not promise bytes from an earlier manifest.
Expired representations return HTTP 410 for that snapshot. A client then reconciles against another advertised snapshot.

A GET event, body, or import-selection success returns the canonical object directly, with its ETag.
An import-selection POST returns HTTP 201 for new bytes or 200 for existing bytes, with exactly hash, bytes, and count.
The hash is its content ID. The counts are uncompressed bytes and publication IDs. The server accepts no malformed or unsorted selection.

A chosen signed view grants import-selection authority. Upload alone grants none. It does not add a ranking wrapper.
A missing object returns HTTP 404 with code `missing`. An explicit service refusal returns HTTP 451 with code `withheld` only for legal restrictions.

Other explicit refusals return HTTP 403 with code `withheld`. A server can conceal possession by returning `missing` instead.
A client must not infer nonexistence from either response.
An invalid cursor returns HTTP 400 with code `bad_cursor`. An expired cursor or snapshot returns HTTP 410 with code `snapshot_expired`.

Inventory `after` is exclusive and must use the requested identifier family. Its next value equals the last returned ID, or null at the end.
Changes cursors are server-specific and never transferable between peers. Empty changes pages retain the supplied cursor and set caught_up appropriately.

An empty-string cursor is invalid. A request without a changes cursor starts from that server's earliest retained receipt. An empty initial log returns its opaque initial cursor. Retention gaps require snapshot reconciliation through HTTP 410.
Search accepts an optional `after` cursor tied to the same query, language, retired flag, view, and snapshot.

Match kinds are `headword`, `gloss`, `sequence-exact`, `sequence-contiguous`, `headword-prefix`, `gloss-prefix`, `sequence-subsequence`, `token`, and `component`, in that relevance order.
The `component` class uses the first uncovered occurrence of each query word before the stable word-ID tie break.
New servers return `segmentation` on every page. Older servers can omit it.
`complete` means that segmentation completed within its limits. It does not assert that every query run has a Lojban reading.
`limited` states that a query or headword indexing limit prevents complete sequence coverage.
Search cursors bind the matching version as well as their query, language, retired flag, view, and snapshot.
Search responses identify candidates but carry no unqualified quality score. The word response supplies ranking when requested.
A calculation failure leaves calculation null and lists every affected target in unavailable_scores. It does not replace unknown scores with zero.
A no-judgment candidate has an exact zero score when complete graph inputs support that conclusion.

### Search package contract

The server returns HTTP 200 for the manifest when publication receipts cannot be evaluated.
Its snapshot, inventory manifest, cursors, and declared `view` remain available for record synchronization and policy inspection.
The declared view does not claim successful evaluation. Readers can choose another view without changing the server's declaration.
Without a configured view, the declaration uses `jve1:` followed by 64 zeroes. This sentinel does not identify an available signed policy.

Clients treat this sentinel as no selected view and do not fetch a signed policy for it.
Record synchronization requires a real view selection and never saves this sentinel as the inventory's view.
A reader's explicit selection of a real signed view still overrides the server declaration.

When publication receipts cannot be evaluated, the manifest sets `packages_available: false` and returns empty `packages` and `package_versions` arrays.
Package downloads then return HTTP 503 with `resource_unavailable`. Existing downloaded packages remain available in the browser under their saved snapshots.
With `packages_available: true`, empty descriptor arrays mean that the server has no language packages in that snapshot.

Older servers can omit both new fields. Clients retain the earlier word-response view lookup when no explicit view choice exists.
An absent availability field retains the earlier package-discovery behavior. A present field must be a boolean, and a present view must be an event ID.

A package manifest contains exactly `version`, `language`, `snapshot`, and `parts`. Version is 1 or 2.
The manifest response lists version 1 packages in `packages` and every other version in `package_versions`.
A client requests a version explicitly with the `version` query. The default remains version 1.
Each part contains `hash`, `bytes`, and `count`. Part hashes identify canonical JSON arrays of search entries.
Parts contain at most 2,000 entries and 4 MiB uncompressed. These are derived artifacts, not signed event bodies.

Their dedicated endpoint uses that limit rather than the 256 KiB event-body limit. Split a larger package into more parts.
An entry contains `event`, `word`, `language`, `glosses`, `plain_text`, `classification`, and `body`.
Event is the publication ID. Word is its word object. Body is its body hash or null.
A version 2 entry adds `issuer`, `notes`, `rafsi`, `rafsi_complete`, and `attribution`.
Issuer is the signing key, which is the importer for an import. Notes is true when the definition has notes.
Rafsi lists the spellings of retained rafsi claim bodies for the word, sorted, at most 64 of them. `rafsi_complete` is false when the word has more claims than the list holds. Missing, unreadable, or invalid claim bytes also set `rafsi_complete` to false. A client never treats a cut list as a complete conflict inventory. The exact claims of a word are the `rafsi` event IDs of the word route and their claim bodies.
Attribution is null for a native publication.
If an advertised version 2 package fails its checks, the client uses the version 1 package instead and records the reason with the cached package. It shows that state wherever it describes the package. It never falls back without that record.
For an import it contains `source`, nullable `author`, nullable `account` with `origin` and `account`, and `dates`, a map of source date labels to source strings.
These fields are server assertions derived from the records. They are not part of the signed format, and a client can authenticate them against the records.

Other fields use definition shapes, except plain_text, which is a literal search string derived from rich text.
The package sorts entries by event ID and preserves alternatives. It does not encode one chosen definition per word.
The manifest hash covers its canonical bytes. Package entries are derived index data, not new signed claims.
The app can reconstruct them from authenticated publications and flag disagreements.

## 12. Admission, privacy, and rendering

The Worker applies limits before expensive signature work and separates anonymous network quotas from key-based quotas.
A new key does not bypass every network limit. A trusted key does not bypass parser or signature rules.
The operator publishes local refusal reasons and an appeal or contact path when it offers one.
Rate limits never rewrite valid records or become a claim about linguistic quality.

Render plain text and the format's permitted nodes only. Sanitize any generated markup through a shared renderer.
Each inline string renders in a bidirectional isolate, which prevents its direction controls from affecting neighboring nodes.
The editor and renderer flag invisible directional controls. Source and difference views show C0, C1, and bidirectional control characters as visible escapes.

These presentation rules never rewrite signed bytes. Identity names use isolated elements, and fingerprints use isolated left-to-right elements.
External links show their destination and use safe navigation attributes. No external images or embeds load from dictionary content.
Apply a restrictive Content Security Policy and self-host executable assets and fonts.

The signer page uses no third-party script. Dependency updates remain a code-supply risk despite these controls.

Search history, private heeds, drafts, and backup passphrases remain local by default.
Public heeds, judgments, reports, and publication content can be copied indefinitely after delivery.
The first-signature explanation covers retained public history for direct actions without a preview.
Later previews also state that clearing or deprecating an action does not erase its public history.
Peer addresses and outbox receipt times reveal some network activity. The app does not describe the protocol as anonymous.

## 13. Accessibility and review tools

Every input has a persistent label. Every icon control has an accessible name.
Focus is visible. Dialogs restore focus to their invoking control. Status changes use noninterrupting announcements.

All actions work by keyboard. Standalone touch controls are at least 44 by 44 CSS pixels.
Inline prose links and place markers use the [WCAG inline exception](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html).
They remain clickable without overlapping enlarged hit areas.
Equivalent 44px place-navigation controls can appear in the existing place strip or details.
Do not insert another control beside every inline marker occurrence.
Outlined fields and buttons use ink3 or accent boundaries that meet 3:1 contrast in every enabled state.
The line and line2 tokens remain decorative. Quiet text actions remain visibly identifiable without a forced box.
The app meets WCAG 2.2 AA contrast and interaction requirements as a release target.
Test zoom, screen readers, reduced motion, long words, and right-to-left interface text.

The review queue is optional and contains dictionary work only.
It offers competing definitions, new unreviewed submissions, revisions of watched definitions, and rafsi conflicts as separate filters.
No account receives trust automatically because it works through the queue.
The activity model supports testing a review queue. It does not establish a correct priority algorithm or expected review rate.
A bulk curator action shows every exact revision before signing separate judgments.

Batch progress exposes partial delivery without pretending that the actions form a network-wide transaction.

## 14. Acceptance scenarios

The implementer must demonstrate these end-to-end cases before public release:

1. Anonymous lookup works with local search and with a warm offline cache.
2. A first-time contributor writes a short literal definition, exports a key backup, and publishes without advanced fields.
3. A structured definition preserves numbered order when its prose mentions place 3 before place 1.
4. A cmavo has both a grammatical operand and a constructed-predicate frame without confusing their indices.
5. A malformed place reference blocks signing and offers a lossless literal-text escape.
6. Two devices change one judgment offline, then resolve their conflict without a timestamp tie-break.
7. A published revision receives its author blessing, inherits no parent judgments, and displays exact changes to places and defaults.
8. Private Ignore writes an overlay.blocked entry and blocks routes while an unrelated public report remains an allegation.
9. Root changes appear as a view change, with no claim that scores are comparable universal units.
10. Broad score intervals remain visible when most candidates form one unresolved layer, including a long list of alternatives.
11. Wrong-password, altered-backup, unsupported-algorithm, quota, and storage-eviction cases preserve honest UI states.
12. Partial transfer delivery remains recoverable through the saved acceptance event and new key.
13. A missing predecessor, withheld body, late compromise notice, and server omission produce distinct warnings.
14. Keyboard and screen-reader users can search, publish, review places, manage keys, and resolve an opinion conflict.
15. Judgment arrows create or unlock a key, resume the exact target, and clear a selected judgment on repeated activation.
16. Every public publish group persists before dispatch, including definition and rafsi blessings, and survives partial delivery or reload.
17. A timeout queries the receipt by ID before immutable retry. Normal sends and index lag never create false failure markers.
18. “Not delivered” clears delivered rows while retaining records and receipts. With no waiting or stopped records, its marker disappears. Its direct route then shows an empty state.
19. Net scores expose support, opposition, reviewer count, exact values, ranges, and unavailable state through keyboard and touch.
20. Search rows expose rafsi, notes, matching alternatives, more results, retired results, and immediate judgment actions.
21. New native definitions contain the fixed CC0 expression, URL, and empty attribution. Imported records retain source rights and author attribution.
22. The default local lexical nearby search sends no private draft. Explicit remote search and new providers obtain consent for their declared scope.
23. Private blocks survive a public clear. Root removal never claims to block every incoming route.
24. The full editor preserves every structured field and supports manual headword and type entry without bypassing validation.
25. Every page exposes search and footer navigation, including all twelve layouts in [UI design](ui-design.md).
26. Header-only acceptance retains a missing-body row until matching body delivery completes. Body refusal never becomes index lag.
27. A nonzero exact score never displays as zero. “No judgments yet” requires known zero direct reviewers.
28. First-signature copy explains public history before direct judgments or trust actions without adding per-action confirmation.
29. Manual Form preserves spelling, classification, and notes, and private Ignore writes the scoped blocked entry.
30. Stop retrying keeps the record listed as “Stopped”, with Resume and Save as file. Discard appears only when no later local own record depends on it. The marker still counts it.
31. Resume delivery retrieves receipt state and retries identical bytes to the original recipients, including after reload.
32. Permanent refusal stays auto-paused. Stopping neither retracts public records nor promises cancellation of an in-flight request.
33. Outlined control boundaries meet 3:1 contrast in every enabled state in both themes.
34. Discard refuses a stopped record when a later local own record depends on it, directly or transitively. Resume and Save as file remain available. Discarding an independent stopped leaf restores its retained predecessors to the frontier when they become maximal. No later signature names the discarded ID.

The app must also measure cold package load, local search latency, signature latency, backup unlock time, and ranking cost on representative mobile devices.
No target in this design constitutes a completed browser compatibility or accessibility audit.
Performance targets are under 100ms for warm local search and under 200ms for routine noncryptographic interaction.
Longer cryptographic or ranking work needs cancellable progress and must not block typing or reading.

## 15. Rationale and sources

[Toadua](https://toadua.uakci.space/) informs the compact contribution and definition layout.
[Paclatkerlo](https://paclatkerlo.com/?en) informs immediate lookup and restrained visual hierarchy.
Reference software licenses do not establish rights in all dictionary content.

[WebCrypto Ed25519](https://www.w3.org/TR/webcrypto-2/#ed25519) supplies standard key operations, subject to runtime support.
[JWE](https://www.rfc-editor.org/rfc/rfc7516) and its [password-based algorithm](https://www.rfc-editor.org/rfc/rfc7518#section-4.8) define the selected encrypted container.
[WebAuthn PRF](https://www.w3.org/TR/webauthn-3/#prf-extension) supports the optional unlock direction, with origin and implementation limits.
[WebKit's storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/) and the [Storage Standard](https://storage.spec.whatwg.org/) explain why local storage needs export paths.

The hosting design uses [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/), [R2](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), and [D1](https://developers.cloudflare.com/d1/worker-api/).
Its coordination state uses [Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
[Workers compatibility documentation](https://developers.cloudflare.com/workers/configuration/compatibility-flags/) identifies the native-process limitation.
These services are selected components, not evidence that an implementation already exists.

## 16. Semantic search and optional AI

Semantic search finds definitions with related meanings. It supplements exact spelling, gloss, and ordinary text search.
A reader can choose a configured embedding profile and see its language coverage and indexing progress.
Semantic similarity is neither an endorsement nor a probability that two definitions mean the same thing.
The interface keeps similarity, editorial support, and direct reviewer counts distinct.

The server retains portable vector artifacts under the repository specification's derived-data contract.
It can compute them with a configured local model, a cloud embedding provider, or a trusted peer's compatible cache.
A cache still needs a compatible query-vector service. Downloaded document vectors alone do not make semantic search work offline.
The browser can offer offline semantic search only when it also has a compatible local model and enough retained vectors.
Ordinary offline search and the manual wizard remain available without either.

A result identifies its profile and definition revision. New or changed definitions show pending indexing until their vectors are available.
The server never substitutes a vector for another revision without proving that its declared input bytes match under the same profile.
It also retains the target event association explicitly. Identical text does not merge authors, definitions, or judgments.

Different profile distances never enter a common sorted scale. The first release shows one selected profile at a time.
A later rank-fusion feature must label its algorithm and every contributing profile.

Cloud model aliases can change. The operator exposes revision and compatibility limits for each profile.
A failed compatibility probe or provider change disables the affected semantic index until repaired. Lexical search continues normally.
A signature on shared vectors identifies the producer. It does not prove that the producer computed good embeddings.

The operator's trusted producer list remains inspectable service policy, separate from dictionary trust roots.

### Inference configuration and consent

Every AI action is optional, including type, component, source-word, definition, selma'o, place, and gloss suggestions.
Operators can disable all generation, disable individual tasks, or disable remote providers while retaining local models.
Capabilities report those decisions. Disabled or failed AI never prevents manual authoring, signing, reading, or synchronization.
Operators can turn on a decision report, which is off by default. Each request then asks the model to write one detailed report before its tool call. The report recounts the arguments behind every decision as one connected text. The inference log shows it as text that the assistant wrote. The setting costs more tokens. It exists to collect material for prompt tuning.
The system prompt puts `explain.txt` after the task file. For `sources`, it follows `sound-guide.txt` and precedes the language block.
The language block stays last. Without a language block, `explain.txt` is last.

The Assistance group of Settings has one checkbox, “Use AI assistance”. It is on by default when the server offers assistance.
When it is off, the app hides every AI tagged button, every suggestion panel and its notes, the consent dialog, the “by meaning” search mode, and every AI hint line. Hidden controls leave no gap, and every manual path stays complete. The app sends nothing to a provider.
When no assistance capability is available, the app looks the same. The checkbox is replaced by the line “Not available on this server.” The user's own choice is kept for a server that offers assistance later.

The server offers assistance when capabilities expose a generation operation or a query-available embedding profile.
A generation operation requires `features.assistance` and an `assistance_profiles` entry that lists the operation.
Meaning search requires `features.semantic_search` and a `query_available` embedding profile. A partial setup keeps the checkbox and exposes only available actions.
If neither capability is available, the checkbox gives way to “Not available on this server.”

While assistance is off, search uses “by words” and keeps the stored mode unchanged.
When assistance returns, the stored mode returns if its required capability is available.
The same fallback applies whenever the stored mode's capability is unavailable, including when assistance is on for generation alone.
Search uses “by words” and preserves the stored preference. The stored mode returns when its capability becomes available.

The baseline provider interface is a documented subset of OpenAI-compatible Chat Completions and Embeddings over HTTP and JSON.
It uses `/chat/completions` and `/embeddings` under a configured base URL. It does not depend on legacy text completions.
This is an interoperability target, not a claim of one universal standardized protocol.
OpenRouter, Ollama, vLLM, and other compatible providers can use explicit adapters for their supported fields.
Required model parameters, structured-output support, and context limits are discovered or configured and then tested for that adapter.

A provider without enforced JSON Schema output can still supply proposals after strict local parsing and validation.
The server checks each answer and runs the correction loop. The model answers through one `submit_answer` call.
For a failed answer with one usable call, the server appends the assistant turn and returns the exact problems as its tool result.
After three failed answers for one task, the suggestion fails.
A response without a `submit_answer` call counts as one failed answer and gets no tool result.
A response with multiple calls also counts as one failed answer.
Missing or repeated calls add the problem “Call submit_answer exactly once with the complete answer.”
For either case, the server appends the assistant text without tool calls, followed by a user message that lists the problems.
The next request keeps the existing exchange and adds those turns. It uses the feedback text in the [answer checks](../prompts/README.md#checks-on-an-answer).
It does not restart the request or add a tool result.
After three failed answers, including responses without that call, show the same failed state.
Invalid output never enters a signed body automatically.

Every AI action has four states. Idle is the AI tagged button. Working replaces the button with one status line, a spinner, and Cancel. A retry says so with its count, such as “The first answer had errors, so the assistant is trying again (2 of 3).” Done is the suggestion panel. Failed is one line in the button's place, such as “No usable answer after 3 tries. Try again or fill the rows in by hand.” The failed line never blocks the manual path.

Every suggestion panel, note, and failed line links to the inference log with “How the assistant decided”. The log is a modal that shows the whole exchange that produced the suggestion.
Its header names the task, the model and reasoning level, and the provider. It links the prompt version to the public prompt file.
It shows the time and duration, and the number of answers and corrections.
It shows tokens and cost only when the provider sent those figures. Omit each missing figure.
One line says that the provider does not make the assistant's private reasoning available, and that the log holds the shared reasoning summary and everything that the assistant wrote.
The rows start with the collapsed system prompt and the app's request.
Each answer shows its shared reasoning summary or “No reasoning summary was shared for this answer.”
It also shows the assistant text, tool calls, available token counts, and the server's check.
A failed check lists each problem that the server sent back to the assistant.
“Export as Markdown” saves the log as shown. “Export raw JSON” saves the retained request and response bodies with credentials and encrypted reasoning removed.
The browser keeps the log with the draft. The server temporarily holds the private job result and log until expiry or explicit deletion.
A publication does not include the log.

Server configuration supplies provider base URL, authentication secret reference, models, task capabilities, request limits, and permitted provider-specific parameters.
The browser receives capability names and disclosure metadata, never the operator's API key.
Localhost means the machine that makes the request. A container's local provider address is not the browser's localhost.
Public clients cannot turn an inference request into an arbitrary outbound URL fetch. Only configured provider and source adapters make network requests.

The first AI request shows one consent dialog for the selected provider and its declared tasks and data scope.
The dialog names the server, provider, and fields sent. A broad scope is permitted only when the dialog declares it explicitly.
Remembered consent applies only to that provider and scope. A new provider or expanded scope requires a new disclosure.
Related public dictionary definitions and analysis of an already supplied spelling do not expand that scope.
The dialog mentions those public definitions in a fixed line outside its remembered scope.
A new embedding route that receives the original meaning requires a new disclosure unless the current statement already names it.
Type jobs use lexical retrieval until a query-available semantic route is named in that statement.
Every suggestion request requires an explicit action. Enabling a provider never uploads private drafts passively.
After consent, buttons use a small “AI” tag without repeated provider text.
Suggestions appear in a quiet panel with “Use this” and “Dismiss.” Accepted text becomes ordinary draft text with undo.
The service does not retain draft prompts or outputs in ordinary logs or peer sync.

Queued inference jobs have an exposed expiry policy. After the server's job expiry, private outputs remain local draft data unless the author publishes selected content.
Cancel stops further local processing and requests upstream cancellation where supported. It cannot guarantee reversal of an already billed provider request.

Provider output and retrieved definitions remain untrusted data. They cannot execute tools, install grammar rules, sign events, or make external writes.
Suggestions include model, provider, prompt-recipe version, and optional usage information.
The app validates each proposal against the permitted task fields and the current draft revision before showing an apply action.
If the draft changed meanwhile, show a stale suggestion comparison. Never overwrite newer edits automatically.

An undo record survives draft reload and mode changes.

### Optional service API

The common API adds the following endpoints. Both standalone and Workers hosts implement identical contracts when they advertise each capability.

| Endpoint                   | Contract                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `GET /embedding-profiles`  | Available profiles, query availability, coverage, and provenance limits.                |
| `POST /search/semantic`    | Meaning search under one profile and one dictionary snapshot.                           |
| `GET /session`             | Establish or renew the caller's private assistance session and return its CSRF token.   |
| `POST /assist`             | Start one private suggestion job and return HTTP 202, with no publication side effects. |
| `GET /jobs/ID`             | State, progress, result, and log of the caller's job.                                   |
| `DELETE /jobs/ID`          | Request cancellation of that caller's job.                                              |
| `GET /assist/prompts/FILE` | Public text of a prompt file named by the inference log.                                |

Embedding-profile responses contain exactly profiles. Each entry contains id, label, query_available, indexed, eligible, pending, and limitations.
Id is a profile hash. Counts are nonnegative integers. Limitations is an array of strings. Query_available is a boolean.
Optional snapshot, view, and language parameters select the profile response's coverage context.
Without them, coverage uses the completed snapshot, configured view, and all languages.
Query availability requires a compatible published index for the requested view and selected profile.
Each result must match the exact event, envelope, body, word, language, and extraction version in the requested snapshot.
Pending or failed entries remain outside the results. Other indexed definitions remain searchable.

The semantic request contains query, language, snapshot, view, profile, and limit. Query is nonempty text of at most 16 KiB.
Language is a definition-language tag. Snapshot and profile are hashes. View is an event ID. Limit ranges from 1 through 100.
The selected profile can impose a tighter input limit, including its literal prefix. The server rejects that limit before paid dispatch.

The response contains snapshot, view, profile, query_hash, hits, and coverage.
Each hit contains event, word, distance, and position. Word is its word ID. Distance is a finite JSON number under this external API.

Position is the one-based search order. Equal distances use event-ID order. Coverage contains indexed, eligible, pending, and failed counts.
No semantic response labels its distance as a dictionary score. A word-page request supplies editorial calculations separately.

The assist request contains operation, draft_revision, language, meaning, current, context, and profile.
Operation is type, lujvo, gismu-sources, cmavo-class, definition, or places-glosses.
Draft_revision is a client-generated random revision string. Meaning is nonempty text of at most 16 KiB.
Current contains exactly word_type, classification, spelling, text, frame, glosses, formation, and compound.

Word_type and spelling are nullable draft strings. Classification is null or the definition classification object.
When both word_type and classification are present, their lexical kinds must agree. Other fields use the corresponding definition shapes and permit empty values.
`current.formation` uses signed source fields, so a request never carries private `stem` or `ipa` fields.

Context is at most 32 exact definition event IDs. Profile names an advertised generation configuration, not an arbitrary provider URL.

The total uncompressed request limit is 256 KiB. The server also enforces task-specific token and billing limits.
A request body that does not arrive within ten seconds returns HTTP 408 with code `request_timeout`.

A completed suggestion contains operation, draft_revision, proposals, explanation, provenance, usage, and log.
For type results, `existing` is null or contains `word`, exact `event`, nullable `conversion`, and nullable `revised_definition`.
Conversion is `se`, `te`, `ve`, or `xe`. Short related refs stay in the private exchange log and never replace the resolved result event.
A null type has an empty proposals array. Other operations still require proposals.
Each proposal contains path and value. Path is a JSON Pointer into current, restricted by the operation's allowlist below.
Explanation is literal text. Provenance contains provider, model, revision, recipe, and seed. The reference service returns null for revision and seed.
`revision` is a string or null. `seed` is a safe integer or null.

Usage contains input_tokens and output_tokens. Each count is a nonnegative integer or null when unavailable.
Reasons for proposed field edits travel inside proposal values. Panel-only reasons travel in the accepted tool arguments described below.
Place type alternatives use `type_hints.note` paragraphs with `type: reason`. Derivations keep the full kind prefix in `explanation`.
Word type alternatives appear as an additional line in `explanation`, with the display type and its own reason.

Proposed source `notes` contain only the new selected sense and note with `Sense: ` and `Note: ` prefixes.
Proposals never target identity, signatures, publication status, trust records, source ownership, or delivery state.

The result's `log` contains the complete private provider exchange:

```text
InferenceLog = {
  operation: string, model: string, reasoning_effort: string, provider: string,
  prompt_version: string, prompt_files: [string], started_at: UTC-string,
  duration_ms: integer, answers: integer, corrections: integer,
  input_tokens: integer | null, output_tokens: integer | null,
  cost_usd: number | null, unknown_cost_attempts: integer,
  exchanges: [{task: string, system_prompt: string, request: string,
    attempts: [InferenceAttempt]}]
}
InferenceAttempt = {
  attempt: integer, reasoning_summary: string | null, text: string,
  usage: object | null, cost_usd: number | null,
  request: object, response: unknown
} & (
  {tool_calls: [SubmitAnswerCall], check: {accepted: true, problems: []}} |
  {tool_calls: [unknown], check: {accepted: false, problems: [string]}}
)
```

Each exchange corresponds to one task. Its attempts keep request and response bodies with credentials and encrypted reasoning removed.
The exchange's `request` is the initial user-message text for that task, including the requested-key list and any permitted-component-place list.
The [prompt guide](../prompts/README.md#request) defines both lists.
Each attempt's `request` is the full provider request body, including messages and tools. Neither field includes authentication headers.

The log also keeps the assistant text, shared reasoning summary, calls, checks, timing, configured reasoning level, and available usage and cost.

An accepted attempt has exactly one tool call of this shape. Its `function.arguments` is JSON text, decoded by the task's answer shape:

```text
SubmitAnswerCall = {
  id: string, type: "function",
  function: {name: "submit_answer", arguments: JSON-string}
}
HintsAnswer = {requested-place-key: [{type: current-tag | "unclear", reason: string}]}
MappingsAnswer = {requested-place-key: [{component: supplied-component-place | "none" | "unclear", reason: string}]}
```

For a task exchange, the browser reads these arguments from the attempt whose `check.accepted` is true.
The decoded answers use the [task shapes](../prompts/answer-shapes.json).
`requested-place-key` is an `xN` key in the retained requested-key list.
`supplied-component-place` is a label such as `klama[2]`: a supplied component spelling and a one-based place index listed in the request.
The model sees and writes these spellings. Any internal component labels remain an application detail.

The browser uses the requested place key, task, sentinel, and reason to show panel-only hints and mappings.
An `unclear` hint or a `none` or `unclear` mapping produces no field edit for that item.

An aggregate `/frame` proposal can carry other edits. For a panel-only item, it must retain the authored hint or derivations.
Acceptance never applies an empty hint or derivation list in place of that retained metadata.

Missing cost stays null. `unknown_cost_attempts` counts attempts without a known cost. `answers` and `corrections` count across all tasks in the job.
The browser uses these fields for the inference log and its exports. No provider credential enters the log.

| Operation      | Permitted proposal roots |
| -------------- | ------------------------ |
| type           | word_type                |
| lujvo          | spelling and compound    |
| gismu-sources  | formation.sources        |
| cmavo-class    | classification.selmaho   |
| definition     | text                     |
| places-glosses | frame and glosses        |

A cmavo-class proposal requires the draft classification to be cmavo. The author reviews its proposed selmaho array before acceptance.
A type proposal uses the ordinary type-change flow. Acceptance clears an incompatible classification to null and preserves its prior value in draft undo history.
The author must complete the new classification before publication. The app never treats the old classification as valid for the new type.

A gismu-sources request requires a non-null formation object with exactly one source row.
The browser copies `current` and reduces `formation.sources` to the selected row for that request.
Its source language is `current.formation.sources[0].language`. The request's `language` still names the definition language.
The server uses that row's language to choose the source-language prompt. An unsupported source language is rejected before provider work.

The manual builder initializes the formation object before requesting suggestions. The response proposes edits for that one source row.

The browser keeps a stable private ID for every row. It records that ID, the original index, language, row values, and draft revision when requesting.

The proposal path stays `/formation/sources`, with a one-element array. Its first element is a partial object containing only proposed fields.
It permits only `word`, `word_ipa`, `stem`, `ipa`, `input`, and `notes`. This object is a partial draft edit, separate from the signed formation schema.
The proposal can carry private `stem` and `ipa` values even though `current.formation` and signed sources exclude them.

Non-null `word`, `word_ipa`, `stem`, and `ipa` map to their matching fields. Non-null `sounds` maps to `input: {format: "lojbanized", text: sounds}`.
A null `word`, `word_ipa`, `stem`, `ipa`, or `sounds` omits its matching proposal field.
Every proposal includes `notes`, even when empty. It contains only new nonempty `Sense: ` and `Note: ` paragraphs, or an empty rich-text value.
The proposal never echoes existing notes or carries language, weight, or provenance fields.

Acceptance maps those edits to the recorded row ID through the source acceptance rules in [step 4](#step-4-places-glosses-and-supporting-fields).
It applies only the permitted fields and replaces the tracked AI note group. It preserves every omitted field and all authored notes pending explicit review.
It leaves every other row unchanged, including alternative rows of the same language. It never replaces the stored row with the partial object.

Reordering marks the suggestion stale. After a comparison, the author can apply it to the same private ID if that row remains unchanged.
If the row changed, changed language, or disappeared, the browser offers a new request and never applies to its former index.
A lujvo proposal never bypasses deterministic construction and segmentation analysis.
A places proposal must pass the frame and reference rules before acceptance. The author can edit rejected proposals as ordinary draft text.

Assistance success always starts with HTTP 202 and exactly job, expires_at, and poll_after_ms.
The reference service returns `poll_after_ms: 100`.
`poll_after_ms` is an integer from 100 through 60,000.
Job state is queued, running, completed, failed, cancel_requested, or canceled.
GET and DELETE return state, result, error, expires_at, and progress.

Progress contains exactly task, attempt, and max_attempts. Before execution, task is null and attempt is zero.
During execution, task names the current task, attempt ranges from 1 through 3, and max_attempts is 3.
The attempt limit applies separately to each task in a job. The server runs the answer checks and correction loop.

Completed, failed, and canceled jobs keep the last reported progress. If no task started, task stays null and attempt stays zero.
`max_attempts` remains 3 in every state. DELETE does not reset progress.

Result and error are nullable. Errors use the common API error shape and can add log for a failed private job.
A job ID is opaque, unpredictable, and scoped to its requesting session. Expires_at uses the format specification's UTC timestamp syntax.

The reference service keeps jobs, results, and logs in memory for at most ten minutes from admission.
Each admitted job has a fixed expiry. Reads and session renewal never extend it.
Expiry aborts execution and deletes all sensitive job content. A service restart loses these private jobs and their expiry markers too.

The server publishes this retention limit in its assistance disclosure. It never copies these records into ordinary logs or peer synchronization.

After result disposal, GET returns HTTP 410 with `result_discarded`. The browser explains the disposal and offers another request.
An oversized spending request returns `billing_request_too_large` without a retry time.
A temporary spending limit uses `billing_limit` and an actual expiry time when the remaining charges are known.
Pending provider costs use `billing_pending` without a promised retry time. The browser preserves these distinctions and the server wording.

Successful DELETE returns HTTP 200 with the current job response. A queued job becomes canceled. A running job becomes cancel_requested until execution stops.
Completed, failed, and canceled jobs retain their state. Cancellation cannot retract an already transmitted provider request or its charges.
DELETE of a finished job clears result and any error.log while retaining its state until expiry.

The reference deployment serves private jobs from the app's origin. GET /session returns a CSRF token and establishes a random session cookie.
The response contains exactly csrf, an opaque token. The cookie is `__Host-jvc-assist`, with Path=/, Secure, HttpOnly, and SameSite=Strict.
Private assistance uses the configured app origin even when public dictionary routes permit cross-origin access.
Each renewal extends the session by at most one hour. An admitted job keeps the session valid until that job expires.

The browser sends that token in X-CSRF-Token when creating or canceling jobs. Anonymous sessions still receive network and billing quotas.
Job reads require the same session cookie. A job ID alone never authorizes access. An expired session cannot retrieve its private jobs.

Disabled capability returns HTTP 503 with code feature_disabled. Quotas use HTTP 429 with a retry interval.

Each session can retain at most 128 unexpired job records, including completed, failed, and canceled jobs.
At that limit, admission returns HTTP 429 with code `session_job_limit` and an integer `Retry-After` header in seconds.
Its value is `max(1, ceil((earliest_live_expiry_ms - now_ms) / 1000))`. Both times use milliseconds, and `earliest_live_expiry_ms` is the earliest retained job expiry.
Job expiry frees a slot. Expiry markers never count toward this limit and never cause refusal of new work.

Unknown job IDs and jobs owned by another session return HTTP 404 with code missing.
For its owner's current session, an expired job with a retained expiry marker returns HTTP 410 with code job_expired.

The service keeps a tombstone, a small expiry marker, after deleting the content.
It contains only the job ID, owner session ID, and job expiry.
A marker expires one hour after its job expiry, or when its session ends, whichever comes first. Session renewal never extends marker retention.

Each session can retain at most 128 markers, separately from its unexpired job records.
When a new marker exceeds that cap, the service evicts the oldest marker by job expiry, with lexicographic job ID as the tie-breaker.

Evicted, aged-out, and restart-lost IDs return HTTP 404 with code missing, including for the former owner.
The browser treats both 404 and 410 as a gone job. It stops polling and retains any outputs already saved with the local draft.

Retrying a private draft operation does not publish anything or create a dictionary event.

## 17. Lensisku linking and cross-posting

The identity page offers “Link a Lensisku account” without using that account as jvc login or recovery.
The flow resolves the source numeric user ID, signs the account claim locally, and shows the exact Personal info marker to paste.
It then reads the configured source profile and explains whether the expected marker and numeric ID match.
The user can retain a local observation or open a configured witness service to request an observation.
The account_observation capability identifies an available service link. It does not promise an automatic signing endpoint in the dictionary API.

When that capability is true, account_witness_service contains its HTTPS URL. Otherwise that field is null.
Opening the service requires an explicit action. The app supplies the public claim ID for manual entry, without private credentials or drafts.
The badge states the witness and observation date. An old observation is not a guarantee of current exclusive account control.

An accepted link grants retirement and restoration over matching imported definitions in views that enable account_authority.
The account page lists definitions with sufficient numeric evidence separately from username-only matches. Unsupported matches keep their revision and attribution controls.
Before linking, show the affected definition count and the selected witnesses. Explain that source-account takeover can grant the same imported controls to another key.

Account observations report the actual profile marker, even when another claim prompted the lookup. A stranger's failed claim never clears the genuine marker.
Source access cannot recover the jvc key, change native publications signed by that key, or transfer its endorsements.
The transfer flow retrieves the accepted claim and known device heads. It proposes previous and carry fields that preserve existing status.
The preview lists preserved states, conflicts, missing dependencies, and every known action omitted by the proposed boundary.

The app normally refuses to label a handover ready while its preserved history is incomplete. It offers evidence retrieval and an exportable draft.
The user can deliberately select an earlier boundary or initialize new status history. The preview treats either choice as a status change.
A return to a former key creates a fresh claim. Reusing an old profile marker never reopens a superseded period.

The browser stores and uploads the complete new claim before it shows the marker for publication.
Each witness retrieves and retains that claim and its previous chain before signing present. The client shows missing claim delivery separately from source-profile failure.
That distinction uses local delivery state or witness-service diagnostics. The signed unreachable observation does not identify which retrieval failed.
The account page distinguishes a prepared claim, partial witness coverage, a certified controller, and a controller dispute.

A claim becomes eligible only after every selected witness group supplies present evidence. A partial first claim cannot change imported status.
The browser signs under the selected controller only while its key and account claim retain authority.
Removing the external marker does not revoke an accepted link. A signed clear stops new commands and preserves prior decisions.
A fresh certified claim establishes a new controller period.

Failed fetches leave signed positive evidence intact and show its age. They do not silently restore definitions or roll back a handover.
A fresh claim with carry independently adopts imported status. Ordinary key succession alone retains the older key's inherited-authority risks.
The interface never describes source-account replacement as recovery of the previous jvc key or its endorsements.
A managed link shows pending source-divergence notices on the author's dashboard, with the batch that observed each difference.

The management preview includes changes by other Lensisku editors and the risk of source-account takeover.

The published-definition page offers manual Lensisku instructions and an optional authenticated bridge.
The manual flow provides a text rendering, source links, and the exact revision marker, with instructions to establish the management link.
The authenticated flow requires an explicit Lensisku connection and a preview of every field sent.
It never requests or sends the jvc private key. Lensisku credentials remain a separate integration credential.

Browser operation depends on the deployed source API and CORS behavior. The source audit establishes feasibility, not successful live interoperability.
If browser access fails, retain manual copy and an explicitly configured CLI bridge.

The preferred browser bridge sends credentials directly to Lensisku and keeps short-lived tokens in memory.
Persistent token storage is a separate opt-in choice with a clear removal control. No token enters a dictionary event, backup of public records, or peer metadata.
The server does not silently receive Lensisku passwords through an inference or account-linking request.
The implementation must test login, token refresh, profile-marker preservation, definition writes, and CORS against an authorized test account before enabling automation.

The bridge writes only a selected immutable jvc revision. Publication in jvc happens first.
It renders text, places, notes, etymology, keywords, classification, and selected rafsi through a versioned export recipe.
Rich-text place integers become explicit x-index notation. Formation metadata also receives a readable textual rendering where Lensisku lacks fields.

The preview identifies information that the source cannot represent. It preserves other source fields through a complete read-modify-write.
It adds one exact revision marker to notes without discarding unrelated notes or source attribution.

For updates, fetch the full external definition and retain its numeric definition ID, current content, and expected_time.
Show a comparison if it differs from the last successful bridge result. External edits require a new explicit overwrite or merge decision.
Serialize this client's writes. Use expected_time where supported, then fetch again and compare the full submitted projection.

The source timestamp has second-level resolution. It is not a guarantee against every concurrent edit.
A failed comparison becomes a conflict, not an automatic overwrite loop.

For a create timeout, search for the exact revision marker and compare source ownership and content before retrying.
If exactly one matching creation exists, establish that link. If several match, ask the author to select and inspect them.
If the service cannot establish whether creation occurred, keep delivery unknown. Do not blindly create another entry.
A source failure leaves the jvc definition published and the bridge operation pending or failed independently.

A management declaration is signed only after the source definition ID is known and the author reviews the link.
The UI explains that managed rows skip future automatic imports, including edits made only in Lensisku.

The source write and jvc publication are never atomic. The app reports each outcome separately and never rolls back a valid dictionary event.
Read-only batch import continues even when authenticated writing is disabled. Source-only new definitions remain eligible for later import batches.

## 18. Additional release requirements

The generator uses [CLL scoring](https://lojban.github.io/cll/4/12/) for its classic lujvo profile.
Its gismu profile follows the [CLL generation rules](https://lojban.github.io/cll/4/14/), with explicit normalization and aggregation parameters.
[Nonalgorithmic gismu](https://lojban.github.io/cll/4/15/) explain why source tuples and generation scores cannot be mandatory.
The provider interface follows the documented capabilities of [OpenRouter](https://openrouter.ai/docs/api/api-reference/embeddings/submit-an-embedding-request), [Ollama](https://docs.ollama.com/api/openai-compatibility), and [vLLM](https://docs.vllm.ai/en/stable/serving/openai_compatible_server/).

Release scenarios must cover these additional cases:

1. Complete every wizard branch with inference disabled and the network unavailable.
2. Preserve drafts, undo history, rafsi locks, explicit join choices, and human prose after mode switches and delayed AI responses.
3. Generate cmavo-based compounds and permitted long fu'ivla forms with short alternatives also present.
4. Select a non-top gismu candidate and acknowledge every known root and rafsi conflict.
5. Reuse shared vectors only with matching content, input recipe, vector profile, and accepted producer.
6. Reconcile repeated Lensisku batches without fabricating edits from missing fields or changed aggregate scores.
7. Report partial cross-post outcomes without duplicate creates or rollback of signed jvc records.
8. Run the standalone Docker service with no Cloudflare credentials and exchange records with the Workers service.
9. Render Latin, zbalermorna, circled places, and mathematical symbols with the selected font stacks at narrow widths.
10. Show account evidence and its age without claiming historical signatures or recoverable jvc keys.
11. Retire and restore a linked author's import, then carry its status through a certified replacement claim.
12. Ignore new former-period actions outside the carry while preserving source attribution and the original importer signature.
13. Change witnesses without an active fallback, then preview a parentless reset and obtain new certificate evidence.
14. Inspect a stranger's account claim without replacing the genuine profile marker's accepted observation.
15. Select valid optional `y`, `r`, and `n` hyphens under profiles that permit them, including forms with worse construction scores.
16. Refuse missing required joins and invalid optional joins. Recover the intended components and joins from every accepted spelling.
17. Preserve optional joins through publication and revision. Require review when a component change invalidates an explicit join choice.
18. Read and revise definitions with omitted optional fields, including nested place and formation fields, without changing retained signed bodies.
19. Keep explicit old records readable and preserve their IDs. Refuse invalid present values and missing required evidence.

The [prototype plan](prototype-plan.md) defines implementation stages. The [handover cases](handover-cases.md) define required account-control outcomes.
