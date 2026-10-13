# Jbovlacku UI design

This document alone defines the target visual system and twelve screen layouts.
An implementation needs no access to the optional design canvas to follow these requirements.
The [frontend specification](frontend.md) defines behavior, storage, accessibility, and acceptance scenarios.
The [format specification](format.md) defines field shapes, signatures, authority, and ranking.
The [README](../README.md) describes the implemented scope. These layouts do not establish that a feature exists.

## Design principles

Search appears on every page. The initial page shows dictionary results rather than an introduction.
Result rows combine headword, rafsi, type, definition, attribution, date, and score.
An unlocked contributor can endorse or oppose from a result row in one action.
Creation starts with meaning and introduces structure through five steps.
Explanations appear beside the action that needs them. Critical state and errors remain visible.
The app has no general activity feed, chat, discussion controls, background images, gradients, or emoji.
An identity can have its own recent activity list.

## Shared shell and dimensions

The header and footer use a centered container with a maximum width of 64rem and 20px horizontal padding.
The header uses 10px vertical padding, an 8px row gap, and a 16px column gap.
It includes the wordmark, search, “Add a word,” the conditional “Not delivered” marker, and the local identity link.
The search field has a persistent accessible label, a search icon, and an accessible clear button.
With an existing key, the identity link includes a lock icon and an accessible description of its lock state.
Without a key, “Your key” opens `/identity` for creation or import. Navigation alone never generates a key.
The delivery marker counts distinct unfinished records listed on Not delivered, not requests, retries, or peers.
Listed records include active offline failure, refusal, and unknown delivery. Stopped records remain retained but leave the list and count.
Normal transient sends and accepted index lag remain excluded.
Its details show independent outcomes for each peer. An ordinary transient send does not display it.

The footer includes the active view link, Settings, About, and Source on every page.
Settings opens `/preferences`, which includes search mode, delivery peers, languages, storage, export, and appearance.
For a personal view, its label reads “Trust: personal view.” The label follows the actual selected mode.
The footer uses 13px text, 14px vertical padding, and gaps of 6px by 18px.
Editor action bars supplement this navigation. They do not remove it.

| Surface | Maximum width | Main padding |
| --- | --- | --- |
| Search | 40rem | 18px top, 20px sides, 56px bottom |
| Word | 44rem | 36px top, 20px sides, 64px bottom |
| Local identity, public identity, trust | 40rem | 36px top, 20px sides, 64px bottom |
| Not delivered | 44rem | 36px top, 20px sides, 64px bottom |
| Wizard | 64rem | 32px top and sides of 20px |
| Publish step | 64rem | 32px top, 20px sides, 48px bottom |

Widths include the horizontal padding. The main content fills available space up to its maximum width.
The page uses neutral background, a surface header, and thin separators.
Content determines page height. A short page keeps the footer below its content.

## Fonts and type scale

The ordinary stack is `"Noto Sans", "STIX Two Math", Crisa, Verdana, sans-serif`.
Dedicated mathematical symbols put STIX Two Math first. Zbalermorna puts Crisa first and retains accessible Latin text.
An orthography choice changes display only. Copy controls offer an explicit format choice.
The gismu source table includes Noto Sans Devanagari, Noto Sans Arabic, and Noto Sans SC.
Self-host the required fonts, script subsets, and symbols. Retain their notices under the [dependency guide](dependencies.md).

| Use | Size | Weight | Other values |
| --- | --- | --- | --- |
| Body | 16px | 400 | Line height 1.5 |
| Result headword | 21px | 640 | Letter spacing -0.01em |
| Result definition | 17px | 400 | Line height 1.55 |
| Word headword and selected builder form | 44px | 680 | Line height 1.1, letter spacing -0.025em |
| Word definition | 21px | 400 | Same layout for all alternatives |
| Editor heading | 28px | 660 | Line height 1.2, letter spacing -0.015em |
| Metadata and field labels | 13px | 400 | Secondary or tertiary text |
| Header search | 18px | 400 | Minimum height 48px |
| Step label | 14px | 500 | Current step weight 650 |
| Step number | 12px | 650 | 24px circle |
| AI tag | 11px | 700 | Letter spacing 0.06em |

