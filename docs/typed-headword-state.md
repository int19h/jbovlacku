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
`profileChosen` records an explicit ordinary profile choice. It takes precedence over retained evidence only while those rows stay ordinary.

`joins` keeps explicit boundaries. `restoredJoinParts` binds restored ordinary joins to row IDs and locks.
`restoredSpelling` keeps the exact bytes for those rows. `restoredProfile` binds them to their morphology version.
`restoredReleased` records a released construction. Reopening, relocking, replacing rows, and reloading keep that release while ordinary rows remain.
An empty published revision can start a new restoration from matching signed evidence.

`restoredEvidenceHistory` keeps profiles by exact spelling after release or metadata removal. Visits to other typed words preserve the entries.
Signed evidence supplies the authoritative profile for its matching spelling.
The old single `restoredEvidence` entry migrates into that history during normalization or reconciliation.
An existing history entry takes precedence over the old entry during migration. Profile history does not authorize restored joins.
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
This empty-row restoration starts again from the signed profile, even after an ordinary profile choice or a release.
It clears the former release and profile choice. Partial rows, relocking, and row replacement do not start this restoration.
During a spelling mismatch, signed evidence cannot restore the empty rows. A corrected spelling can start that restoration on the next visit.

A new typed lujvo receives a fresh reading and exact spelling and boundary locks.
Fresh analysis uses matching signed metadata first, then matching profile history, then the current extended profile.
An ordinary profile choice never supplies the profile for fresh typed analysis.
Supported typed rows have one exact candidate. Their profile controls stay hidden and disabled.
A profile event cannot change their fixed reading.

If a historical constructor cannot rebuild the reading, the rows stay ordinary and the profile controls stay available.
The fallback uses the fresh reading's rows, even after a visit to another word.
It associates those ordinary rows with the headword only when every source is resolved.
Missing sources leave fresh analysis available for the next visit, reload, or spelling correction after a package download.
An explicit ordinary profile choice survives repeated unresolved analysis. A supported fresh typed reading still uses its evidence profile.

Compatible old rows keep author-linked sources, definitions, claims, and IDs.
Exact locked parts take precedence. An unlocked source can match an existing claim, a recognized whole word, or a gismu stem.

The same position takes precedence among those unlocked matches. Otherwise, only one remaining compatible source can supply the choice.
Ambiguous fallback sources stay unresolved. A retained unlocked row receives the fresh reading's exact lock without an invented claim.
Matching compound evidence supplies missing sources before dictionary suggestions do.

A changed part receives a new row. Dictionary order never chooses an ambiguous source.

Dictionary Add and Add as entered append ordinary rows. Remove deletes a row. Move changes the row order.
These events, row replacement, and a changed rafsi release restored joins and exact spelling before construction.
Rafsi controls include automatic, the current lock again, and a different lock. Selecting the same lock preserves restoration.

Clearing a lock and then restoring it does not undo a release.
The release persists for every morphology profile through navigation and reload.

The typed Source word list replaces source attribution while it keeps the row ID and exact rafsi.
Other source word changes its source spelling, resets its definition and claims, and marks an empty source unresolved.
Exact-definition controls change the selected source definition. Other rafsi you know replaces the entered claims.
These attribution events preserve restoration when the row identity, order, and exact rafsi stay the same.
Changing the morphology profile also releases restored joins and their exact spelling.

Reopening ordinary rows keeps that explicit profile choice. Fresh typed analysis starts without that private choice marker.

Choosing an alternative candidate previews it and clears conflict reviews without replacing the headword or evidence.
Using a candidate records its spelling, evidence, selected candidate, and builder mode.
An ordinary selection records `ordinarySpelling`. A typed selection keeps its typed binding.
Selection without metadata removes compound evidence only through that explicit action.

Accepting Suggest components or Suggest a lujvo creates fresh ordinary rows under the current ordinary profile.
The new rows have no old joins, restoration snapshot, or typed binding. Their construction starts with automatic joins.
A supplied spelling records an ordinary selection. Without one, the current headword keeps its typed identity and its association with the suggested rows.
Both actions keep profile history. The fixed typed layout hides both actions.
Validation rejects a lujvo spelling proposal without checked components. A spelling-only AI event is not reachable.

Spelling changes clear publication reviews and mark retained evidence and annotations for review.
The accepted action discards old compound evidence before it decides whether retained fields need a new spelling review.
Any retained formation keeps its evidence binding. Existing review marks remain.
Proposal order does not change these results.

AI Undo restores each accepted field only if its current value still matches the accepted value.
The undo snapshot includes rows, joins, restoration markers, source choices, spelling markers, evidence, and review marks.
Reload preserves the snapshot. Later unrelated author edits survive Undo.
If later row or profile edits prevent a full restoration, Undo releases incompatible restored construction.
If later edits invalidate restored typed rows, Undo exits typed mode before rebuilding.

