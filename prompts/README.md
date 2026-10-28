# AI prompts

This folder holds the prompts for the optional AI actions that the [frontend specification](../docs/frontend.md) describes.
The shared service uses these files for both server adapters.
The four tasks below retain the studied prompts. Local mock tests cover the application loop and answer checks.
Provider availability still depends on operator configuration.

## Tasks

| Task       | Frontend action              | The model suggests                                                                      |
| ---------- | ---------------------------- | --------------------------------------------------------------------------------------- |
| `glosses`  | "Suggest places and glosses" | A short English gloss and an optional sense for the whole word and for each place.      |
| `hints`    | "Suggest places and glosses" | The kinds of thing that can fill each place, such as referent, agent, event or number.  |
| `mappings` | "Suggest places and glosses" | For each place of a compound, the component places that it corresponds to.              |
| `sources`  | "Suggest source words"       | One source word for one language, its stem, its pronunciation, and its scoring letters. |

Additional editor prompts cover type, components, selma'o, definition text, and an initial place structure.
These prompts use the same tool and retry loop. They do not share the four tasks' study evidence.
The application checks a proposed lujvo with deterministic construction and segmentation before it returns the spelling.

The type answer contains `word_type`, `alternative`, `reason`, `alternative_reason`, and `existing`.
A null main type asks one question and gives no field proposal. A second type has its own reason and needs separate card selection.
An existing word requires a supplied ref, its exact dictionary spelling, a nullable conversion, and a nullable improved definition.
The server resolves the ref to an exact publication event before it returns the existing-word action.
The approved type prompt and answer enum use `fuivla`. The application translates that identifier to its `fuhivla` lexical kind.

For `components`, the application labels supplied definitions `d1`, `d2`, and so on, in their supplied order.
The model returns a matching label or null in each component's `definition` field.
The request keeps each label beside its exact event ID for the author's inference log.
Selected component constraints use those labels too. Unknown labels, event IDs, prose, and labels for another word fail the answer checks.

The application maps accepted labels to exact event IDs before construction and public proposals. The raw tool log keeps the labels.
The other answer schemas require no event ID or hash. `mappings` keeps studied names such as `klama[2]`.

## Files

| File                                                                                                     | Contents                                                                                            |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `common.system.txt`                                                                                      | The rules that every task shares.                                                                   |
| `glosses.task.txt`, `hints.task.txt`, `mappings.task.txt`, `sources.task.txt`                            | The rules of each task.                                                                             |
| `sound-guide.txt`                                                                                        | The conversion from IPA to the Lojban scoring letters. Only `sources` uses it.                      |
| `languages/*.txt`                                                                                        | One block of language rules for each source language. Only `sources` uses them.                     |
| `answer-shapes.json`                                                                                     | The JSON shape of an answer for each task.                                                          |
| `explain.txt`                                                                                            | Optional. The server adds it before any language block when the operator turns on decision reports. |
| `type.task.txt`, `components.task.txt`, `cmavo-class.task.txt`, `definition.task.txt`, `places.task.txt` | Rules for the other editor actions.                                                                 |
| `build-bundle.mjs`                                                                                       | Rebuilds the runtime copy of the public prompt files. Run it after editing a prompt.                |

## Request

Each request has one system prompt, one user message, and one tool, `submit_answer`.
Every request uses `tool_choice: "auto"`, which the tested provider requires.
The application still accepts only one valid `submit_answer` call. A missing call receives correction instructions within the same three-answer limit.

Only the type request adds `related` definitions that the server finds from the original meaning in its current dictionary snapshot.
Up to three exact typed spelling definitions come first after trimming and NFC normalization.
Ordinary editorial layers decide their order when available. Ties use meaning relevance, then event ID.
For relevance, an exact gloss match counts three, a gloss prefix two, and a definition-text match one for each query word.
The lexical fallback uses up to six distinct meaning words. It removes whole-token place marks and punctuation at token ends and keeps inner apostrophes.
Each query scans the dictionary once with the ordinary search match tiers and order.
Equal query counts use summed search positions, then word ID.
Exact senses keep separate records. Later hits omit duplicate spellings. The whole list contains at most 30 records.
Each related record has a short ref, spelling, type, and at most 500 Unicode code points of definition text.
A cut definition has `truncated: true`. Selected context events do not appear again.
The log records the snapshot and exact events. Retrieval metadata carries `method`: `lexical`, `semantic`, or `none`.
Lexical retrieval records query words. Semantic retrieval records `profile`. A missing hook or unavailable dictionary records `none`.
The log also records the morphology identifier and version for a successful spelling analysis.
The request adds `spelling_form` when a spelling is present. Other task requests stay unchanged.
The current TypeScript morphology profile identifies compound cmavo and supplies their parsed words in `spelling_parts`.
For example, `taia` sends `["tai", "a"]`, and `i'ecu'i` sends `["i'e", "cu'i"]`.
Other forms omit `spelling_parts`. An empty spelling omits both fields.
Type runs currently have no dictionary lookup tools. The shared system prompt keeps its no-lookup sentence.

The system prompt joins these files in this order, with a blank line between them:

1. `common.system.txt`
2. The task file, such as `hints.task.txt`
3. For `sources` only: `sound-guide.txt`
4. When decision reports are on: `explain.txt`
5. For `sources` only: the block of the requested language