Lower-ranked definitions use secondary text without a smaller or incomplete block.
Scores and place numbers use tabular figures. Names use `<bdi>` to isolate their writing direction.
List dates use a month and year, such as “Sep 2024.” Identity activity can use “Oct 10.”
Signed event headers contain no creation timestamp. Show an import or source date only when its provenance supplies one.
Label a receipt date “Seen …” and identify the receiving server in its details.
A receipt date never implies the original creation date.
Omit unknown dates rather than assigning the current date.
Identity activity can use receipt chronology for navigation only. Dates never settle causal event order or conflicts.

## Color tokens

The theme follows the system preference. Settings can provide an explicit appearance preference.
These tokens define the starting palette. Implementations must meet the frontend's WCAG 2.2 AA release target.
Decorative separators do not establish sufficient contrast for interactive boundaries or selected states.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `bg` | `#f7f7f4` | `#121315` | Page background |
| `surface` | `#ffffff` | `#1a1c1f` | Header, fields, cards |
| `sunk` | `#eeeeea` | `#222429` | Place strips, quiet hover |
| `line` | `#e3e3dd` | `#2c2f34` | Decorative separators |
| `line2` | `#c9c9c1` | `#3d4147` | Secondary decorative borders |
| `ink` | `#1a1c1e` | `#ecebe6` | Main text |
| `ink2` | `#474c52` | `#c0c2c5` | Secondary text |
| `ink3` | `#656b72` | `#9da1a7` | Metadata |
| `accent` | `#0e6a5b` | `#5ec4ab` | Links, selected state |
| `accent-hover` | `#0a5549` | `#7fd3be` | Active hover |
| `on-accent` | `#ffffff` | `#06201a` | Text on primary buttons |
| `accent-soft` | `#e2efea` | `#16352e` | Selected backgrounds, AI tag |
| `mark` | `#d6ece4` | `#1f4a40` | Search matches |
| `warn` | `#7a4a00` | `#f0c47e` | Warning text |
| `warn-soft` | `#fbf0d9` | `#33270f` | Warning backgrounds |
| `warn-line` | `#e9cf9b` | `#5b4520` | Warning border |
| `focus` | `#2b63d9` | `#8db0ff` | Keyboard focus |

Amber appears on warnings and conflicts. State never depends on color alone.
Focus uses a 3px outline with a 2px offset. Search matches use a 3px radius and 2px horizontal padding.
Links use the accent and an underline offset of 0.18em. Selected actions retain explicit text or accessible state.

## Shared components

Buttons use an 8px radius, a 1px border, 16px horizontal padding, and a minimum 44px height.
Outlined fields and buttons use ink3 or accent boundaries that meet at least 3:1 contrast in every enabled state.
Line and line2 remain decorative. Primary buttons use the accent and on-accent text.
Quiet text actions remain visibly identifiable without a forced box and can use a sunk hover background.
Fields use an 8px radius, 9px vertical padding, and 12px horizontal padding.
The header search uses a 10px radius and 44px space at either end for its controls.
Standalone touch controls are at least 44 by 44 CSS pixels, including arrows, copy, removal, movement, and chips.
Inline prose links and place markers use the [WCAG inline exception](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html).
They remain clickable without overlapping enlarged hit areas.
Small glyphs can remain visually compact within that target. Adjacent targets must not overlap.

Place markers use a 1.5px border and a circular shape of 1.45em, with a 0.7em number and weight 650.
Their accessible name is “place N.” Word-page markers link to the declared place rows.
For numbers above 20, use an outlined numeric badge with the same accessible name.
Equivalent 44px place-navigation controls can appear in the existing place strip or details.
Do not insert a new button beside each inline occurrence. Never overlap enlarged marker hit areas.
Literal circled characters remain text. The token, not its glyph, establishes a structured reference.

