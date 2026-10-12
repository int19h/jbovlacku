//! The gismu generator of CLL 4.14 with exact rational scores, zero weights,
//! normalization over distinct languages, maximum aggregation of alternatives,
//! tied ranks, and complete conflict lists. Recognition counting and the
//! similar-consonant mapping are ported from jbotci.
use crate::lujvo::{BuilderError, InventoryClaim, Versioned};
use crate::phonotactics::{
    CONSONANTS, VOWELS, is_consonant, is_initial_pair, is_permissible_pair, is_vowel,
};
use crate::rafsi::{gismu_shape, possible_short_rafsi};
use num_bigint::{BigInt, BigUint};
use num_integer::Integer;
use num_rational::Ratio;
use num_traits::{One, Zero};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const ALGORITHM_ID: &str =
    "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#gismu-generator";
pub const ALGORITHM_VERSION: &str = "1";
pub const WEIGHTING: &str = "normalize-positive-sum-v1";
pub const MATCHING: &str = "cll-letter-match-v1";
pub const TRANSLITERATION: &str = "literal-lojbanized-v1";
pub const CANDIDATES_SOURCE_LETTERS: &str = "cll-gismu-forms-v1";
pub const CANDIDATES_ALL_LETTERS: &str = "cll-gismu-forms-all-letters-v1";
pub const AGGREGATION: &str = "maximum-per-language-v1";

