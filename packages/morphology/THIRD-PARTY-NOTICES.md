# Third-party notices for morphology

The phonotactic tables, rafsi shape rules, lujvo bonding and scoring rules,
short rafsi derivation, gismu recognition scoring, and similar-consonant
conflict rules in this package are ported from jbotci, revision
`3d9fd41d9ed32de26311ee27ec86b6b165985aa1`, files
`crates/jbotci-morphology/src/lujvo.rs`,
`crates/jbotci-morphology/src/segment.rs`,
`crates/jbotci-morphology/src/cmavo.rs`,
`crates/jbotci-morphology/src/segment/phonotactics.rs`, and
`crates/jbotci-gimfihi/src/lib.rs`. Their regression fixtures are kept in the
tests of this package.

jbotci is licensed under the MIT License:

MIT License

Copyright © 2026 Pavel Minaev <me@int19h.org>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The language weight tables of the CLL 1987 and CLL 1995 profiles are facts
cited from the Lojban language-statistics archive and CLL chapter 4.14. The
Ilmen profiles cite lynn's gimyzba page. These citations record numbers and
URLs, pinned source digests, and factual table excerpts.

## Peggy grammar sources

The word grammar derives from ilmentufa at revision `778ea138f7d150121ca722db7536ce3b123943ac`.
Its source files are `camxes-morpho.pegjs` and `camxes-exp.pegjs`.
The following source notice retains both copyright statements and license grants.

```text
The MIT License (MIT)

Copyright (c) 2014 lagleki, ilmen, and other contributors.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


                   ---------------------------------------


The files “camxes.js.peg” and “camxes.js” are copyright (c) 2013, 2014 Masato
Hagiwara and licensed as follow:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

```

The grammar also follows the word rules and prose in gencmu at revision `0b3da7d2ec2f727a6730d77c775f88214a7ffc89`.
The regression fixtures cite that revision and the exact source files.
The [text orthography layer](src/orthography.ts) derives its rules from these gencmu files at revision `0b3da7d2ec2f727a6730d77c775f88214a7ffc89`:

- `grammars/phonemes/latin-strict.md`
- `grammars/phonemes/latin.md`
- `grammars/phonemes/latin-experimental.md`
- `grammars/phonemes/cyrillic.md`
- `grammars/phonemes/cyrillic-experimental.md`
- `grammars/phonemes/zbalermorna.md`

The [experimental corpus fixture](evidence/gencmu-corpus.json) adapts cases from `tests/corpus/*.jsonl` at the same revision.
It retains source case identifiers, file names, line numbers, and file digests.
It records expectations from gencmu and each replacement that treats a magic word as an ordinary cmavo.
The gencmu source license below covers the derived orthography rules and gencmu's own test material.
Quoted texts retain their separate source rights and attribution. The corpus text notices below record the identified sources.

```text
MIT License

Copyright (c) 2026 Pavel Minaev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Corpus text sources

The experimental fixture retains six cases from gencmu's `tests/corpus/cll.jsonl` at revision `0b3da7d2ec2f727a6730d77c775f88214a7ffc89`.
Four contain book examples. The other two contain literary translations:

`cll.chrestomathy.alice01` contains an extract from *Alice's Adventures in Wonderland*, by Lewis Carroll.
`cll.chrestomathy.in-xanadu` contains an extract from *Kubla Khan*, by Samuel Taylor Coleridge.
Both match the Lojban table columns in [the retained CLL appendix](https://github.com/int19h/cll/blob/13ce309d49a99bbef4a0f37c699230456622a4f2/chapters/a01.xml), after whitespace normalization.
That appendix does not name either translator or state separate translation terms.
These records do not establish a separate license for those inherited translation versions.

The fixture extracts Lojban text and adds token expectations. It omits the book's parallel English translations and table layout.
The text stays as recorded in gencmu. Each case records changes to its expectations.
The book's [copyright section](https://github.com/int19h/cll/blob/13ce309d49a99bbef4a0f37c699230456622a4f2/chapters/01.xml#L522) supplies the following notice:

```text
Copyright © 1997 by The Logical Language Group, Inc. All Rights Reserved.

Permission is granted to make and distribute verbatim copies of this book, either in electronic or in printed form, provided the copyright notice and this permission notice are preserved on all copies.

Permission is granted to copy and distribute modified versions of this book, provided that the modifications are clearly marked as such, and provided that the entire resulting derived work is distributed under the terms of a permission notice identical to this one.

Permission is granted to copy and distribute translations of this book into another language, under the above conditions for modified versions, except that this permission notice may be stated in a translation that has been approved by the Logical Language Group, rather than in English.

The contents of Chapter 21 are in the public domain.
```

This notice retains the book's terms. It does not assign a license to Jbovlacku or to separately authored quotations.
The fixture retains source file names and case identifiers for other inherited texts. Their presence in gencmu does not establish separate redistribution rights.

## Generated parser

The generated parser uses Peggy 5.1.1. The parser retains its upstream legal header.

```text
MIT License

Copyright (c) 2010-2025 The Peggy AUTHORS

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