The judgment control contains an up arrow, net score, and down arrow.
The arrows have the accessible names Endorse and Oppose and expose `aria-pressed` for known, unambiguous state.
A selected arrow uses accent text and an accent-soft background. Repeating that action clears the judgment.
An explicit “Clear my judgment” action remains reachable in judgment details.
A known clear or absent judgment leaves both arrows unpressed. Unknown evidence does not mean a known absence.
Conflicted or unknown state never becomes an arbitrary pressed arrow. Pending local changes remain separately labeled.
The score title and accessible name include support, opposition, and direct reviewer count.
A disclosure exposes that breakdown through keyboard and touch. Hover is an additional route only.
An exact nonzero headline never rounds to zero. Use sufficient precision, scientific notation, or a signed small-value indicator with exact details.
“No judgments yet” requires a known zero direct-reviewer count, not a zero net score or unknown evidence.
Bounded results show ranges or unresolved order. Unavailable results never become zero.

The step bar uses Meaning, Type, Form, Places, Publish.
Its 24px numbered circles use a 1.5px border. The current step fills with accent and uses `aria-current="step"`.
Completed steps use an accent outline. Completion and current state have accessible text.
“Skip to the full editor” appears beside the step bar and preserves the draft.

Radio cards use a 12px radius and 1px border. A selected card uses a 2px accent border and adjusts padding by 1px.
Rafsi radio chips use an 8px radius and 12px horizontal padding, with the same selected treatment.
Native radio inputs remain keyboard accessible. Focus appears on the enclosing card or chip when its input receives focus.
AI tags use 1px vertical padding, 6px horizontal padding, a 4px radius, and accent colors.
AI suggestions provide “Use this,” “Dismiss,” and persistent undo after acceptance.
Named disclosures have a chevron, secondary label, and at least a 44px target.

## Search screen

The search surface corresponds to `/search?q=...&lang=en`.
A count line and quiet definition-language select appear above the results. English is the initial definition language.
The active view appears in the footer. Local or remote search mode lives in Settings.
The first remote request discloses the named server. Switching modes never uploads local query history silently.

Each row has three content lines, separated from the next row by a thin rule and 16px vertical padding.
The first line shows the linked headword, italic rafsi, type, and selma'o for cmavo.
The second line shows definition text, place markers, and highlighted query matches.
The third line shows author attribution, month and year, optional “notes,” matching alternatives, and the judgment control at the right.
“notes” opens that definition's notes. “also:” links to another matching definition and its author.
Native authors link to their signing identity. Imported authors link to source-account evidence when available, without impersonating a signing identity.
The importer signer remains inspectable separately. A shared display name never merges the two.

Search order follows exact headword, exact gloss, headword prefix, gloss prefix, and token matches, without class headings.
The list ends with the remaining count and “show all,” then “Missing a word for this? Add it” and the retired-results filter.
A rafsi query shows its word relation, for example “cku ← cukta,” and retains assignment conflicts.
No official badge appears. No identity, key prompt, or general activity feed precedes reading.

## Word screen

The word surface corresponds to `/word/<word-id>?lang=en`.
Its heading shows the 44px headword, Crisa rendering beside it, type, and accessible copy control.
A lujvo composition line shows source words, component rafsi, and descriptive glosses when known.
The rafsi line shows assignments or “none yet,” with “claim one.” Language tabs show definition counts.

Each definition block shows 21px prose, glosses, author, date, permanent event link, and judgment controls.
“N reviewers” opens reviewer identities, units, and influence-route details under the actual selected view.
When several routes contribute, summarize them and expose the complete details. Do not claim one route as the whole explanation.
The explanation reads “The score adds the weight of each reviewer in your trust view.”
The current user's weight follows the calculation and personal overlay. It never comes from an illustrative reviewer table.