/// A calculated rational in lowest terms as canonical decimal strings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Calculated {
    pub numerator: String,
    pub denominator: String,
}
fn calculated(value: &Ratio<BigUint>) -> Calculated {
    Calculated {
        numerator: value.numer().to_string(),
        denominator: value.denom().to_string(),
    }
}
/// A nonnegative rational input. Numerator and denominator can be numbers or decimal strings.
fn parse_rational(value: &Value) -> Option<Ratio<BigUint>> {
    let part = |v: &Value| -> Option<BigUint> {
        match v {
            Value::Number(n) => n.as_u64().map(BigUint::from),
            Value::String(s)
                if !s.is_empty()
                    && s.len() <= 64
                    && s.bytes().all(|b| b.is_ascii_digit())
                    && (s.len() == 1 || !s.starts_with('0')) =>
            {
                BigUint::parse_bytes(s.as_bytes(), 10)
            }
            _ => None,
        }
    };
    let n = part(value.get("numerator")?)?;
    let d = part(value.get("denominator")?)?;
    if d.is_zero() {
        return None;
    }
    Some(Ratio::new(n, d))
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceRow {
    pub language: String,
    pub word: String,
    /// The exact scoring letters, or null for an unfinished row.
    #[serde(default)]
    pub input: Option<String>,
    /// A nonnegative rational, or null when unknown.
    #[serde(default)]
    pub weight: Option<Value>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CandidateRecipe {
    /// Use only letters that appear in the scoring inputs.
    SourceLetters,
    /// Every Lojban consonant and vowel.
    AllLetters,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InventoryGismu {
    pub spelling: String,
    pub word: String,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GismuInventory {
    #[serde(default)]
    pub snapshot: Option<String>,
    /// Known gismu and experimental gismu spellings with word IDs.
    #[serde(default)]
    pub gismu: Vec<InventoryGismu>,
    /// Known rafsi claims across every word type.
    #[serde(default)]
    pub claims: Vec<InventoryClaim>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GismuLimits {
    /// Candidates times total input letters, bounded before the search.
    #[serde(default = "default_work")]
    pub work: u64,
}
fn default_work() -> u64 {
    60_000_000
}
impl Default for GismuLimits {
    fn default() -> Self {
        Self {
            work: default_work(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GismuRequest {
    pub sources: Vec<SourceRow>,
    #[serde(default = "default_recipe")]
    pub candidates: CandidateRecipe,
    #[serde(default)]
    pub inventory: GismuInventory,
    /// How many ranked candidates to return, at most 512.
    #[serde(default = "default_window")]
    pub window: usize,
    /// A manually chosen spelling evaluated under the same recipe.
    #[serde(default)]
    pub manual: Option<String>,
    #[serde(default)]
    pub limits: GismuLimits,
}
fn default_recipe() -> CandidateRecipe {
    CandidateRecipe::SourceLetters
}
fn default_window() -> usize {
    32
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedLanguage {
    pub language: String,
    /// The entered weight.
    pub weight: Calculated,
    /// The weight divided by the sum of positive weights.
    pub normalized: Calculated,
    pub inputs: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Contribution {
    pub language: String,
    /// The alternative that gave the largest recognition fraction.
    pub input: String,
    pub matched: usize,
    pub length: usize,
    pub weighted: Calculated,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RootConflict {
    pub word: String,
    pub spelling: String,
    /// identical, final-vowel, or similar-consonant.
    pub rule: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RafsiConflict {
    pub rafsi: String,
    pub word: String,
    pub spelling: String,
    pub pair: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GismuCandidate {
    pub form: String,
    pub score: Calculated,
    /// One plus the number of candidates with a strictly greater score. Null outside the search.
    pub rank: Option<u64>,
    pub contributions: Vec<Contribution>,
    pub short_rafsi: Vec<String>,
    pub conflicts: Vec<RootConflict>,
    pub rafsi_conflicts: Vec<RafsiConflict>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Parameters {
    pub weighting: String,
    pub matching: String,
    pub transliteration: String,
    pub candidates: String,
    pub aggregation: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GismuResult {
    pub languages: Vec<ResolvedLanguage>,
    /// The number of candidate spellings in the complete inventory.
    pub considered: u64,
    pub complete: bool,
    pub candidates: Vec<GismuCandidate>,
    pub manual: Option<GismuCandidate>,
    pub algorithm: Versioned,
    pub parameters: Parameters,
    pub diagnostics: Vec<String>,
}
/// The CLL 4.14 recognition count: the longest common subsequence when it has
/// three or more letters. Two letters count only when both strings hold them
/// adjacent or separated by one letter, in the same arrangement.
pub fn match_score(candidate: &[char], source: &[char]) -> usize {
    let lcs = lcs_len(candidate, source);
    if lcs >= 3 {
        return lcs;
    }
    if lcs != 2 {
        return 0;
    }
    for a in 0..candidate.len() {
        for b in a + 1..candidate.len() {
            let gap = b - a;
            if gap > 2 {
                continue;
            }
            for c in 0..source.len() {
                if c + gap < source.len()
                    && candidate[a] == source[c]
                    && candidate[b] == source[c + gap]
                {
                    return 2;
                }
            }
        }
    }
    0
}
fn lcs_len(left: &[char], right: &[char]) -> usize {
    let mut previous = vec![0usize; right.len() + 1];
    let mut current = vec![0usize; right.len() + 1];
    for l in left {
        for (j, r) in right.iter().enumerate() {
            current[j + 1] = if l == r {
                previous[j] + 1
            } else {
                previous[j + 1].max(current[j])
            };
        }
        std::mem::swap(&mut previous, &mut current);
        current.fill(0);
    }
    previous[right.len()]
}
/// The directional similar-consonant rule of CLL 4.14 as jbotci records it.
pub fn too_similar_consonant(proposed: char, existing: char) -> bool {
    match proposed {
        'b' => matches!(existing, 'p' | 'v'),
        'c' => matches!(existing, 'j' | 's'),
        'd' => existing == 't',
        'f' => matches!(existing, 'p' | 'v'),
        'g' => matches!(existing, 'k' | 'x'),
        'j' => matches!(existing, 'c' | 'z'),
        'k' => matches!(existing, 'g' | 'x'),
        'l' => existing == 'r',
        'm' => existing == 'n',
        'n' => existing == 'm',
        'p' => matches!(existing, 'b' | 'f'),
        'r' => existing == 'l',
        's' => matches!(existing, 'c' | 'z'),
        't' => existing == 'd',
        'v' => matches!(existing, 'b' | 'f'),
        'x' => matches!(existing, 'g' | 'k'),
        'z' => matches!(existing, 'j' | 's'),
        _ => false,
    }
}
/// Every conflict of a proposed spelling with an existing gismu.
struct ConflictIndex<'a> {
    by_candidate: BTreeMap<String, Vec<(&'a InventoryGismu, &'static str)>>,
}
impl<'a> ConflictIndex<'a> {
    fn build(inventory: &'a [InventoryGismu]) -> Self {
        let mut by_candidate: BTreeMap<String, Vec<(&InventoryGismu, &'static str)>> =
            BTreeMap::new();
        for entry in inventory {
            let chars: Vec<char> = entry.spelling.chars().collect();
            if chars.len() != 5 {
                continue;
            }
            by_candidate
                .entry(entry.spelling.clone())
                .or_default()
                .push((entry, "identical"));
            if is_vowel(chars[4]) {
                for vowel in VOWELS.chars().filter(|v| *v != chars[4]) {
                    let mut c = chars.clone();
                    c[4] = vowel;
                    by_candidate
                        .entry(c.iter().collect())
                        .or_default()
                        .push((entry, "final-vowel"));
                }
            }
            for (index, existing) in chars.iter().enumerate() {
                if !is_consonant(*existing) {
                    continue;
                }
                for proposed in CONSONANTS
                    .chars()
                    .filter(|p| too_similar_consonant(*p, *existing))
                {
                    let mut c = chars.clone();
                    c[index] = proposed;
                    by_candidate
                        .entry(c.iter().collect())
                        .or_default()
                        .push((entry, "similar-consonant"));
                }
            }
        }
        Self { by_candidate }
    }
    fn conflicts(&self, candidate: &str) -> Vec<RootConflict> {
        let mut out: Vec<RootConflict> = self
            .by_candidate
            .get(candidate)
            .map(|v| {
                v.iter()
                    .map(|(e, rule)| RootConflict {
                        word: e.word.clone(),
                        spelling: e.spelling.clone(),
                        rule: (*rule).into(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.sort_by(|a, b| a.spelling.cmp(&b.spelling).then(a.rule.cmp(&b.rule)));
        out.dedup_by(|a, b| a.word == b.word && a.rule == b.rule);
        out
    }
}
struct Language {
    language: String,
    weight: Ratio<BigUint>,
    inputs: Vec<Vec<char>>,
}
fn normalize_input(text: &str) -> Result<Vec<char>, BuilderError> {
    if text.len() > 256 {
        return Err(BuilderError::ResourceLimit {
            measure: "scoring input bytes".into(),
            value: text.len() as u64,
            limit: 256,
        });
    }
    let chars: Vec<char> = text
        .trim()
        .chars()
        .map(|c| c.to_ascii_lowercase())
        .filter(|c| *c != '\'' && *c != ',' && *c != '.')
        .collect();
    if chars.is_empty() {
        return Err(BuilderError::Invalid {
            message: "A scoring input is empty.".into(),
        });
    }
    if chars.len() > 64 {
        return Err(BuilderError::Invalid {
            message: "A scoring input has more than 64 letters.".into(),
        });
    }
    if let Some(bad) = chars
        .iter()
        .find(|c| !(is_vowel(**c) || is_consonant(**c) || **c == 'y'))
    {
        return Err(BuilderError::Invalid {
            message: format!("A scoring input uses \"{bad}\", which is not a Lojban letter."),
        });
    }
    Ok(chars)
}
fn resolve_languages(sources: &[SourceRow]) -> Result<Vec<Language>, BuilderError> {
    if sources.is_empty() || sources.len() > 64 {
        return Err(BuilderError::Invalid {
            message: "The generator needs 1 through 64 source rows.".into(),
        });
    }
    let mut order: Vec<String> = Vec::new();
    let mut by_language: BTreeMap<String, Language> = BTreeMap::new();
    for row in sources {
        for (measure, text, limit) in [
            ("language bytes", row.language.as_str(), 64),
            ("source word bytes", row.word.as_str(), 256),
        ] {
            if text.len() > limit {
                return Err(BuilderError::ResourceLimit {
                    measure: measure.into(),
                    value: text.len() as u64,
                    limit: limit as u64,
                });
            }
        }
        if let Some(weight) = &row.weight {
            for field in ["numerator", "denominator"] {
                if let Some(text) = weight.get(field).and_then(Value::as_str) {
                    if text.len() > 64 {
                        return Err(BuilderError::ResourceLimit {
                            measure: "weight digits".into(),
                            value: text.len() as u64,
                            limit: 64,
                        });
                    }
                }
            }
        }
        let language = row.language.trim().to_owned();
        if language.is_empty() {
            return Err(BuilderError::Invalid {
                message: "A source row has no language.".into(),
            });
        }
        let Some(weight) = row.weight.as_ref().and_then(parse_rational) else {
            return Err(BuilderError::Invalid {
                message: format!(
                    "The weight of {language} is missing or not a nonnegative rational."
                ),
            });
        };
        let Some(input) = row.input.as_deref() else {
            return Err(BuilderError::Invalid {
                message: format!("The source row for {language} has no scoring input."),
            });
        };
        let input = normalize_input(input)?;
        match by_language.get_mut(&language) {
            Some(existing) => {
                if existing.weight != weight {
                    return Err(BuilderError::Invalid {
                        message: format!(
                            "The rows for {language} have different weights. Alternatives of one language share one weight."
                        ),
                    });
                }
                existing.inputs.push(input);
            }
            None => {
                order.push(language.clone());
                by_language.insert(
                    language.clone(),
                    Language {
                        language,
                        weight,
                        inputs: vec![input],
                    },
                );
            }
        }
    }
    Ok(order
        .into_iter()
        .map(|l| by_language.remove(&l).unwrap())
        .collect())
}
fn generate_inventory(recipe: CandidateRecipe, languages: &[Language]) -> Vec<String> {
    let (consonants, vowels): (Vec<char>, Vec<char>) = match recipe {
        CandidateRecipe::AllLetters => (CONSONANTS.chars().collect(), VOWELS.chars().collect()),
        CandidateRecipe::SourceLetters => {
            let mut c = BTreeSet::new();
            let mut v = BTreeSet::new();
            for language in languages {
                for input in &language.inputs {
                    for ch in input {
                        if is_consonant(*ch) {
                            c.insert(*ch);
                        } else if is_vowel(*ch) {
                            v.insert(*ch);
                        }
                    }
                }
            }
            (c.into_iter().collect(), v.into_iter().collect())
        }
    };
    let mut out = Vec::new();
    for &c0 in &consonants {
        for &c1 in &consonants {
            if !is_initial_pair(c0, c1) {
                continue;
            }
            for &v2 in &vowels {
                for &c3 in &consonants {
                    for &v4 in &vowels {
                        out.push(format!("{c0}{c1}{v2}{c3}{v4}"));
                    }
                }
            }
        }
    }
    for &c0 in &consonants {
        for &v1 in &vowels {
            for &c2 in &consonants {
                for &c3 in &consonants {
                    if !is_permissible_pair(c2, c3) {
                        continue;
                    }
                    for &v4 in &vowels {
                        out.push(format!("{c0}{v1}{c2}{c3}{v4}"));
                    }
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}
/// Integer scoring tables: every contribution is `weight * matched / length`,
/// scaled by a shared denominator so candidate sums are integer additions.
struct Scorer {
    /// Per language, per alternative, per matched count 0..=5: the scaled contribution.
    tables: Vec<Vec<Vec<BigUint>>>,
    /// The sum of positive weights times the shared length multiple.
    denominator: BigUint,
}
impl Scorer {
    fn new(languages: &[Language]) -> Self {
        let total: Ratio<BigUint> = languages
            .iter()
            .map(|l| l.weight.clone())
            .fold(Ratio::zero(), |a, b| a + b);
        let mut length_lcm = BigUint::one();
        for language in languages {
            for input in &language.inputs {
                length_lcm = length_lcm.lcm(&BigUint::from(input.len()));
            }
        }
        let mut weight_lcm = BigUint::one();
        for language in languages {
            weight_lcm = weight_lcm.lcm(language.weight.denom());
        }
        weight_lcm = weight_lcm.lcm(total.denom());
        // scale = length_lcm * weight_lcm. contribution = weight * m / len * scale / total.
        let denominator = (&total * Ratio::from_integer(&length_lcm * &weight_lcm)).to_integer();
        let tables = languages
            .iter()
            .map(|language| {
                language
                    .inputs
                    .iter()
                    .map(|input| {
                        (0..=5usize)
                            .map(|m| {
                                (&language.weight
                                    * Ratio::from_integer(
                                        &length_lcm * &weight_lcm * BigUint::from(m),
                                    )
                                    / Ratio::from_integer(BigUint::from(input.len())))
                                .to_integer()
                            })
                            .collect()
                    })
                    .collect()
            })
            .collect();
        Self {
            tables,
            denominator,
        }
    }
    /// The integer score and per-language best alternative (index, matched).
    fn score(&self, candidate: &[char], languages: &[Language]) -> (BigUint, Vec<(usize, usize)>) {
        let mut sum = BigUint::zero();
        let mut best = Vec::with_capacity(languages.len());
        for (l, language) in languages.iter().enumerate() {
            let mut chosen = (0usize, 0usize);
            let mut chosen_value = BigUint::zero();
            for (a, input) in language.inputs.iter().enumerate() {
                let m = match_score(candidate, input).min(5);
                let value = &self.tables[l][a][m];
                if a == 0 || *value > chosen_value {
                    chosen = (a, m);
                    chosen_value = value.clone();
                }
            }
            sum += &chosen_value;
            best.push(chosen);
        }
        (sum, best)
    }
    fn rational(&self, value: &BigUint) -> Ratio<BigUint> {
        if self.denominator.is_zero() {
            Ratio::zero()
        } else {
            Ratio::new(value.clone(), self.denominator.clone())
        }
    }
}
/// One scored candidate: the integer score, the form, and the best alternative and match per language.
type Scored<'a> = (BigUint, &'a str, Vec<(usize, usize)>);
/// Runs the generator. The search is complete or refused; a window only limits the output.
pub fn generate_gismu(request: &GismuRequest) -> Result<GismuResult, BuilderError> {
    let languages = resolve_languages(&request.sources)?;
    let mut denominator_lcm = BigUint::one();
    for language in &languages {
        denominator_lcm = denominator_lcm.lcm(language.weight.denom());
        if denominator_lcm.bits() > 4096 {
            return Err(BuilderError::ResourceLimit {
                measure: "weight arithmetic bits".into(),
                value: denominator_lcm.bits(),
                limit: 4096,
            });
        }
    }
    let total: Ratio<BigUint> = languages
        .iter()
        .map(|l| l.weight.clone())
        .fold(Ratio::zero(), |a, b| a + b);
    if total.is_zero() {
        return Err(BuilderError::Invalid {
            message: "At least one language weight must be positive.".into(),
        });
    }
    for size in [total.numer().bits(), total.denom().bits()] {
        if size > 4096 {
            return Err(BuilderError::ResourceLimit {
                measure: "weight arithmetic bits".into(),
                value: size,
                limit: 4096,
            });
        }
    }
    if request.inventory.gismu.len() > 20_000 || request.inventory.claims.len() > 20_000 {
        return Err(BuilderError::ResourceLimit {
            measure: "inventory rows".into(),
            value: request
                .inventory
                .gismu
                .len()
                .max(request.inventory.claims.len()) as u64,
            limit: 20_000,
        });
    }
    let window = request.window.min(512);
    let inventory = generate_inventory(request.candidates, &languages);
    let letters: u64 = languages
        .iter()
        .flat_map(|l| l.inputs.iter().map(|i| i.len() as u64))
        .sum();
    let work = inventory.len() as u64 * letters.max(1);
    if work > request.limits.work.min(60_000_000) {
        return Err(BuilderError::ResourceLimit {
            measure: "candidates times input letters".into(),
            value: work,
            limit: request.limits.work.min(60_000_000),
        });
    }
    let scorer = Scorer::new(&languages);
    let mut scored: Vec<Scored<'_>> = inventory
        .iter()
        .map(|form| {
            let chars: Vec<char> = form.chars().collect();
            let (sum, best) = scorer.score(&chars, &languages);
            (sum, form.as_str(), best)
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1)));
    // Ranks: one plus the number of strictly greater scores.
    let mut ranks: Vec<u64> = Vec::with_capacity(scored.len());
    let mut greater = 0u64;
    let mut index = 0;
    while index < scored.len() {
        let mut end = index;
        while end < scored.len() && scored[end].0 == scored[index].0 {
            end += 1;
        }
        for _ in index..end {
            ranks.push(greater + 1);
        }
        greater += (end - index) as u64;
        index = end;
    }
    let conflicts = ConflictIndex::build(&request.inventory.gismu);
    let claims_by_rafsi: BTreeMap<&str, Vec<&InventoryClaim>> = request
        .inventory
        .claims
        .iter()
        .fold(BTreeMap::new(), |mut m, c| {
            m.entry(c.rafsi.as_str()).or_default().push(c);
            m
        });
    let describe =
        |form: &str, sum: &BigUint, best: &[(usize, usize)], rank: Option<u64>| -> GismuCandidate {
            let contributions = languages
                .iter()
                .enumerate()
                .map(|(l, language)| {
                    let (a, m) = best[l];
                    Contribution {
                        language: language.language.clone(),
                        input: language.inputs[a].iter().collect(),
                        matched: m,
                        length: language.inputs[a].len(),
                        weighted: calculated(&scorer.rational(&scorer.tables[l][a][m])),
                    }
                })
                .collect();
            let short_rafsi = possible_short_rafsi(form);
            let rafsi_conflicts = short_rafsi
                .iter()
                .flat_map(|r| {
                    claims_by_rafsi
                        .get(r.as_str())
                        .into_iter()
                        .flatten()
                        .map(move |c| RafsiConflict {
                            rafsi: r.clone(),
                            word: c.word.clone(),
                            spelling: c.spelling.clone(),
                            pair: c.pair.clone(),
                        })
                })
                .collect();
            GismuCandidate {
                form: form.to_owned(),
                score: calculated(&scorer.rational(sum)),
                rank,
                contributions,
                short_rafsi,
                conflicts: conflicts.conflicts(form),
                rafsi_conflicts,
            }
        };
    let candidates: Vec<GismuCandidate> = scored
        .iter()
        .zip(&ranks)
        .take(window)
        .map(|((sum, form, best), rank)| describe(form, sum, best, Some(*rank)))
        .collect();
    let mut diagnostics = Vec::new();
    let manual = match request
        .manual
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
    {
        None => None,
        Some(manual) => {
            let normalized = crate::phonotactics::normalize_word(manual);
            if normalized.is_none() {
                diagnostics.push("The manual form uses characters outside Lojban letters.".into());
            }
            if let Some(normalized) = normalized {
                if gismu_shape(&normalized).is_none() {
                    diagnostics.push(format!(
                        "\"{normalized}\" is not a gismu shape, so it has no generation score."
                    ));
                    None
                } else {
                    let chars: Vec<char> = normalized.chars().collect();
                    let (sum, best) = scorer.score(&chars, &languages);
                    let rank = scored
                        .iter()
                        .position(|(_, f, _)| *f == normalized)
                        .map(|i| ranks[i]);
                    if rank.is_none() {
                        diagnostics.push(format!("\"{normalized}\" is outside the generated inventory, so it has a score but no rank."));
                    }
                    Some(describe(&normalized, &sum, &best, rank))
                }
            } else {
                None
            }
        }
    };
    if request.inventory.snapshot.is_none() {
        diagnostics
            .push("No inventory snapshot was supplied. Conflict coverage is unknown.".into());
    }
    Ok(GismuResult {
        languages: languages
            .iter()
            .map(|l| ResolvedLanguage {
                language: l.language.clone(),
                weight: calculated(&l.weight),
                normalized: calculated(&(&l.weight / &total)),
                inputs: l.inputs.iter().map(|i| i.iter().collect()).collect(),
            })
            .collect(),
        considered: inventory.len() as u64,
        complete: true,
        candidates,
        manual,
        algorithm: Versioned {
            id: ALGORITHM_ID.into(),
            version: ALGORITHM_VERSION.into(),
        },
        parameters: Parameters {
            weighting: WEIGHTING.into(),
            matching: MATCHING.into(),
            transliteration: TRANSLITERATION.into(),
            candidates: match request.candidates {
                CandidateRecipe::SourceLetters => CANDIDATES_SOURCE_LETTERS.into(),
                CandidateRecipe::AllLetters => CANDIDATES_ALL_LETTERS.into(),
            },
            aggregation: AGGREGATION.into(),
        },
        diagnostics,
    })
}
/// Exact rational helper for callers that compare scores.
pub fn ratio_to_bigint(value: &Ratio<BigUint>) -> Ratio<BigInt> {
    Ratio::new(
        BigInt::from(value.numer().clone()),
        BigInt::from(value.denom().clone()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn chars(s: &str) -> Vec<char> {
        s.chars().collect()
    }
    fn row(language: &str, input: &str, n: u64, d: u64) -> SourceRow {
        SourceRow {
            language: language.into(),
            word: input.into(),
            input: Some(input.into()),
            weight: Some(json!({"numerator": n, "denominator": d})),
        }
    }
    #[test]
    fn scoring_uses_cll_lcs_rules() {
        assert_eq!(match_score(&chars("kanpe"), &chars("ekspekt")), 3);
        assert_eq!(match_score(&chars("kanpe"), &chars("uan")), 2);
        assert_eq!(match_score(&chars("kanpe"), &chars("na")), 0);
        assert_eq!(match_score(&chars("kanpe"), &chars("ap")), 0);
        assert_eq!(match_score(&chars("kanpe"), &chars("akp")), 2);
    }
    #[test]
    fn similar_consonants_are_directional() {
        assert!(too_similar_consonant('b', 'p'));
        assert!(too_similar_consonant('f', 'p'));
        assert!(!too_similar_consonant('b', 'f'));
        assert!(too_similar_consonant('p', 'f'));
        assert!(too_similar_consonant('m', 'n'));
        assert!(!too_similar_consonant('m', 'l'));
    }
    #[test]
    fn exact_scores_normalize_positive_weights_and_keep_zero_rows() {
        let request = GismuRequest {
            sources: vec![
                row("eng", "makrum", 2, 1),
                row("spa", "ongo", 1, 1),
                row("deu", "pilts", 0, 1),
            ],
            candidates: CandidateRecipe::SourceLetters,
            inventory: GismuInventory::default(),
            window: 8,
            manual: Some("makru".into()),
            limits: GismuLimits::default(),
        };
        let result = generate_gismu(&request).unwrap();
        assert_eq!(
            result.languages[0].normalized,
            Calculated {
                numerator: "2".into(),
                denominator: "3".into()
            }
        );
        assert_eq!(
            result.languages[2].normalized,
            Calculated {
                numerator: "0".into(),
                denominator: "1".into()
            }
        );
        assert!(result.complete);
        // makru: makrum matches 5 of 6 letters -> 5/6 * 2/3 = 5/9; ongo matches nothing; pilts has zero weight.
        let manual = result.manual.unwrap();
        assert_eq!(
            manual.score,
            Calculated {
                numerator: "5".into(),
                denominator: "9".into()
            }
        );
        assert_eq!(
            manual.contributions[2].weighted,
            Calculated {
                numerator: "0".into(),
                denominator: "1".into()
            }
        );
        assert_eq!(manual.contributions.len(), 3);
        assert!(manual.rank.is_some());
        // Ranks share on equal scores and are one plus the count of strictly greater scores.
        let ranks: Vec<u64> = result.candidates.iter().map(|c| c.rank.unwrap()).collect();
        assert_eq!(ranks[0], 1);
        for pair in result.candidates.windows(2) {
            if pair[0].score == pair[1].score {
                assert_eq!(pair[0].rank, pair[1].rank);
            } else {
                assert!(pair[1].rank.unwrap() > pair[0].rank.unwrap());
            }
        }
    }
    #[test]
    fn alternatives_share_a_weight_and_contribute_their_maximum() {
        let request = GismuRequest {
            sources: vec![
                row("eng", "mukrom", 1, 1),
                row("eng", "makrum", 1, 1),
                row("spa", "ongo", 1, 1),
            ],
            candidates: CandidateRecipe::SourceLetters,
            inventory: GismuInventory::default(),
            window: 4,
            manual: Some("makru".into()),
            limits: GismuLimits::default(),
        };
        let result = generate_gismu(&request).unwrap();
        assert_eq!(result.languages.len(), 2);
        let manual = result.manual.unwrap();
        // makru vs makrum: 5 of 6; vs mukrom: m, k, r = 3 of 6. The maximum 5/6 times the normalized weight 1/2 is 5/12.
        assert_eq!(manual.contributions[0].input, "makrum");
        assert_eq!(
            manual.contributions[0].weighted,
            Calculated {
                numerator: "5".into(),
                denominator: "12".into()
            }
        );
        let bad = GismuRequest {
            sources: vec![row("eng", "mukrom", 1, 1), row("eng", "makrum", 2, 1)],
            ..request.clone()
        };
        assert!(matches!(
            generate_gismu(&bad),
            Err(BuilderError::Invalid { .. })
        ));
        let zero = GismuRequest {
            sources: vec![row("eng", "mukrom", 0, 1)],
            ..request.clone()
        };
        assert!(matches!(
            generate_gismu(&zero),
            Err(BuilderError::Invalid { .. })
        ));
    }
    #[test]
    fn manual_form_outside_the_recipe_has_a_score_without_a_rank() {
        let request = GismuRequest {
            sources: vec![row("eng", "makrum", 1, 1)],
            candidates: CandidateRecipe::SourceLetters,
            inventory: GismuInventory::default(),
            window: 2,
            manual: Some("zbasu".into()),
            limits: GismuLimits::default(),
        };
        let result = generate_gismu(&request).unwrap();
        let manual = result.manual.unwrap();
        assert_eq!(manual.rank, None);
        assert!(
            result
                .diagnostics
                .iter()
                .any(|d| d.contains("outside the generated inventory"))
        );
    }
    #[test]
    fn conflicts_list_every_rule_and_every_competing_rafsi_claim() {
        let inventory = GismuInventory {
            snapshot: Some("sha256:x".into()),
            gismu: vec![
                InventoryGismu {
                    spelling: "klama".into(),
                    word: "w1".into(),
                },
                InventoryGismu {
                    spelling: "plami".into(),
                    word: "w2".into(),
                },
                InventoryGismu {
                    spelling: "klamu".into(),
                    word: "w3".into(),
                },
            ],
            claims: vec![
                InventoryClaim {
                    rafsi: "kla".into(),
                    word: "w1".into(),
                    spelling: "klama".into(),
                    pair: "p1".into(),
                },
                InventoryClaim {
                    rafsi: "kla".into(),
                    word: "w9".into(),
                    spelling: "klaku".into(),
                    pair: "p9".into(),
                },
            ],
        };
        let request = GismuRequest {
            sources: vec![row("eng", "come", 1, 1)],
            candidates: CandidateRecipe::AllLetters,
            inventory,
            window: 1,
            manual: Some("klama".into()),
            limits: GismuLimits::default(),
        };
        let result = generate_gismu(&request).unwrap();
        let manual = result.manual.unwrap();
        let rules: Vec<(String, String)> = manual
            .conflicts
            .iter()
            .map(|c| (c.spelling.clone(), c.rule.clone()))
            .collect();
        assert_eq!(
            rules,
            vec![
                ("klama".into(), "identical".into()),
                ("klamu".into(), "final-vowel".into())
            ]
        );
        assert_eq!(manual.rafsi_conflicts.len(), 2);
        let request = GismuRequest {
            manual: Some("glama".into()),
            ..request
        };
        let manual = generate_gismu(&request).unwrap().manual.unwrap();
        assert!(
            manual
                .conflicts
                .iter()
                .any(|c| c.spelling == "klama" && c.rule == "similar-consonant")
        );
        assert!(!manual.conflicts.iter().any(|c| c.spelling == "klamu"));
        assert!(!manual.conflicts.iter().any(|c| c.spelling == "plami"));
        let request = GismuRequest {
            manual: Some("plama".into()),
            ..request
        };
        let manual = generate_gismu(&request).unwrap().manual.unwrap();
        assert!(
            manual
                .conflicts
                .iter()
                .any(|c| c.spelling == "plami" && c.rule == "final-vowel")
        );
        assert!(
            !manual.conflicts.iter().any(|c| c.spelling == "klama"),
            "p and k are not similar consonants"
        );
    }
    #[test]
    fn work_limit_refuses_before_search() {
        let request = GismuRequest {
            sources: vec![row("eng", "bacdefgijklmnopr", 1, 1)],
            candidates: CandidateRecipe::AllLetters,
            inventory: GismuInventory::default(),
            window: 1,
            manual: None,
            limits: GismuLimits { work: 1000 },
        };
        assert!(matches!(
            generate_gismu(&request),
            Err(BuilderError::ResourceLimit { .. })
        ));
    }
    #[test]
    fn resource_bounds_precede_normalization_and_exact_arithmetic() {
        assert!(matches!(
            normalize_input(&"a".repeat(257)),
            Err(BuilderError::ResourceLimit { .. })
        ));
        let row = SourceRow {
            language: "eng".into(),
            word: "test".into(),
            input: Some("test".into()),
            weight: Some(serde_json::json!({"numerator":"1".repeat(65),"denominator":1})),
        };
        assert!(matches!(
            resolve_languages(&[row]),
            Err(BuilderError::ResourceLimit { .. })
        ));
        assert!(
            parse_rational(&serde_json::json!({"numerator":"1".repeat(65),"denominator":1}))
                .is_none()
        );
    }
}
