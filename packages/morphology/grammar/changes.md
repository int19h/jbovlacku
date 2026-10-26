# Word grammar sources and changes

The Peggy grammar handles word boundaries and word classes. It does not handle sentence grammar or word operations.
A parse returns word spans and component spans. The same parse supplies the CgV warning, which identifies a consonant before a glide and vowel.

## Sources

The base is ilmentufa revision `778ea138f7d150121ca722db7536ce3b123943ac`.
The source files are `camxes-morpho.pegjs` and `camxes-exp.pegjs`.
The [source notices](../THIRD-PARTY-NOTICES.md) retain their MIT license and copyright statements.

The grammar follows gencmu revision `0b3da7d2ec2f727a6730d77c775f88214a7ffc89` for the changes below.
Its word rules consume phonemes from an earlier stage. This package accepts Latin spelling directly.
Alternate scripts and marked glide letters from that earlier stage are outside this package.
The [word fixtures](../evidence/gencmu-words.json) record source revisions, source digests, and case IDs.

## Changes from camxes morphology

The table names every rule family that changes recognition behavior.
Tree actions and the top-level entry point also change to return word and component spans.
The remaining letter, syllable, stress, and rafsi rules retain the camxes experimental expressions.

| Rule family | Change and source |
| --- | --- |
| `extended_rafsi`, `stressed_extended_rafsi`, `initial_rafsi` | Use the camxes-exp alternatives. See gencmu [Extended rafsi](https://github.com/int19h/gencmu/blob/0b3da7d2ec2f727a6730d77c775f88214a7ffc89/grammars/words/experimental.md#extended-rafsi). This includes classical `hy-rafsi`, borrowing rafsi, and their stressed forms. |
| `fuhivla_rafsi`, `stressed_fuhivla_rafsi` | Permit an apostrophe onset before `y`. Keep the onset ordinary, so CgV cannot fill this rafsi slot. See the same Extended rafsi section. |
| `slihykru`, `brivla` | Refuse an initial CCV followed by `'y` and another onset. Include CgV in that onset. Apply the refusal to every brivla test, including nested tests. See the same Extended rafsi section. |
| `m` | Permit `mz`, as camxes-exp does. See gencmu [The pair mz](https://github.com/int19h/gencmu/blob/0b3da7d2ec2f727a6730d77c775f88214a7ffc89/grammars/words/experimental.md#the-pair-mz). |
| Consonant letters, `brivla_onset`, syllables, and `fuhivla` | Permit CgV in names and borrowing syllables. Keep ordinary rafsi onsets. Require a cluster in every borrowing. Keep the short-rafsi guard and its `r` exception. A borrowing can contain a late cluster. See gencmu [Consonants before glides](https://github.com/int19h/gencmu/blob/0b3da7d2ec2f727a6730d77c775f88214a7ffc89/grammars/words/experimental.md#consonants-before-glides). |
| `fuhivla` span conditions | Test the complete borrowing for a cluster and CgV. A later word cannot supply either test. See the same Consonants before glides section. |
| `words`, `lojban_word`, and gaps | Read word forms only. Omit quotes, erasure, selma'o matching, BU formation, and ZEI compounds. Every magic word remains an ordinary cmavo. This is an explicit project scope decision. |
| `cmavo_form` and gaps | Read a complete pure `y` run as an ordinary cmavo. Read `ie'o` and similar forms as ordinary cmavo. Never discard them as hesitation. This explicit project decision overrides gencmu [Hesitation words](https://github.com/int19h/gencmu/blob/0b3da7d2ec2f727a6730d77c775f88214a7ffc89/grammars/words/experimental.md#hesitation-words) and [Whole hesitation runs](https://github.com/int19h/gencmu/blob/0b3da7d2ec2f727a6730d77c775f88214a7ffc89/grammars/words/bpfk.md#whole-hesitation-runs). |
| `cmavo_nucleus`, `cmavo_last`, and `post_word` | Prefer the complete falling diphthong before another cmavo. Permit the implied pause at that boundary. Thus `taia` is `tai .a`, and `i'ecu'i` is `i'e cu'i`. This explicit project decision changes the reference treatment of [Cmavo](https://github.com/int19h/gencmu/blob/0b3da7d2ec2f727a6730d77c775f88214a7ffc89/grammars/words/bpfk.md#cmavo) and [Syllables and stress](https://github.com/int19h/gencmu/blob/0b3da7d2ec2f727a6730d77c775f88214a7ffc89/grammars/words/bpfk.md#syllables-and-stress). It uses no dictionary matches. |

## Output and limits

The parser records a warning on each accepted CgV word. It does not run a second recognizer to produce that warning.
The warning says, “This form is not valid under the current BPFK morphology.”
It makes no general validity claim about the form.

Two or more cmavo form a compound cmavo. Mixed word sequences remain unknown as dictionary headwords.
For example, `y bu` is a compound cmavo, while `broda zei brode` remains three words.
A `y` inside a lujvo stays inside that word.
A pure `y` run cannot take the start of a cmavo such as `y'y` or `y'e`.
One-word headwords permit one leading and one trailing framing period.
Other surrounding pause material remains visible in word spans, but it does not become a valid one-word headword.

Peggy counts every rule entry, including failed branches and cached calls. One analysis permits 50,000 entries and 128 original input bytes.
Exhaustion discards the complete result. Builders also charge these entries to their shared recognition budget.
The historical profiles retain their earlier counting rules and exact diagnostics.

The package commits the generated parser. `npm run build:morphology` regenerates it without runtime code evaluation.
`npm run test:morphology` makes sure that its bytes match the grammar and the pinned Peggy version.
This supports the browser policy that prohibits JavaScript string evaluation.
