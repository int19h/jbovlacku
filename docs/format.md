# Jbovlacku repository format and tooling

This specification defines target behavior for format version 1. It does not claim that every requirement exists in the prototype.
The [frontend specification](frontend.md) defines the web app. The [README](../README.md) describes the implemented scope.

## 1. Scope and authority

The format covers Lojban definitions, revisions, rafsi assignments, identities, and public editorial decisions.
Phrasebooks, collections, wiki pages, and mailing-list archives remain outside the scope.
A publication is an immutable dictionary claim. An event is an immutable signed action.
A body contains the longer content of an event. A header contains its control fields.

Independent servers exchange events and retained bodies. Each server chooses its admission and retention policies.
No server, root list, morphology parser, or ranking view has mandatory authority across the network.
A view is a chosen policy for interpreting editorial influence. Different frontends can choose different views over identical records.

Signatures identify keys. They do not prove distinct people, expertise, personal names, or linguistic correctness.

The same accepted event set and policy produce the same logical state. Arrival order, Git line order, and wall clocks never settle conflicts.
Missing data remains missing. A server cannot claim that its inventory contains every event in the network.

## 2. Storage decision

Version 1 uses portable SSHSIG signatures over canonical JSON headers. Bodies use content hashes.
Git is a specified repository carrier. HTTP is another carrier for the same signed events.
Author signatures survive Git history changes and export to ordinary files. Git commit signatures authenticate repository snapshots only.

This choice retains established OpenSSH signing infrastructure. It does not introduce a cryptographic algorithm.
It also permits client signing and Workers hosting without a Git process.
A normal clone provides readable JSONL. A dictionary merger supplies set-union semantics that ordinary text merging does not provide.

## 3. Bytes, identifiers, and signatures

All JSON uses UTF-8 and RFC 8785 canonicalization. Reject duplicate object keys, invalid Unicode scalar values, and noncanonical stored bytes.
HTTP transport can use ordinary JSON whitespace and key order. Receivers reject duplicate keys and canonicalize enclosed objects before computing signed inputs.
Stored objects must already use canonical bytes. Canonicalization cannot repair a wrong signature, forbidden field, or invalid value.

Numbers are integers within the JavaScript safe integer range. Exact decimal quantities use strings.
Transport accepts mathematically integral decimal and exponent forms, such as `1.0` and `1e0`. Canonicalization writes these values as integer tokens.
Receivers must reject genuine fractions before binary64 rounding can turn them into integers. Stored JSON remains strictly canonical.

Unknown fields are errors for version 1, except explicitly open legacy source objects and derived-profile parameters.
Missing required fields and additional union variants are errors. An optional field has the exact absence or null rule stated below.

Identifiers have these forms:

| Identifier | Derivation |
| --- | --- |
| Identity | `ed25519:` plus 64 lowercase hexadecimal digits for the public key. |
| Body | `sha256:` plus SHA-256 of its canonical JSON bytes. |
| Event | `jve1:` plus SHA-256 of `jbovlacku-event-v1\n` followed by canonical header bytes. |
| Word | `jvw1:` plus SHA-256 of `jbovlacku-word-v1\n` followed by canonical word-object bytes. |
| Rafsi pair | `jvr1:` plus SHA-256 of `jbovlacku-rafsi-v1\n` followed by canonical pair-object bytes. |
| View | The event ID of a `view.publish` event. |

The `\n` notation above means one LF byte. Hash inputs contain no trailing LF unless specified.
A word object contains exactly `language: "jbo"` and `spelling`.
A rafsi pair object contains exactly `word`, as its word ID, and `rafsi`, as its NFC spelling.
New spellings use NFC. Preserve case, apostrophes, periods, and internal spaces.

Reject empty spellings, control characters, and leading or trailing whitespace. Limit a spelling to 256 UTF-8 bytes.
Search aliases do not change word identity. Morphology disagreement does not invalidate a word.

The SSHSIG message M equals the event hash input, including its domain prefix and single LF separator.
SSHSIG hashes M with SHA-512. Ed25519 signs the SSHSIG signed-data structure, not M directly and not the event ID.
Use SSHSIG version 1, namespace `jbovlacku-event-v1`, hash name `sha512`, and a reserved SSH string of length zero.
An SSH string contains a four-byte unsigned big-endian length followed by that many bytes.
The signed-data structure concatenates `SSHSIG`, the namespace string, the empty reserved string, the hash-name string, and the 64-byte digest string.

The stored blob concatenates `SSHSIG`, version as four big-endian bytes, and the public-key, namespace, reserved, hash-name, and signature SSH strings.
The public-key string contains SSH strings for `ssh-ed25519` and the 32 public-key bytes.
The signature string contains SSH strings for `ssh-ed25519` and the 64 signature bytes. The complete stored blob has no enclosing SSH-string length prefix.
The SSH key type and signature algorithm are `ssh-ed25519`. Certificates and other key algorithms are outside version 1.

The SSHSIG structure must parse completely, without trailing bytes. The SSH public key must equal the header identity. The signature field stores the complete binary SSHSIG blob as RFC 4648 section 4 base64, with padding and no line breaks.
Reject base64url alphabets, missing padding, and nonzero unused trailing bits.
The CLI can convert that blob to standard OpenSSH armor without changing its meaning.

Use established Ed25519 and SSHSIG libraries. Do not implement curve arithmetic as application code.
The acceptance profile requires canonical point encodings, a scalar below L, and a nonidentity public point in the prime-order subgroup.
The signature point must belong to that subgroup. Use the uncofactored Ed25519 verification equation.
All implementations must pass the shared boundary vectors before interoperability claims.

A platform verifier that cannot establish this profile needs an additional compatible library.
This profile deliberately accepts a stricter subset than some generic Ed25519 verifiers.
OpenSSH signing interoperability does not make its verifier alone the acceptance oracle for malicious boundary inputs.

An envelope contains exactly `id`, `header`, and `signature`. The ID is derived, not an independent authority.
Duplicate envelopes represent one event. Different valid signatures over the same header do not create additional actions.
For a deterministic carrier export, select the smallest valid signature by decoded-byte lexicographic order among the available variants.

Invalid variants are rejected without quarantining an existing valid event. Collision handling compares canonical headers, not complete envelope bytes.
A digest collision between different canonical headers is a hard integrity failure. Quarantine both values rather than choose one.

```json
{
  "id":"jve1:<64 hex digits>",
  "header":{
    "version":1,
    "issuer":"ed25519:<64 hex digits>",
    "previous":[],
    "nonce":"<32 hex digits>",
    "action":{"kind":"identity.merge"},
    "content":null
  },
  "signature":"<base64 SSHSIG blob>"
}
```

Angle-bracket values in examples are placeholders, not valid production records.
A header contains exactly the six fields shown. `previous` is a sorted, duplicate-free array of this key's preceding event IDs.
`nonce` contains 16 random bytes as lowercase hexadecimal. It distinguishes intentional identical actions.

`content` is null or `{"hash":"sha256:...","bytes":123}`. The byte count measures canonical body bytes.
Bodies contain no authoritative timestamps. Optional author dates in provenance remain descriptive claims.

Limits are part of this version:

| Item | Limit |
| --- | --- |
| Canonical header | 16 KiB |
| Complete envelope | 20 KiB |
| Canonical body | 256 KiB |
| JSON container depth | 32 |
| Own predecessors | 64 |
| Other event references | 256 |
| Definition parents | 16 |
| Rich text nodes | 8,192 per body |
| Place declarations | 256 per definition |

These limits protect parsers. A server can impose stricter admission limits, but it must identify them as local policy.
Large legacy rows require retained source files and an explicit incomplete-import notice. An importer never truncates them silently.

## 4. Causal order and acceptance

A predecessor must use the same issuer key. All predecessor envelopes must pass signature and header rules.
A first event has no predecessors. Multiple first events represent concurrent branches, not multiple identities.
A client names all known maximal own events, within the limit. It can first publish merge events to combine a larger frontier.

A frontier is a set of maximal known events. A merge event changes no editorial state.

Event B follows event A when B reaches A through own predecessor links.
Foreign publication parents and target references do not establish own causal order.
A client retains unresolved predecessor IDs and reports them as pending. It never invents a missing predecessor.
A cycle, foreign-key predecessor, or invalid dependency blocks that causal branch. Independent identities remain usable.

A known missing or refused own predecessor makes that issuer's history incomplete. Its continuity group is suspended from judgments and outgoing trust.
The evaluator also removes its starting allocation and incoming routes, without redistributing their shares. This prevents known gaps from reviving stale opinions.
Native publication status controlled by an incomplete group is uncertain. Imported publications and explicitly adopted view bodies retain their separate rules.

Before publishing suspended-group scores, a server attempts retrieval from every configured peer within its declared synchronization deadline.
Results list incomplete identities and describe any numerical score as conditional on their suspension. Each suspension names the event that exposed its missing predecessor.
Gap suspension prevents known partial history from reviving stale opinions. It does not detect a peer that omits both newer events and their predecessors. A complete local inventory cannot prove absence of hidden remote events.

Acceptance has separate stages:

1. Make sure that sizes, encodings, hashes, and signatures satisfy section 3.
2. Resolve own predecessors and action references.
3. Determine key lifecycle authority under section 6.
4. Determine whether the action has the required target and body schema.
5. Apply the action to the logical state and rebuild affected indexes.

A signature-valid header can carry an invalid action. Retain its causal position, but give the action no effect.
Its descendants do not inherit the action's semantic error. An invalid envelope cannot serve as a valid predecessor.
A missing definition body prevents that definition from becoming a readable candidate. It does not imply withdrawal.

An absent or invalid explanation body cannot hide a signed clear, curse, shun, or replacement value in a valid header.
A valid register header occupies its causal position even when its required body is missing or malformed.
Unavailable profile content never restores an older profile. An unavailable adopted view body makes its scores unavailable, without parent-view fallback.
A publication with a missing or invalid body remains unavailable as content. Header validity and body availability remain separate.

Server receipts separate admission, interpretation, and body availability, as specified in the frontend API contract.
Interpretation is effective, pending, suspended, inert, or unavailable. Suspended means that incomplete group history or a pending compromise cutoff temporarily prevents authority.
Rejected encoding or signatures never become admitted events. Local withholding is an availability decision, not an editorial verdict.

Local admission refusal is separate from an invalid signature. No peer's invalid event invalidates a complete repository.

## 5. Action catalog and registers

A register holds one actor's replaceable opinion. Historical events remain immutable.
For a register, retain actions without a causally later action for that same register.
A later action replaces an earlier action even without a clock or explicit replacement list.
Unrelated later actions do not replace it. This rule uses the same-key causal graph and accepted succession links.

If all maximal values agree, count that value once. If they disagree, the register is conflicted.
A resolution follows every known conflicting head and states the desired value again.
A newly discovered concurrent branch can reopen the conflict. The client must show that change.

The following table defines all version 1 actions. Objects contain exactly their listed fields.
`kind` appears in every action. Required content refers to the body, not an extra header field.

| Kind | Other action fields | Content |
| --- | --- | --- |
| `identity.merge` | None | Null. |
| `identity.profile` | None | Required profile object. |
| `identity.transfer` | `successor` identity | Null. |
| `identity.accept` | `transfer` event ID | Null. |
| `identity.compromise` | `safe` sorted own frontier | Null. |
| `definition.publish` | `word`, `language`, `parents`, `origin` | Required definition body. |
| `rafsi.publish` | `word`, `assignment` rafsi-pair ID, `origin` | Required rafsi body. |
| `judgment.set` | `target`, `value` | Null or explanation body. |
| `trust.set` | `subject`, `scope`, `value` | Null or explanation body. |
| `status.set` | `target`, `value` | Null or explanation body. |
| `import.status` | `target`, `claim`, `value` | Null or explanation body. |
| `report.set` | `subject`, `category`, `value` | Required reason for `report`, otherwise null or explanation. |
| `account.set` | `origin`, `account`, `value`. Claims also require `previous`, `carry` | Null or account locator body. |
| `account.observe` | `origin`, `account`, `claim`, `result` | Required observation body. |
| `bridge.set` | `origin`, `source_definition`, `target`, `value` | Null or explanation. |
| `view.publish` | `parents` view IDs | Required view body. |

`word` is a word ID. `language` must have well-formed BCP 47 syntax, as defined in RFC 5646 section 2.1. It must use lowercase ASCII and contain at most 63 bytes.
No IANA registry membership test applies. Registry changes must not change the validity of signed records.
An importer retains unmapped legacy language codes separately. It never silently merges simplified English into English.
Publication bodies must agree with their action's word and language.

Origin is `native` or `import`. A native body has legacy null, while an imported body requires a legacy object.
Imported definitions permit import.status through accepted source-author links under section 11. An importer signature alone grants no withdrawal authority.
Imported rafsi claims retain no author status control. Their word-level eligibility still follows the definition gate below.

