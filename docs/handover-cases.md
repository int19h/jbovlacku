# Required handover cases

These are behavioral fixtures for the prototype. They are not executed tests or final serialized records.
The [format specification](format.md) defines field names and evidence requirements.
Every case runs with delivery permutations, duplicate delivery, and reconstruction from the complete input set.

## Names and assumptions

`D` is an imported definition with numeric source-author evidence. `A`, `B`, and `C` are distinct signing keys.
`CA` and `CB` are distinct source-account claims. Selected witnesses attest to the actual profile marker.
An accepted handover names a fixed boundary for the prior history. Its preserved status does not depend on local arrival order.

No example treats a display name, a timestamp, or an unsigned assertion as authority.
Witness keys are distinct from A, B, and C unless a case explicitly tests witness compromise.
A former claimant that also controls a selected witness retains that separate witness role. These cases isolate source-author authority.

## Status preservation and stale actions

| Case | Input | Required outcome |
| --- | --- | --- |
| H01 | A retires D. An accepted handover to B preserves that action. | D remains deprecated. B controls future changes. |
| H02 | A explicitly activates D before that handover. | D remains active. B does not need a repair action merely because control changed. |
| H03 | A signs a new retirement after B restores D. Its claim is CA, and its explanation cites old witness proof. | D remains active. The stale action supplies neither a value nor uncertainty. |
| H04 | A's explanation names B's restoration as a replacement target. A separate variant adds an obsolete replaces action field. | The explanation grants no replacement authority. The extra-field variant fails the action schema. Neither changes D. |
| H05 | A repeatedly creates independent branches using the old claim and valid old proof. | Repetition cannot change the inherited baseline or B's effective status. |
| H06 | The same old record arrives many times. | Deduplication leaves the result unchanged. |
| H07 | B retires D, and a late old A activation arrives outside the accepted boundary. | D remains deprecated. |
| H08 | A changes its old account claim or clears it after an accepted independent B handover. | The old-key action cannot erase B's preserved status. |

## Missing history and device branches

| Case | Input | Required outcome |
| --- | --- | --- |
| H09 | The handover includes an A retirement that one server has not received. | The server exposes the missing committed input. It never guesses that D is active. |
| H10 | The missing H09 input arrives. | Every replica obtains the same preserved status. No new signature is necessary. |
| H11 | Two A devices have distinct known branches. The handover includes both. | Independent actions survive. Opposite status actions require an explicit resolution. |
| H12 | An offline device later reveals an A action outside the handover boundary. | The action remains historical evidence but supplies no current command. B can adopt its intent explicitly. |
| H13 | A peer hides a branch that the browser already remembers. | The browser retains its reference and reports missing evidence. It never silently discards the branch. |
| H14 | Only a stale action has a missing predecessor after B's accepted handover. | That uncommitted dependency cannot suspend B's imported author controls. |

## Account evidence and repeated transfers

| Case | Input | Required outcome |
| --- | --- | --- |
| H15 | B proves source-account control but cannot obtain A's key. | A fresh claim with carry can establish B's controls without an A signature. The preview identifies the adopted history. |
| H16 | Control moves from CA to CB and then to a fresh claim signed by A. | Only the fresh A claim can authorize new commands. Earlier A-period actions do not revive. |
| H17 | A former profile marker reappears after its claim was closed. | That marker alone cannot reopen the closed period. A new claim is necessary. |
| H18 | Selected witnesses contribute incompatible, fully certified, unsuperseded periods. | The interface reports a controller dispute. Arrival order cannot choose the legitimate controller. |
| H19 | A source fetch fails after an accepted handover and retirement. | Positive certificate evidence remains. D stays deprecated, with retrieval failure and evidence age shown separately. |
| H20 | The current witness policy changes. | The evaluator follows explicit policy and history rules. It never treats missing history as an empty active baseline. |
| H21 | A copied marker appears on another numeric account. | It grants no author controls over D. |
| H22 | A stranger asks an observer to inspect a false claim. The actual profile still contains CB. | The observation records CB. The request cannot manufacture absence of CB. |

## Identity lifecycle and source revisions

