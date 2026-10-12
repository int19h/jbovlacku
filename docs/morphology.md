# Morphology profiles

This document names the word-form rules that the shared core implements in `crates/jvc-morphology`. Formation and compound metadata cite these identifiers and versions. A version changes when a rule changes.

The crate ports its phonotactic tables, rafsi shapes, lujvo bonding and scoring, short rafsi derivation, recognition counting, and similar-consonant rules from jbotci revision `3d9fd41d9ed32de26311ee27ec86b6b165985aa1`. The notices are in `crates/jvc-morphology/THIRD-PARTY-NOTICES.md`.

## CLL lujvo

Identifier: `https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#cll-lujvo`. Version `1`.

The profile follows [CLL chapter 4](https://lojban.github.io/cll/4/1/):

- Consonant pairs and initial pairs follow CLL 3.6 and 3.7.
- A component form is a short rafsi (CVC, CCV, CVV, CV'V), a four-letter gismu stem (CVCC, CCVC) before another part, or a whole gismu in the last position. A CVC rafsi never ends a lujvo.
- Joins follow CLL 4.11. A `y` follows a four-letter stem, separates a forbidden consonant pair, and separates `n` from `tc`, `ts`, `dj`, or `dz`. An `r` follows a first CVV rafsi, or `n` when the next part begins with `r`, unless the lujvo has two parts and the second is CCV. The tosmabru test adds one `y` after a leading CVC run that would read as cmavo before a gismu.
- A candidate is valid only when the whole spelling reads as one lujvo under these rules and that reading gives back the intended parts and joins. A needless or missing hyphen rejects the form.

## CLL lujvo scoring

Identifier: `https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#cll-lujvo-scoring`. Version `1`.

The score follows [CLL 4.12](https://lojban.github.io/cll/4/12/): `1000 L - 500 A + 100 H - 10 R - V`. L is the letter count, A the apostrophe count, H the hyphen count, R the sum of the shape ranks, and V the vowel count. The shape ranks are CVCCV 1, CVCC 2, CCVCV 3, CCVC 4, CVC 5, CV'V 6, CCV 7, CVV 8. The builder orders candidates by ascending score, then spelling, then the component choices.

## Extended lujvo

Identifier: `https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#extended-lujvo`. Version `1`.

The extended profile adds the audited jbotci behavior for whole-word parts. It is not CLL text:

- A whole brivla can serve as a part. A brivla core ends with a vowel, has a permissible consonant pair among its first five letters, and uses no `y`.
- A core that ends with a vowel is followed by `'y`. A rafsi that ends with a consonant is followed by `y` before a consonant that it cannot pair with, or by `y'` before a vowel nucleus, as in `fuly'ismu`. Before `i` or `u` plus a vowel, the join is `y`, as in `aktyiismu`.
- A rafsi part can have a shape outside the CLL table. The extended scorer gives that shape rank zero.
- A candidate with whole-word parts is valid when its joins reproduce the spelling, every core is a brivla core, and the CLL rules do not read the spelling as a different lujvo. The classic reading, when it exists, wins.

## Extended lujvo scoring

Identifier: `https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#extended-lujvo-scoring`. Version `1`.

The CLL formula applies. A shape outside the CLL table has rank zero.

## Gismu generator

Identifier: `https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#gismu-generator`. Version `1`.

The generator follows [CLL 4.14](https://lojban.github.io/cll/4/14/) with explicit parameters:

| Parameter       | Rule                                                     | Meaning                                                                                                                                                                                             |
| --------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| weighting       | `normalize-positive-sum-v1`                              | Each language weight is divided by the sum of the positive weights over distinct languages. Zero weights stay and contribute nothing.                                                               |
| matching        | `cll-letter-match-v1`                                    | The recognition count is the longest common subsequence when it has three or more letters. Two letters count only when both strings hold them adjacent or one letter apart in the same arrangement. |
| transliteration | `literal-lojbanized-v1`                                  | The scoring input is used as entered, in lowercase, without apostrophes, commas, or periods.                                                                                                        |
| candidates      | `cll-gismu-forms-v1` or `cll-gismu-forms-all-letters-v1` | CVCCV forms with a permissible pair and CCVCV forms with an initial pair, from the letters of the scoring inputs or from every Lojban letter.                                                       |
| aggregation     | `maximum-per-language-v1`                                | Alternatives of one language share its weight and contribute the largest recognition fraction.                                                                                                      |

A candidate score is the sum over languages of the normalized weight times the recognition count divided by the input length. Scores are exact rationals. The rank is one plus the number of candidates with a strictly greater score, so equal scores share a rank. A manual form outside the generated inventory has a score and no rank. The search is complete or refused by a work limit. It is never partial.

Conflicts come from the inventory the caller supplies. The rules are `identical`, `final-vowel` (same first four letters, another final vowel), and `similar-consonant` (one consonant replaced by a too-similar consonant: b with p or v, c with j or s, d with t, f with p or v, g with k or x, j with c or z, k with g or x, l with r, m with n, n with m, p with b or f, r with l, s with c or z, t with d, v with b or f, x with g or k, z with j or s). The rafsi conflicts list every known claim of each possible short rafsi, across every word type.

## Weight profiles

| Profile  | Languages and numerators over 1000                                                                 | Source                                                                                                                                        |
| -------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| CLL 1995 | cmn 347, hin 196, eng 160, spa 123, rus 89, ara 85                                                 | [CLL 4.14](https://lojban.github.io/cll/4/14/), dated by the [language-statistics archive](https://lojban.org/files/etymology/langstat99.htm) |
| CLL 1987 | cmn 360, hin 156, eng 208, spa 116, rus 87, ara 73                                                 | [Language-statistics archive](https://lojban.org/files/etymology/langstat99.htm), the original gismu-remaking table                           |
| Ilmen 6  | eng 339, cmn 255, hin 136, spa 126, ara 74, fra 70                                                 | [gimyzba](https://github.com/lynn/lynn.github.io/blob/master/gimyzba/index.html)                                                              |
| Ilmen 8  | cmn 271, eng 170, spa 130, hin 125, ara 104, ben 76, rus 64, por 60                                | [gimyzba](https://github.com/lynn/lynn.github.io/blob/master/gimyzba/index.html)                                                              |
| Ilmen 12 | cmn 238, eng 160, spa 113, hin 108, ara 90, ben 66, rus 55, por 52, msa 32, jpn 30, deu 29, fra 26 | [gimyzba](https://github.com/lynn/lynn.github.io/blob/master/gimyzba/index.html)                                                              |

The gimyzba page names no population source and no license for its tables. The profiles record its numbers and URL as a citation of facts. Ilmen 8 is Ilmen's 2016 twelve-language table, published as the etymology of the experimental gismu stima on 2016-01-28, cut to eight languages and rescaled, as the lynn/gimyzba README credited in commit b413e2b of 2020-11-12. Ilmen 6 and Ilmen 12 first appear in the first commit of the gimyzba page, 567f4ada91 of 2026-06-16, with no citation. Their attribution to Ilmen is by name only, and Ilmen 12 differs from the 2016 table. The origin of those two tables is unconfirmed. The CLL 1987 table is not the rounded 1985 table of CLL. New runs normalize the numerators by their positive sum, so the Ilmen 12 sum of 999 does not change candidate order against a run that divides by 1000, but the two runs have different scores and are never labeled the same.