Definition parents must name definitions for the same word and language. A different-word derivation belongs in source references.
Missing parents keep lineage unresolved. They do not block a complete publication body or its judgments.

An identity profile contains `name`, `bio`, and `links`. The name is at most 80 Unicode scalar values.
The biography uses rich text. Links are HTTPS strings, at most eight.
A profile is a register with one key per issuer. Conflicting profiles show the fingerprint and both claims.

A missing newer profile body does not restore an older profile as current. It shows unavailable profile content.

An explanation body contains exactly `text`, as rich text. It does not affect the verdict.
The judgment register key is actor plus target ID. Values are `bless`, `curse`, and `clear`.
A definition target is its exact publication ID. A rafsi target is its immutable pair ID, shared by all publications asserting that pair.

Judgments on a rafsi pair assess the assignment, not a particular publisher or rationale. Publication itself supplies no implicit blessing.
A conflicted judgment contributes zero. A clear contributes zero and remains visible in history.

The trust register key is actor, subject key, and exact scope. Values are `heed`, `shun`, and `clear`.
Section 8 resolves overlapping scopes. Self-trust records have no effect because self-influence is implicit.
The native status.set register key is publication ID and its controlling author. Only native definition and rafsi claim publications permit status.set.

Values are active and deprecated. Imported definitions use the separate import.status action.
Only the original signer or an accepted successor controls status. Imported attribution does not grant a historical username that authority.
Without a native status action, a native publication is active. Section 11 defines the corresponding imported-definition rule.

Conflicting status makes a publication unavailable for ordinary ranking until resolved.
Deprecated definitions retain judgments, but those judgments contribute zero while deprecated.
Restoring a definition reactivates its existing judgments. A rafsi claim status instead affects pair eligibility, as specified below.

A rafsi body contains `word`, `rafsi`, `rationale`, `sources`, and `legacy`.
Its word is the same word-object shape as a definition. Its rationale uses rich text without place or operand nodes.
Sources use the source-reference array. Legacy is null or the import object in section 11.

`rafsi` is one NFC string, at most 64 UTF-8 bytes. Syntax analysis is an attributed tool result, not admission authority.
Different claims for the same rafsi can coexist. Withdrawal of one definition does not withdraw a separate rafsi claim.
A view treats rafsi claims as inactive when every known eligible definition for that word is deprecated.

This rule is intentional. Without an active definition, that view supplies no current meaning for use in new compounds.
Retired definitions and rafsi assignments remain available for historical interpretation. Retirement does not rewrite existing compounds.
If no eligible definitions are known, rafsi status is unknown. It is not proof that the word is deprecated everywhere.

A conflicted or missing definition status also prevents an all-deprecated conclusion.

Derive the word ID from body.word under section 3. Construct the pair object from that ID and body.rafsi.
Its derived pair ID must equal the action's assignment ID. Never hash the complete claim body as the pair preimage.
Pair eligibility requires a complete active matching claim and at least one active eligible definition for its word.

Valid native publications remain candidates in every view. Source selections restrict only imports.
View exclusions remove influence, not publication content or an author's control over native publication status.
The word gate considers every definition language admitted by the selected view. A display-language filter never changes that gate.
If every eligible definition is deprecated, the pair is inactive only when import eligibility for that word is resolved.

A missing import-selection artifact can contain definitions for any word. It prevents an all-deprecated conclusion without an independently active eligible definition.
Missing selected publications with unknown word IDs have the same effect. Known word IDs restrict that uncertainty to their words. If no complete active claim exists, the pair is inactive or unknown.

In this no-active-claim case, inactivity requires every known matching claim to be completely resolved as deprecated. Missing claims or uncertain status make it unknown.
Without an active eligible definition, missing or conflicted definition status makes the pair unknown unless the all-deprecated rule applies.
No known eligible definition also makes the pair unknown. Unknown pairs cannot receive an automatic assignment.
Eligibility never suppresses evaluation of a competing pair's potential score bounds under section 8.

Deprecating one claim withdraws that signer's assertion. Other active claims for the pair remain.
When no active claims remain, its judgments become inactive. A new claim of the identical pair reactivates those same judgments only when the word eligibility gate also passes.
Changing the word or rafsi creates a different pair and transfers no judgments.

A report names `key-compromise`, `fabricated-identities`, `spam-flooding`, or `impersonation`.
Its register key is actor, subject, and category. Values are `report` and `clear`.
A report with an unavailable reason remains an allegation labeled “reason unavailable.” It supplies no automatic exclusion.
Reports are allegations. They never revoke signatures, appoint successors, or automatically change influence in the baseline view.

A view publisher can name exclusions and cite report IDs.
Unavailable evidence is labeled unavailable. It does not silently remove an exclusion or restore the excluded identity.
Readers can inspect the policy. If they reject it, they can create an explicit local view change.
Version 1 contains no account-age oracle and no recursive voting system for declaring malicious identities.

## 6. Transfer and compromise

A transfer retires one key in favor of a fresh key. It needs a transfer event and an acceptance event.
The old key publishes `identity.transfer`. The new key publishes `identity.accept` as its only first event.

Acceptance names the exact transfer. The transfer names that new key. Neither event proves the holder's real-world identity.

A valid transfer is terminal for the old key. Its eligible ordinary history contains only strict causal ancestors of the transfer.
Ordinary events concurrent with or after the transfer remain visible but lose old-key authority.
A missing acceptance means retired, awaiting acceptance. It does not leave the old key open for new ordinary actions.
The new key can act after acceptance through its own predecessor graph.

Automatic continuity requires exactly one transfer destination and one matching acceptance history.
Two distinct transfer events freeze automatic continuity, even when they name the same destination.
Multiple first events at the proposed successor also freeze continuity. A successor cannot merge several old identities.
Cycles and a successor that already acted independently never establish continuity.

Continuity depends on the current known inventory. A later-discovered transfer or independent successor branch can withdraw previously inferred continuity.
The client must recompute inherited authority and disclose the change. Arrival dates never select which branch deserves continuity.
A later old-key transfer does not override an earlier one. It is evidence of conflicting transfer use.

These conservative rules permit denial of service by a stolen old key. Conflicting evidence prevents the evaluator from selecting an arbitrary successor.
An uncontested thief can transfer inherited influence to a fresh key. Two signatures prove control of keys, not legitimate possession.

An accepted transfer chain forms one continuity group. Its actor ID is the first key in that chain. Each signing key remains separately identifiable.
Inherited judgments, trust registers, author status authority, and configured starting weight move through that group.
The scorer counts the group once. It never counts old and new versions of the same opinion twice.

A new-key action follows retained old-key actions through its acceptance link.
A scope or target that names an old key resolves through accepted continuity before graph construction.
A group's starting allocation is the maximum allocation among its member keys, not their sum.
The client flags duplicate group entries and offers one explicit replacement entry. Late continuity discovery never doubles a duplicated allocation.

A compromise event can appear on any old-key branch, including after a transfer. It remains terminal and cannot be cleared.
Its `safe` frontier contains at most 64 existing own events and can be empty.
Retained authority is limited to those events and their ancestors. Multiple compromise records intersect these retained sets.

Every safe event must be an ancestor of the compromise event. Missing dependencies keep the cutoff pending.
A pending, signature-valid compromise notice suspends that key's outgoing edges and judgment effects until its cutoff resolves.
Its stored judgments remain visible as suspended. A resolved cutoff recomputes their effects from retained history.

A compromise record disables automatic continuity out of that key, regardless of its order relative to a transfer.
A transfer after or concurrent with a compromise never restores inherited continuity. Those signed events remain visible. A compromise record does not revoke independently granted trust in the new key.
An old-key compromise cannot invalidate the successor's own publications or reveal its secrets. It can remove authority inherited through the old key.

Previously inherited authority is recomputed.
A native publication has uncertain status if an admitted status action relies on a transfer-and-acceptance path that is now contested.
Such a path needs matching signatures, even when freshness or unique-transfer rules later fail. An unrelated key cannot create it alone.
Uncertain status does not silently restore an older active value. It excludes the publication from ordinary ranking and exposes the disputed actions.

A new, independently trusted revision remains possible. Version 1 does not resolve contested status authority through timestamps or operator guesses. Historical signatures remain visible with the cutoff that excludes their authority.
A stolen key can name a dishonest frontier or erase useful authority. Cryptography cannot distinguish the legitimate holder from another key holder.

Lifecycle exclusions have explicit effects. Definitions and rafsi publications retain candidate content and show an outside-retained-history label when applicable.
Other actors can still judge those immutable claims. Excluded judgments, trust actions, status actions, profiles, reports, account actions, and bridge actions have no effective value.
Compromise exclusions can make an open imported-status period uncertain under section 11.
Post-transfer actions outside the accepted transfer history have no effect under that section.

A successor independently adopts carried status. Former-period records outside its carry have no effect, including no uncertainty.
A view adopted by exact event ID remains usable despite its publisher's later cutoff. The reader chose that immutable policy directly.
Lifecycle control events remain evidence for cutoffs and conflicts even when they lie outside another retained frontier.

They require correct signatures and action syntax. Invalid lifecycle actions cannot retire a key.

After transfer, clients offer explicit migration of heeds and view allocations to the new key.
A migrated heed first clears the old-key register, then heeds the new key through a causally later event.
A view migration replaces the old root entry instead of adding a second allocation. Direct new-key references survive a later old-key continuity failure.
The retired key remains sensitive. A later holder can disrupt references that still rely on it.

Version 1 has no grace-period undo, quorum recovery, or precommitted recovery secret.
A user with a backup can restore the same key. A user without the key cannot sign a transfer.
Social endorsements can support a new key, but they never forge continuity with the lost key.

## 7. Structured definition content

### Definition payload

The following fields are required. Optional information uses null or an empty array, as specified.

| Field | Type and meaning |
| --- | --- |
| `word` | Object with `language: "jbo"` and NFC `spelling`. |
| `language` | Tag for this definition with well-formed BCP 47 syntax, lowercase ASCII, and at most 63 bytes. No registry membership test applies. |
| `text` | Rich text, defined below. |
| `frame` | Null, or the place frame below. |
| `operands` | Array of grammatical operands. |
| `glosses` | Array of gloss objects. |
| `notes` | Rich text. |
| `etymology` | Descriptive text and optional structured formation data. |
| `examples` | Array of example objects. |
| `classification` | Object with lexical kind and selmaho claims. |
| `labels` | Array of text labels, without automatic ranking effects. |
| `sources` | Array of source references. |
| `license` | License expression and attribution, or explicit unknown for imports. |
| `legacy` | Null, or the import provenance below. |

A lexical kind is an author's classification, not a morphology admission rule.
The permitted labels are `gismu`, `cmavo`, `lujvo`, `fuivla`, `cmevla`, `compound`, `letteral`, and `other`.
Experimental and obsolete status belongs in labels. Import mappings retain the original classification in legacy source fields.
A selmaho is a Lojban grammatical class. Preserve its spelling, including experimental markers.

### Rich text

Rich text is an array of paragraphs. Each paragraph is an array of inline nodes.
Strings represent literal text. Positive integers represent numbered places. Objects represent the other inline types.
Each line below shows one permitted node shape:

```jsonl
"runs on "
2
{"operand":"bridi"}
{"code":"lo ka ce'u cadzu"}
{"word":{"language":"jbo","spelling":"bajra"},"label":"bajra"}
{"url":"https://example.org/source","label":"source"}
```

The example URL is illustrative. It is not a recommended source.
A string node preserves its Unicode content. An empty rich text value is `[]`.

A nonempty paragraph contains at least one node. String nodes must be nonempty. A literal number is a string, such as "2".
Inline booleans, nulls, fractional numbers, and arrays are invalid. Old text and place wrapper objects are not alternate encodings.
Raw HTML, executable code, embedded images, and automatic remote fetches are absent from version 1.

Outside a definition, rich text prohibits integer place references and operand nodes. A profile, reason, rafsi claim, or view has no implicit frame.
URLs use HTTPS. Clients show their destination and never execute URL text.
Literal mathematics and legacy TeX remain text or code. A future math extension cannot redefine place nodes.

Every integer node refers to the current definition's frame. It must name a declared place from 1 through 65,535.
Every `operand` node refers to a declared operand ID. It never counts as a predicate place.
Nested examples and foreign predicates use code or literal text. Version 1 does not infer their variable bindings.

Text, notes, frame constraints, place descriptions, place constraints, default conditions, default explanations, tail descriptions, type notes, and operand descriptions permit those nodes.
Etymology descriptions, formation notes, and derivation explanations prohibit them. Notes can use explicit nodes for the current frame. A quoted foreign `x_2` remains literal text.

The editor converts unescaped ① through ⑳ to integer place nodes only in its structured mode.
This convention comes from other dictionaries. It is not Lensisku source notation.
An explicit insert control handles higher numbers. The editor provides a literal-character escape and a plain-text paste choice.