A later ordinary profile choice also keeps Undo in ordinary mode, even when that profile can rebuild the old spelling.
The old typed profile remains separate evidence for future fresh analysis.

Gismu Use replaces compound and formation evidence as one action through `selectGismuSpelling`.
Its spelling transition marks retained places and glosses for review. Discarded evidence cannot add a new spelling review.
It keeps the old component inputs and existing review marks, then binds the accepted formation to its selected spelling.
Equivalent typed presentation remains exact when the author adds evidence. That evidence-only action preserves the typed identity.
A later replacement still requires the typed-spelling confirmation.

Form Use calls `useManualForm`. For a gismu with source rows, it creates manual formation evidence when evidence is absent or scores are stale.
This action removes old algorithmic scores and binds the manual evidence to the headword at that moment.
It keeps typed identity and review marks. Unchanged scoring evidence keeps its earlier binding.

`syncFormationSources` copies current source rows into existing manual evidence or scoring-compatible algorithmic evidence.
It returns a stale-score result for changed algorithmic scoring inputs and keeps the old evidence unchanged.
It never changes `evidenceForm`, headword identity, or spelling review marks.
Normalization, publication validation, Form, the gismu page, source acceptance, and Undo use this writer.

AI gismu source acceptance calls `applySource`. It edits the selected stable source row and calls `syncFormationSources`.
It clears candidate and publication acknowledgments, but keeps the headword, its typed identity, and the formation binding.
Changed source words can add source review marks for retained evidence. These marks are separate from spelling reviews.
Its conditional Undo uses `restorePatches`, then synchronizes formation sources again. Later row edits and source review choices survive under the same Undo rules.

Reload and draft import normalize saved state. Legacy migration uses the same builder-open transition.
A published revision starts with copied evidence and its exact parent, without invented typed origin.
“New word” retains entered content and chooses the next wizard step. Starting a separate draft uses fresh state.
Removing evidence does not remove compatible saved rows or their joins.

Requested-word initialization uses `newDraft` without inherited builder state.
A separate draft or confirmed draft replacement also starts with fresh rows, joins, and profile state.
Discard removes the saved draft. It does not migrate its builder state into another draft.

## Invariants

For supported construction, a typed candidate rebuilds its exact spelling, including case, commas, framing dots, and optional joins.
A restored ordinary spelling rebuilds exactly while its profile, source rows, rafsi, and joins still match.
Its restored spelling remains the builder candidate during a pending or different headword edit.
Fresh analysis on a later builder visit can replace those rows and their candidate.

Ordinary rows never become locked typed rows merely because their rafsi are locked.
No spelling edit silently removes author-linked sources, compatible joins, prose, or signed evidence.
Every supported replacement typed lujvo enters typed mode after fresh analysis, including a spelling round trip before the next builder visit.
Its profile comes from matching signed or restored evidence, never an ordinary profile override.
A historical construction gap cannot create typed rows with locked, unusable profile controls.

Compatible author choices survive that fresh analysis. Incompatible parts never inherit another part's attribution.
A source remains unresolved until the author chooses it, matching signed evidence supplies it, or exactly one dictionary source supplies it.
Unresolved sources cannot produce compound attribution.

An unchanged row and rafsi retain their joins across navigation, reload, and evidence removal.
A genuine row or rafsi change releases restored joins before construction. A return to the former values does not undo the release.
Restored profile evidence can guide fresh analysis without reviving released joins.
A matching signed publication with no rows is the explicit exception. Its next builder visit restores the whole signed construction together.
A complete AI Undo restores the old rows and their exact joins together.
Spelling edits preserve evidence bindings and set review marks instead of rewriting signed metadata.
An explicit manual Form action can replace stale generation evidence and bind the new manual evidence to the current headword.
Source synchronization and AI source edits preserve that binding.
Only retained evidence and annotations can cause a new spelling review during a form replacement. Existing review marks persist.

Source invariants compare complete interpreted values with the core's definition defaults.
An absent `word_ipa` and explicit null both mean unknown. Present pronunciation, input, weight, notes, and source order remain distinct.
The same rule applies to nested hints, place defaults, derivations, and source references during reload and draft import.

Preservation comparisons map editor fields to definition fields before applying defaults.
An empty editor gloss sense means the wire value null. Flattened place defaults and derivations retain their complete values in that comparison.
Rich text keeps its exact nodes and text. A changed code node, note, condition, explanation, or nonempty sense remains a real edit.

