# Morphology evidence

`word-parses.json` records results from two independent parsers. The jbotci source revision is `3d9fd41d9ed32de26311ee27ec86b6b165985aa1`. The gencmu source and grammar revision is `6d705c316797b02983220780ecebb17636d1c5b7`.

The jbotci results use `segment_words_with_modifiers` and `parse_lujvo_word_parts`. A parser that returns several words supplies no single-word classification. Part text removes phonetic stress and glide marks, but retains the parser's part boundaries.

The gencmu results use the `cll-ebnf` and `bpfk` dialects. `ok` records grammar acceptance. `brackets` records the resulting word sequence. Acceptance of a sequence does not establish acceptance of one lujvo. For example, both dialects read `baurismu` as two words.

`cross-check.rs` contains the comparison program. Run it in a scratch Cargo package with these dependencies: the two pinned source trees, the historical `jvc-morphology` crate at revision `62340e6`, and `serde_json`. The output line that begins with `REFERENCE_JSON=` contains the reference rows. The program also reports Jbovlacku output for comparison, but those outputs do not supply the retained expected parts.

Before a comparison, make sure that gencmu's embedded grammars match its source revision. Its `node tools/sync.js --check` command checks the copied grammars. The retained comparison used 75 source and grammar files that matched the named gencmu revision byte for byte.

`presets.json` retains factual weight rows, source references, and the SHA-256 digests of the original source bytes. The Ilmen sources use fixed GitHub revisions. The source page states no license for its program, so this evidence retains the factual tables rather than that program.

The Ilmen 8 README credits its eight-language configuration to Ilmen. It states no source population or transformation from twelve languages. The evidence makes no claim about such a transformation.

The recognizer port retains the parsing functions needed for word recognition and lujvo part ranges. It removes contract macros and external diagnostic types. It replaces the UI and CAI lookup with their pinned indicator table. The retained compatibility port keeps work accounting to functions that share the recognition cache. The port uses the CLL consonant-pair table and refuses `mz`, which jbotci accepts as an experimental relaxation. The notices for the source are in [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).

This evidence records representative cases. It does not establish full equivalence between the two reference grammars or between either grammar and Jbovlacku. For example, the CLL lujvo profile restricts components, while general fu'ivla recognition follows the pinned jbotci rules.

`cross-check.rs` writes Jbovlacku's label `fuhivla` for jbotci's `WordKind::Fuhivla` kind.
`word-parses.json` and `typed-lujvo.json` use that derived label.
The parser results, tokens, source revisions, and gencmu tree rules stay unchanged.

`gencmu-words.json` pins word-level cases for the Peggy profile.
The [grammar changes](../grammar/changes.md) distinguish source behavior from explicit project decisions.