The wire representation contains no escape convention beyond JSON. Clients never run compatibility normalization on definition text.
NFKC changes circled numerals, so it cannot preserve this editor notation.

### Place frames

A frame describes the numbered places of one relation.

```json
{
  "role":"predicate",
  "arity":{"mode":"fixed","count":3},
  "places":[
    {"index":1,"glosses":[],"description":[],"type_hints":[],"defaults":[],"constraints":[],"derivation":[]},
    {"index":2,"glosses":[],"description":[],"type_hints":[],"defaults":[],"constraints":[],"derivation":[]},
    {"index":3,"glosses":[],"description":[],"type_hints":[],"defaults":[],"constraints":[],"derivation":[]}
  ],
  "tail":null,
  "constraints":[]
}
```

`role` is `predicate` or `constructed-predicate`. The latter describes the relation formed by a grammatical construction.
A null frame means that the publication supplies no frame. It does not mean zero places.
Fixed arity declares every index from 1 through `count` exactly once. Count ranges from 0 through 256.

A context-dependent frame uses `{"mode":"context"}`. Its optional declared places make no completeness claim.
A variable frame uses `{"mode":"variadic","minimum":2}`. Its `tail` describes repeated places beyond the declared prefix.
A tail contains `from`, `description`, and `type_hints`. Its `from` equals one plus the prefix length.

Variable frames declare a contiguous prefix that includes at least the minimum number of places.
Place references in rich text still require explicit declarations, including illustrative places beyond the minimum.
A missing upper limit means no finite bound, not that clients must allocate an infinite array.
Every frame has exactly `role`, `arity`, `places`, `tail`, and `constraints`.

Frame constraints are rich-text descriptions of relationships between several places. Place constraints describe that place. The places array is always present, with unique indices in ascending order.
For fixed and context modes, tail is null. For variadic mode, tail is required and minimum ranges from 0 through 256.

A context frame can have an empty or noncontiguous place list. Its declarations still need unique indices.
Arity objects have exactly one of three shapes: fixed with count, variadic with minimum, or context without another field.
Relation arity uses only that arity object, without a frame or tail. Its counts range from 0 through 65,535.

A frame contains at most 256 declarations. Place indices are positive integers no larger than 65,535.
A fixed frame uses contiguous indices. Other frames can represent uncertainty without guessing a fixed count.
The frame order follows indices. Text order never changes that order.

### Glosses, types, and defaults

A gloss has `language`, `text`, and nullable `sense` fields. Its language is independent of the definition language.
A place gloss belongs to its explicit place object. Array position never supplies a missing place index.
Imported glosses without indices remain unassigned legacy data. They never enter a guessed place object.

A place has at most one type hint object in its type_hints array. A tail follows that same limit.
A type hint states an author's expectation about a place. It does not enforce grammar or prove a formal type.
The `alternatives` array expresses alternatives. Within an alternative, its fields apply together.

```json
{
  "alternatives":[
    {"tags":["relation"],"abstractor":"ka","relation_arity":{"mode":"fixed","count":1}},
    {"tags":["number"],"abstractor":"ni","relation_arity":null}
  ],
  "note":[]
}
```

Each hint contains exactly `alternatives` and `note`. Its alternatives array has between 1 and 32 distinct objects.
Each alternative contains exactly `tags`, `abstractor`, and `relation_arity`. Tags form a sorted, duplicate-free array with at most 32 entries.
At least one tag, abstractor, or relation-arity value must supply information. Empty alternatives are invalid.

Standard tags are `entity`, `agent`, `event`, `state`, `process`, `relation`, `proposition`, `number`, `text`, `set`, `mass`, `sequence`, and `tuple`.
These tags carry no automatic subtype relationships. `abstractor` names a suggested Lojban abstraction form, or null.
Standard abstractors are `nu`, `du'u`, `ka`, `ni`, `jei`, `li'i`, `si'o`, `su'u`, `mu'e`, `pu'u`, `za'i`, and `zu'o`.
A relation arity describes the value in one place. It does not change the outer definition's place count.

Custom tags use an HTTPS URI. The client preserves unknown tags and does not fetch them automatically.
`relation_arity` supports `fixed`, `variadic`, or `context` with the same count meanings as a frame.
Absence of a type hint means unknown. A hint does not prohibit metaphor, coercion, or a competing interpretation.

A default has the following shape:

```json
{
  "kind":"conventional",
  "value":{"format":"lojban","text":"li pa"},
  "condition":[],
  "explanation":[]
}
```

`kind` is `conventional` or `suggested`. `value.format` is `lojban` or `prose`.
A prose value also contains `language`. An empty condition states no additional condition.
A default describes a proposed interpretation or fill. Version 1 does not execute conditions or substitute omitted arguments.

A missing default does not mean `zo'e`, `zi'o`, an empty value, or a universal quantifier.
Several defaults can describe different contexts. The client exposes their conditions instead of selecting one silently.
Cross-place constraints are rich text. They are attributed descriptions, not an executable constraint language.

Units and standards remain separate place roles or descriptions. Version 1 does not infer conversions from an English unit name.

A derivation item records a component word, nullable exact definition ID, source place index, and explanatory rich text.
A word-only reference is unresolved evidence. It never asserts a formal identity between places from every definition of that word.

### Etymology and formation evidence

Etymology contains exactly `text`, `formation`, and `compound`. Text is rich text without place or operand references.
Both structured fields can be null. Free text remains available when structured evidence exists.
These fields record attributed formation claims, not automatic proof of historical construction.
A lexical classification never implies that a generation algorithm produced the word.

The formation object contains exactly method, algorithm, sources, weights_profile, generated, selected_score, selected_rank, selection_reason, candidates, and conflicts.
Method is algorithmic, non-algorithmic, or unknown. Non-algorithmic requires a null algorithm. These claims can describe roots, borrowings, or names.
Sources is an ordered array with at most 64 entries. Each entry contains language, word, input, weight, and notes.

Language is a definition-language tag. Word preserves the original source spelling. Input is the exact algorithm input, or null when unknown.
Weight is a nonnegative rational under section 8, or null when historical evidence supplies none. Notes is rich text.

An input contains exactly format and text. Format is `lojbanized` or `ipa`, and text is nonempty.
IPA input requires a versioned conversion rule before a letter-based generator can use it.
Repeated languages represent multiple source words. A new run must specify how it aggregates their contributions.

Algorithm is null or an object containing id, version, implementation, and parameters.
Id is an HTTPS identifier. Version is a nonempty string. Implementation is a nullable source reference.
Parameters contains exactly weighting, matching, transliteration, candidates, and aggregation, each a nonempty versioned rule identifier.
The first four reference rules are `normalize-positive-sum-v1`, `cll-letter-match-v1`, `literal-lojbanized-v1`, and `cll-gismu-forms-v1`.

Aggregation uses `maximum-per-language-v1`. Alternative rows for one language share a weight and contribute its largest normalized recognition score.
Normalize weights over distinct languages, not source rows. Adding another synonym never creates another language allocation.
Different non-null weights for one language make the formation claim inconsistent. The body remains valid, but the client never labels that run reproducible.

A run with unresolved parameters remains descriptive historical evidence. The frontend never labels it reproducible.
Weights_profile is null or an object containing exactly name and source. Name is a nonempty string or null. Source is a nullable source reference.

Resolved row weights remain authoritative for the recorded run. A profile name never substitutes for the actual weights or normalization rule.

Generated is null or the exact candidate spelling evaluated by the recorded run. It can differ from the current headword after manual editing.
Selected_score is null or a nonnegative calculated rational. Numerator and denominator are canonical unsigned decimal strings, each at most 4,096 digits.
The fraction uses lowest terms and a positive denominator. Zero is numerator "0" and denominator "1".

This representation preserves results such as 3/7 without inventing a finite decimal approximation.
Selected_rank is null or a positive safe integer. It equals one plus the number of candidates with strictly greater scores.
Equal scores share a rank. An incomplete search has null selected_rank rather than a claimed global rank.

Selection_reason is rich text. Rank and score never require the author to choose a top-scoring form.
Missing historical weights, inputs, scores, or ranks remain unknown. Importers never substitute dictionary voting scores.

Candidates contains at most 32 considered alternatives, each with form, score, and rank. Score and rank follow the selected-result types.
Conflicts contains acknowledged objects with word, rule, and snapshot. Word is a word ID. Snapshot is the author's inventory digest.

Rule is identical, final-vowel, or similar-consonant. These records identify known acknowledgments, not proof of complete global coverage.
A source inconsistency or a calculated mismatch produces a visible diagnostic. It does not make otherwise well-formed historical evidence invalid.

The compound object contains exactly components, morphology, scoring, score, and notes.
Components is an ordered array of 2 through 64 objects. Each contains word, definition, and rafsi.
Word is a word object. Definition is a nullable exact definition event ID. Rafsi is the selected nonempty spelling, without automatically inserted joining characters.

Morphology and scoring are objects with exactly id and version. Id is an HTTPS identifier, and version is nonempty.
Score is null or a safe integer. Notes is rich text. This metadata does not itself assign or endorse any rafsi.

The author can record both structured formation fields when that reflects the word's history. Neither field overrides its classification.

A compact illustrative etymology follows. It does not claim actual historical inputs for a named word.

```json
{
  "text":[["The author chose this form for easier pronunciation."]],
  "formation":{
    "method":"unknown","algorithm":null,
    "sources":[{"language":"en","word":"write","input":{"format":"lojbanized","text":"rait"},"weight":null,"notes":[]}],
    "weights_profile":null,"generated":null,"selected_score":null,"selected_rank":null,
    "selection_reason":[["The historical score is unknown."]],"candidates":[],"conflicts":[]
  },
  "compound":null
}
```

### Grammatical operands

An operand has `id`, `category`, `description`, and `cardinality`.
Its ID matches `[a-z][a-z0-9_-]{0,31}`. Its category is a descriptive string such as `bridi`, `selbri`, `sumti`, or `number`.
Cardinality contains exactly `minimum` and nullable `maximum`. Both finite values are integers from 0 through 65,535.

A finite maximum cannot be smaller than the minimum. Operand IDs are unique within the definition.
Cardinality describes the construction, not outer predicate arity.
A `ka` entry can declare a bridi operand and a constructed-predicate frame separately.
A `se` entry can describe a transformation without inventing places belonging to `se` itself.

Version 1 has no executable grammar plugin. Detailed transformations remain notes until a separate, reviewed extension defines their semantics.

### Remaining body fields

`classification` contains `kind`, as a standard lexical label, and `selmaho`, as an array of strings.
`labels` contains at most 32 strings, each at most 80 Unicode scalar values.
An example contains `language`, `text`, `translation`, and `notes`. Its text is a literal string.
Its translation and notes use rich text without outer-place or operand nodes. Example variables remain literal.

A source reference contains `label`, nullable HTTPS `url`, nullable `event`, and nullable `locator`.
Its locator is a textual source position. Source references do not fetch content automatically or grant authority.
A derivation item contains `word`, nullable `definition`, positive `place`, and rich-text `explanation`. Its word field is a word object, not a word ID. Its place index belongs to that source word, not the current frame.

Both frame and place `constraints` fields are arrays of rich-text values. `glosses`, `type_hints`, `defaults`, and `derivation` are arrays, even when empty.

`license` contains `expression`, nullable `url`, and `attribution` text.
A license value records a rights claim. Signature acceptance does not establish that claim's legal validity.

