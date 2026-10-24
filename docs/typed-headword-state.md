# Headword and builder state

The headword and the component builder keep separate state.
The headword can differ from the builder while the author edits either one.
Only an explicit form selection replaces the headword with a builder candidate.

## Fields

`spelling` keeps the entered bytes. `typedSpelling` identifies an entered headword.
`typedOrigin` identifies rows made by typed analysis. Locks alone never identify that mode.
`typed` binds the current typed rows to their exact spelling.
`typedReading` and `readingIndex` are old analysis fields. A mode exit removes them.
`ordinarySpelling` identifies the headword accepted with ordinary rows.
An empty value requires fresh typed analysis after a replacement.

Each component keeps its stable `id`, source `spelling`, `kind`, selected `definition`, available `definitions`, `gloss`, and rafsi `claims`.
`locked` keeps a selected rafsi. `unresolvedSource` marks a missing source choice.
`profile` selects the exact morphology version.
`profileChosen` records an explicit ordinary profile choice. It takes precedence over the profile in retained evidence.
`joins` keeps explicit boundaries. `restoredJoinParts` binds restored ordinary joins to row IDs and locks.
`restoredSpelling` keeps the exact bytes for those rows. `restoredProfile` binds them to their morphology version.
`selected` keeps a candidate choice. `acknowledged` keeps reviews of candidate conflicts.

`compound` and `formation` keep attributed evidence. `evidenceForm` binds that evidence to its selected spelling.
`review` marks retained annotations that need review. `publishAcknowledged` keeps publication conflict reviews.
Prose, places, glosses, source references, and signed metadata remain authored content.
Private builder markers never become signed fields.

## Events

Typing, paste, replacement, and Meaning's “Use this word” share one spelling transition.
A changed spelling clears publication reviews and exits typed mode.
It retains source choices, rows, locks, row-associated joins, and signed evidence.
It marks retained evidence and annotations for spelling review.
If typed rows supplied the old state, it sets `ordinarySpelling` to an empty value.

Opening Form, Places, the full editor, or the gismu builder does not reinterpret lujvo rows.
Opening the lujvo builder reconciles its rows with the headword and retained compound evidence.
Rows for their associated ordinary spelling stay editable, even during a pending spelling edit.
Entering a different valid typed lujvo can request fresh typed analysis at the next builder visit.
An unmatched ordinary headword does not discard row-associated joins.
Legacy rows gain row-associated joins only after a complete matching reading confirms their locks and boundaries.
Published revisions without rows recover sources, locks, profile, and exact boundaries from their evidence.

A new typed lujvo receives a fresh reading and exact spelling and boundary locks.
Its profile controls stay hidden and disabled. A profile event cannot change its fixed reading.
Compatible old rows keep author-linked sources, definitions, claims, and IDs.
Exact locked parts take precedence. An unlocked source can match an existing claim, a recognized whole word, or a gismu stem.
The same position takes precedence among those unlocked matches. Otherwise, only one remaining compatible source can supply the choice.
Ambiguous fallback sources stay unresolved. A retained unlocked row receives the fresh reading's exact lock without an invented claim.
Matching compound evidence supplies missing sources before dictionary suggestions do.
A changed part receives a new row. Dictionary order never chooses an ambiguous source.

Changing ordinary rows, their order, or their rafsi releases their restored joins to automatic construction.
Changing source attribution without changing a row or rafsi keeps its joins.
Changing the morphology profile also releases restored joins and their exact spelling.
Reopening ordinary rows keeps that explicit profile choice. Fresh typed analysis starts without that private choice marker.
Choosing a candidate records its spelling, evidence, selected candidate, and builder mode.
An ordinary selection records `ordinarySpelling`. A typed selection keeps its typed binding.
Selection without metadata removes compound evidence only through that explicit action.

Reload preserves the same state. Legacy migration uses the same builder-open transition.
A published revision starts with copied evidence and its exact parent, without invented typed origin.
“New word” retains entered content and chooses the next wizard step. Starting a separate draft uses fresh state.
Removing evidence does not remove compatible saved rows or their joins.

## Invariants

A typed candidate rebuilds its exact spelling, including case, commas, framing dots, and optional joins.
A restored ordinary spelling rebuilds exactly while its profile, source rows, rafsi, and joins still match.
Its restored spelling remains the builder candidate during a pending or different headword edit.
Fresh analysis on a later builder visit can replace those rows and their candidate.
Ordinary rows never become locked typed rows merely because their rafsi are locked.
No spelling edit silently removes author-linked sources, compatible joins, prose, or signed evidence.
Every replacement typed lujvo receives fresh analysis, including a spelling round trip before the next builder visit.
Compatible author choices survive that fresh analysis. Incompatible parts never inherit another part's attribution.
A source remains unresolved until the author chooses it, matching signed evidence supplies it, or exactly one dictionary source supplies it.
Unresolved sources cannot produce compound attribution.
An unchanged row and rafsi retain their joins across navigation, reload, and evidence removal.
A genuine row or rafsi change releases restored joins before construction.
Spelling edits preserve evidence bindings and set review marks instead of rewriting signed metadata.
Exact rebuilding of the current headword applies after reconciliation when it matches the builder's associated spelling.
During pending headword edits, the row and evidence preservation rules apply instead.

Older morphology profiles validate the normalized construction before the browser restores its exact presentation.
The browser retains case, commas, and the accepted apostrophe spellings `h`, `H`, and `’` in the displayed tokens.
It requires matching normalized spelling, component forms, and complete recovered boundaries from the core.
It preserves the core's score, parts, claims, and morphology and scoring versions.
This restoration requires a construction that the saved profile supports.
The historical CLL constructor cannot restore optional joins that it does not generate, even when its analyzer accepts them.
For example, it analyzes `SAI,rZBA` but constructs `saizba` from `sai` and `zba`.
The browser reports that mismatch instead of presenting a changed spelling as an exact restoration.
The historical CLL and extended version 2 profiles reject framing dots, so their restored spellings cannot contain framing dots.