When decision reports are on, `explain.txt` follows the task file, or `sound-guide.txt` for `sources`.
Without a language block, `explain.txt` is last.
The request then must let the model write text before its tool call, so it does not force the tool call.
The language block comes last, so that requests for different languages share the longest possible identical prefix.
Providers can then cache that prefix.

The user message contains the case: the word, its definition, the component definitions where the task uses them, and the requested keys.
A place key such as `klama[2]` becomes `x2` in the tool arguments, and the whole word becomes `word`.
The user message includes that key list, such as "In submit_answer, use these keys: word for klama, x1 for klama[1]."
If the draft has no spelling, the key list uses "the whole word" and "place 1" instead.
For `mappings`, the prompt, tool schema, and answer use component spellings and place indices, such as `klama[2]`.
The `component_places` metadata lists each component word, exact definition event or null, and available place indices.
The request groups the permitted indices by spelling and uses the first unambiguous full name as its example.
It lists ambiguous names separately before the model answers. If every name is ambiguous, the example uses `unclear`.
After the answer check, the application resolves each name to its exact selected definition.
Repeated spellings with the same exact definition share a name.
If one name refers to distinct selected definitions, the check asks for `unclear` instead of choosing a definition.

For `mappings`, grouped indices such as `klama[1,2]` permit `klama[1]` and `klama[2]`.
A `sources` request covers one target meaning and one language.

The tool arguments are the answer. For `glosses`, `hints` and `mappings`, the tool schema lists each requested key as an explicit property.
Some providers drop a schema that defines its keys only through `additionalProperties`, and then send an empty object.

## Checks on an answer

The server checks every answer before the browser shows the suggestion.
Type checks enforce the nullable shape, paired alternatives and reasons, distinct types, nonblank text, and the spelling analysis for cmavo versus compound.
An existing ref must name a supplied entry whose exact spelling matches a real entry in the job's dictionary snapshot.
Reasons permit 400 Unicode code points. Alternative reasons permit 200. Existing spellings permit 64, refs 128, and revised definitions 600.
The application checks conversion values but does not judge whether a conversion expresses the meaning.
For a failed answer with one usable call, it returns the problems as the tool result. The model then sends a corrected answer.
After three failed answers for one task, the suggestion fails.

A response without a `submit_answer` call counts as one failed answer and gets no tool result.
A response with multiple calls also counts as one failed answer.
Missing or repeated calls add the problem “Call submit_answer exactly once with the complete answer.”
For either case, the server appends the assistant text without tool calls, followed by a user message that lists the problems.
The next request keeps the existing exchange and adds those turns. It does not restart the request or add a tool result.
After three failed answers, including responses without that call, the suggestion shows the same failed state.

The feedback starts with this text, followed by a newline and one problem per line:

```text
The answer was not accepted. Fix every problem and call submit_answer with the complete corrected answer.
```

These checks apply:

- The answer has exactly the requested keys, with the shape in `answer-shapes.json`.
- `glosses`: each gloss is nonempty, a sense does not repeat its gloss, and the whole-word sense is nonempty.
- `hints`: each place has one to three alternatives, each with a known type and a reason. `unclear` stands alone. If a narrower type appears beside a broader type, keep only the broader entry and its own reason. For example, keep `referent` over `event`. This rule applies only to the AI type list, not to signed alternatives with abstractors or relation arity.
- `mappings`: each entry names a supplied component place, `none` or `unclear`. A place does not list the same component place twice. `none` and `unclear` stand alone. A link's `reason` must start with `direct: `, `merged: `, `distributed: `, or `functional: `, followed by its explanation. A sentinel's reason must instead start with its matching `none: ` or `unclear: `. The check rejects a missing or mismatched prefix. There is no separate `kind` field.
- `sources`: `word` is one word. `word_ipa` and `ipa` contain no space or dot. `sounds` has 1 to 64 letters from `a b c d e f g i j k l m n o p r s t u v x z`. A stem equal to the whole word needs a reason in the note.

In a model answer, non-null `sounds` requires `ipa`.
Step 7 in `sources.task.txt` derives scoring letters from the stem IPA.
If the model cannot give `ipa`, `sounds` must be null and the note must explain why.

For `sources`, if `word` is null, `sense`, `word_ipa`, `stem`, `ipa`, and `sounds` must be null.
A null `stem` or `word_ipa` requires null `ipa` and `sounds`. A null `ipa` requires null `sounds`.
A missing stem never discards a known `word_ipa`. The note explains any unknown field.

The answer keeps `stem` and `ipa` because the model needs them to derive the scoring letters.
The application keeps these fields only in the private draft and AI log. It never copies them into a signed formation source.
Signed sources can keep `word_ipa` independently.

## Rules that the application keeps

- The definition of the whole word decides the meaning. Component definitions only identify roles.
- Any word form that follows the morphology rules is valid, including lower-scoring rafsi and optional hyphens. The tasks never judge a form.
- The hint types follow the standard tags of the [format specification](../docs/format.md#glosses-types-and-defaults). `unclear` is not a tag. It marks a place that the definition does not describe.
- The AI never suggests the retired tags `entity`, `mass`, or `tuple`.
- In `sources`, the pronunciation lets speakers of the language check the word later. The stress mark in `word_ipa` is informational. Only `sounds` is scored.

## Tested configuration

The prompts were tuned with Muse Spark 1.3 through OpenRouter. Medium reasoning gave the best balance of quality and cost.
