# Morphology profiles

This document names the word-form rules that the shared core implements in `crates/jvc-morphology`. Formation and compound metadata cite these identifiers and versions. A version changes when a rule changes.

The crate ports pure primitives from jbotci revision `3d9fd41d9ed32de26311ee27ec86b6b165985aa1`. They cover word recognition, consonant pairs, rafsi shapes, lujvo construction, gismu scoring, and conflicts. The notices are in [THIRD-PARTY-NOTICES.md](../crates/jvc-morphology/THIRD-PARTY-NOTICES.md).

## CLL lujvo

Identifier: `https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#cll-lujvo`. Version `2`.

The profile follows [CLL chapter 4](https://lojban.github.io/cll/4/1/):

- Consonant pairs and initial pairs follow CLL 3.6 and 3.7. The pair `mz` is forbidden, including at a component boundary without `y`.
- A component form is a short rafsi (CVC, CCV, CVV, CV'V), a four-letter gismu stem (CVCC, CCVC) before another part, or a whole gismu in the last position. A CVC rafsi never ends a lujvo.
- Joins follow CLL 4.11. A `y` follows a four-letter stem, separates a forbidden consonant pair, and separates `n` from `tc`, `ts`, `dj`, or `dz`. An `r` follows a first CVV rafsi, or `n` when the next part begins with `r`, unless the lujvo has two parts and the second is CCV. The tosmabru test adds one `y` after a leading CVC run that would read as cmavo before a gismu.
- A constructed candidate must parse as one lujvo and recover the intended parts and joins. Construction uses the required joins from CLL 4.11.
- Analysis accepts legal optional hyphens, such as the `r` in `sairzba`, under the pinned recognizer. The [PEG morphology rules](https://mw.lojban.org/papri/BPFK_Section:_PEG_Morphology_Algorithm) permit such optional joins. The original CLL 4.11 construction algorithm adds only required hyphens. An analyzed spelling does not become a construction result unless its joins satisfy the construction rules.

The CLL profile retains version `2` and required-only construction. Explicit optional joins use the extended profile version `3`.

## CLL lujvo scoring

Identifier: `https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#cll-lujvo-scoring`. Version `1`.

The score follows [CLL 4.12](https://lojban.github.io/cll/4/12/): `1000 L - 500 A + 100 H - 10 R - V`. L is the letter count, A the apostrophe count, H the hyphen count, R the sum of the shape ranks, and V the vowel count. The shape ranks are CVCCV 1, CVCC 2, CCVCV 3, CCVC 4, CVC 5, CV'V 6, CCV 7, CVV 8. The builder orders candidates by ascending score, then spelling, then the component choices.

## Extended lujvo

Identifier: `https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#extended-lujvo`. Version `3`.

### Version 2

Version `2` uses the recognizer and required-only construction at revision `0cd2bb9bb50d93748fbf44a25b165401710c400a`.
Callers select `extended-v2` to inspect or rebuild records with this version.
The morphology identifier remains the extended identifier above, and the version remains `2`.

The extended profile adds the audited jbotci behavior for whole-word parts. It is not CLL text:

- A whole brivla can serve as a part. The pinned recognizer must read each core as one gismu, lujvo, or fu'ivla. A core uses no `y`.
- A core that ends with a vowel is followed by `'y`. A rafsi that ends with a consonant can need a join. If the next consonant cannot pair with its final consonant, the join is `y`. Before a vowel nucleus, the join is `y'`, as in `fuly'ismu`. Before `i` or `u` plus a vowel, the join is `y`, as in `aktyiismu`.
- A rafsi part can have a shape outside the CLL table. The extended scorer gives that shape rank zero.
- Every candidate must parse as one lujvo under the pinned recognizer. Its parsed components and joins must equal the intended sequence. Token reconstruction supplies no parse evidence.
- A join can produce an invalid spelling. For example, bonding `leksiko` and `ismu` produces `leksiko'yismu`. The builder refuses that result after parsing it.

Version `2` and the CLL profile refuse the pair `mz` in every word kind and whole-word component. Version `2` does not include jbotci's experimental `mz` relaxation.

For example, the parts `ckusni` and `broda` build `ckusni'ybroda` with the first part retained as one whole-word core.
Explicit boundary joins and spelling overrides are unavailable in this version.

### Version 3

Version `3` follows the extended rafsi rules in the gencmu experimental dialect at revision `98417655a407566f50ed491cf8074f0c55ddce64`.
The [retained comparison](../crates/jvc-morphology/evidence/typed-lujvo.json) pins the grammar digests and one-word results.
Its source grammar is [experimental.md](https://github.com/int19h/gencmu/blob/98417655a407566f50ed491cf8074f0c55ddce64/grammars/words/experimental.md).
The bounded recognizer retains its jbotci lineage and adds these experimental rules only under the extended profile.
Version `3` permits the pair `mz` in every word kind and whole-word component, as the experimental grammar does.
This bounded comparison does not establish complete equivalence with gencmu.

The profile supports these rules:

- A whole gismu or borrowing can supply an extended rafsi when the experimental grammar recovers that exact part.
- A compound core can split into shorter rafsi under version `3`. Its parts must match that recovered sequence, rather than version `2` whole-word bonding.
- Borrowing rafsi permit an apostrophe onset in ordinary and stressed positions, as in `spageti'ybroda` and `spageti'ykla`.
- Extended rafsi use classical `hy-rafsi` or borrowing rafsi. Classical forms include `kerlybai'ybroda` and `kerlybla'ykla`.
- The `slihykru` restriction rejects CCV plus `'y` before an onset at the start of every brivla. This includes nested brivla tests after a possible cmavo. It rejects `bla'ykla` and its CgV variants. Thus `baibla'ykla` stays one lujvo because its tail is not a separate brivla.
- Explicit joins contain one nullable string per boundary. Null uses the automatic join. An empty string selects no join.
- Explicit choices permit `y`, `y'`, `'y`, `'y'`, `r`, and `n` only when a complete parse recovers every intended part and join.
- An explicit rafsi lock describes morphology independently of dictionary assignment standing. Unknown and conflicting source assignments remain visible.
- A core that ends with a vowel is followed by `'y`. A rafsi that ends with a consonant is followed by `y` before a consonant that it cannot pair with, or by `y'` before a vowel nucleus, as in `fuly'ismu`. Before `i` or `u` plus a vowel, the join is `y`, as in `aktyiismu`.
- A rafsi part can have a shape outside the CLL table. The extended scorer gives that shape rank zero.
- Every candidate must parse as one lujvo under the pinned recognizer. Its parsed components and joins must equal the intended sequence. Token reconstruction supplies no parse evidence.
- A join can produce an invalid spelling. The builder refuses a result when the complete parse differs from its intended parts or joins.

A request can also supply the exact entered `spelling`. Its normalization must equal the complete parsed candidate.
Normalization uses lowercase letters, omits commas, and reads `h` and curly apostrophes as apostrophes.
Typed presentation can include one leading and one trailing framing period. Detection and reconstruction omit them from component rafsi.
The construction score uses those normalized tokens. The candidate spelling and its presentation tokens keep the original bytes.
A mismatched spelling produces no candidate. The override never bypasses segmentation or recognition limits.

Version `2` keeps its earlier recognizer and required-only construction rules. Version `3` never rewrites existing compound metadata.
The CLL profile keeps its recognition and construction rules at version `2`.

Version `2` and the CLL profile refuse `mz`. Version `3` permits it. New authoring uses version `3`.

Extended analysis also accepts the join `'y'`, as in `bangu'y'ismu`. It reports the full token as the join before the next component. A nonfinal whole gismu is a core. A final whole gismu can be a rafsi under the CLL component rules.

The word recognizer ports the pure recognition functions from jbotci's `segment.rs` and the indicator table from `cmavo.rs`. Contract macros and source diagnostic types do not enter the port. The crate adds work limits. Version `2` and CLL use CLL consonant-pair restrictions. Version `3` permits `mz`. It returns spelling spans without jbotci's stress and glide marks.

The CLL profile restricts lujvo components and construction joins. General word recognition uses the pinned jbotci lineage for both profiles. This is not full equivalence with gencmu's `cll-ebnf` grammar. For example, jbotci and gencmu `bpfk` recognize `ismu`, while gencmu `cll-ebnf` rejects it. The retained [reference results](../crates/jvc-morphology/evidence/word-parses.json) record this difference. Fu'ivla classification is advisory under the CLL profile. Every such analysis reports that the extended jbotci lineage does not establish CLL validity.

The extended parser recognizes `sakrsakysakli` as `sakrsak + y + sakli`. The CLL profile rejects it. Neither profile returns the invalid classic split `sak + rsak + y + sakli`.

## Work limits

The recognizer accepts at most 128 input bytes. It permits at most 50,000 calls to recursive recognition functions that share its cache. This counts failed paths and cached calls. Exhaustion invalidates the whole analysis, including any earlier successful branch. Analysis returns `unknown` with a resource diagnostic. Candidate recognition exhaustion makes builders return `BuilderError::ResourceLimit` and no partial result.

A lujvo request accepts 2 through 64 components, 64 claims per component, and 20,000 inventory claims. A component or claimed rafsi accepts at most 128 bytes. A build permits at most 20,000 choice combinations and 2,000,000 recognition calls across candidate checks. A result window permits at most 512 candidates.

Caller limits can reduce these ceilings. The public Rust score function returns an error above 128 bytes, before arithmetic.

The builder bonds and scores every combination before parsing candidates in score order. It stops parsing when the result window fills. Every returned candidate recovers the intended parts and joins from a full parse. The builder caches each distinct whole-word core check across candidate checks. Failed candidate parses count toward the shared work limit.

The work limit can still stop long or repeatedly rejected forms before the window fills. It does not guarantee 512 results for every input. A shared build recognition error suggests a component lock. Per-word recognition errors give no lock advice. Resource errors return no partial result.

The builder creates conflict details only for returned candidates. A complete result covers every combination for bonding and scoring. Its rejected list covers only candidates parsed before the window fills.

A gismu request accepts 1 through 64 source rows. Each raw scoring input and native source word accepts at most 256 bytes. A normalized scoring input accepts at most 64 letters. A language identifier accepts at most 64 bytes. Each weight part accepts at most 64 decimal digits. Exact weight arithmetic permits at most 4096 bits in its shared denominator and total weight. The search permits at most 60,000,000 candidate-input-letter operations. Each inventory list permits at most 20,000 rows. Caller limits can reduce these ceilings.

Each builder shares one conflict budget across its result. It permits 1,000,000 inventory scans and index references, 20,000 copied conflict rows, and 4,000,000 copied text bytes. Gismu budgets include both ranked candidates and the manual form. Preflight checks cover the later copy pass before that pass allocates conflict strings. A resource error returns no partial result and no incomplete conflict list.

Direct component analysis reports incomplete recognition when the recognizer reaches its work limit. It does not declare the spelling invalid from that incomplete result. The row reports `recognition_incomplete: true` and keeps its listed rafsi choices.

An extended whole-word lock stays valid but pending until recognition finishes. For a non-gismu component, a CLL whole-word lock is invalid.
Both cases preserve the saved lock and explain that candidates use listed rafsi while recognition remains incomplete.
The interface shows that lock even when it is absent from the choices. Other invalid locks and locks in an invalid position still prevent candidates.
Each returned candidate still needs a complete parse.

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
| Ilmen 6  | eng 339, cmn 255, hin 136, spa 126, ara 74, fra 70                                                 | [gimyzba](https://github.com/lynn/lynn.github.io/blob/567f4ada91/gimyzba/index.html)                                                              |
| Ilmen 8  | cmn 271, eng 170, spa 130, hin 125, ara 104, ben 76, rus 64, por 60                                | [gimyzba](https://github.com/lynn/lynn.github.io/blob/567f4ada91/gimyzba/index.html)                                                              |
| Ilmen 12 | cmn 238, eng 160, spa 113, hin 108, ara 90, ben 66, rus 55, por 52, msa 32, jpn 30, deu 29, fra 26 | [gimyzba](https://github.com/lynn/lynn.github.io/blob/567f4ada91/gimyzba/index.html)                                                              |

The gimyzba page names no population source and no license for its tables. The profiles record its numbers and URL as a citation of facts. The lynn/gimyzba README at commit `b413e2b` credits the eight-language configuration to Ilmen. It states no population data or method for deriving the weights. Ilmen 6 and Ilmen 12 first appear in the first commit of the gimyzba page, 567f4ada91 of 2026-06-16, with no citation. Their attribution to Ilmen is by name only, and Ilmen 12 differs from the 2016 table. The origin of those two tables is unconfirmed. The CLL 1987 table is not the rounded 1985 table of CLL. New runs normalize the numerators by their positive sum, so the Ilmen 12 sum of 999 does not change candidate order against a run that divides by 1000, but the two runs have different scores and are never labeled the same.

Every preset returns `source_digest`, the SHA-256 digest of its cited source bytes. The [retained factual tables](../crates/jvc-morphology/evidence/presets.json) record those digests and source references. The Ilmen tables cite the fixed gimyzba page revision `567f4ada91`. The evidence stores the factual weight rows rather than the page's unlicensed program code.

The identifier URLs name stable metadata identities. They do not prove that a branch already contains this document. The source-letter recipe retains `cll-gismu-forms-v1` for existing formation records. It searches letters from the inputs. The all-letter recipe searches every Lojban consonant and vowel. These names do not change the candidate alphabet that each run records.
