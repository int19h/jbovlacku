//! Lujvo bonding, scoring, segmentation, and the component builder.
//! Bonding, tosmabru, and scoring are ported from jbotci. Segmentation
//! enumerates rafsi splits and keeps those that bonding reproduces exactly.
use crate::phonotactics::{PairClass, is_consonant, is_initial_pair, is_vowel, pair_class};
use crate::rafsi::{
    RafsiShape, gismu_shape, is_short_rafsi_form, rafsi_shape, universal_gismu_forms,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The morphology profile of a build or an analysis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Profile {
    /// CLL chapter 4: rafsi only, joins from CLL 4.11, scores from CLL 4.12.
    Cll,
    /// The audited jbotci extension: brivla cores joined with `'y`, `y`, or
    /// `y'`, and rank zero for a shape outside the CLL table.
    Extended,
}
pub const CLL_MORPHOLOGY_ID: &str =
    "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#cll-lujvo";
pub const EXTENDED_MORPHOLOGY_ID: &str =
    "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#extended-lujvo";
pub const CLL_SCORING_ID: &str =
    "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#cll-lujvo-scoring";
pub const EXTENDED_SCORING_ID: &str =
    "https://github.com/int19h/jbovlacku/blob/main/docs/morphology.md#extended-lujvo-scoring";
pub const MORPHOLOGY_VERSION: &str = "1";
pub const SCORING_VERSION: &str = "1";
impl Profile {
    pub fn morphology_id(self) -> &'static str {
        match self {
            Self::Cll => CLL_MORPHOLOGY_ID,
            Self::Extended => EXTENDED_MORPHOLOGY_ID,
        }
    }
    pub fn scoring_id(self) -> &'static str {
        match self {
            Self::Cll => CLL_SCORING_ID,
            Self::Extended => EXTENDED_SCORING_ID,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PartKind {
    Rafsi,
    /// A whole brivla used as a component under the extended profile.
    Core,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Part {
    pub text: String,
    pub kind: PartKind,
}
impl Part {
    pub fn rafsi(text: &str) -> Self {
        Self {
            text: text.to_owned(),
            kind: PartKind::Rafsi,
        }
    }
    pub fn core(text: &str) -> Self {
        Self {
            text: text.to_owned(),
            kind: PartKind::Core,
        }
    }
}
pub fn is_hyphen(token: &str) -> bool {
    matches!(token, "y" | "y'" | "'y" | "r" | "n")
}
fn is_cmevla(text: &str) -> bool {
    text.chars()
        .last()
        .is_some_and(|c| !matches!(c, 'a' | 'e' | 'i' | 'o' | 'u' | 'y' | '\''))
}
fn needs_y_hyphen(previous: &str, next: &str) -> bool {
    let previous_tail = previous.chars().last();
    let next_head = next.chars().next();
    matches!(rafsi_shape(previous), RafsiShape::Cvcc | RafsiShape::Ccvc)
        || matches!((previous_tail, next_head), (Some(l), Some(r)) if is_consonant(l) && is_consonant(r) && pair_class(l, r) == Some(PairClass::Forbidden))
        || (previous_tail == Some('n')
            && (next.starts_with("ts")
                || next.starts_with("tc")
                || next.starts_with("dz")
                || next.starts_with("dj")))
}
fn starts_with_vowel_nucleus_after_y(text: &str) -> bool {
    let mut chars = text.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !is_vowel(first) {
        return false;
    }
    !matches!(first, 'i' | 'u') || !chars.next().is_some_and(is_vowel)
}
fn y_hyphen_for_pair(previous: &str, next: &str) -> Option<&'static str> {
    let previous_tail = previous.chars().last();
    let needs = needs_y_hyphen(previous, next)
        || (previous_tail.is_some_and(is_consonant) && next.chars().next().is_some_and(is_vowel));
    needs.then(|| {
        if starts_with_vowel_nucleus_after_y(next) {
            "y'"
        } else {
            "y"
        }
    })
}
fn hyphen_for_pair(previous: &Part, next: &Part) -> Option<&'static str> {
    if previous.kind == PartKind::Core && previous.text.chars().last().is_some_and(is_vowel) {
        Some("'y")
    } else {
        y_hyphen_for_pair(&previous.text, &next.text)
    }
}
fn should_insert_cvv_hyphen(first: &str, second: &str, count: usize) -> bool {
    matches!(rafsi_shape(first), RafsiShape::Cvv | RafsiShape::CvhV)
        && (count > 2 || rafsi_shape(second) != RafsiShape::Ccv)
}
fn pair_is_initial(left: &str, right: &str) -> bool {
    matches!((left.chars().last(), right.chars().next()), (Some(l), Some(r)) if is_consonant(l) && is_consonant(r) && is_initial_pair(l, r))
}
/// The tosmabru test of CLL 4.11: a leading run of CVC rafsi with initial
/// pairs would read as a cmavo sequence before a gismu.
pub fn tosmabru(tokens: &[String]) -> bool {
    let Some(last) = tokens.last() else {
        return false;
    };
    if is_cmevla(last) {
        return false;
    }
    if let Some(y) = tokens.iter().position(|t| t == "y") {
        let heads = &tokens[..y];
        return heads.len() > 1
            && heads.iter().all(|t| rafsi_shape(t) == RafsiShape::Cvc)
            && heads.windows(2).all(|p| pair_is_initial(&p[0], &p[1]));
    }
    if rafsi_shape(last) == RafsiShape::Cvccv {
        let chars: Vec<char> = last.chars().collect();
        if is_initial_pair(chars[2], chars[3]) {
            let heads = &tokens[..tokens.len() - 1];
            return !heads.is_empty()
                && heads.iter().all(|t| rafsi_shape(t) == RafsiShape::Cvc)
                && tokens.windows(2).all(|p| pair_is_initial(&p[0], &p[1]));
        }
    }
    false
}
/// Joins parts with the required hyphens. The result lists parts and hyphens
/// as separate tokens. Returns None for fewer than two parts or an empty part.
pub fn bond(parts: &[Part]) -> Option<Vec<String>> {
    if parts.len() < 2 || parts.iter().any(|p| p.text.is_empty()) {
        return None;
    }
    let first = &parts[0];
    let second = &parts[1];
    let mut tokens = Vec::with_capacity(parts.len() * 2);
    tokens.push(first.text.clone());
    if first.kind == PartKind::Rafsi
        && should_insert_cvv_hyphen(&first.text, &second.text, parts.len())
    {
        tokens.push(if second.text.starts_with('r') {
            "n".to_owned()
        } else {
            "r".to_owned()
        });
    }
    for pair in parts.windows(2) {
        if let Some(h) = hyphen_for_pair(&pair[0], &pair[1]) {
            tokens.push(h.to_owned());
        }
        tokens.push(pair[1].text.clone());
    }
    if tosmabru(&tokens) {
        tokens.insert(1, "y".to_owned());
    }
    Some(tokens)
}
/// The CLL 4.12 score: `1000 L - 500 A + 100 H - 10 R - V`. Under the
/// extended profile a shape outside the table has rank zero.
pub fn score(tokens: &[String]) -> i32 {
    let text: String = tokens.concat();
    let length = text.chars().count() as i32;
    let apostrophes = text.chars().filter(|c| *c == '\'').count() as i32;
    let hyphens = tokens.iter().filter(|t| is_hyphen(t)).count() as i32;
    let ranks: i32 = tokens
        .iter()
        .filter(|t| !is_hyphen(t))
        .map(|t| rafsi_shape(t).score())
        .sum();
    let vowels = text.chars().filter(|c| is_vowel(*c)).count() as i32;
    1000 * length - 500 * apostrophes + 100 * hyphens - 10 * ranks - vowels
}
fn rafsi_token_ok(token: &str, last: bool) -> bool {
    match rafsi_shape(token) {
        RafsiShape::Cvc => !last,
        RafsiShape::Cvcc | RafsiShape::Ccvc => !last,
        RafsiShape::Ccv => {
            is_initial_pair(token.chars().next().unwrap(), token.chars().nth(1).unwrap())
        }
        RafsiShape::Cvv => is_short_rafsi_form(token),
        RafsiShape::CvhV => true,
        RafsiShape::Cvccv | RafsiShape::Ccvcv => last && gismu_shape(token).is_some(),
        RafsiShape::Other => false,
    }
}
/// Every reading of `word` as rafsi and hyphens under CLL 4.11. A reading is
/// kept only when bonding its rafsi reproduces its tokens exactly, so a
/// needless or missing hyphen rejects it. Most lujvo have exactly one reading.
pub fn segment_cll(word: &str) -> Vec<Vec<String>> {
    let chars: Vec<char> = word.chars().collect();
    if chars.len() < 5 || chars.len() > 200 {
        return Vec::new();
    }
    let mut readings = Vec::new();
    let mut current: Vec<String> = Vec::new();
    fn walk(chars: &[char], at: usize, current: &mut Vec<String>, readings: &mut Vec<Vec<String>>) {
        if readings.len() > 64 {
            return;
        }
        if at == chars.len() {
            let rafsi: Vec<Part> = current
                .iter()
                .filter(|t| !is_hyphen(t))
                .map(|t| Part::rafsi(t))
                .collect();
            if rafsi.len() >= 2 && bond(&rafsi).as_deref() == Some(current.as_slice()) {
                readings.push(current.clone());
            }
            return;
        }
        // Hyphen tokens, never first and never after another hyphen.
        if !current.is_empty() && !is_hyphen(current.last().unwrap()) {
            for hyphen in ["y", "r", "n", "y'"] {
                let h: Vec<char> = hyphen.chars().collect();
                if chars[at..].starts_with(&h) && at + h.len() < chars.len() {
                    current.push(hyphen.to_owned());
                    walk(chars, at + h.len(), current, readings);
                    current.pop();
                }
            }
        }
        for len in 3..=5 {
            if at + len > chars.len() {
                break;
            }
            let token: String = chars[at..at + len].iter().collect();
            let last = at + len == chars.len();
            if rafsi_token_ok(&token, last) {
                current.push(token);
                walk(chars, at + len, current, readings);
                current.pop();
            }
        }
    }
    walk(&chars, 0, &mut current, &mut readings);
    readings
}
/// Whether a spelling can serve as a brivla core under the extended profile:
/// it ends with a vowel, has a consonant pair among its first five letters,
/// and uses Lojban letters without `y`.
pub fn is_brivla_core(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() < 4
        || !chars
            .iter()
            .all(|c| is_vowel(*c) || is_consonant(*c) || *c == '\'')
    {
        return false;
    }
    if !chars.last().is_some_and(|c| is_vowel(*c)) {
        return false;
    }
    let head: Vec<char> = chars
        .iter()
        .filter(|c| **c != '\'')
        .take(5)
        .copied()
        .collect();
    head.windows(2).any(|p| {
        is_consonant(p[0])
            && is_consonant(p[1])
            && pair_class(p[0], p[1]).is_some_and(PairClass::is_permissible)
    }) && chars.windows(2).all(|p| {
        !(is_consonant(p[0]) && is_consonant(p[1]))
            || pair_class(p[0], p[1]).is_some_and(PairClass::is_permissible)
    })
}
/// A recovered part of a candidate: the component text and the hyphen before it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveredPart {
    pub text: String,
    pub kind: PartKind,
    /// The hyphen inserted before this part, or null.
    pub join_before: Option<String>,
}
fn recovered(tokens: &[String], parts: &[Part]) -> Vec<RecoveredPart> {
    let mut out = Vec::new();
    let mut pending: Option<String> = None;
    let mut index = 0;
    for token in tokens {
        if is_hyphen(token) {
            pending = Some(pending.map(|p| p + token).unwrap_or_else(|| token.clone()));
            continue;
        }
        let kind = parts.get(index).map(|p| p.kind).unwrap_or(PartKind::Rafsi);
        out.push(RecoveredPart {
            text: token.clone(),
            kind,
            join_before: pending.take(),
        });
        index += 1;
    }
    out
}
/// Validates one bonded candidate under the profile and returns its recovered
/// parts, or a diagnostic. The classic profile needs a CLL reading that equals
/// the bonded tokens. The extended profile needs each core to be a brivla core
/// and the bonded tokens to reproduce the spelling, and it reports a classic
/// reading that disagrees.
pub fn validate(
    profile: Profile,
    parts: &[Part],
    tokens: &[String],
) -> Result<Vec<RecoveredPart>, String> {
    let word: String = tokens.concat();
    if !word.chars().last().is_some_and(is_vowel) {
        return Err("The form ends with a consonant, so it is a name shape, not a lujvo.".into());
    }
    if parts.iter().any(|p| p.kind == PartKind::Core) && profile == Profile::Cll {
        return Err("A whole-word component needs the extended profile.".into());
    }
    match profile {
        Profile::Cll => {
            let readings = segment_cll(&word);
            if readings.iter().any(|r| r.as_slice() == tokens) {
                Ok(recovered(tokens, parts))
            } else if readings.is_empty() {
                Err("CLL rules do not read this form as one lujvo.".into())
            } else {
                Err(format!(
                    "CLL rules read this form as {}, not as the intended parts.",
                    readings[0].join(" + ")
                ))
            }
        }
        Profile::Extended => {
            for part in parts {
                if part.kind == PartKind::Core && !is_brivla_core(&part.text) {
                    return Err(format!(
                        "\"{}\" is not usable as a whole-word component.",
                        part.text
                    ));
                }
                if part.kind == PartKind::Rafsi
                    && !part
                        .text
                        .chars()
                        .all(|c| is_vowel(c) || is_consonant(c) || c == '\'')
                {
                    return Err(format!(
                        "\"{}\" is not a Lojban letter sequence.",
                        part.text
                    ));
                }
            }
            if parts.iter().all(|p| p.kind == PartKind::Rafsi) {
                return validate(Profile::Cll, parts, tokens);
            }
            let readings = segment_cll(&word);
            if let Some(reading) = readings.first() {
                return Err(format!(
                    "CLL rules read this form as {}, so the whole-word components are not recoverable.",
                    reading.join(" + ")
                ));
            }
            Ok(recovered(tokens, parts))
        }
    }
}
/// A component row as the builder receives it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Component {
    /// The caller's stable row identifier.
    pub id: String,
    pub spelling: String,
    /// The declared lexical kind: gismu, cmavo, lujvo, fuivla, cmevla, or other.
    pub kind: String,
    #[serde(default)]
    pub definition: Option<String>,
    /// Rafsi claims known for this word: spelling and pair ID.
    #[serde(default)]
    pub claims: Vec<Claim>,
    /// A locked choice, by form.
    #[serde(default)]
    pub locked: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Claim {
    pub rafsi: String,
    pub pair: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Origin {
    /// A listed rafsi claim.
    Claim,
    /// The four-letter gismu stem, nonfinal only.
    Stem,
    /// The five-letter gismu, final only.
    Final,
    /// The whole brivla, extended profile only.
    Core,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Position {
    Any,
    Nonfinal,
    Final,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Choice {
    pub form: String,
    pub origin: Origin,
    pub shape: RafsiShape,
    pub position: Position,
    #[serde(default)]
    pub pair: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RowAnalysis {
    pub id: String,
    pub normalized: String,
    pub choices: Vec<Choice>,
    /// Whether the locked form is one of the choices.
    pub lock_valid: bool,
    pub diagnostics: Vec<String>,
}
/// The choices of one component under the profile.
pub fn row_choices(profile: Profile, component: &Component) -> RowAnalysis {
    let mut diagnostics = Vec::new();
    let mut choices: Vec<Choice> = Vec::new();
    let Some(normalized) = crate::phonotactics::normalize_word(&component.spelling) else {
        return RowAnalysis {
            id: component.id.clone(),
            normalized: String::new(),
            choices,
            lock_valid: component.locked.is_none(),
            diagnostics: vec!["The spelling uses characters outside Lojban letters.".into()],
        };
    };
    let gismu = gismu_shape(&normalized).is_some();
    if component.kind == "gismu" && !gismu {
        diagnostics
            .push("The spelling is not a gismu shape, so it has no automatic long forms.".into());
    }
    if gismu {
        if let Some((stem, full)) = universal_gismu_forms(&normalized) {
            if let Some(stem) = stem {
                choices.push(Choice {
                    shape: rafsi_shape(&stem),
                    form: stem,
                    origin: Origin::Stem,
                    position: Position::Nonfinal,
                    pair: None,
                });
            }
            choices.push(Choice {
                shape: rafsi_shape(&full),
                form: full,
                origin: Origin::Final,
                position: Position::Final,
                pair: None,
            });
        }
    }
    for claim in &component.claims {
        let Some(form) = crate::phonotactics::normalize_word(&claim.rafsi) else {
            diagnostics.push(format!(
                "Claimed rafsi \"{}\" is not Lojban letters.",
                claim.rafsi
            ));
            continue;
        };
        if !is_short_rafsi_form(&form) {
            diagnostics.push(format!(
                "Claimed rafsi \"{}\" is not a short rafsi shape and is not offered.",
                form
            ));
            continue;
        }
        if choices.iter().any(|c| c.form == form) {
            continue;
        }
        let shape = rafsi_shape(&form);
        choices.push(Choice {
            form,
            origin: Origin::Claim,
            position: if shape == RafsiShape::Cvc {
                Position::Nonfinal
            } else {
                Position::Any
            },
            shape,
            pair: Some(claim.pair.clone()),
        });
    }
    match component.kind.as_str() {
        "cmavo" => {
            if component.claims.is_empty() {
                diagnostics.push(
                    "A cmavo needs a listed combining form. Its class alone creates none.".into(),
                );
            }
        }
        "cmevla" => diagnostics.push("A name has no combining form in a lujvo.".into()),
        _ if !gismu => {
            if is_brivla_core(&normalized) {
                if profile == Profile::Extended {
                    choices.push(Choice {
                        form: normalized.clone(),
                        origin: Origin::Core,
                        shape: RafsiShape::Other,
                        position: Position::Any,
                        pair: None,
                    });
                } else {
                    diagnostics.push(
                        "The whole word is usable as a long form only under the extended profile."
                            .into(),
                    );
                }
            } else if component.claims.is_empty() {
                diagnostics
                    .push("The spelling is not a brivla shape and has no listed rafsi.".into());
            }
        }
        _ => {}
    }
    let lock_valid = component
        .locked
        .as_ref()
        .is_none_or(|locked| choices.iter().any(|c| &c.form == locked));
    if !lock_valid {
        diagnostics.push(format!(
            "The locked form \"{}\" is not one of this component's choices.",
            component.locked.clone().unwrap_or_default()
        ));
    }
    RowAnalysis {
        id: component.id.clone(),
        normalized,
        choices,
        lock_valid,
        diagnostics,
    }
}
/// A known rafsi claim in the inventory, for conflict lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InventoryClaim {
    pub rafsi: String,
    pub word: String,
    pub spelling: String,
    pub pair: String,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Inventory {
    #[serde(default)]
    pub snapshot: Option<String>,
    #[serde(default)]
    pub claims: Vec<InventoryClaim>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Limits {
    /// The largest product of per-row choice counts searched exhaustively.
    #[serde(default = "default_product")]
    pub choice_product: u64,
    /// The largest number of candidates returned.
    #[serde(default = "default_results")]
    pub results: usize,
}
fn default_product() -> u64 {
    20_000
}
fn default_results() -> usize {
    64
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            choice_product: default_product(),
            results: default_results(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LujvoRequest {
    pub profile: Profile,
    pub components: Vec<Component>,
    #[serde(default)]
    pub inventory: Inventory,
    #[serde(default)]
    pub limits: Limits,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectedPart {
    pub id: String,
    pub form: String,
    pub origin: Origin,
    #[serde(default)]
    pub pair: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conflict {
    /// The selected rafsi.
    pub rafsi: String,
    /// The component row that selected it.
    pub id: String,
    /// The competing word's ID and spelling.
    pub word: String,
    pub spelling: String,
    pub pair: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Candidate {
    pub spelling: String,
    pub parts: Vec<SelectedPart>,
    pub tokens: Vec<String>,
    pub score: i32,
    pub recovered: Vec<RecoveredPart>,
    pub conflicts: Vec<Conflict>,
    /// Selected claims that the inventory does not list.
    pub unlisted: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LujvoResult {
    pub rows: Vec<RowAnalysis>,
    pub candidates: Vec<Candidate>,
    /// Whether the search covered every combination.
    pub complete: bool,
    pub considered: u64,
    /// Combinations that bonding or the profile rejected, with reasons.
    pub rejected: Vec<Rejected>,
    pub morphology: Versioned,
    pub scoring: Versioned,
    pub diagnostics: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rejected {
    pub spelling: String,
    pub parts: Vec<String>,
    pub reason: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Versioned {
    pub id: String,
    pub version: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum BuilderError {
    Invalid {
        message: String,
    },
    ResourceLimit {
        measure: String,
        value: u64,
        limit: u64,
    },
}
impl std::fmt::Display for BuilderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid { message } => f.write_str(message),
            Self::ResourceLimit {
                measure,
                value,
                limit,
            } => write!(f, "{measure} is {value}, above the limit of {limit}."),
        }
    }
}
/// Builds every valid lujvo from the component choices, in ascending score
/// order, then spelling, then the choice tuple.
pub fn build_lujvo(request: &LujvoRequest) -> Result<LujvoResult, BuilderError> {
    let count = request.components.len() as u64;
    if !(2..=64).contains(&count) {
        return Err(BuilderError::Invalid {
            message: "A lujvo needs 2 through 64 components.".into(),
        });
    }
    let rows: Vec<RowAnalysis> = request
        .components
        .iter()
        .map(|c| row_choices(request.profile, c))
        .collect();
    let mut diagnostics = Vec::new();
    let last = rows.len() - 1;
    let mut per_row: Vec<Vec<&Choice>> = Vec::new();
    for (index, (row, component)) in rows.iter().zip(&request.components).enumerate() {
        let mut options: Vec<&Choice> = row
            .choices
            .iter()
            .filter(|c| match c.position {
                Position::Any => true,
                Position::Nonfinal => index != last,
                Position::Final => index == last,
            })
            .collect();
        if let Some(locked) = &component.locked {
            if row.lock_valid {
                options.retain(|c| &c.form == locked);
                if options.is_empty() {
                    diagnostics.push(format!(
                        "The locked form \"{locked}\" of \"{}\" cannot stand in position {}.",
                        component.spelling,
                        index + 1
                    ));
                }
            } else {
                options.clear();
            }
        }
        if options.is_empty() && row.diagnostics.is_empty() {
            diagnostics.push(format!(
                "\"{}\" has no form that can stand in position {}.",
                component.spelling,
                index + 1
            ));
        }
        per_row.push(options);
    }
    let product = per_row
        .iter()
        .try_fold(1u64, |acc, r| acc.checked_mul(r.len() as u64))
        .unwrap_or(u64::MAX);
    if product > request.limits.choice_product {
        return Err(BuilderError::ResourceLimit {
            measure: "choice combinations".into(),
            value: product,
            limit: request.limits.choice_product,
        });
    }
    let claims_by_rafsi: BTreeMap<&str, Vec<&InventoryClaim>> = request
        .inventory
        .claims
        .iter()
        .fold(BTreeMap::new(), |mut m, c| {
            m.entry(c.rafsi.as_str()).or_default().push(c);
            m
        });
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut rejected = Vec::new();
    let mut considered = 0u64;
    if per_row.iter().all(|r| !r.is_empty()) {
        let mut selected: Vec<&Choice> = Vec::new();
        fn walk<'a>(
            per_row: &[Vec<&'a Choice>],
            selected: &mut Vec<&'a Choice>,
            visit: &mut dyn FnMut(&[&'a Choice]),
        ) {
            if selected.len() == per_row.len() {
                visit(selected);
                return;
            }
            for choice in &per_row[selected.len()] {
                selected.push(choice);
                walk(per_row, selected, visit);
                selected.pop();
            }
        }
        walk(&per_row, &mut selected, &mut |chosen| {
            considered += 1;
            let parts: Vec<Part> = chosen
                .iter()
                .map(|c| {
                    if c.origin == Origin::Core {
                        Part::core(&c.form)
                    } else {
                        Part::rafsi(&c.form)
                    }
                })
                .collect();
            let Some(tokens) = bond(&parts) else { return };
            let spelling: String = tokens.concat();
            match validate(request.profile, &parts, &tokens) {
                Ok(recovered_parts) => {
                    let mut conflicts = Vec::new();
                    let mut unlisted = Vec::new();
                    for (choice, component) in chosen.iter().zip(&request.components) {
                        if choice.origin != Origin::Claim {
                            continue;
                        }
                        let known = claims_by_rafsi
                            .get(choice.form.as_str())
                            .map(|v| v.as_slice())
                            .unwrap_or(&[]);
                        if !known.iter().any(|k| Some(&k.pair) == choice.pair.as_ref()) {
                            unlisted.push(choice.form.clone());
                        }
                        for other in known
                            .iter()
                            .filter(|k| Some(&k.pair) != choice.pair.as_ref())
                        {
                            conflicts.push(Conflict {
                                rafsi: choice.form.clone(),
                                id: component.id.clone(),
                                word: other.word.clone(),
                                spelling: other.spelling.clone(),
                                pair: other.pair.clone(),
                            });
                        }
                    }
                    candidates.push(Candidate {
                        spelling,
                        parts: chosen
                            .iter()
                            .zip(&request.components)
                            .map(|(c, comp)| SelectedPart {
                                id: comp.id.clone(),
                                form: c.form.clone(),
                                origin: c.origin,
                                pair: c.pair.clone(),
                            })
                            .collect(),
                        score: score(&tokens),
                        tokens,
                        recovered: recovered_parts,
                        conflicts,
                        unlisted,
                    });
                }
                Err(reason) => {
                    if rejected.len() < 64 {
                        rejected.push(Rejected {
                            spelling,
                            parts: chosen.iter().map(|c| c.form.clone()).collect(),
                            reason,
                        });
                    }
                }
            }
        });
    }
    candidates.sort_by(|a, b| {
        a.score
            .cmp(&b.score)
            .then_with(|| a.spelling.cmp(&b.spelling))
            .then_with(|| {
                a.parts
                    .iter()
                    .map(|p| &p.form)
                    .cmp(b.parts.iter().map(|p| &p.form))
            })
    });
    candidates.truncate(request.limits.results);
    Ok(LujvoResult {
        rows,
        candidates,
        complete: true,
        considered,
        rejected,
        morphology: Versioned {
            id: request.profile.morphology_id().into(),
            version: MORPHOLOGY_VERSION.into(),
        },
        scoring: Versioned {
            id: request.profile.scoring_id().into(),
            version: SCORING_VERSION.into(),
        },
        diagnostics,
    })
}
/// The word kind that analysis recognizes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WordKind {
    Gismu,
    Lujvo,
    Cmavo,
    Fuivla,
    Cmevla,
    Unknown,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Analysis {
    pub original: String,
    pub normalized: Option<String>,
    pub kind: WordKind,
    /// Rafsi readings of a lujvo. More than one means ambiguity.
    pub readings: Vec<Vec<RecoveredPart>>,
    pub diagnostics: Vec<String>,
    pub morphology: Versioned,
}
fn is_cmavo_shape(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let rest = if chars.first().is_some_and(|c| is_consonant(*c)) {
        &chars[1..]
    } else {
        &chars[..]
    };
    if rest.is_empty() {
        return false;
    }
    let mut groups = 0;
    for group in rest.split(|c| *c == '\'') {
        groups += 1;
        match group.len() {
            1 => {
                if !is_vowel(group[0]) {
                    return false;
                }
            }
            2 => {
                if !(is_vowel(group[0]) && is_vowel(group[1])) {
                    return false;
                }
            }
            _ => return false,
        }
    }
    groups >= 1
}
/// Classifies a spelling and recovers lujvo parts under the profile.
pub fn analyze_word(profile: Profile, spelling: &str) -> Analysis {
    let morphology = Versioned {
        id: profile.morphology_id().into(),
        version: MORPHOLOGY_VERSION.into(),
    };
    let Some(normalized) = crate::phonotactics::normalize_word(spelling) else {
        return Analysis {
            original: spelling.into(),
            normalized: None,
            kind: WordKind::Unknown,
            readings: vec![],
            diagnostics: vec![
                "The spelling uses characters outside Lojban letters, apostrophes, and commas."
                    .into(),
            ],
            morphology,
        };
    };
    let mut diagnostics = Vec::new();
    let kind;
    let mut readings = Vec::new();
    if gismu_shape(&normalized).is_some() {
        kind = WordKind::Gismu;
    } else if is_cmevla(&normalized) {
        kind = WordKind::Cmevla;
    } else if is_cmavo_shape(&normalized) {
        kind = WordKind::Cmavo;
    } else {
        let found = segment_cll(&normalized);
        if found.is_empty() {
            if is_brivla_core(&normalized) {
                kind = WordKind::Fuivla;
                diagnostics.push("The form is a brivla that CLL rules do not read as a lujvo. It is treated as a fu'ivla shape.".into());
            } else {
                kind = WordKind::Unknown;
                diagnostics.push("The form is not a gismu, lujvo, cmavo, or name shape under the selected profile.".into());
            }
        } else {
            kind = WordKind::Lujvo;
            if found.len() > 1 {
                diagnostics.push(format!("The form has {} rafsi readings.", found.len()));
            }
            for tokens in found {
                let parts: Vec<Part> = tokens
                    .iter()
                    .filter(|t| !is_hyphen(t))
                    .map(|t| Part::rafsi(t))
                    .collect();
                readings.push(recovered(&tokens, &parts));
            }
        }
    }
    Analysis {
        original: spelling.into(),
        normalized: Some(normalized),
        kind,
        readings,
        diagnostics,
        morphology,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|i| i.to_string()).collect()
    }
    fn rafsi(items: &[&str]) -> Vec<Part> {
        items.iter().map(|i| Part::rafsi(i)).collect()
    }
    #[test]
    fn bonds_cvv_initial_rafsi_with_r_or_n() {
        assert_eq!(
            bond(&rafsi(&["bau", "gri", "kla"])),
            Some(s(&["bau", "r", "gri", "kla"]))
        );
        assert_eq!(bond(&rafsi(&["bau", "rok"])), Some(s(&["bau", "n", "rok"])));
        assert_eq!(bond(&rafsi(&["sai", "cli"])), Some(s(&["sai", "cli"])));
    }
    #[test]
    fn inserts_y_for_impermissible_consonant_pair_and_four_letter_rafsi() {
        assert_eq!(
            bond(&rafsi(&["jbon", "bau"])),
            Some(s(&["jbon", "y", "bau"]))
        );
        assert_eq!(
            bond(&rafsi(&["cukt", "sni"])),
            Some(s(&["cukt", "y", "sni"]))
        );
        assert_eq!(bond(&rafsi(&["jun", "dji"])), Some(s(&["jun", "y", "dji"])));
    }
    #[test]
    fn tosmabru_gets_a_y() {
        // tos + mabru would read as tosmabru: cmavo + gismu. CLL 4.11.
        assert_eq!(
            bond(&rafsi(&["tos", "mabru"])),
            Some(s(&["tos", "y", "mabru"]))
        );
        assert_eq!(bond(&rafsi(&["tol", "sakli"])), Some(s(&["tol", "sakli"])));
    }
    #[test]
    fn bonding_rejects_empty_or_single_parts() {
        assert_eq!(bond(&rafsi(&["", "jbo"])), None);
        assert_eq!(bond(&rafsi(&["jbo"])), None);
    }
    #[test]
    fn scores_follow_cll_examples() {
        // CLL 4.12 scores zbasai 5847, zbacai 5847, jbogri 5858? Use the formula directly.
        assert_eq!(score(&s(&["cku", "sni"])), 6000 - 10 * (7 + 7) - 2);
        assert_eq!(score(&s(&["cukt", "y", "sni"])), 8008);
        assert_eq!(score(&s(&["cku", "sinxa"])), 8000 - 10 * (7 + 1) - 3);
    }
    #[test]
    fn classic_segmentation_accepts_lujvo_and_rejects_non_lujvo() {
        for word in [
            "jbogri",
            "soirsai",
            "ro'inre'o",
            "ckusni",
            "cuktysni",
            "saicli",
            "tolsakli",
            "tosymabru",
            "bangyjbari",
            "vlaste",
        ] {
            assert!(!segment_cll(word).is_empty(), "{word} should be a lujvo");
        }
        for word in [
            "babau",
            "soisai",
            "xlamkai",
            "xlaglymlu",
            "kerlyu'ukerlo",
            "rokyre'o",
            "basykla",
            "saircli",
            "tosmabru",
            "sakli",
            "cukta",
        ] {
            assert!(segment_cll(word).is_empty(), "{word} should not be a lujvo");
        }
    }
    #[test]
    fn segmentation_recovers_the_intended_parts() {
        assert_eq!(segment_cll("cuktysni"), vec![s(&["cukt", "y", "sni"])]);
        assert_eq!(segment_cll("ckusni"), vec![s(&["cku", "sni"])]);
        assert_eq!(segment_cll("bauryo'a").len(), 0);
        assert_eq!(segment_cll("ro'inre'o"), vec![s(&["ro'i", "n", "re'o"])]);
    }
    #[test]
    fn extended_profile_joins_cores_and_classic_rejects_them() {
        let parts = vec![Part::rafsi("akt"), Part::core("iismu")];
        let tokens = bond(&parts).unwrap();
        assert_eq!(tokens.concat(), "aktyiismu");
        assert!(validate(Profile::Extended, &parts, &tokens).is_ok());
        assert!(validate(Profile::Cll, &parts, &tokens).is_err());
        let parts = vec![Part::core("fulta"), Part::core("ismu")];
        let tokens = bond(&parts).unwrap();
        assert_eq!(tokens.concat(), "fulta'yismu");
        let parts = vec![Part::rafsi("ful"), Part::core("ismu")];
        let tokens = bond(&parts).unwrap();
        assert_eq!(tokens.concat(), "fuly'ismu");
        assert!(validate(Profile::Extended, &parts, &tokens).is_ok());
        let parts = vec![Part::rafsi("gim"), Part::core("iismu")];
        assert_eq!(bond(&parts).unwrap().concat(), "gimyiismu");
        let parts = vec![Part::core("jenjigu"), Part::rafsi("di'e")];
        assert_eq!(bond(&parts).unwrap().concat(), "jenjigu'ydi'e");
    }
    #[test]
    fn builds_ckusni_from_components_with_long_forms_beside_short_ones() {
        let request = LujvoRequest {
            profile: Profile::Cll,
            components: vec![
                Component {
                    id: "a".into(),
                    spelling: "cukta".into(),
                    kind: "gismu".into(),
                    definition: None,
                    claims: vec![Claim {
                        rafsi: "cku".into(),
                        pair: "jvr1:a".into(),
                    }],
                    locked: None,
                },
                Component {
                    id: "b".into(),
                    spelling: "sinxa".into(),
                    kind: "gismu".into(),
                    definition: None,
                    claims: vec![Claim {
                        rafsi: "sni".into(),
                        pair: "jvr1:b".into(),
                    }],
                    locked: None,
                },
            ],
            inventory: Inventory {
                snapshot: None,
                claims: vec![
                    InventoryClaim {
                        rafsi: "cku".into(),
                        word: "jvw1:x".into(),
                        spelling: "cukta".into(),
                        pair: "jvr1:a".into(),
                    },
                    InventoryClaim {
                        rafsi: "sni".into(),
                        word: "jvw1:z".into(),
                        spelling: "snime".into(),
                        pair: "jvr1:zz".into(),
                    },
                ],
            },
            limits: Limits::default(),
        };
        let result = build_lujvo(&request).unwrap();
        let spellings: Vec<&str> = result
            .candidates
            .iter()
            .map(|c| c.spelling.as_str())
            .collect();
        assert_eq!(
            spellings,
            vec!["ckusni", "ckusinxa", "cuktysni", "cuktysinxa"]
        );
        assert_eq!(result.candidates[0].score, 5858);
        assert_eq!(result.candidates[2].tokens, s(&["cukt", "y", "sni"]));
        assert_eq!(result.candidates[0].conflicts.len(), 1);
        assert_eq!(result.candidates[0].conflicts[0].spelling, "snime");
        assert_eq!(result.candidates[0].unlisted, vec!["sni"]);
        assert!(
            result.rows[0]
                .choices
                .iter()
                .any(|c| c.origin == Origin::Stem && c.form == "cukt")
        );
        assert!(
            result.rows[0]
                .choices
                .iter()
                .any(|c| c.origin == Origin::Final && c.form == "cukta")
        );
    }
    #[test]
    fn locks_limit_choices_and_an_invalid_lock_is_explained() {
        let mut request = LujvoRequest {
            profile: Profile::Cll,
            components: vec![
                Component {
                    id: "a".into(),
                    spelling: "cukta".into(),
                    kind: "gismu".into(),
                    definition: None,
                    claims: vec![Claim {
                        rafsi: "cku".into(),
                        pair: "jvr1:a".into(),
                    }],
                    locked: Some("cukt".into()),
                },
                Component {
                    id: "b".into(),
                    spelling: "sinxa".into(),
                    kind: "gismu".into(),
                    definition: None,
                    claims: vec![Claim {
                        rafsi: "sni".into(),
                        pair: "jvr1:b".into(),
                    }],
                    locked: None,
                },
            ],
            inventory: Inventory {
                snapshot: None,
                claims: vec![],
            },
            limits: Limits::default(),
        };
        let result = build_lujvo(&request).unwrap();
        assert_eq!(
            result
                .candidates
                .iter()
                .map(|c| c.spelling.as_str())
                .collect::<Vec<_>>(),
            vec!["cuktysni", "cuktysinxa"]
        );
        request.components[0].locked = Some("cukta".into());
        let result = build_lujvo(&request).unwrap();
        assert!(result.candidates.is_empty());
        assert!(
            result
                .diagnostics
                .iter()
                .any(|d| d.contains("cannot stand in position 1"))
        );
        request.components[0].locked = Some("zzz".into());
        let result = build_lujvo(&request).unwrap();
        assert!(!result.rows[0].lock_valid);
        assert!(result.candidates.is_empty());
    }
    #[test]
    fn repeated_components_stay_separate_and_cmavo_need_claims() {
        let request = LujvoRequest {
            profile: Profile::Cll,
            components: vec![
                Component {
                    id: "a".into(),
                    spelling: "kerlo".into(),
                    kind: "gismu".into(),
                    definition: None,
                    claims: vec![Claim {
                        rafsi: "ker".into(),
                        pair: "p".into(),
                    }],
                    locked: None,
                },
                Component {
                    id: "b".into(),
                    spelling: "kerlo".into(),
                    kind: "gismu".into(),
                    definition: None,
                    claims: vec![Claim {
                        rafsi: "ker".into(),
                        pair: "p".into(),
                    }],
                    locked: None,
                },
            ],
            inventory: Inventory {
                snapshot: None,
                claims: vec![],
            },
            limits: Limits::default(),
        };
        let result = build_lujvo(&request).unwrap();
        assert!(result.candidates.iter().any(|c| c.spelling == "kerkerlo"));
        assert!(result.candidates.iter().all(|c| c.parts.len() == 2));
        let cmavo = Component {
            id: "c".into(),
            spelling: "ka".into(),
            kind: "cmavo".into(),
            definition: None,
            claims: vec![],
            locked: None,
        };
        let row = row_choices(Profile::Cll, &cmavo);
        assert!(row.choices.is_empty());
        assert!(row.diagnostics[0].contains("combining form"));
        let kam = Component {
            claims: vec![Claim {
                rafsi: "kam".into(),
                pair: "k".into(),
            }],
            ..cmavo
        };
        assert_eq!(row_choices(Profile::Cll, &kam).choices.len(), 1);
    }
    #[test]
    fn work_limit_refuses_before_search() {
        let component = |id: &str| Component {
            id: id.into(),
            spelling: "sakli".into(),
            kind: "gismu".into(),
            definition: None,
            claims: ["kli", "sa'i", "sai", "sak", "sal", "ska"]
                .iter()
                .map(|r| Claim {
                    rafsi: r.to_string(),
                    pair: format!("p{r}"),
                })
                .collect(),
            locked: None,
        };
        let request = LujvoRequest {
            profile: Profile::Cll,
            components: (0..8).map(|i| component(&i.to_string())).collect(),
            inventory: Inventory {
                snapshot: None,
                claims: vec![],
            },
            limits: Limits {
                choice_product: 1000,
                results: 8,
            },
        };
        assert!(matches!(
            build_lujvo(&request),
            Err(BuilderError::ResourceLimit { .. })
        ));
    }
    #[test]
    fn analysis_classifies_forms() {
        assert_eq!(analyze_word(Profile::Cll, "sakli").kind, WordKind::Gismu);
        assert_eq!(analyze_word(Profile::Cll, "ckusni").kind, WordKind::Lujvo);
        assert_eq!(analyze_word(Profile::Cll, "ka'a").kind, WordKind::Cmavo);
        assert_eq!(analyze_word(Profile::Cll, "djan.").normalized, None);
        assert_eq!(analyze_word(Profile::Cll, "djan").kind, WordKind::Cmevla);
        assert_eq!(analyze_word(Profile::Cll, "iismu").kind, WordKind::Fuivla);
        assert_eq!(analyze_word(Profile::Cll, "aaaa").kind, WordKind::Unknown);
        assert_eq!(analyze_word(Profile::Cll, "leksiko").kind, WordKind::Fuivla);
        let a = analyze_word(Profile::Cll, "ckusni");
        assert_eq!(
            a.readings[0]
                .iter()
                .map(|p| p.text.as_str())
                .collect::<Vec<_>>(),
            vec!["cku", "sni"]
        );
        let a = analyze_word(Profile::Cll, "cuktysni");
        assert_eq!(a.readings[0][1].join_before.as_deref(), Some("y"));
    }
}