The place strip uses the sunk surface and lists each place number and its short gloss.
Missing descriptions offer “Add descriptions.” A revision notice names its proposer and provides “Compare.”
Source and History remain named disclosures. Source exposes original Lensisku text and numeric account evidence when available.
Each block includes “Revise.” Lower-ranked definitions retain the same block layout with secondary text.
After the last definition, offer “Add a definition,” “Add a translation,” and See also links.
Rafsi claims retain their separate pair judgments, status, conflicts, and rationale.

## Meaning screen, step 1

The first wizard screen uses two columns with a 40px gap when space permits.
The left column asks “What does the word mean?” and provides a meaning textarea, language select, and optional Lojban word.
The right column is “Close in meaning,” with existing words and exact definitions.
Both columns can start from a 360px basis and stack at narrow widths.

“By words” uses a local package initially and does not inherit ordinary remote-search upload settings.
If that package is missing, offer a download or continued manual editing.
An explicit remote lexical request and “By meaning” require consent before any private text leaves the browser.
The best match offers “Add a definition” and “Revise this one.” Other matches offer “Use this word.”
The author can continue despite every match. The bottom action area shows “Saved in this browser” and “New word.”
Underscores remain draft placeholders until the author approves their numbering.
The original meaning remains separate from later editable definition prose.

## Type screen, step 2

The type screen asks “What kind of word?” and offers lujvo, gismu, fu'ivla, cmavo, cmevla, and Other radio cards.
Each card has one line of explanation and an example. Gismu classification does not require algorithmic generation.
Other exposes every remaining lexical kind that the format permits, including compound and letteral.
The card grid uses approximately 230px minimum columns where available, then one column on narrow screens.

The main column uses a 480px basis and the suggestion panel a 260px basis, with a 40px gap.
An explicit AI action can mark a proposal “AI pick” and show its reason. It does not select the type automatically.
“Have the spelling already? Type it in and skip the builder” opens manual entry.
The primary button names the selected next action, such as “Build the lujvo.”
Type changes preserve prose and annotations and require review before incompatible formation fields disappear.

The manual Form branch, step 3C, uses a spelling field and attributed morphology notes.
Cmavo also provide selma'o and an opt-in AI suggestion with its explanation.
Back returns to Type, and “Use <form>” continues to Places.
Direct navigation to Places preserves manual spelling, classification, and notes.

## Lujvo screen, step 3A

The main builder uses a 480px basis. The definition column uses a 300px basis, with a 40px gap.
The result card shows the 44px form with underlined component rafsi, construction score, and recovered components.
A taken or available label names its snapshot and coverage limits. It never promises global uniqueness.
A construction score describes the stated algorithm. It does not guarantee readability or editorial endorsement.

Each component row includes move up, move down, word and gloss, permitted rafsi chips, lock, and remove.
Rows use 14px by 16px padding, 12px radii, and wrapped gaps of 10px by 16px.
Permitted long forms remain available. A displayed joining character stays separate from the selected component rafsi.

Each boundary offers automatic joins and the optional hyphens that the selected morphology profile permits.
Required hyphens remain visible and cannot be removed. A boundary with no optional choices needs no extra control.
An explicit choice updates the candidate spelling and construction score without changing component rafsi or definition text.
The result card distinguishes required and optional hyphens. A worse score never prevents selection of an otherwise valid form.

A component change that invalidates a join choice exposes that boundary for review instead of silently resetting it.
“Add a part” appears with “AI Suggest parts” and “AI Suggest a lujvo.”
“Other forms from these parts” opens a table of forms, component sequences, scores, and Use controls.

The right column shows current prose, preserved meaning, “AI Rewrite for <form>,” and the suggestion panel.
Accepted prose has undo. Human prose never changes solely because a component changes.
Locks, morphology profile, scorer versions, analysis of recovered components, and complete conflict review follow the frontend specification.
The bottom actions are Back and “Use <form>.”

