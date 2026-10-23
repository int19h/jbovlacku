# AI prompts

This folder holds the prompts for the optional AI actions that the [frontend specification](../docs/frontend.md) describes.
No application code uses them yet. AI actions remain target features.
They were tested in separate studies, not through the application.

## Tasks

| Task | Frontend action | The model suggests |
|---|---|---|
| `glosses` | "Suggest places and glosses" | A short English gloss and an optional sense for the whole word and for each place. |
| `hints` | "Suggest places and glosses" | The kinds of thing that can fill each place, such as referent, agent, event or number. |
| `mappings` | "Suggest places and glosses" | For each place of a compound, the component places that it corresponds to. |
| `sources` | "Suggest source words" | One source word for one language, its stem, its pronunciation, and its scoring letters. |

## Files

| File | Contents |
|---|---|
| `common.system.txt` | The rules that every task shares. |
| `glosses.task.txt`, `hints.task.txt`, `mappings.task.txt`, `sources.task.txt` | The rules of each task. |
| `sound-guide.txt` | The conversion from IPA to the Lojban scoring letters. Only `sources` uses it. |
| `languages/*.txt` | One block of language rules for each source language. Only `sources` uses them. |
| `answer-shapes.json` | The JSON shape of an answer for each task. |
| `explain.txt` | Optional. The server adds it before any language block when the operator turns on decision reports. |

## Request

Each request has one system prompt, one user message, and one tool, `submit_answer`.

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
After the case, the user message lists the requested keys.
For example: "In submit_answer, use these keys: word for klama, x1 for klama[1]."

For `mappings`, the permitted component places follow the requested keys, such as "Permitted component places: klama[1,2]".
That grouped form permits `klama[1]` and `klama[2]`. The answer names each component place by its supplied spelling and one-based index.
A `sources` request covers one target meaning and one language.

The tool arguments are the answer. For `glosses`, `hints` and `mappings`, the tool schema lists each requested key as an explicit property.
Some providers drop a schema that defines its keys only through `additionalProperties`, and then send an empty object.

## Checks on an answer

The server checks every answer before the browser shows the suggestion.
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