| Case | Input | Required outcome |
| --- | --- | --- |
| H23 | A later compromise notice targets the old key after B independently adopts the preserved status. | It does not revoke B's independent adoption. General inherited identity influence remains subject to section 6. |
| H24 | B's own control evidence is compromised or incomplete. | Apply the explicit current-controller rule. Do not conflate this with a harmless stale A action. |
| H25 | A definition has conflicting status inside the preserved boundary. | Preserve the conflict or carry an explicit authorized resolution. Never choose by event ID. |
| H26 | A new source revision creates a distinct imported publication. | It starts active unless its exact publication ID has a status action, subject to account-control availability rules. |
| H27 | A source reversion reuses an existing publication ID. | It reuses that publication's preserved status. |
| H28 | The importer signs the extraction without a matching source-author claim. | Its signature alone grants no retirement or restoration power. |
| H29 | A first account claim has an observation from only one of two selected witnesses. | It has no certificate and cannot change imported status. |
| H30 | A certified descendant exists, but a witness later observes the ancestor's old marker. | The closed ancestor stays excluded. Historical positive evidence selects the unsuperseded period. |
| H31 | All current witnesses change and have no observations, but an ancestral policy certifies a prior controller. | Status is unavailable until current evidence arrives. It never defaults to active. |
| H32 | The profile marker disappears after a completed link. | Removal alone does not revoke that link. A signed clear stops commands and preserves status. A newly certified claim changes the controller. |
| H33 | Two certified branches disagree about D, but agree about another imported definition. | D is conflicted. The other definition retains its agreed value. Author controls remain disabled during the dispute. |

## Additional control cases

| Case | Input | Required outcome |
| --- | --- | --- |
| H34 | A transfers to B within CA, then signs a new retirement outside the accepted transfer ancestry. | The new A action has no effect or uncertainty. B retains commands through accepted succession. |
| H35 | The current controller signs a clear after retiring D. | D stays deprecated. New commands stop. A later unauthorized activation has no effect. |
| H36 | The controller signs a new claim before witnesses certify it. | Earlier decisions under the old period remain. The new claim alone grants no commands. |
| H37 | All witnesses change after CA closes through CB. They then certify the old CA marker. | Historical closure excludes CA. Status stays unavailable until an eligible new claim has current evidence. |
| H38 | A witness compromise cutoff retains its CA observation but excludes its CB observation. | CB can lose current eligibility. CA remains closed through historical evidence and cannot regain commands. |
| H39 | Every witness observes CB, but CB or a middle claim is missing. | The missing chain gives unavailable selection. The evaluator never substitutes CA. |
| H40 | CA has no later own events. CB carries only CA's event ID. | The carry is valid and closes CA when CB gains certification. |
| H41 | A clear and a status action are concurrent within one period. | The action keeps its effect. Commands stop until a fresh claim is certified. |
| H42 | Current witnesses change without new evidence for an account with untouched imports. | The account-wide historical guard makes those imports unavailable. It does not infer an active default. |
| H43 | An independent CB uses a key that previously inherited continuity from A. A later reveals an uncommitted missing predecessor. | CB's imported authority stays independent. General inherited influence can still be suspended. |
| H44 | A profile marker names a lost claim or a mistyped event ID. | Honest witnesses report unreachable until they retrieve and retain the claim chain. A phantom claim gains no certificate. |
| H45 | The same key signs CA, clears it, then signs a fresh CA2 that gains certification. | A status action under CA2 can act. The earlier clear does not permanently disable that key. |
| H46 | Witnesses retain a claim chain, but a replica lacks one claim record. | The replica reports unavailable selection until it retrieves that record. Witness retention does not invent the replica's missing input. |
| H47 | A view names no witnesses. | With account_authority true, its body is invalid. An empty witness set never supplies a current or historical certificate. |
| H48 | Two conflicting account-register branches both precede a status action. The action names one claim. | The action is unauthorized and inert. Naming one claim does not resolve the register conflict. |

## Rafsi and lightweight clients

If every eligible definition is deprecated, the word is unavailable for current word construction.
Its rafsi assignments remain historical evidence. An active replacement definition can restore eligibility without creating new rafsi endorsements.
An unrelated active definition prevents an all-deprecated result. Missing evidence never proves that all definitions are deprecated.

The browser needs references to its known history and copies of undelivered events.
It can retrieve the evidence required for a handover from peers. It never needs to clone the whole dictionary as a signing prerequisite.
The handover preview identifies included branches, omitted known work, and any unresolved dependencies.