## Gismu screen, step 3B

The source and candidate column uses a 520px basis. The selected-form column uses a 280px basis, with a 40px gap.
Source rows show language, resolved weight, native word, transliteration when supplied, and editable scoring input.
The preset select offers documented CLL 1995, CLL 1987, twelve-language, and custom profiles when their sourced parameters exist.
Every named preset exposes pinned source evidence, resolved weights, normalization, and rule versions.
The screen's sample numerical results do not establish those parameters.

“AI Fill in source words” and “Add a language” appear beneath the source rows.
The candidate table shows rank, form, score, conflicts, and Choose.
Equal generation scores share a rank under the [formation evidence rules](format.md#etymology-and-formation-evidence).
Generation rank never becomes editorial rank.
The selected card shows its form, score, rank when known, per-language contribution bars, and zero contributions.
A non-top or manual form remains selectable. “Type a form yourself” never fabricates algorithmic evidence.

Rafsi claim controls identify every known competing word, or qualified absence of a conflict in the named snapshot.
“Why this one?” is optional. A conflict permits selection and requires acknowledgment at Publish.
Refreshing the conflict snapshot invalidates affected acknowledgments. Candidate score and editorial rafsi support stay separate.
The bottom actions are Back and “Use <form>.”

## Places screen, step 4

The top shows headword, type, definition language, and “AI Fill in places and glosses.”
The definition uses an actual accessible rich-text editor, with Place insertion, Link a word, and typed circled-number guidance.
Glosses appear as removable chips with an add field. Every removal target meets the 44px rule.
Place rows show Description, Gloss, Kind of thing, and From, followed by “Add a place.”
Repeated field labels include the place number in their accessible names.

| Arity control | Format representation | Required behavior |
| --- | --- | --- |
| “Exactly N” | `{"mode":"fixed","count":N}` | Declare each place from 1 through N. |
| “N or more” | `{"mode":"variadic","minimum":N}` | Provide the required prefix and tail. |
| “Depends on context” | `{"mode":"context"}` | Keep explicit declarations without a completeness claim. |
| Unspecified structure | `frame: null` | Preserve uncertainty rather than guessing zero places. |

Kind of thing is a convenient view over the full `type_hints` schema.
It preserves alternatives, tags, custom HTTPS tags, abstractors, relation arity, and notes.
The mock menu's object, event, property, number, and unspecified choices are not a closed protocol enumeration.
From edits `derivation`, with source word, nullable exact definition ID, source place, and explanation.
It does not infer a source place from array position.

Defaults and constraints, Notes, Examples, Etymology, and Sources start as named disclosures.
Etymology retains accepted formation evidence from step 3. The full editor opens every section and exposes all format fields.
It also permits manual headword and type, grammatical operands, labels, and classification.
Fixed license values, derived identifiers, and generated provenance remain read-only.
The editor cannot fabricate import origin or another author's source evidence.
Typed circled numbers, literal paste, fixed and variable frames, and reference validation follow the frontend specification.
The bottom actions are Back and Review.

## Publish screen, step 5

The preview column uses a 460px basis. The publication panel uses a 300px basis, with a 40px gap.
The preview matches the word-page definition block, including place descriptions, glosses, sources, and formation evidence.
Below it, a conflict line identifies the current snapshot and every acknowledgment group, or the qualified absence of known conflicts.
Edit returns to the retained draft.

The panel names the signing identity and says “Signed with your key, with your endorsement.”
It does not promise permanent storage. Each new native definition carries the fixed CC0 expression, official URL, and empty `license.attribution` string.
The signed header issuer identifies the contributor. These fields remain read-only, and imported author attribution stays in separate source evidence.
The linked notice reads “New definitions use CC0 1.0. By publishing, you release your contribution under CC0 1.0.”
Publish expresses agreement without a separate checkbox. Imported text retains its source rights claim rather than a fabricated legacy CC0 choice.

An untested backup warning appears above Publish. The author can test it or proceed after the required loss warning.
The panel names each configured recipient and states that failed delivery remains in this browser for retry.
The definition, author blessing, selected rafsi claims, and pair blessings persist as one intended local group before dispatch.
Separate receipts describe their outcomes.
Receipt confirmation of the envelope and matching required body opens the word page. The page shows accurate remaining state.
Delivery failure opens a clearly labeled local preview and the Not delivered marker.
Pending dependencies or index lag never become a false fully published state or automatic redelivery.

## Your key screen

The local identity page shows the name, public-page link, Edit public profile, and the full fingerprint.
Until a local recovery test succeeds, an amber banner says “Test your backup” and offers Test the backup and Download again.
The test decrypts the backup and makes sure that the recovered identity matches. Opening a file alone is insufficient.
The page offers lock state with Lock, Stay unlocked this session, Lensisku account link, and import another key.
Move to a new key and report a stolen key open the dedicated lifecycle flows.

The idle lock remains 15 minutes without a signing action, unless the explicit session setting applies.
Working keys remain in memory and passphrases never enter persistent browser storage.
The page explains that site code can misuse the key and that no reset or recovery exists without a backup.
Before the first public signature, one explanation states that judgments and public trust choices are signed public records.
It says “Undo adds a record. It does not erase the earlier public record.” Direct arrows need no additional modal or checkbox.
Lifecycle previews retain exact successor approval, causal frontier selection, missing evidence, and partial delivery from the frontend specification.
A compromise notice does not erase arbitrary later history. A handover does not provide a grace-period undo.

## Public identity screen

The public page shows the name, full fingerprint, signed biography, HTTPS links, and actual activity counts.
Known successor, profile conflict, or unavailable profile state remains visible.
Root status describes the selected view only. It never becomes an official badge or global reputation score.
Trust their judgments, Ignore their judgments, and Report abuse are separate actions.

The trust panel offers Just for me and Publicly, an all-judgments default scope, and a link to narrower scopes.
Public mode previews the exact subject and scope before signing.
Its explanation says “Signed. Others can build on it. It stays in history after you undo it.”
Private Ignore writes `overlay.blocked` with the selected identity and scope.
It blocks the identity and routes through it in the personal view.
It does not write an issuer-edge shun into `overlay.trust`.
Public Ignore signs `trust.set` with `value: "shun"`.
The personal view also applies the current user's effective public shuns as local blocks.
Abuse reports require category, explanation, and explicit public preview. Linguistic disagreement uses Oppose.

Recent lists dated actions with exact targets and an All activity link for this identity.
The page never substitutes invented dates, reviewer counts, or example identities for retained evidence.
The intended baseline curator uses an ordinary key and actual signed endorsements of baseline publications.
Its name and initial site-view root allocation require the approved roster and configuration.
An organization such as LLG has no protocol privilege.
Imported attribution remains with the original source author and importer signer. Imports never forge an organization endorsement.

## Trust screen

The view switch offers “Mine: site view + my choices” and “Site view only.”
People I trust and People I ignore list names, scopes, public or private labels, and applicable actions.
Public Undo signs clear and retains history. Private Remove changes local preferences.
Make public opens a deliberate preview and signs only after approval. Clearing a public choice does not clear an independent private block.

The explanation reads “Public choices are signed and stay in history after you undo them. Ignoring someone is not an accusation.”
Site view names the actual roots and publisher. Removing a root removes its starting allowance, not every possible incoming route.
Settings and history exposes allocations, Outward allowance (H), Passed on (alpha), rafsi threshold, exclusions, and work budget.
It also exposes exact view ID, imports and selections, account authority, witnesses, and available evidence.
H is an outward multiplier, not a route depth limit. Full transitivity remains part of the calculation.
Pin this version, Use another view, and Earlier versions retain the adoption and availability rules in the frontend specification.

## Not delivered screen

The page title is “Not delivered” and its route remains `/outbox`.
Its opening paragraph describes retained local records and automatic retry, qualified by the actual failure or refusal.
Each listed unfinished record names its target and action, last attempt, next retry, Try now, and Stop retrying.
Stop retrying stops future attempts to all still-unfinished selected peers for that record.
The app retains signed bytes and receipts, then removes the row from the active list and count.
It does not retract a public record or guarantee that an in-flight request stopped.
Unknown delivery states explain that the client asks whether the record arrived before it sends the same bytes again.
The app stores bounded retry and backoff state. Connectivity return and reload resume eligible retries while the app is active.
The client respects Retry-After. A closed browser does not guarantee background delivery.
A known permanent refusal shows the server's reason and stays auto-paused until corrective action or explicit retry.

The page offers “Save them as a file” and states that browser clearing can lose local work.
Delivery completes only when the receipt confirms the submitted envelope and, when required, its matching submitted body.
Header-only acceptance retains a missing-body row. After lookup, an identical complete submission can supply that body.
Body refusal remains an unfinished delivery outcome. Accepted bodies with interpretation dependencies or index lag are delivered.
Finished rows disappear and the header marker clears when no listed unfinished records remain.
The direct route remains valid and shows an empty state. Stored records and independent peer receipts remain retained.
A quiet retained-records disclosure exposes stopped records, export, and Resume delivery within `/outbox`.
Resume uses the same bytes, selected recipients, and receipt lookup before retry, including after reload.
It never creates a new signature or silently changes recipients. Acceptance scenarios in the frontend specification cover this flow.
Normal transient sends do not appear here. Accepted pending dependencies and index lag remain accurate publication states elsewhere.

## Responsive and accessible behavior

At 360 CSS pixels, ordinary controls and prose fit without horizontal page scrolling.
Header groups wrap and the search field remains available. Footer links wrap without hidden navigation.
Wizard columns stack in source order. Type cards use one column when two no longer fit.
Place fields stack at narrow widths rather than retaining the desktop three-column grid.
Long headwords, identity fingerprints, labels, and right-to-left text never force page overflow.

Wide gismu tables can scroll inside a labeled keyboard-accessible region, or use a stacked alternative.
Tables provide header cells and retain the association between each value and its column.
Sticky action bars reserve sufficient content space. The final field, footer, and focused control remain reachable without overlap.
Scrolling, zoom, and virtual keyboards must not hide the active editor behind the bar.
An implementation can use ordinary-flow action bars when sticky behavior cannot meet those requirements.

Every input has a persistent label. Hidden radio inputs show visible focus on their enclosing control.
Dialogs restore focus and disclose provider, declared tasks, and data scope before the first AI request.
Changed providers or expanded scopes require new consent. AI failure never blocks manual editing.
Status changes use noninterrupting announcements. Reduced motion and screen-reader behavior follow the frontend acceptance requirements.
Critical delivery, authority, storage, and conflict state remains accessible despite the compact layout.

## Evidence and sample data

The [design canvas](https://claude.ai/artifact/RA67uPNTP1oiVoSmks6Fsi) is an optional, informative reference.
This document contains the requirements independently of canvas access.
Its twelve screens are Search, Word, Meaning, Type, Lujvo, Gismu, Places, Publish, Your key, Public identity, Trust, and Not delivered.
Their layout and palette inform this document. Their canvas scripts and runtime-dependent HTML are not application code.
The behavior and corrections in these specifications take precedence over illustrative screen omissions.

Example identities, fingerprints, scores, reviewer counts, dates, revisions, and undelivered records are not operational fixtures or trust roots.
Deployment names, roots, witnesses, biographies, and recipient names come from actual configuration or records.
Named generation presets require sourced, pinned parameters. Sample numerical outputs never become an independent algorithm oracle.
The launch roster and baseline identity name remain separate approval decisions. The software license also remains undecided.