The reference client fills new native definitions with `expression: "CC0-1.0"` and `url: "https://creativecommons.org/publicdomain/zero/1.0/"`.
The Publish action is explicit agreement to these terms. The client shows the linked notice before that action, without a separate checkbox.
The [frontend specification](frontend.md#5-add-a-definition) defines the publication flow and notice.
The software license remains a separate prelaunch decision.

Imported Lensisku dictionary text uses `expression: "LicenseRef-Lensisku-Public-Domain"`.
Its `url` is `https://github.com/lojban/lensisku/blob/d5a12821ed1e8c24ede711b63625b0782d2f6ae8/frontend/src/locales/en.json#L362`.
This expression records the source public-domain claim. It does not mean that Lensisku selected CC0.
The importer preserves original author attribution and the following exact statement in `license.attribution`:

> All content is public domain. By submitting content, you agree to place it in the public domain to the fullest extent allowed by local law.

The importer also records a source reference with that URL and locator `footer.publicDomainNotice`.
Retain the statement and pinned source evidence in the import archive.
This is the importer's report of the source notice, not proof of historical contributor consent or authorship.
The notice covers imported dictionary text. It does not establish rights for third-party images or other separately sourced artifacts.

Imports without established rights retain `expression: "unknown"` and their available source evidence.
Existing signed bodies with unknown rights remain immutable. Section 11 defines how an explicit enriched extraction records newly established rights.
A native revision uses the same CC0 fields for the contributor's own contribution.
Its `license.attribution` and `sources` retain the imported rights claim, original attribution, and source evidence.
That action does not relicense the imported source.
Prototype fixtures declare their own rights and do not establish rights for real source content.

### Example of a structured definition

This example is new illustrative wording. It is not a claim that a historical author supplied these annotations.
This complete body includes empty values for its unused fields. Pretty-printed examples become canonical JSON before signing.

```json
{
  "word":{"language":"jbo","spelling":"banli"},
  "language":"en",
  "text":[[1," is great in property ",2," by standard ",3,"."]],
  "frame":{
    "role":"predicate",
    "arity":{"mode":"fixed","count":3},
    "places":[
      {"index":1,"glosses":[],"description":[],"type_hints":[],"defaults":[],"constraints":[],"derivation":[]},
      {"index":2,"glosses":[{"language":"en","text":"property","sense":null}],"description":[],
       "type_hints":[{"alternatives":[{"tags":["relation"],"abstractor":"ka","relation_arity":{"mode":"fixed","count":1}}],"note":[]}],
       "defaults":[],"constraints":[],"derivation":[]},
      {"index":3,"glosses":[],"description":[],"type_hints":[],"defaults":[],"constraints":[],"derivation":[]}
    ],
    "tail":null,"constraints":[]
  },
  "operands":[],
  "glosses":[{"language":"en","text":"great","sense":"in a property"}],
  "notes":[],"etymology":{"text":[],"formation":null,"compound":null},"examples":[],
  "classification":{"kind":"gismu","selmaho":[]},
  "labels":[],"sources":[],
  "license":{"expression":"CC0-1.0","url":"https://creativecommons.org/publicdomain/zero/1.0/","attribution":"Illustrative specification example"},
  "legacy":null
}
```

## 8. Editorial trust and ranking

### Views and starting influence

The reference view uses a fixed own allowance and a separate outward allowance.
It never assigns influence merely because a key exists, submits many definitions, or claims an old creation date.
The public view publisher chooses starting identities and allocations. A personal view can choose different roots or private overrides.

A `view.publish` body contains these fields:

| Field | Meaning |
| --- | --- |
| `name` | Human-readable name, at most 80 Unicode scalar values. |
| `description` | Rich text. |
| `roots` | Sorted objects containing `identity` and nonnegative rational `q`. |
| `rafsi_threshold` | Positive rational automatic-assignment threshold. Reference value `1/1`. |
| `H` | Rational outward multiplier. Reference value `3/1`. |
| `alpha` | Rational onward fraction. Reference value `1/2`. |
| `excluded` | Sorted objects containing `identity` and `evidence`, an array of event IDs. |
| `calculation` | `simple-routes-bounds-v1`. |
| `work` | Positive integer expansion budget. Reference value 1,000,000. |
| `import_sets` | Sorted objects containing `source`, `importer`, and `selection`. |
| `account_witnesses` | Sorted identity keys trusted for external-account observations, without duplicates. |
| `account_authority` | Boolean enabling source-author controls on imported definitions. The reference view uses true. |
| `notes` | Rich text. |

A rational is `{"numerator":n,"denominator":d}` in lowest terms, with positive denominator.
The numerator and denominator are each at most 1,000,000,000. `0 <= H <= 100` and `0 <= alpha <= 9/10`.
There are at most 10,000 roots. Zero allocations remain permitted but supply no starting influence.

The work budget ranges from 1 through 10,000,000. Resource failures produce unavailable scores, never invented completed results.
Roots and exclusions sort by identity, without duplicates. Evidence IDs sort lexicographically, without duplicates.
Each import entry pins a source namespace, importer identity, and import-selection hash. Sort entries by those fields, without duplicates.

An import is eligible only when its source and signing key match the entry and its event ID belongs to that selection.
The selection is a canonical sorted JSON array of unique publication event IDs. Its ID hashes its canonical bytes with SHA-256.
Each selection contains at most 200,000 IDs and 16 MiB. Larger selections use several entries with distinct hashes.

A selection can span source snapshots and extraction versions. Each publication retains its own original provenance.
Selections are unsigned artifacts. A chosen signed view authenticates their selection through their hashes.
A missing selected artifact makes import eligibility unavailable. It never means accept every publication that claims the same source.

The importer matches the publication's signing key directly, without succession aliases. Selection entries grant no editorial endorsements.
Each root appears once before continuity resolution. No automatic normalization follows root additions, exclusions, or unused heeds.

The reference public view starts with explicitly selected community participants at `q=1` each.
The launch operator supplies and publishes that roster. This specification does not appoint particular people or organizations.
Adding a participant creates new influence. It is a visible policy action, not a free consequence of account registration.

Organizations can use ordinary keys and ordinary blessings. Official definitions receive no infinite score or protocol privilege.

Public view adoption is outside event validity. A client never adopts a view merely because someone publishes it.
A view update is a new publication with parent links. Its changed allocations remain inspectable and reversible by choosing another view.
Private roots, scopes, weights, and exclusions form an unsigned local overlay. The client includes its digest in result metadata.

The overlay has exactly `version`, `base_view`, `root_changes`, `trust`, `blocked`, and `work`.
Version is 1. Base view is the public view event ID. Work is null or a permitted replacement expansion budget.
Each root change has `identity` and `q`, where null removes that root and a rational replaces its allocation.
Each private trust rule has `issuer`, `subject`, `scope`, `value`, and nullable rational `weight`.

Values are `heed`, `shun`, and `clear`. A private exact-scope rule replaces the corresponding public rule before specificity resolution.
A clear removes the exact public rule and permits broader fallback. A weight is permitted only with heed and must be positive.
Unweighted effective heeds receive relative weight 1. Conflicting retained private heed weights block that edge until the user resolves them.

Blocked entries contain `identity` and `scope`. Their local reason text is stored separately and has no scoring effect.
Arrays sort by their canonical object bytes and contain no duplicate register keys. The overlay digest hashes the canonical complete object.
A null overlay uses the digest of canonical JSON null. Private preferences never become signed records through ordinary synchronization.

### Scope and shuns

A scope contains exactly `kind`, `word`, and `language`.
Version 1 does not scope trust by free-form vocabulary labels or infer dialect equivalence. Distinct views can make different editorial choices.
`kind` is `definition`, `rafsi`, or `*`. Word and language are exact identifiers or `*`.
A rafsi context has no definition language, so it matches only `language: "*"`.

The comparison context uses the target definition's word and language, or the rafsi pair's word with no definition language. Every route edge must match that same context.

Resolve each exact trust register before comparing scopes. Discard `clear` values.
A scope is narrower when its matching contexts form a strict subset of another scope's contexts.
Keep only matching scopes without a narrower matching scope for that same issuer and subject.
If every retained value is `heed`, an edge exists. Any shun or conflict blocks that issuer's edge.

Incomparable scopes can therefore conflict. A narrow clear falls back to a broader heed, but a narrow shun blocks it.

A public shun prevents its issuer's direct edge. It does not cancel independent routes from other people.
A reader's local shun removes the target and all routes through it in that reader's view.
A view exclusion has that same graph effect within the named view.

A block naming any key in a continuity group blocks the whole group. Its own q becomes zero as well as its incident routes. Neither action reverses curses into blessings.
The reference frontend also treats its current user's effective public shuns as local blocks in that user's personal view.
This personal behavior does not impose a veto on the public view.

Build each positive outgoing row before applying view exclusions and local blocks. Divide it equally among its resolved heeds.
Private weights can replace equal weights. Let s be their positive sum.
If s exceeds one, divide each weight by s. Otherwise retain the weights without scaling them upward.

This permits a private row to leave part of its allowance unused. Default weight one gives equal shares across ordinary heeds.
Then zero blocked destinations without redistributing their shares. Self edges are absent.
Resolve subject keys through continuity before register grouping. This makes old-key and successor-key opinions refer to the same resolved subject.

Merge duplicate destinations before normalizing a row. Recompute these groups if later evidence changes continuity.
Changing one's own heed list can change the original split. A downstream block never enlarges surviving route shares.

### Mathematical target

Let `q_i` be actor i's configured starting allowance. Let `p_uv` be the resolved outgoing share from u to v.
A simple route never visits an actor twice. Continuity groups count as actors for this rule.
The contribution along route `(r,v1,...,vk)` is:

```text
H * q_r * alpha^(k-1) * p[r,v1] * ... * p[v(k-1),vk]
```

An actor's weight equals its own `q` plus all simple-route contributions that end there.
An actor retains every received contribution for its judgments and forwards the alpha fraction onward.
Its own outward pool is `H*q`, independent of its own judgment allowance.
Changing only its outgoing heeds cannot increase its own weight. No route can return through proxies and pay it again.

The total weight is bounded by `Q * (1 + H/(1-alpha))`, where Q is the retained sum of starting allocations.
At H=3 and alpha=1/2, that bound is 7Q. One root and aligned delegates can approach seven units together.
This is intentional delegated influence. It is not seven independent reviewers or evidence against coordinated endorsements.

Unused shares disappear. There is no final normalization by used influence.

The scorer counts each actor's effective judgment once per definition publication or rafsi pair.
Support sums weights for blessings. Opposition sums weights for curses. Net support equals support minus opposition.
A deprecated definition contributes no score and sorts after every active definition in its word and language context.

A publication alone gives its author no automatic blessing. The reference client publishes a separate signed author blessing with each definition or rafsi claim.
This is client behavior, not a condition for valid publication. Other clients and importers can publish without that judgment.
A new revision receives no automatic transfer of other people's judgments.

### Bounded calculation

Full enumeration can take exponential work. Version 1 preserves that mathematical target and permits certified numerical intervals.
An interval contains a proved lower and upper bound. It is not a probability or confidence percentage.
A score result names both snapshot and logical-inventory digests, view event, local overlay digest, algorithm, work budget, and completed work.

The reference algorithm maintains complete stages of simple-route prefixes. Each prefix contains visited actors, an endpoint, and its outgoing mass.
Initialize one prefix per positive root with mass `H*q` and a visited set containing that root. Omit zero-mass prefixes.
Initialize each actor's lower weight to its q.

Before costing a stage, merge prefixes with identical visited actor sets and identical endpoints. Sum their outgoing masses exactly.
Visited sets contain continuity-group actor IDs. Prefix order does not affect merging or cost.

A stage attempts every positive-share edge of every merged current prefix. Outgoing degree counts positive entries in the effective matrix P. Its cost is the sum of those outgoing degrees, including repeated-actor attempts.
Compute that cost before expansion. If it exceeds the remaining budget, stop before the complete stage.

A prefix holds outgoing mass m before edge shares. An allowed edge of share p adds m*p to the destination's lower weight.
Queue outgoing mass alpha*m*p for the next stage. These operations place alpha after the first hop, as the route formula requires.

Discard repeated-actor edges and zero masses. Do not redistribute them. If no prefixes remain, the result is exact.
Identity order determines stable serialization only. It never selects a partial stage for deeper expansion.

At the limit, aggregate every unexpanded prefix's outgoing mass by endpoint into vector b.
This aggregation scans prefixes once. It does not enumerate their neighbors again.
Set `f = Pᵀ*b`. This first relaxed step ignores visited-set restrictions, so it supplies an upper bound, not additional lower credit.
The lower result remains the completed-stage totals L. For the upper result, add these vectors to L:

```text
f, alpha*Pᵀ*f, ..., (alpha*Pᵀ)^64*f
```

Then add this scalar tail bound to each actor's upper endpoint:

```text
alpha^65 * sum(f) / (1-alpha)
```

Each allowed continuation occurs in this nonnegative relaxed walk sum. Extra repeated routes only enlarge the upper bound.
Rows sum to at most one, so the stated tail contains every remaining contribution. Empty b gives exact bounds.
The largest useful complete stage depends on the graph. A high-degree graph can stop before its first stage.

This profile avoids a separate unbounded pass over all prefix-neighbor pairs for an exact frontier.

The reference intervals use exact rational arithmetic. A result bearing this profile name must equal those intervals.
An implementation with outward rounding must identify a derived calculation profile and enclose the reference intervals.
It cannot claim an ordering that the reference bounds do not establish. More complete exact stages use a larger declared budget.
Implementations that prove tighter bounds through another method also need a distinct profile name.

The format's mathematical target remains unchanged across these calculation profiles.

The expansion budget does not bound graph construction, memory, rational sizes, or matrix work.
A server can return a resource-limit error. It cannot label uncertified partial numbers as final scores.

For signed judgments, add blessing intervals and subtract curse intervals in the opposite endpoint order.
If support is `[b0,b1]` and opposition is `[c0,c1]`, net support is `[b0-c1,b1-c0]`.
For candidates with the same weighted context graph, compare their score difference per actor before summing bounds.
Let each actor's coefficient be its scoring verdict on A minus its scoring verdict on B, with bless=1, curse=-1, and absence=0.
Only effective judgments on eligible targets supply scoring verdicts. Deprecated or unavailable targets never acquire a lead through raw historical judgments.

Conflicted or suspended judgments contribute absence. Their visible history remains unchanged.
Sum the smaller endpoint product for the lower difference bound and the larger product for the upper bound.
The coefficient can be -2, -1, 0, 1, or 2, because a bless-versus-curse comparison differs by two.
For positive coefficients, use lower weights in the lower result and upper weights in the upper result.

For negative coefficients, reverse those endpoints before multiplying. Zero coefficients contribute zero.
Shared judgments cancel exactly. A positive lower difference bound proves that A outranks B.
For different context graphs, subtract separate score intervals instead. Word-scoped rafsi comparisons often require this conservative case.

Overlapping intervals remain unresolved. Exact equal scores remain ties.

The default list groups candidates into successive nondominated layers. A nondominated candidate has no certainly higher candidate among the remaining candidates.
Within a layer, use full event ID order for stable presentation. Label this as presentation order, not a quality distinction.
The client offers more computation and exposes the intervals.

A resumable calculation retains its complete-stage prefixes and lower totals. It never resumes by treating upper-bound contributions as exact credit. It never silently substitutes a hop limit or random estimate.

### Rafsi decisions and future edits

An eligible rafsi pair has positive support only when its net lower bound exceeds zero.
Each actor has one judgment register per pair, regardless of the number of publishers or duplicate claims.
Concurrent opposite judgments on that pair conflict. A causally later judgment changes the actor's opinion for the pair.
Automatic assignment requires a net lower bound at least rafsi_threshold. A view must set this threshold above zero.

Competing pairs have identical rafsi spellings and different word IDs. Distinct spellings never compete through this rule.
A unique preferred assignment requires a qualifying pair with a certified lead over every eligible competitor with positive net upper bound.
An unresolved known same-spelling pair also prevents automatic selection when its potential net upper bound exceeds zero, or that bound is unavailable.
Compute this potential bound from retained pair judgments without assuming that its claim or word gate passes. It is not an eligibility claim.

An unresolved pair with proved nonpositive potential support cannot defeat a positive candidate.
A claim whose body never revealed its spelling remains unidentified pending data. The service discloses that coverage limitation rather than claiming universal uniqueness.
Automatic preference is conditional on the known, identified inventory. A later body can reveal a new competitor and change it.

Otherwise, tools expose alternatives or an unresolved assignment. They must not quietly choose a new rafsi for generation.
Known historical assignments remain visible with their provenance. Their historical status does not manufacture modern endorsements.

Automatic blessing of future revisions is outside version 1. The frontend can offer notifications and an explicit review queue.
A later extension needs precise branch, author-transfer, revocation, and cutoff rules before it can move any endorsement.

## 9. Git repository layout

A body is the larger content named by a signed header.
The distinction permits selective retention without discarding that signed header. It does not require separate Git files.
The canonical carrier puts an envelope and its available body together in each record.
An import selection lists exact imported publications accepted by a view. It is separate from the server's complete inventory.

A conforming checkout has this layout:

```text
format.json
manifest.json
.gitattributes
records/<first-two-hex>/<six-digit-part>.jsonl
import-selections/<first-two-hex>/<remaining-hex>.json
README.md
```

Format.json contains exactly `{"format":"jbovlacku-git","version":1}` without a final newline.
The attributes file contains exactly `* -text -ident -filter` followed by LF. Tools read Git blob bytes rather than transformed worktree bytes.
A validator rejects a transformed checkout whose bytes differ from its declared snapshot.

Each record contains exactly envelope and body. Envelope has the shape from section 3. Body is a canonical JSON object or null.
A present body must match its header's hash and byte count. A null body means unavailable, not an authenticated empty body.

A null content descriptor requires a null body. Unsupported or invalid action content can remain stored with its authenticated header.
Content-schema failures make that action unavailable or inert under its action rules. They do not alter the signed bytes.

Partition records by the first two digest digits after the `jve1:` prefix. Sort each partition by full event ID.
Pack consecutive canonical JSON lines greedily into parts of at most 8 MiB. Each line ends with LF.
The size includes each final LF. Canonical key order puts body before envelope, regardless of illustrative field order elsewhere.

Number parts from `000000` without gaps. Empty partitions have no files. Duplicate IDs, blank lines, and comment lines are invalid.
Reject a partition that needs more than 1,000,000 parts. This is a carrier limit, not an identity rule.

The layout avoids one indefinitely growing Git blob. Consumers can run `jq '.body.text' records/*/*.jsonl` directly.
The export command also provides a single JSONL stream. No separate dictionary projection is required.
A record's presence does not establish its current authority or eligibility. Consumers need the state evaluator for those decisions.

Import-selection paths split their 64 digest digits into two characters and the remaining 62.
Each file contains canonical bytes without a final newline. Its content ID must reproduce its filename.
Only regular files are permitted. Reject symlinks, executable modes, submodules, path traversal, and unexpected paths.

README is untrusted documentation without authority. Tools never execute it or repository hooks.
README is excluded from the snapshot digest. Fixed format and attribute files must match the stated bytes.

Servers can store bodies separately internally and deduplicate identical content. This does not change the Git representation.
If any retained body matches an envelope's descriptor, canonical export includes it in every matching record.
All copies of one body hash must agree. A descriptor with an incorrect byte count cannot consume that body.
Body objects with no matching retained event remain a local cache outside the canonical snapshot.

Local refusal by body hash takes precedence over copying content from another record or peer.
Two different byte strings that reproduce one body ID create a hash collision. Quarantine both and fill neither until the collision is resolved.
An identical selection-hash collision makes the affected selection unavailable. An invalid claimed hash alone never quarantines matching valid bytes.

The manifest contains exactly these fields:

```json
{
  "version":1,
  "events":{"count":0,"hash":"sha256:<digest>"},
  "bodies":{"count":0,"hash":"sha256:<digest>"},
  "import_selections":{"count":0,"hash":"sha256:<digest>"}
}
```

The events hash covers canonical envelope lines in global event-ID order, each followed by LF. It excludes the containing record and body.
It binds the selected signature bytes. The count states its number of envelopes. An empty stream hashes the empty byte string.

Bodies hashes the canonical sorted array of distinct retained body IDs. Import_selections hashes the equivalent array of retained selection IDs.
Their counts state the array lengths. These content hashes and the canonical filling rule determine each record's body representation.
The snapshot ID hashes canonical manifest bytes, without a final LF, using the sha256 prefix form.
Source-file digests and local-overlay digests use that same string form.

Git and HTTP compute the same manifest from the same retained objects. File partition boundaries do not enter those hashes.

The logical-inventory digest hashes a canonical object with exactly events, bodies, and import_selections.
Each field is a sorted array of its retained IDs. Signature variants do not enter this digest.
Ranking metadata carries both digests. Equal logical digests identify equal known input, not global completeness.
A changed valid signature variant changes the carrier snapshot but not this logical digest.

The dictionary merger examines both snapshots in quarantine and unions their accepted envelopes.
For identical event IDs, canonical headers must agree. Merge valid signature variants under section 3.
Union matching bodies and import selections, then apply the receiving operator's explicit retention policy.
Fill available bodies into every matching record and rebuild the manifest. Line order never establishes semantic time.

Ordinary Git line merging does not replace this procedure.

Carrier history is optional. An operator can rebuild it without refused bodies while preserving author signatures.
A receiver retains accepted events when a remote rewinds refs or advertises fewer objects.
A smaller remote snapshot is a transport observation, not an authenticated user deletion.

## 10. Exchange, omission, and local retention

Peers exchange manifests, event envelopes, and bodies by content ID. Receivers recompute every received digest.
A missing object is `missing`. An explicit local refusal is `withheld`. Neither state means an empty object or a withdrawn opinion.
A server's claim that another server withholds an object is not authoritative.

The HTTP carrier provides a stable snapshot inventory and object reads. Pagination remains tied to that snapshot.
An envelope read for a snapshot returns the exact signature variant committed by that snapshot. Event identity remains independent of that representation.
A server retains those representations for every advertised snapshot, or expires the snapshot explicitly. It never substitutes the latest variant silently.

A cursor is a server-issued page position. It never establishes semantic time.
An expired cursor requires a new manifest and set reconciliation. Existing accepted events remain retained.
Repeated uploads of the same event are safe and never multiply influence.

A successful admission receipt means that this server stored the event under its stated policy.
It does not promise global delivery, permanent retention, or endorsement. The client can send identical signed bytes to another server.
Peer omission remains possible. Compare independent servers and retain known key frontiers to detect some omissions.
No finite collection of peers proves that no hidden branch exists.

Local retention has three separate controls:

| Control | Effect |
| --- | --- |
| Hide | Omit content from ordinary presentation, but retain its bytes. |
| Refuse body | Retain its header and hash, but stop storing and serving its body. |
| Refuse event | Omit its envelope and accept possible gaps in dependent history. |

Body refusal is the normal content-moderation tool. Refusing a signature-accepted header carries a larger cost.
If an operator refuses that envelope, it must exclude that issuer's whole stream from its advertised dictionary inventory.
This avoids publishing an apparently current prefix after knowingly removing a replacement or lifecycle event. Dependent successor streams can become pending.

A private refusal ledger identifies hashes, affected issuers, and operator reasons. It is not a public dictionary shun record.
The receiver consults that ledger before refetching excluded bodies. Peer possession does not override local refusal.
The operator can export the ledger separately, with an explicit privacy warning for its reasons.

Body refusal also expires advertised snapshots that serve the refused bytes. Historical snapshot requests then return HTTP 410 rather than serving those bodies.

Removing a body from the current checkout does not purge historical Git objects.
A physical purge must remove every retained carrier ref, reflog, pack, cache, and backup that contains those bytes.
A fresh repository with the retained event set is the reference safe reconstruction method.
Other operators and prior recipients can retain their copies. The protocol promises no universal deletion.

Signed headers also contain arbitrary bytes. Refusing one can make descendants pending even when their signatures still pass.

### Optional derived embeddings

An embedding is a numerical representation used to compare meaning.
Embeddings are external service artifacts, not dictionary events, author judgments, or part of the canonical repository manifest.
Deleting an embedding cache does not change a definition, its signature, or its endorsements.
Peers can exchange these artifacts separately to avoid repeating expensive inference. Each operator chooses accepted profiles and producers.

A profile describes one vector space and its input rules. Its ID hashes its canonical JSON bytes with the sha256 prefix.
The profile contains exactly version, model, revision, artifacts, provider, runtime, epoch, dimension, encoding, normalization, distance, document, query, and parameters.
Version is 1. Model is the exact requested model string. Revision is an immutable revision string or null when unavailable.

Artifacts is a sorted array of known model, tokenizer, or runtime content hashes, with no duplicate entries.
Provider is a nonempty descriptive identifier. Runtime is null or an object containing name and version.
Epoch is 16 random bytes as lowercase hexadecimal, identifying this declared vector-space generation.

Dimension is an integer from 1 through 65,536. Encoding is f32le. Normalization is unit-l2 or none. Distance is cosine or dot.
Parameters is an explicitly open canonical JSON object containing nonsecret adapter parameters. The entire profile has a 64 KiB limit.

It never contains API keys, bearer tokens, private endpoint credentials, or private draft text.

Document and query each contain recipe, task, prefix, and truncation. Recipe is a versioned identifier, and task is a nullable provider task string.
Prefix is a literal string, including intentional whitespace. Truncation is reject or a versioned, deterministic recipe identifier.
Silent provider-side truncation is not a conforming profile. An adapter must detect or explicitly characterize it before enabling cache sharing.

A profile alone is a metadata claim. The receiving operator must establish that its query adapter produces compatible vectors.

The reference document recipe is `definition-json-v1`.
Construct a canonical object containing language, text, glosses, and places from the authenticated definition body.
Text is the definition's rich text. Glosses is its top-level gloss array. Places is its frame's place array, or an empty array without a frame.
Encode that object as canonical UTF-8 JSON, prepend the profile's literal document prefix, and hash the resulting input bytes.

The recipe excludes the headword, votes, source attribution, etymology, examples, and notes. Another recipe requires another profile.
The reference query recipe is `literal-query-v1`: exact UTF-8 query text after its literal query prefix, without hidden normalization.
Input hashes use the sha256 prefix form. The adapter rejects malformed Unicode and inputs above its declared limit.

Changing dimensions, prefixes, pooling, quantization, input recipes, normalization, or model revision creates a new profile and index.
Matching model names and dimensions alone do not establish compatibility.
A hosted model without an immutable revision needs an explicit epoch and an identified query adapter.
Consumers do not silently merge that profile with independently generated vectors from another endpoint.
Compatibility probes can reveal drift, but cannot prove that a hosted alias never changes.
A detected change suspends that index until compatible query computation or a new profile becomes available.

The operator exposes unknown revision and routing provenance instead of inventing reproducibility.

A vector object contains dimension times four bytes, using little-endian IEEE 754 binary32 values.
Reject NaN, infinity, a zero vector for cosine, and a byte length that disagrees with the dimension.
For unit-l2, require the norm to differ from one by at most 0.0001. Do not silently renormalize a signed artifact.
A vector part concatenates equal-length vectors. An index part is a canonical JSON array with one entry per vector, in event-ID order.

Each index entry contains exactly event, body, and input. These are the definition event ID, authenticated body hash, and recipe input hash.
A part contains at most 8,192 entries. Both its vector and index objects have an 8 MiB uncompressed limit.
Parts can split a large dictionary into bounded transfers. A missing part leaves explicit partial coverage, not an empty dictionary.

A derived manifest contains exactly version, profile, producer, created_at, and parts.
Version is 1. Profile is its hash. Producer is an Ed25519 identity. Created_at is an informational UTC timestamp.

Each part reference contains index, vectors, count, and vector_bytes. Index and vectors are content hashes. Count and vector_bytes are positive integers.
Parts sort by index hash without duplicates. The manifest has at most 4,096 parts and a 1 MiB limit.

An event cannot appear twice across parts of one manifest. The receiver also detects overlapping events across accepted manifests.
Different valid vectors for the same event and profile are conflicting cache claims, not replacements chosen by arrival time.
The operator chooses a producer or recomputes the affected vector. It does not average conflicting vectors silently.

The producer signs the canonical manifest with the same SSHSIG algorithm profile as dictionary events, under namespace `jbovlacku-derived-v1`.
The signed message is `jbovlacku-derived-v1`, one LF, and canonical manifest bytes. The signature does not enter the manifest hash.
The transport bundle contains exactly manifest and signature. This artifact has no dictionary predecessor chain and grants no editorial influence.

Producer trust is an explicit service configuration, independent of linguistic roots and heeds. Unknown producers do not influence semantic search by default.
Revoking a producer suspends its unreviewed artifacts under local cache policy. It does not deprecate dictionary content.

Before indexing a shared artifact, the receiver authenticates the producer and hashes each object.
It must make sure that dimensions and finite values satisfy the artifact profile.
It resolves every definition and body locally, then recomputes the declared recipe input hash.
A missing or changed body prevents activation of that entry. A valid signature proves provenance, not that inference produced the claimed vector.
Trusted producers, reproducible model artifacts, and optional spot recomputation address that remaining trust decision.
The receiver never downloads or executes model code merely because a peer profile names it.

Derived exchange uses these optional endpoints, separate from `/api/v1`:

| Endpoint | Contract |
| --- | --- |
| `GET /derived/v1/profiles/HASH` | Canonical profile bytes matching that hash. |
| `GET /derived/v1/manifests?profile=P&after=ID&limit=N` | Accepted manifest IDs for one profile, sorted by hash. |
| `GET /derived/v1/manifests/HASH` | Signed manifest bundle matching the manifest hash. |
| `GET /derived/v1/objects/HASH` | Exact index or vector bytes matching their content hash. |

The listing returns exactly profile, ids, and next. Next is the last returned hash or null at the end.
Limit ranges from 1 through 1,000, with default 200. Concurrent listings can require another pass and never claim complete network coverage.
GET objects exposes byte length and content hash before bounded download. Compression never changes the hashed uncompressed bytes.

Hosts enforce separate transfer, storage, and inference quotas for derived data. Failure never interrupts ordinary dictionary synchronization.
The canonical import-selection mechanism remains separate from derived manifests. An embedding producer cannot appoint dictionary publications through this API.

## 11. Lensisku import

The import takes immutable source snapshots. Each source manifest records retrieval time, source URL or filename, byte digest, and extraction version.
SQL snapshots and later REST captures remain distinct. The API does not provide a transaction spanning independent requests.
A later field cannot silently overwrite an older row's missing field and masquerade as one source snapshot.

A legacy object contains source, snapshot, extraction, record, locator, original, attribution, conversion, and limitations.
`source` is an HTTPS namespace or stable operator-defined source name. `snapshot` is a source-file digest.
The legacy object also requires `extraction`, a nonempty extraction-version string of at most 80 ASCII characters.

Record contains exactly kind and id. Kind is definition or word for the Lensisku adapter. Id is the positive numeric source record ID.
Definition publications use the source definition ID. Rafsi publications can cite either source kind according to their provenance.
Locator is a human-readable table or endpoint position, independent of that stable record identity.

Original is an open source object with arbitrary field names and preserved source strings, booleans, nulls, arrays, and objects.
Every source number becomes `{"$source_number":"<original numeric token>"}` during extraction, including integer numbers.
An original source object containing the reserved key `$source_number` becomes `{"$source_object":[[key,value],...]}` instead.
The same escape applies to `$source_object`. Escaped object pairs preserve original key order and recursively encoded values.
This tagged representation preserves fractional and large numbers without violating the protocol's integer restriction.

It is an import encoding, not an assertion that the source supplied those tagged objects.
Attribution contains exactly author, editor, author_account, and dates. Author and editor are nullable strings. Dates maps source labels to original date strings.

Author_account is null or an object containing exactly origin, account, username, and evidence. Account is the known numeric source user ID. Username is nullable.
Origin names the canonical HTTPS account system. SQL and API captures of the same account system use the same origin.

Evidence contains exactly kind and source. Kind is source-id or username-lookup. Source is a source reference for the supporting capture or query.
A username-only export cannot invent that numeric association. The importer records separate lookup evidence and its limitations when enriching attribution.

Only source-id evidence establishes source authorship for management or imported status. It needs an explicit numeric author field or a numerically filtered capture.
Username-lookup evidence can support attribution display only. A current profile lookup cannot prove which account authored an older row bearing that username.
The audited listing is `/api/jbovlaste/definitions/list?user_id=ID`. It filters the definition author's numeric ID and returns definition IDs.

Positive membership supplies current source-id evidence. Missing pages or absent rows do not prove different authorship. Version user IDs identify editors instead.
Conversion contains method, tool, version, model, review, mappings, and warnings.

Method is literal, heuristic, or model-assisted. Tool and version are strings. Model is null or an object with provider, model, and nullable revision strings.
Review is unreviewed or reviewed. Mappings contains objects with field, start, end, and place. Warnings contains explanatory strings.

Field is a JSON Pointer into legacy.original. Offsets and place indices follow the conversion rules below.
Literal conversion has no mappings. Reviewed means the importer reports review, not that the historical author signed those annotations. `limitations` is an array of explanatory strings.
The complete source bytes remain separately available in the import archive when permitted.

Importers publish under their own keys. They attest to extraction, not to possession of historical users' signing keys.
A historical author name never becomes a modern key binding without a separate authenticated claim.
An importer never becomes the original author or an organizational signer merely by importing its content.
An importer cannot withdraw an imported publication merely because it signed the extraction. An accepted source author can control definition status under the rules below.
Corrections create new publications with source evidence and parent links.

A view can adopt a corrected import selection. Its previous selection remains available to other readers.
The default view pins exact accepted publications through the import selections in section 8. It does not accept arbitrary new imports because they claim official status.

Retain definitions, notes, etymology, glosses, place keywords, grammatical class, scores, source dates, and available history.
Form imported word IDs from NFC source spellings. Retain the exact original spelling in legacy source fields.
If the normalized spelling fails the word rules, retain the row in the source archive with an unresolved-mapping notice.
Keep exact SQL place indices when available. Preserve missing API indices as unassigned legacy keywords.

Keep older word-level rafsi and newer definition-level rafsi as distinct source evidence for separate word-level claims.
An importer does not infer authenticated individual votes from aggregate scores.
The initial jbovlaste import lacks change history. Lensisku history does not retroactively reconstruct it.

Legacy text first receives a literal rendering. Conversion can add attributed place annotations under the explicit process below.
A later reviewed structured version is a new definition with the imported publication as its parent.
The original body remains readable, including ambiguous component-place expressions and unresolved TeX.
Import reproducibility requires the same source digest, extraction version, importer identity, and preserved event envelopes.
An import journal maps each source locator and extracted content digest to its event ID and original envelope.

Different journals can produce distinct publications for the same source row. Neither publication gains authority from that duplication.
A repeat run reuses its prior envelopes instead of minting fresh duplicate publications.
If the ledger is lost, rebuild it from retained source evidence and publication envelopes before another import.
Lost envelopes can prevent exact reconstruction. Import-sync reports that duplication risk instead of claiming a repeatable import.

### Repeat imports and source reconciliation

Lensisku remains an independent source with ongoing contributions. Importing is a repeatable batch process, not a one-time migration.
The importer retains a ledger keyed by canonical source origin and numeric definition ID.
Each observation records its source snapshot, field coverage, source revision identifier when available, lexical digest, and associated jvc publication.
A ledger entry is import tooling state. It never changes a signed publication in place.

The lexical-v1 digest covers word, language, text, notes, etymology, classification, labels, glosses, place_keywords, place_keyword_indices, official_rafsi, and experimental_rafsi.
Its input is a canonical object with exactly those fields. Values preserve source content through the extraction recipe.
Each value is either `{"known":value}` or `{"unknown":true}`. Missing source fields never become empty strings or arrays.

Text, notes, and etymology preserve exact source strings and known null values. The extraction version defines source-specific classification and label mappings.
Glosses and place_keywords contain objects with exactly word and meaning. Meaning is a nullable source string. Sort by unsigned canonical UTF-8 bytes.

Place_keyword_indices contains objects with exactly place, word, and meaning. Place is the known positive source index.
Sort indexed keywords numerically by place, then by unsigned canonical UTF-8 bytes. Preserve duplicate keyword records in both forms.
SQL extraction produces both unindexed place_keywords and indexed place_keyword_indices. API extraction leaves place_keyword_indices unknown when the endpoint omits indices.

Thus two captures can compare their words without inventing index agreement. Older SQL evidence never silently fills a newer capture's unknown indices.
Each rafsi field contains a sorted array of distinct source tokens. Split source strings on ASCII space, tab, CR, LF, form feed, and vertical tab.

Sort tokens by unsigned UTF-8 bytes. Preserve unexpected non-ASCII whitespace inside tokens and report it for review. Keep both source authority fields separate.
An endpoint that does not fetch a field supplies unknown, even when its response uses null. The extraction recipe names that endpoint behavior.
The digest excludes votes, ranking scores, timestamps, display-name changes, and cache fields.

An attribution correction remains separately reported provenance. It never invents a new lexical edit.

Identical coverage and lexical digests reuse the existing publication envelope.
With different coverage, compare every jointly known field. Agreement means no observed lexical change, not proof that omitted fields stayed unchanged.
A poorer capture cannot erase richer historical evidence. Newly exposed fields enter the source archive as enrichment.
A deliberate enriched extraction can create a new imported revision, labeled enrichment rather than a historical author edit.

Changing extraction software alone does not automatically republish every definition.
A deliberate rights enrichment uses an updated extraction version and creates a new imported publication with the previous publication as its parent.
It retains the source notice and labels the change as importer evidence, not a historical author edit.
This applies even when the lexical digest is unchanged. It never rewrites an existing signed body.
The view publisher explicitly selects the new publication under the existing import-selection rules.
A changed known lexical value creates a new imported revision. Its parent is the preceding known version for the same word and language.
If the source changes word or language, use a source reference rather than an invalid parent link across contexts.
A source reversion can reuse a prior identical publication and its existing judgments. The ledger records the new observation separately.

A current import selection contains at most one definition publication per source definition ID for each selected importer.
This rule spans all selection chunks for that source and importer continuity group. Eligibility still requires each entry's direct importer-key match.
Duplicate conflicting revisions make that selection group unresolved. A transferred importer key never creates a second independent source slot.

Different importers can offer competing extractions. The UI exposes their shared source identity rather than counting them as independent source authors.
Updating a view explicitly changes its selected IDs. Previous views and imported publications remain available for historical inspection.
New batch publications never enter a view merely because an already known importer signed them.

Poll the source changes feed as an accelerator and periodically compare full captures.
The audited feed omits officialdata and mirrored MediaWiki revisions. Ordinary dictionary listings omit wiki type 16.
Neither supplies reliable deletion history. Offset pagination also lacks a transaction across pages.

The importer overlaps scans, deduplicates IDs, and reports capture gaps. It never treats one absent row as authenticated deletion.
An explicit source-missing observation does not deprecate the imported definition. A view publisher decides its own current selection.
Import every relevant definition, including low or negative scores. Do not reuse an exporter mode that chooses only one definition per word.

### Placeholder conversion during import

Lensisku uses x_1 and related TeX-like notation, not the circled-number convention proposed for this editor.
The importer first preserves the exact source text in legacy.original and produces a literal readable body.
A deterministic conversion pass recognizes a versioned set of explicit x-place forms, including x_1, x_{1}, and their supported math delimiters.
It never assigns place order from the appearance order of component variables such as g_1 or m_4.
Foreign quotations, component equivalences, nested relations, and ambiguous math remain literal unless an explicit mapping resolves them.

A conservative mapping can declare observed indices in a context frame without claiming a fixed final arity.
A fixed frame requires evidence that the declared list is complete. The importer records that evidence or its review decision.
Every converted span records its source field, Unicode-scalar start and end offsets, and target place index.
Offsets use a half-open interval in the exact decoded source string. They never refer to rendered HTML or normalized text.

The original strings remain available even when the readable body uses compact integer references.

An optional model-assisted batch can propose mappings for the whole corpus, subject to operator budget and provider configuration.
It does not publish changes, assert historical author approval, or convert uncertain mappings silently.
Reviewers can accept mappings in batches with source and rendered comparisons. Failed or uncertain rows remain readable literal definitions.
A structured import records its conversion method, tool version, reviewed state, and unresolved warnings.

The importer signs that extraction claim. The legacy author never acquires responsibility for a model's inferred annotation.

### Linking a Lensisku account

An account link associates a signing identity with a source account.
It does not replace key-based login, key backup, or succession. Lensisku is not required for later dictionary use.
An accepted link grants author controls over that account's imported definitions when the selected view enables account_authority.
Those controls permit retirement and restoration through import.status. Revision still creates a new native publication and never edits an imported body in place.

A linked person can find their old contributions and publish native revisions with those imports as parents.
The interface can label these as revisions by the linked source author. It never relabels the original importer signature.

An account.set clear action contains exactly kind, origin, account, and value.
A claim action also requires previous and carry. Previous is null or an account.set claim event ID for the same origin and account.
Carry is the sorted history frontier defined below. These fields belong to the signed action, not its optional description body.

Origin is a canonical HTTPS origin with no path, credentials, query, or fragment. Account is the positive numeric Lensisku user ID.
Value is claim or clear. The register key is actor, origin, and account.

Content is null or an object with exactly username and note. Username is a nullable nonauthoritative lookup string. Note is rich text.
The numeric ID and origin establish source identity. Usernames and profile URLs can change.

The claimant places exactly one ASCII line in Personal info: `jvc-identity: jve1:<64 lowercase hexadecimal digits>`.
That ID names the exact signed claim event. The event identifies the account, and the fetched account identifies the event.
A signature alone does not prove placement in the profile. An observer must fetch the field from the configured Lensisku API origin.

It compares the returned numeric ID with the claimed ID. It examines the API string rather than rendered HTML.
Multiple identity markers produce a conflict. A marker copied to another account cannot satisfy the numeric-ID comparison.
For marker detection only, replace CRLF and lone CR with LF, then split on LF. The field hash retains the original bytes.

A valid line equals the marker prefix, one ASCII space, `jve1:`, and 64 lowercase hexadecimal digits. It contains no other characters.
The identity prefix is `jvc-identity:`. The definition prefix is `jvc-definition:`.
Any other line containing the identity prefix makes a profile observation conflict. Any other line containing the definition prefix sends that definition to review.

An account.observe action contains exactly kind, origin, account, claim, and result. Origin and account identify the fetched source profile.
Their types match account.set. Result is present, absent, conflict, or unreachable. Its register key is observer actor, source origin, and numeric account.

Present names the one valid identity marker actually found in that profile. Claim contains its event ID, regardless of whose claim prompted the fetch.
Before signing present, the observer retrieves and retains that claim and every claim record in its previous chain.
It authenticates their event signatures and makes these records available with its observation evidence.
If a required claim record cannot be retrieved, the observation result is unreachable. It cannot create a certificate for a phantom claim.

Either retrieval failure uses null claim and field_hash, with an empty markers array.
This witness duty does not require complete carried status history. Receivers still expose pending claims when their own copies lack retained evidence.
Absent means that no identity marker exists. Conflict means several markers or a malformed marker line. Unreachable means that source-profile or required claim-record retrieval failed.

For absent, conflict, and unreachable, claim is null. Testing a stranger's claim never reports absent while the real author's valid marker remains present.
Its replaceable value includes both claim and result. Different concurrent claim IDs conflict even when both results say present.
Its required body contains origin, account, username, field_hash, markers, method, and observed_at.

Origin and account repeat the action values. Username is the fetched lookup name or null. Field_hash hashes the exact Personal info UTF-8 bytes.
Field_hash is null only for unreachable. Markers is the sorted list of distinct marker event IDs, without discarding duplicate occurrences during conflict detection.

Present requires markers to contain exactly claim. Absent and unreachable require an empty markers array. Conflict can include any parsed valid marker IDs.
Method is lensisku-public-profile-v1. Observed_at uses `YYYY-MM-DDTHH:mm:ssZ`, with valid Gregorian dates and seconds from 00 through 59.

It is informational, not causal authority. Other protocol fields described as UTC timestamps use this same format.
A present observation describes profile content and attests to retained claim records. It does not prove the claim chain's semantic validity. Binding acceptance additionally requires a signed account.set claim for the same origin and account.

A missing claim keeps that binding unresolved. A marker referencing another account cannot establish authority. An unreachable fetch proves neither absence nor revocation.
The observer chooses its configured source lookup. Caller-supplied usernames remain hints and never determine the observation result.

A failed hint cannot replace a known numeric-account locator or alone produce a negative observation. A returned numeric ID must match the requested account.

The view contains account_witnesses, a sorted list of identity keys independent of its linguistic roots and heeds.
The list contains at most 64 keys. Multiple keys in one accepted continuity group count as one witness.
An empty witness set supplies no current or historical certificates.
A view with account_authority true must name at least one witness. Otherwise its view body is invalid.

A witness must explicitly sign an observation. A service cannot fabricate another user's observation using an automatic browser action.
A reader can also use an unsigned local observation in a separately labeled account-linking preference. It never becomes a public signature through synchronization.
The controller calculation below uses certified periods and signed observation history. It never relies on a locally remembered successful lookup.

A failed fetch does not erase earlier positive evidence. The interface shows its age and the latest retrieval outcome separately.
An unobserved claim grants no controls. Current author commands also require retained signer authority and an effective matching account claim.
A witness with incomplete history cannot supply current certificate evidence. Missing evidence is not proof that earlier imported status was active.

Different views can choose different witnesses. No source account service becomes a global identity authority.
A silent or dishonest witness can delay certification. The view publisher can change the witness set through a visible policy update.
The new witness set needs observations for the claims it accepts. The availability guard below prevents an unnoticed active fallback during that change.

An old clear or disputed claim does not erase historical association records.
A Lensisku account takeover can change future observations. It cannot recover a jvc key or rewrite prior signed publications.
Multiple currently accepted jvc identities for one source account are a conflict, without automatic identity merging or authority transfer.
Organizations and shared source accounts require the same visible treatment. Account control never proves a unique human or historical personal authorship.

### Author controls over imported definitions

The selected view's account_authority flag enables these controls. A false value leaves imports active and labels ignored status actions.
The reference view enables controls. It contains no automatic exemption for official or shared source accounts.
Readers can choose another view. Disabling authority is an explicit policy change, not an unnoticed account transition.

A controller period is one signed source-account claim.
A claim's previous field names the period whose status it adopts. Its carry field fixes the history adopted from that period.
The chain follows previous fields to a claim with null previous. Every claim identifies the same origin and numeric account.

A missing chain element makes the inherited state unavailable. A cycle or malformed chain is invalid and grants no control.
An unobserved stranger claim never changes an account's controller or status.

#### Witness evidence and controller selection

A certificate consists of present observations from every selected witness group for one claim.
The observations name that exact claim, origin, and numeric account. Their bodies must pass the account.observe rules.
Each observation needs a complete, retained witness history. Accepted witness succession follows section 6.

An observation can precede later observations. A certificate is evidence of observed control, not a trusted date or proof of continuing access.
The evaluator derives certificates from signed records. It does not need a separate certificate object or a server's remembered acceptance flag.

A certified period has a certificate under the current view's witness set.
A present, structurally valid signed claim chain makes that period eligible. A pending certified claim remains a selection candidate.
A missing claim or chain does not remove its positive observations from selection. A proven malformed or cyclic chain grants no control.

A pending selected chain yields unavailable status with reason claim_pending. Never substitute an older controller for that missing input.
The claim signer identifies its controller. A later loss of signer authority can disable commands without erasing recorded status.

A historical certificate uses the witness set of the current view or an ancestral view.
Its observations need authentic signatures and structurally matching witness succession links. Later lifecycle exclusions do not erase this historical evidence.
It does not grant current command authority. Only retained witness histories supply current certificates.
A period is closed when a historical certificate names a structurally valid descendant whose previous chain contains that period.

Closure survives witness replacement and later witness compromise. An old marker cannot reopen a closed period. A return requires a fresh claim ID.
A missing historically certified claim or chain prevents ruling out closure and makes controller selection unavailable until it resolves.
A proven invalid claim does not close another period. Its historical certificate still prevents an active fallback when no controller exists.

For each current witness group, retain its present observations of certified, nonclosed periods for this account.
Take the causally maximal observations in that retained set. Distinct claims at those maxima give that witness several contributions.
Several maxima for the same claim count once. A witness with no retained observation contributes none.
Absent, conflict, and unreachable observations remain visible but do not erase earlier positive evidence or reopen a closed period.

Marker removal does not revoke a completed account link. A signed clear stops new commands but preserves earlier decisions and selection evidence.
A fresh certified claim can establish a new controller period.

One controller exists when every witness contributes the same single eligible claim.
Otherwise, the contributed claims form the candidate controller set. Several candidates mean a controller dispute.
A selected pending or proven-invalid claim makes selection unavailable. A proven-invalid candidate uses reason binding_unavailable. Its ID and known contributions remain visible as evidence, not command authority.

A dispute grants no automatic author controls. It never resolves through observation dates, event IDs, or arrival order.
For display, the evaluator retains each witness's contribution and its evidence.

Without current candidates, any historical certificate supplies an availability guard. Imported status is unavailable and never defaults to active.
The guard applies to the whole source account, including targets without a known status action.
Without a selected period chain, absence of a target action cannot establish an agreed active baseline.
A historical certificate cannot install a current controller. Its signed evidence can establish closure as defined above.

Without any current or historical certificate, imported definitions keep their initial active status. Unsupported claims alone cannot trigger the guard.
Missing selected policy ancestry makes this distinction unavailable. A parentless view explicitly discards older policy history and previews that effect.
After replacing witnesses, obtain fresh observations before expecting author controls under the new set.

A compromised historical witness set can force closure or unavailable status. It cannot install a controller under a different current witness set.
Recovery uses a fresh certified claim, or an explicit parentless policy reset. Neither recovery happens automatically.

#### Claim boundaries and inherited history

Carry contains at most 64 distinct event IDs, sorted lexicographically. A null previous requires an empty carry.
A non-null previous requires at least one carry event. Every carry head belongs to that previous claim's signer or a structurally linked successor.
The head's history must include the previous claim through the closure rules below.
Carry heads can be any own events, including the previous claim itself.

If that claim has no later own events, carry containing only its ID is sufficient.
Only the signer controls ordinary own-history merges. More than 64 device branches require merges before handover.
The client never silently truncates a carry frontier.

The carry closure includes its heads and their own predecessors.
It also follows an identity.accept reference to its matching, correctly signed identity.transfer and that transfer's predecessors.
Both lifecycle events must name the matching keys and transfer. This traversal uses signed structural links, not current continuity acceptance.
Definition parents, account previous fields, witness references, and arbitrary foreign references do not expand this closure.
The account chain separately supplies inheritance from older periods.

Future records cannot enter an existing closure. A missing committed record remains a dependency rather than an empty history.

For a closed period P, use only import.status records naming P that occur inside the carry closure of the next claim in the evaluated chain.
Each candidate chain uses its own next claim during a dispute.
Each record needs valid action syntax, a valid signature, and a signer connected structurally to P's signing key within the committed history.
Its target must match P's numeric source account through the imported publication's source-id evidence.
The status record must follow P through the same own-history and matching acceptance links.
The successor's signed claim adopts these status decisions under its own source-account authority.

Later compromise notices, missing uncommitted branches, and new claims by former signers cannot change that adopted set.
This independent adoption does not transfer their keys, trust, or endorsements.

For each target, examine periods from newest to oldest.
The first period with status actions for that target supplies its status under the within-period rule below.
If a reached carry closure is incomplete, the status is unavailable. Never skip it and choose an older value.
If a newer period already resolves that target, unrelated missing older carry data does not reopen it.
If every reached period is complete and has no action for the target, its status is active.

The ordinary handover preserves all known history. The preview shows every changed or unresolved status before signing.
Choosing an earlier head omits later work. Choosing null previous explicitly initializes or resets the status history for this account.
A reset requires a fresh certified claim and an explicit preview. It is never the automatic response to missing evidence.

The current controller can adopt omitted work through a new import.status action with the intended value.

#### Status records and current commands

An import.status action contains exactly kind, target, claim, and value.
Target is the exact imported definition event ID. Claim is its controller-period claim ID. Value is active or deprecated.
Content is null or an explanation body. Explanations can cite omitted or superseded actions without giving them replacement authority.

Only numeric source-id attribution grants these controls. A username match or importer signature grants none.
The action must follow its claim through own predecessors and matching transfer-and-acceptance links.

Within one period, causal order removes earlier status actions for the same target.
Concurrent equal values count once. Concurrent different values produce conflicted status.
A later action that follows both branches resolves the conflict. No cross-period replaces field exists.
For carried periods, this order uses the signed structural links inside the carry closure.

For an open candidate period, consider structurally authentic actions from its signer and structurally linked successors.
Imported authority starts independently at that claim's signing key. It follows accepted downstream succession under section 6.
Earlier continuity ancestors do not supply or suspend this independent source-account authority.
Their uncommitted gaps, account actions, and compromise notices do not affect it. General inherited influence still follows section 6.

An accepted transfer limits the earlier key's status actions to strict causal ancestors of that transfer.
Other actions from that earlier key have no effect, including no uncertainty. Contested succession still follows section 6.
The account register for that origin and account must uniquely select the matching claim in the action's strict causal past.
That past follows own predecessors and matching transfer-and-acceptance links, without filtering by later lifecycle acceptance.
Concurrent clear or different-claim maxima in that past make the command unauthorized.

For that same source account, a clear or different claim removes permission when it follows the matching claim and precedes the status action. Those unauthorized actions have no effect and cannot create uncertainty.
Earlier and concurrent status actions keep their effect when a later clear or different claim appears.
New UI commands require the currently effective matching claim. A clear does not remove a period from certificate selection.
These claim-permission rules also apply inside carried history, using its structural links rather than later lifecycle acceptance.

Construct the remaining status frontier before applying compromise exclusions.
This prevents a compromise-excluded later retirement from exposing an older active action.
Every remaining maximum needs retained section 6 authority rooted at the period's signing key.
If a maximum loses that authority through compromise or contested downstream continuity, the target's status is uncertain.
An unrelated signer cannot create such a maximum.
A missing own-history dependency within the open period makes every target of that account unavailable until authority and ordering can be established.

An older carried period can remain incomplete when a complete newer period already resolves the target, as stated above.
Former-period actions outside the carry are discarded before this calculation. Their gaps, replacements, and signatures cannot suspend the current period.

For one controller, use that period's result. New UI commands require that controller's retained key authority and an effective account claim.
During a controller dispute, compute the result for each candidate period independently.
If every candidate supplies the same complete active or deprecated value, preserve that value and expose the dispute separately.
Different complete values produce conflicted status. Any missing candidate result makes the target unavailable.

Any uncertain candidate result makes the target uncertain unless a required result is unavailable.
The client disables author controls during a dispute. Signed records remain admissible, because signatures cannot establish their order relative to other keys' observations.
No rule freezes a server-local value at the instant a dispute begins.

Uncertain, conflicted, and unavailable definitions receive no ordinary ranking score. Their judgments remain stored.
Their rafsi eligibility remains unresolved. A complete deprecated result disables its judgments until restoration.
Controls apply to exact publication IDs. A future imported revision starts active unless that exact ID has status history, subject to the account-control availability rules.

A source reversion that reuses an existing publication ID also reuses its status.
Native revisions remain new signed publications. They receive no automatic transfer of endorsements.

A source-account takeover can gain these controls after the selected witnesses certify the replacement claim.
The linking preview states the affected count, the adopted history, and the witness policy.
Removing the external marker alone does not undo an accepted claim. A failed fetch does not remove its positive evidence.
General identity succession within one account period retains the section 6 exposure to a later old-key compromise.

A fresh claim with carry independently adopts imported status. It does not independently inherit editorial influence or native publication authority.

The evaluator applies explicit resource limits to chains and closures. Exceeding a limit produces resource-unavailable, never a truncated active result.

### Cross-post markers and management

Lensisku notes can contain one ASCII line: `jvc-definition: jve1:<64 lowercase hexadecimal digits>`.
The ID names an exact native revision. There is no implied stable family ID or automatic latest-revision pointer.
A marker is a discovery hint. Copying it alone cannot suppress imports or establish ownership.

A bridge.set action contains exactly kind, origin, source_definition, target, and value.
Origin is the source HTTPS origin. Source_definition is its positive numeric definition ID. Target is an exact native definition event ID.

Value is managed or clear. The register key is actor, origin, and source_definition. Content is null or an explanation body.
A suspended or incomplete acting group cannot establish current management.
The acting group must control the target publication through its original signature or accepted succession. Otherwise the bridge action is inert.

The external source author's numeric account must have an accepted link to that group before an importer treats the bridge as established.
The numeric authorship association must have source-id evidence. Username resolution alone cannot establish management, even after a successful account link.
The target and source must agree on word and definition language. A mutable username alone cannot establish the source author.

The account link supplies source-author evidence. Imported status and future import management remain separate actions, even when the same account authorizes both.

Managed means that the author takes responsibility for keeping this external entry represented through jvc publications.
The importer skips new dictionary publications for an established managed row whose sole marker names the effective bridge target.
It still archives the raw source and records changed content as a source-divergence notice. Existing imported publications remain untouched.
This is an explicit opt-out from future automatic import of that row. It is not a claim that every later external edit matches jvc.

The management preview states that edits made only in Lensisku will not become jvc definitions automatically while this link remains active.
This includes edits by other Lensisku contributors. A source-account takeover can establish management until later observations remove the accepted binding.
The preview discloses that risk. The batch report and linked author's dashboard expose source-divergence notices.

A clear resumes ordinary imports for future batches. It does not retroactively mint publications for every skipped observation.

Without an established link, matching content can suggest a duplicate but cannot merge author identities or move judgments.
Missing targets, several markers, ownership conflicts, invalid signatures, or unavailable account evidence enter the batch review list.
The importer preserves those source rows and normally imports them unless the operator explicitly defers the affected rows.
A syntactically valid marker alone never authorizes silent exclusion.
A source word or language change suspends management until a matching new declaration exists.

A new jvc revision needs an updated bridge declaration and external marker. Ancestor links alone never authorize skipping an unrelated external revision.

## 12. Required low-level tools

The first implementation provides one shared core for browser, self-hosted server, Worker, and CLI use.
The CLI command is jvc, with one letter for each rafsi in jbovlacku.
It covers canonicalization, signature acceptance, causal state, structured content, continuity, scopes, and ranking bounds.
A separate implementation supplies interoperability tests. No implementation's undocumented behavior overrides this specification.

The target CLI exposes these commands:

| Command | Required behavior |
| --- | --- |
| `jvc validate PATH` | Inspect a snapshot and report encoding, signature, dependency, content, and policy outcomes separately. |
| `jvc merge LEFT RIGHT --output PATH` | Union accepted event sets and retained bodies, then regenerate the snapshot. |
| `jvc import-lensisku SOURCE --manifest PATH` | Produce an attributed import proposal and source manifest. Signing is a separate explicit step. |
| `jvc export PATH --format jsonl` | Produce canonical records with inline bodies and their manifest. |
| `jvc export PATH --format dictionary --view EVENT` | Produce a readable derived stream with the source snapshot and selected view. It is not signed evidence. |
| `jvc inspect EVENT` | Explain signature, causal predecessors, body availability, and effective state. |
| `jvc rank PATH --view EVENT` | Produce weights, judgment components, intervals, and calculation metadata. |
| `jvc retain PATH --policy FILE` | Apply operator refusal policy to a new output snapshot. It never claims physical purge of old copies. |
| `jvc handover --identity KEY --output PATH` | Prepare both transfer signatures, persist their complete bundle, and reuse it on retries. |
| `jvc serve --data PATH` | Run the standalone server without Cloudflare services. |
| `jvc import-sync SOURCE --ledger PATH` | Prepare a repeat import batch with explicit additions, revisions, omissions, and conflicts. |
| `jvc sign FILE --identity KEY` | Sign a prepared event with a local key or an explicitly configured local SSH signer. |

These are target interface requirements. The [README](../README.md) identifies commands available in the prototype.
Ordinary sign rejects lifecycle events and directs the user to the dedicated handover or compromise flow.
Handover stores both events and the new encrypted key before it releases either event for upload.
Before signing, it searches configured peers and local history for existing transfer or acceptance records. Retries never mint replacement nonces.

The preview warns that unseen concurrent old-key branches lose ordinary authority after the terminal transfer.
Tools default to read-only inspection unless their command names an output or an explicit signing action.
A validator exit result distinguishes invalid objects, incomplete dependencies, and a complete accepted snapshot.
Machine reports contain stable codes, event IDs, and field paths. Human messages describe the next useful action.

## 13. Conformance requirements

Implementation starts with shared fixtures for these cases:

1. Canonical JSON, duplicate keys, Unicode boundaries, malformed base64, and SSHSIG domain substitution.
2. Valid Ed25519 examples and rejected noncanonical, low-order, and mixed-order points.
3. Two concurrent additions to the same JSONL carrier, merged without changing either author signature.
4. A later opinion, concurrent opposite opinions, agreeing branches, and an explicit resolution.
5. A missing body, missing predecessor, invalid action, withheld event, and independent unaffected branches.
6. Transfer acceptance, concurrent old-key activity, two transfers, recipient forks, and compromise intersections.
7. Repeated place markers, nonsequential text order, literal circled numbers, variable arity, and cmavo operands.
8. Legacy component variables and unassigned place glosses without fabricated indices.
9. Scope overlap, narrow clear, shun blocking, independent routes, and no redistribution after local exclusion.
10. Cycles, proxy return attempts, root changes, and exact ranking inside certified intervals.
11. Withdrawn definitions, restored judgments, absent candidates, and competing rafsi without a certified winner.
12. Rewritten Git carrier history and refused-body synchronization without false authenticated deletion.
13. Inline body filling, repeated body hashes, refusal precedence, and matching manifests across both host adapters.
14. Compact text and integer nodes, contextual frame references, literal numerals, and visible handling of bidirectional controls.
15. Rational generation scores, optional nonalgorithmic evidence, non-top selections, and inconsistent formation claims.
16. Account-marker copying, absent witnesses, conflicting bindings, and management declarations from unrelated authors.
17. Repeat import, incomplete field coverage, source reversions, changed extraction, and copied or stale notes markers.
18. Model-profile drift, bad shared vectors, unavailable bodies, producer exclusion, and independent derived-data quotas.
19. Claimed-author retirement and restoration, source-id evidence, witness refresh, marker replacement, and unchanged importer signatures.
20. Carried status, stale former-key branches, missing committed history, concurrent status, and source-reversion status reuse.
21. Certified controller periods, witness-set changes without active fallback, explicit policy resets, and actual-marker observations after stranger-claim lookups.
22. Repeated A-to-B-to-A claims, historical marker reversal, former-key compromise after carry, and all cases in [handover-cases.md](handover-cases.md).

The implementations must agree on logical state from the same fixtures. Their certified bounds must contain independently calculated exact small-graph scores.
Performance measurements must cover the imported dictionary and adversarial trust graphs. The design does not claim completed runtime benchmarks.
Before release, measure candidate-comparison coverage on stated synthetic verdict scenarios and realistic graph sizes.

Measure the specified complete-stage profile itself. Earlier prototype coverage cannot substitute for those results.
For equal completed stages, the relaxed first frontier gives wider intervals than a separately computed exact first frontier.
A later derived profile can budget exact frontier work separately, but it must not label that extra work as this reference calculation. Actor-pair coverage alone is insufficient.
If practical graphs produce unusably broad intervals, change a named calculation profile or propose a new ranking version openly.

Do not silently replace full transitivity with a depth cutoff during implementation.
Public launch must state the recovery policy for concentrated curator identities. Version 1 supports backup restoration, with no recovery after complete key loss.
That decision also accepts the stated theft and retired-key disruption risks. It does not promise a future recovery mechanism.

## 14. Normative sources and limits

Encoding follows [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) and [Ed25519](https://www.rfc-editor.org/rfc/rfc8032).
The signature container follows [OpenSSH SSHSIG](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.sshsig).
The selected profile pins version 1 and the fields in section 3. Upstream changes cannot silently change accepted bytes.
[Unicode normalization](https://www.unicode.org/reports/tr15/) explains why compatibility normalization cannot preserve circled-number notation.

Brismu distinguishes relations, propositions, and abstraction forms. It also states unresolved questions about several abstractors.
These distinctions support open annotations. They do not require Brismu's complete interpretation.
See its [abstractor discussion](https://brismu.systems/0-midju/8-abstractors.html) and [dictionary conventions](https://brismu.systems/vlaste.html).

The ranking coefficients define a reference calculation. They do not establish real contributor expertise or dictionary quality.
The [prototype plan](prototype-plan.md) defines implementation stages. The [handover cases](handover-cases.md) define required account-control outcomes.
