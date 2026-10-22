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

## Request

Each request has one system prompt, one user message, and one tool, `submit_answer`.

The system prompt joins these files in this order, with a blank line between them:

1. `common.system.txt`
2. The task file, such as `hints.task.txt`
3. For `sources` only: `sound-guide.txt`, then the block of the requested language

The language block comes last, so that requests for different languages share the longest possible identical prefix.
Providers can then cache that prefix.

The user message contains the case: the word, its definition, the component definitions where the task uses them, and the requested keys.
A place key such as `klama[2]` becomes `x2` in the tool arguments, and the whole word becomes `word`.
The user message ends with that key list, such as "In submit_answer, use these keys: word for klama, x1 for klama[1]."
A `sources` request covers one target meaning and one language.

The tool arguments are the answer. For `glosses`, `hints` and `mappings`, the tool schema lists each requested key as an explicit property.
Some providers drop a schema that defines its keys only through `additionalProperties`, and then send an empty object.

## Checks on an answer

The application checks every answer before it shows the suggestion. If the answer fails, the application returns the list of problems as the tool result, and the model sends a corrected answer. After three failed answers, the suggestion fails.
These checks apply:

- The answer has exactly the requested keys, with the shape in `answer-shapes.json`.
- `glosses`: each gloss is nonempty, a sense does not repeat its gloss, and the whole-word sense is nonempty.
- `hints`: each place has one to three alternatives, each with a known type and a reason. `unclear` stands alone. A type listed beside a broader type, such as `event` beside `referent`, merges into the broader type.
- `mappings`: each entry names a supplied component place, `none` or `unclear`. A place does not list the same component place twice. `none` and `unclear` stand alone.
- `sources`: a null field makes every later field null, and the note then says what is unknown. `word` is one word. `word_ipa` and `ipa` contain no space or dot. `sounds` has 1 to 64 letters from `a b c d e f g i j k l m n o p r s t u v x z`. A stem equal to the whole word needs a reason in the note.

## Rules that the application keeps

- The definition of the whole word decides the meaning. Component definitions only identify roles.
- Any word form that follows the morphology rules is valid, including lower-scoring rafsi and optional hyphens. The tasks never judge a form.
- The hint types follow the standard tags of the [format specification](../docs/format.md#glosses-types-and-defaults). `unclear` is not a tag. It marks a place that the definition does not describe.
- In `sources`, the pronunciation lets speakers of the language check the word later. The stress mark in `word_ipa` is informational. Only `sounds` is scored.

## Tested configuration

The prompts were tuned with Muse Spark 1.3 through OpenRouter. Medium reasoning gave the best balance of quality and cost.