Private row IDs, source choices, profile choices, joins, spelling bindings, and Undo decisions retain their exact comparisons.
Default interpretation never equates distinct signed body bytes or event IDs.
Undo preserves later evidence edits, and signature inspection still compares the exact canonical source body.

Exact rebuilding of the current headword applies after reconciliation when it matches the builder's associated spelling.
During pending headword edits, the row and evidence preservation rules apply instead.

Older morphology profiles validate the normalized construction before the browser restores its exact presentation.
The browser retains case, commas, and the accepted apostrophe spellings `h`, `H`, and `’` in the displayed tokens.
It requires matching normalized spelling, component forms, and complete recovered boundaries from the core.
It preserves the core's score, parts, claims, and morphology and scoring versions.

This restoration requires a construction that the saved profile supports.
The historical CLL constructor cannot restore optional joins that it does not generate, even when its analyzer accepts them.
For example, it analyzes `SAI,rZBA` but constructs `saizba` from `sai` and `zba`.
An ordinary restoration reports that mismatch instead of presenting a changed spelling as an exact restoration.

An unsupported typed reading returns to ordinary construction with profile controls available.
Its automatic candidate does not replace the headword until the author confirms Use.
The historical CLL and extended version 2 profiles reject framing dots, so their restored spellings cannot contain framing dots.

## Production writers

The following inventory covers headword, component, source, join, profile, formation, and binding writers.
Page controls can edit source rows before synchronization. Pure constructors supply evidence only through the accepting transitions.

| Writer                                                                       | Production entry points and effect                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `changeTypedWord`                                                            | Meaning typing and Use this word, Form spelling, and the full editor headword. It also serves accepted spelling proposals and gismu selection.                                                                      |
| `continueWithWord`, `selectWordKind`, `clearWordEvidence`                    | New word, confirmed type changes, and evidence removal preserve or remove the corresponding bindings explicitly.                                                                                                    |
| `newDraft`, `draftFromBody`, `normalizeDraft`                                | Requested words, separate drafts, revision copies, imports, and reload. Normalization also migrates profile history and source identities in Undo snapshots.                                                        |
| `prepareLujvoBuilder`, `typedLujvoState`, `retainSources`, `signedComponent` | Builder open, legacy migration, fresh typed analysis, and complete signed restoration write rows, sources, locks, profile, and joins. The last two helpers are private.                                             |
| `leaveTypedMode`, `reconcileLujvoRows`, `reconcileLujvoUndo`                 | Mode exit, row reconciliation, and partial Undo preserve or release exact construction. `leaveTypedMode` is private.                                                                                                |
| `normalizeLujvoEvidence`, `rememberLujvoEvidence`                            | Profile history migration and retention. Signed evidence can update its matching entry. Ordinary profile controls cannot rewrite that evidence.                                                                     |
| `editLujvoRows`                                                              | Dictionary Add, Add as entered, Remove, Move, row replacement, automatic or explicit rafsi, exact definitions, and entered rafsi claims.                                                                            |
| `selectLujvoSource`, `selectLujvoProfile`                                    | Typed source controls retain the exact part. Ordinary profile controls release incompatible construction.                                                                                                           |
| `chooseLujvoAlternative`, `selectLujvoCandidate`                             | Candidate preview keeps the headword. Use records the checked spelling and optional compound evidence. `compoundMetadata` constructs that evidence.                                                                 |
| `applyProposals`, `restorePatches`                                           | AI component or lujvo acceptance and conditional Undo. Undo also restores source edits by stable row identity.                                                                                                      |
| Gismu page source controls                                                   | Preset changes, custom languages, weights, Add, Remove, alternatives, native words, pronunciations, scoring letters, notes, and source review decisions edit rows. `saveSources` then calls `syncFormationSources`. |
| `sourceRowsFromFormation`, `normalizeSourceRow`, `alternativeSourceRow`      | Signed-source hydration, legacy source migration, and new alternatives supply gismu rows. `editSourceNotes`, `setSourceAiNoteGroup`, and `resolveSourceReview` edit source annotations and review choices.          |
| `selectGismuSpelling`, `formationMetadata`                                   | Gismu Use accepts checked generation evidence and its spelling together. Evidence-only Use keeps equivalent typed bytes and identity.                                                                               |
| `useManualForm`, `manualFormation`                                           | Form Use accepts source rows as manual evidence when generation evidence is absent or stale.                                                                                                                        |
| `syncFormationSources`, `applySource`                                        | Source synchronization and accepted AI source edits update only compatible evidence. Stale scoring evidence keeps its original inputs until explicit selection or removal.                                          |

No independent join editor exists in the implemented UI. Exact joins come from typed analysis, signed restoration, saved legacy state, or conditional Undo.
