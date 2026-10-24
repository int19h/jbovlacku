//! Lujvo bonding, scoring, segmentation, and the component builder.
//! Bonding, tosmabru, and scoring are ported from jbotci. Segmentation
//! uses the pinned recognizer and compares parsed parts with intended parts.
use crate::detail_budget::DetailBudget;
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
pub const MORPHOLOGY_VERSION: &str = "2";
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
    matches!(token, "y" | "y'" | "'y" | "'y'" | "r" | "n")
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
    if !(2..=64).contains(&parts.len())
        || parts
            .iter()
            .any(|p| p.text.is_empty() || p.text.len() > 128)
    {
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
pub fn score(tokens: &[String]) -> Result<i32, BuilderError> {
    require_limit("score tokens", tokens.len() as u64, 128)?;
    let length: usize = tokens
        .iter()
        .try_fold(0usize, |sum, t| sum.checked_add(t.len()))
        .ok_or_else(|| {
            resource(
                "score bytes",
                u64::MAX,
                crate::recognize::MAX_WORD_BYTES as u64,
            )
        })?;
    require_limit(
        "score bytes",
        length as u64,
        crate::recognize::MAX_WORD_BYTES as u64,
    )?;
    let text: String = tokens.concat();
    let apostrophes = text.chars().filter(|c| *c == '\'').count() as i32;
    let hyphens = tokens.iter().filter(|t| is_hyphen(t)).count() as i32;
    let ranks: i32 = tokens
        .iter()
        .filter(|t| !is_hyphen(t))
        .map(|t| rafsi_shape(t).score())
        .sum();
    let vowels = text.chars().filter(|c| is_vowel(*c)).count() as i32;
    Ok(
        1000 * text.chars().count() as i32 - 500 * apostrophes + 100 * hyphens
            - 10 * ranks
            - vowels,
    )
}
fn resource(measure: &str, value: u64, limit: u64) -> BuilderError {
    BuilderError::ResourceLimit {
        measure: measure.into(),
        value,
        limit,
    }
}
fn require_limit(measure: &str, value: u64, limit: u64) -> Result<(), BuilderError> {
    if value > limit {
        Err(resource(measure, value, limit))
    } else {
        Ok(())
    }
}
fn rafsi_token_ok(token: &str, last: bool) -> bool {
    match rafsi_shape(token) {
        RafsiShape::Cvc => !last,
        RafsiShape::Cvcc => {
            !last
                && crate::phonotactics::is_permissible_pair(
                    token.as_bytes()[2] as char,
                    token.as_bytes()[3] as char,
                )
        }
        RafsiShape::Ccvc => {
            !last && is_initial_pair(token.as_bytes()[0] as char, token.as_bytes()[1] as char)
        }
        RafsiShape::Ccv => {
            is_initial_pair(token.chars().next().unwrap(), token.chars().nth(1).unwrap())
        }
        RafsiShape::Cvv => is_short_rafsi_form(token),
        RafsiShape::CvhV => true,
        RafsiShape::Cvccv | RafsiShape::Ccvcv => last && gismu_shape(token).is_some(),
        RafsiShape::Other => false,
    }
}
/// Parses a classic lujvo, including legal optional hyphens.
/// A resource failure remains an error instead of an empty reading.
pub fn segment_cll(word: &str) -> Result<Vec<Vec<String>>, BuilderError> {
    let reading = crate::recognize::parse(word)?;
    if reading.kind == crate::recognize::Kind::Lujvo && classic_tokens(&reading.tokens) {
        Ok(vec![reading.tokens])
    } else {
        Ok(vec![])
    }
}
fn classic_tokens(tokens: &[String]) -> bool {
    let parts: Vec<&String> = tokens.iter().filter(|t| !is_hyphen(t)).collect();
    parts.len() >= 2
        && parts
            .iter()
            .enumerate()
            .all(|(i, t)| rafsi_token_ok(t, i + 1 == parts.len()))
        && tokens
            .iter()
            .all(|t| !matches!(t.as_str(), "'y" | "y'" | "'y'"))
}
/// Uses pinned word recognition before offering a whole-word component.
pub fn is_brivla_core(text: &str) -> bool {
    !text.contains('y')
        && crate::recognize::parse(text).is_ok_and(|r| {
            matches!(
                r.kind,
                crate::recognize::Kind::Gismu
                    | crate::recognize::Kind::Lujvo
                    | crate::recognize::Kind::Fuivla
            )
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
/// Parses a bonded candidate as one lujvo and recovers its exact parts.
/// Construction also requires the minimal joins from the selected profile.
pub fn validate(
    profile: Profile,
    parts: &[Part],
    tokens: &[String],
) -> Result<Vec<RecoveredPart>, String> {
    validate_checked(
        profile,
        parts,
        tokens,
        &mut RecognitionBudget::default(),
        true,
    )
    .map_err(|e| e.to_string())
}
#[derive(Default)]
struct RecognitionBudget {
    spent: usize,
    cores: BTreeMap<String, bool>,
}
impl RecognitionBudget {
    fn charge(&mut self, spent: usize) -> Result<(), BuilderError> {
        self.spent += spent;
        require_limit("build recognition work", self.spent as u64, 2_000_000)
    }
    fn core_is_brivla(&mut self, text: &str) -> Result<bool, BuilderError> {
        if let Some(valid) = self.cores.get(text) {
            return Ok(*valid);
        }
        let core = crate::recognize::parse(text)?;
        self.charge(core.spent)?;
        let valid = !text.contains('y')
            && matches!(
                core.kind,
                crate::recognize::Kind::Gismu
                    | crate::recognize::Kind::Lujvo
                    | crate::recognize::Kind::Fuivla
            );
        self.cores.insert(text.into(), valid);
        Ok(valid)
    }
}
fn validate_checked(
    profile: Profile,
    parts: &[Part],
    tokens: &[String],
    budget: &mut RecognitionBudget,
    required_only: bool,
) -> Result<Vec<RecoveredPart>, BuilderError> {
    require_limit("validation parts", parts.len() as u64, 64)?;
    require_limit("validation tokens", tokens.len() as u64, 128)?;
    for part in parts {
        require_limit("component bytes", part.text.len() as u64, 128)?;
    }
    for token in tokens {
        require_limit("token bytes", token.len() as u64, 128)?;
    }
    let invalid = |message: &str| BuilderError::Invalid {
        message: message.into(),
    };
    if required_only && bond(parts).as_deref() != Some(tokens) {
        return Err(invalid(
            "The tokens do not use the required construction joins.",
        ));
    }
    if profile == Profile::Cll && parts.iter().any(|p| p.kind == PartKind::Core) {
        return Err(invalid(
            "A whole-word component needs the extended profile.",
        ));
    }
    for part in parts.iter().filter(|p| p.kind == PartKind::Core) {
        if !budget.core_is_brivla(&part.text)? {
            return Err(invalid("A whole-word component must parse as one brivla."));
        }
    }
    let length = tokens.iter().map(|t| t.len()).sum::<usize>();
    require_limit(
        "word bytes",
        length as u64,
        crate::recognize::MAX_WORD_BYTES as u64,
    )?;
    let reading = crate::recognize::parse_profile(&tokens.concat(), profile)?;
    budget.charge(reading.spent)?;
    if reading.kind != crate::recognize::Kind::Lujvo {
        return Err(invalid(
            "The selected profile does not read this form as one lujvo.",
        ));
    }
    if profile == Profile::Cll && !classic_tokens(&reading.tokens) {
        return Err(invalid("CLL rules do not read this form as one lujvo."));
    }
    if reading.tokens != tokens {
        return Err(invalid("The parsed parts differ from the intended parts."));
    }
    let parsed_parts: Vec<&str> = reading
        .tokens
        .iter()
        .filter(|t| !is_hyphen(t))
        .map(String::as_str)
        .collect();
    if !parsed_parts
        .iter()
        .copied()
        .eq(parts.iter().map(|p| p.text.as_str()))
    {
        return Err(invalid(
            "The parsed components differ from the intended components.",
        ));
    }
    Ok(recovered(&reading.tokens, parts))
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
    /// Whether the lock is a choice or an extended whole-word lock awaiting recognition.
    pub lock_valid: bool,
    /// The whole-word check exhausted its work limit. Listed rafsi remain available.
    #[serde(default)]
    pub recognition_incomplete: bool,
    pub diagnostics: Vec<String>,
}
/// The choices of one component under the profile.
pub fn row_choices(profile: Profile, component: &Component) -> RowAnalysis {
    row_choices_with_parser(profile, component, |word| {
        crate::recognize::parse_profile(word, profile)
    })
}
fn row_choices_with_parser(
    profile: Profile,
    component: &Component,
    parse: impl Fn(&str) -> Result<crate::recognize::Reading, BuilderError>,
) -> RowAnalysis {
    let mut diagnostics = Vec::new();
    if component.spelling.len() > crate::recognize::MAX_WORD_BYTES
        || component.claims.len() > 64
        || component.claims.iter().any(|c| c.rafsi.len() > 128)
    {
        return RowAnalysis {
            id: component.id.clone(),
            normalized: String::new(),
            choices: vec![],
            lock_valid: false,
            recognition_incomplete: false,
            diagnostics: vec!["The component exceeds the limit of 128 bytes or 64 claims.".into()],
        };
    }
    let mut choices: Vec<Choice> = Vec::new();
    let Some(normalized) = crate::phonotactics::normalize_word(&component.spelling) else {
        return RowAnalysis {
            id: component.id.clone(),
            normalized: String::new(),
            choices,
            lock_valid: component.locked.is_none(),
            recognition_incomplete: false,
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
            let reading = match parse(&normalized) {
                Ok(reading) => reading,
                Err(error) => {
                    diagnostics.push(format!("Whole-word recognition is incomplete: {error}"));
                    let whole_word_lock = component.locked.as_ref() == Some(&normalized);
                    let lock_valid = component.locked.as_ref().is_none_or(|locked| {
                        (profile == Profile::Extended && whole_word_lock)
                            || choices.iter().any(|c| &c.form == locked)
                    });
                    if whole_word_lock {
                        let policy = if profile == Profile::Extended {
                            "The whole-word lock waits for complete recognition."
                        } else {
                            "The whole-word lock is invalid under the CLL profile."
                        };
                        diagnostics.push(format!(
                            "{policy} Candidates use the listed rafsi until recognition finishes."
                        ));
                    } else if !lock_valid {
                        diagnostics.push(format!(
                            "The locked form \"{}\" is not one of this component's choices.",
                            component.locked.as_deref().unwrap_or_default()
                        ));
                    }
                    return RowAnalysis {
                        id: component.id.clone(),
                        normalized,
                        choices,
                        lock_valid,
                        recognition_incomplete: true,
                        diagnostics,
                    };
                }
            };
            if !normalized.contains('y')
                && matches!(
                    reading.kind,
                    crate::recognize::Kind::Gismu
                        | crate::recognize::Kind::Lujvo
                        | crate::recognize::Kind::Fuivla
                )
            {
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
        recognition_incomplete: false,
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
    /// One choice per boundary. Null uses the required join. Empty means no join.
    /// An empty list preserves version 2 construction.
    #[serde(default)]
    pub joins: Vec<Option<String>>,
    /// Preserve entered presentation only when it normalizes to the complete candidate.
    #[serde(default)]
    pub spelling: Option<String>,
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
    /// Whether the builder bonded and scored every combination.
    pub complete: bool,
    pub considered: u64,
    /// The first 64 rejected combinations checked before the window filled.
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
            } => {
                write!(f, "{measure} is {value}, above the limit of {limit}.")?;
                if measure == "build recognition work" {
                    f.write_str(" Lock a component form.")?;
                }
                Ok(())
            }
        }
    }
}
/// Scores every combination, then parses candidates until the result window
/// fills. Order is ascending score, then spelling, then the choice tuple.
pub fn build_lujvo(request: &LujvoRequest) -> Result<LujvoResult, BuilderError> {
    build_lujvo_with_detail_budget(request, DetailBudget::default())
}
fn build_lujvo_with_detail_budget(
    request: &LujvoRequest,
    mut detail_budget: DetailBudget,
) -> Result<LujvoResult, BuilderError> {
    if let Some(spelling) = &request.spelling {
        require_limit("typed spelling bytes", spelling.len() as u64, 128)?;
        if request.profile != Profile::Extended || spelling.trim() != spelling {
            return Err(BuilderError::Invalid {
                message: "A typed spelling needs the extended profile and no outer whitespace."
                    .into(),
            });
        }
    }
    let count = request.components.len() as u64;
    if !(2..=64).contains(&count) {
        return Err(BuilderError::Invalid {
            message: "A lujvo needs 2 through 64 components.".into(),
        });
    }
    require_limit(
        "inventory claims",
        request.inventory.claims.len() as u64,
        20_000,
    )?;
    for component in &request.components {
        require_limit("component bytes", component.spelling.len() as u64, 128)?;
        require_limit("component claims", component.claims.len() as u64, 64)?;
        if let Some(locked) = &component.locked {
            require_limit("locked rafsi bytes", locked.len() as u64, 128)?;
            if locked.is_empty() || is_hyphen(locked) {
                return Err(BuilderError::Invalid {
                    message: "A component lock must contain a rafsi, not an empty form or a join."
                        .into(),
                });
            }
        }
        for claim in &component.claims {
            require_limit("rafsi bytes", claim.rafsi.len() as u64, 128)?;
        }
    }
    if request.profile == Profile::Cll && !request.joins.is_empty() {
        return Err(BuilderError::Invalid {
            message: "Explicit joins need the extended profile.".into(),
        });
    }
    if !request.joins.is_empty()
        && (request.joins.len() + 1 != request.components.len()
            || request
                .joins
                .iter()
                .flatten()
                .any(|join| !join.is_empty() && !is_hyphen(join)))
    {
        return Err(BuilderError::Invalid {
            message: "Choose one permitted join for each boundary.".into(),
        });
    }
    let rows: Vec<RowAnalysis> = request
        .components
        .iter()
        .enumerate()
        .map(|(index, c)| {
            let mut row = row_choices(request.profile, c);
            if !request.joins.is_empty() {
                if let Some(locked) = &c.locked {
                    if !row.choices.iter().any(|choice| &choice.form == locked)
                        || (request.profile == Profile::Extended
                            && locked == &row.normalized
                            && gismu_shape(locked).is_some()
                            && index + 1 < request.components.len())
                    {
                        let core = request.profile == Profile::Extended
                            && locked == &row.normalized
                            && is_brivla_core(locked);
                        row.choices.push(Choice {
                            form: locked.clone(),
                            origin: if core { Origin::Core } else { Origin::Claim },
                            shape: rafsi_shape(locked),
                            position: Position::Any,
                            pair: None,
                        });
                        row.lock_valid = true;
                        row.diagnostics.clear();
                    }
                }
            }
            row
        })
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
            if row.recognition_incomplete && locked == &row.normalized {
                // The row reports the invalid CLL or pending extended lock explicitly.
                // Keep listed rafsi until recognition can establish a whole-word choice.
            } else if row.lock_valid {
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
    if product > request.limits.choice_product.min(20_000) {
        return Err(BuilderError::ResourceLimit {
            measure: "choice combinations".into(),
            value: product,
            limit: request.limits.choice_product.min(20_000),
        });
    }
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut rejected = Vec::new();
    let mut considered = 0u64;
    let mut failure = None;
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
            if failure.is_some() {
                return;
            }
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
            let Some(default_tokens) = bond(&parts) else {
                return;
            };
            let tokens = if request.joins.is_empty() {
                default_tokens
            } else {
                let defaults = recovered(&default_tokens, &parts);
                if defaults.len() != parts.len() {
                    failure = Some(BuilderError::Invalid {
                        message: "The default joins do not recover every component.".into(),
                    });
                    return;
                }
                let mut tokens = vec![parts[0].text.clone()];
                for (index, part) in parts.iter().enumerate().skip(1) {
                    let join = request.joins[index - 1]
                        .as_deref()
                        .or_else(|| defaults.get(index)?.join_before.as_deref())
                        .unwrap_or("");
                    if !join.is_empty() {
                        tokens.push(join.into());
                    }
                    tokens.push(part.text.clone());
                }
                tokens
            };
            let spelling: String = tokens.concat();
            match score(&tokens) {
                Ok(score) => {
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
                        score,
                        tokens,
                        recovered: vec![],
                        conflicts: vec![],
                        unlisted: vec![],
                    });
                }
                Err(error @ BuilderError::ResourceLimit { .. }) => {
                    failure = Some(error);
                }
                Err(error) => {
                    if rejected.len() < 64 {
                        rejected.push(Rejected {
                            spelling,
                            parts: chosen.iter().map(|c| c.form.clone()).collect(),
                            reason: error.to_string(),
                        });
                    }
                }
            }
        });
    }
    if let Some(error) = failure {
        return Err(error);
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
    let mut recognition_budget = RecognitionBudget::default();
    let result_limit = request.limits.results.min(512);
    let mut validated = Vec::new();
    for mut candidate in candidates {
        if validated.len() == result_limit {
            break;
        }
        let parts: Vec<Part> = candidate
            .parts
            .iter()
            .map(|part| Part {
                text: part.form.clone(),
                kind: if part.origin == Origin::Core {
                    PartKind::Core
                } else {
                    PartKind::Rafsi
                },
            })
            .collect();
        match validate_checked(
            request.profile,
            &parts,
            &candidate.tokens,
            &mut recognition_budget,
            request.joins.is_empty(),
        ) {
            Ok(recovered) => {
                candidate.recovered = recovered;
                if let Some(spelling) = &request.spelling {
                    if crate::phonotactics::normalize_word(spelling).as_deref()
                        != Some(&candidate.spelling)
                    {
                        continue;
                    }
                    // Keep the original presentation token spans. Commas follow the preceding token.
                    let mut originals = vec![String::new(); candidate.tokens.len()];
                    let mut index = 0;
                    let mut consumed = 0;
                    for character in spelling.chars() {
                        if character != ',' {
                            while index + 1 < candidate.tokens.len()
                                && consumed == candidate.tokens[index].len()
                            {
                                index += 1;
                                consumed = 0;
                            }
                            consumed += 1;
                        }
                        originals[index].push(character);
                    }
                    candidate.spelling = spelling.clone();
                    candidate.tokens = originals;
                }
                validated.push(candidate);
            }
            Err(error @ BuilderError::ResourceLimit { .. }) => return Err(error),
            Err(error) => {
                if rejected.len() < 64 {
                    rejected.push(Rejected {
                        spelling: candidate.spelling,
                        parts: candidate.parts.into_iter().map(|part| part.form).collect(),
                        reason: error.to_string(),
                    });
                }
            }
        }
    }
    let mut candidates = validated;
    add_conflict_details(&mut candidates, &request.inventory, &mut detail_budget)?;
    Ok(LujvoResult {
        rows,
        candidates,
        complete: true,
        considered,
        rejected,
        morphology: Versioned {
            id: request.profile.morphology_id().into(),
            version: if request.profile == Profile::Extended {
                "3"
            } else {
                MORPHOLOGY_VERSION
            }
            .into(),
        },
        scoring: Versioned {
            id: request.profile.scoring_id().into(),
            version: SCORING_VERSION.into(),
        },
        diagnostics,
    })
}
/// Checks all selected conflict details before copying any strings.
fn add_conflict_details(
    candidates: &mut [Candidate],
    inventory: &Inventory,
    budget: &mut DetailBudget,
) -> Result<(), BuilderError> {
    if candidates.is_empty() {
        return Ok(());
    }
    budget.scan(inventory.claims.len())?;
    let claims_by_rafsi: BTreeMap<&str, Vec<&InventoryClaim>> =
        inventory
            .claims
            .iter()
            .fold(BTreeMap::new(), |mut map, claim| {
                map.entry(claim.rafsi.as_str()).or_default().push(claim);
                map
            });
    for candidate in candidates.iter() {
        for part in candidate.parts.iter().filter(|p| p.origin == Origin::Claim) {
            let known = claims_by_rafsi
                .get(part.form.as_str())
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            // Account for the preflight and the later copy pass.
            budget.scan(known.len().saturating_mul(2))?;
            for other in known.iter().filter(|c| Some(&c.pair) != part.pair.as_ref()) {
                budget.detail(&[
                    &part.form,
                    &part.id,
                    &other.word,
                    &other.spelling,
                    &other.pair,
                ])?;
            }
        }
    }
    for candidate in candidates {
        for part in candidate.parts.iter().filter(|p| p.origin == Origin::Claim) {
            let known = claims_by_rafsi
                .get(part.form.as_str())
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            if !known.iter().any(|c| Some(&c.pair) == part.pair.as_ref()) {
                candidate.unlisted.push(part.form.clone());
            }
            for other in known.iter().filter(|c| Some(&c.pair) != part.pair.as_ref()) {
                candidate.conflicts.push(Conflict {
                    rafsi: part.form.clone(),
                    id: part.id.clone(),
                    word: other.word.clone(),
                    spelling: other.spelling.clone(),
                    pair: other.pair.clone(),
                });
            }
        }
    }
    Ok(())
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
/// Classifies one complete word under the selected profile.
pub fn analyze_word(profile: Profile, spelling: &str) -> Analysis {
    let mut analysis = Analysis {
        original: spelling.into(),
        normalized: None,
        kind: WordKind::Unknown,
        readings: vec![],
        diagnostics: vec![],
        morphology: Versioned {
            id: profile.morphology_id().into(),
            version: if profile == Profile::Extended {
                "3"
            } else {
                MORPHOLOGY_VERSION
            }
            .into(),
        },
    };
    if spelling.len() > crate::recognize::MAX_WORD_BYTES {
        analysis
            .diagnostics
            .push(resource("word bytes", spelling.len() as u64, 128).to_string());
        return analysis;
    }
    let Some(normalized) = crate::phonotactics::normalize_word(spelling) else {
        analysis.diagnostics.push(
            "The spelling uses characters outside Lojban letters, apostrophes, and commas.".into(),
        );
        return analysis;
    };
    match crate::recognize::parse_profile(&normalized, profile) {
        Err(error) => analysis.diagnostics.push(error.to_string()),
        Ok(reading) => {
            use crate::recognize::Kind;
            analysis.kind = match reading.kind {
                Kind::Gismu => WordKind::Gismu,
                Kind::Cmavo => WordKind::Cmavo,
                Kind::Cmevla => WordKind::Cmevla,
                Kind::Fuivla => WordKind::Fuivla,
                Kind::Lujvo if profile == Profile::Extended || classic_tokens(&reading.tokens) => {
                    WordKind::Lujvo
                }
                _ => WordKind::Unknown,
            };
            if profile == Profile::Cll && analysis.kind == WordKind::Fuivla {
                analysis.diagnostics.push("Fu'ivla recognition uses the extended jbotci lineage. This classification does not establish CLL validity.".into());
            }
            if analysis.kind == WordKind::Lujvo {
                let component_tokens: Vec<&String> =
                    reading.tokens.iter().filter(|t| !is_hyphen(t)).collect();
                let parts: Vec<Part> = component_tokens
                    .iter()
                    .enumerate()
                    .map(|(index, t)| {
                        if t.chars().last().is_some_and(is_consonant)
                            || rafsi_token_ok(t, index + 1 == component_tokens.len())
                        {
                            Part::rafsi(t)
                        } else {
                            Part::core(t)
                        }
                    })
                    .collect();
                analysis.readings.push(recovered(&reading.tokens, &parts));
            }
            if analysis.kind == WordKind::Unknown {
                analysis
                    .diagnostics
                    .push("The form is not one word under the selected profile.".into());
            }
        }
    }
    analysis.normalized = Some(normalized);
    analysis
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
    fn exact_readings_rebuild_with_optional_and_extended_joins() {
        for word in [
            "ckusni",
            "cuktysinxa",
            "sairzba",
            "bangu'y'ismu",
            "sakrsakysakli",
            "spageti'ybroda",
            "spageti'ykla",
            "kerlybai'ybroda",
            "kerlybla'ykla",
            "spageiybroda",
            "kerlyfa'u'yiismu",
            "klama'ybroda",
            "aktyiismu",
        ] {
            let analysis = analyze_word(Profile::Extended, word);
            assert_eq!(analysis.kind, WordKind::Lujvo, "{word}");
            let reading = &analysis.readings[0];
            let request: LujvoRequest = serde_json::from_value(serde_json::json!({
                "profile": "extended",
                "joins": reading.iter().skip(1).map(|p| p.join_before.clone().unwrap_or_default()).collect::<Vec<_>>(),
                "components": reading.iter().enumerate().map(|(index, part)| serde_json::json!({
                    "id": index.to_string(), "spelling": part.text, "kind": "other", "locked": part.text
                })).collect::<Vec<_>>()
            })).unwrap();
            let result = build_lujvo(&request).unwrap();
            assert_eq!(result.candidates.len(), 1, "{word}: {:?}", result.rejected);
            assert_eq!(result.candidates[0].spelling.as_bytes(), word.as_bytes());
            assert_eq!(result.candidates[0].tokens.concat(), word);
            assert_eq!(result.morphology.version, "3");
        }
    }
    #[test]
    fn typed_presentation_keeps_bytes_without_bypassing_the_exact_parse() {
        let mut request: LujvoRequest = serde_json::from_value(serde_json::json!({
            "profile": "extended", "joins": ["r"], "spelling": "SAI,rZBA",
            "components": [
                {"id": "a", "spelling": "sai", "kind": "other", "locked": "sai"},
                {"id": "b", "spelling": "zba", "kind": "other", "locked": "zba"}
            ]
        }))
        .unwrap();
        let result = build_lujvo(&request).unwrap();
        assert_eq!(result.candidates[0].spelling, "SAI,rZBA");
        assert_eq!(result.candidates[0].tokens.concat(), "SAI,rZBA");
        assert_eq!(
            result.candidates[0].score,
            score(&s(&["sai", "r", "zba"])).unwrap()
        );
        request.spelling = Some("ckusni".into());
        assert!(build_lujvo(&request).unwrap().candidates.is_empty());
        request.spelling = Some("b".repeat(129));
        assert!(matches!(
            build_lujvo(&request),
            Err(BuilderError::ResourceLimit { .. })
        ));
    }
    #[test]
    fn retained_gencmu_oracle_and_cll_profile_stay_separate() {
        let evidence: serde_json::Value =
            serde_json::from_str(include_str!("../evidence/typed-lujvo.json")).unwrap();
        for case in evidence["cases"].as_array().unwrap() {
            let word = case["word"].as_str().unwrap();
            let analysis = analyze_word(Profile::Extended, word);
            assert_eq!(
                serde_json::to_value(analysis.kind).unwrap(),
                case["kind"],
                "{word}"
            );
            let old = crate::recognize::parse(word).unwrap();
            let cll = analyze_word(Profile::Cll, word);
            assert_eq!(cll.morphology.version, "2");
            assert_eq!(
                cll.kind == WordKind::Lujvo,
                old.kind == crate::recognize::Kind::Lujvo && classic_tokens(&old.tokens),
                "{word}"
            );
        }
        let request: LujvoRequest = serde_json::from_value(serde_json::json!({
            "profile": "cll", "joins": ["r"], "components": [
                {"id": "a", "spelling": "sanmi", "kind": "gismu", "locked": "sai"},
                {"id": "b", "spelling": "zbasu", "kind": "gismu", "locked": "zba"}
            ]
        }))
        .unwrap();
        assert!(build_lujvo(&request).is_err());
    }
    #[test]
    fn component_locks_reject_empty_forms_and_standalone_joins_without_panicking() {
        for locked in ["", "y", "y'", "'y", "'y'", "r", "n"] {
            for joins in [
                serde_json::json!([]),
                serde_json::json!([null]),
                serde_json::json!([""]),
                serde_json::json!(["y"]),
            ] {
                for position in 0..2 {
                    let mut components = serde_json::json!([
                        {"id": "a", "spelling": "bau", "kind": "other", "locked": "bau"},
                        {"id": "b", "spelling": "kla", "kind": "other", "locked": "kla"}
                    ]);
                    components[position]["spelling"] = serde_json::json!(locked);
                    components[position]["locked"] = serde_json::json!(locked);
                    let request: LujvoRequest = serde_json::from_value(serde_json::json!({
                        "profile": "extended", "joins": joins, "components": components,
                    }))
                    .unwrap();
                    assert!(
                        matches!(build_lujvo(&request), Err(BuilderError::Invalid { message }) if message.contains("component lock")),
                        "lock {locked:?}, position {position}, joins {joins}"
                    );
                }
            }
        }
    }
    #[test]
    fn explicit_joins_reject_missing_required_and_invalid_joins() {
        for joins in [serde_json::json!([""]), serde_json::json!(["r"])] {
            let request: LujvoRequest = serde_json::from_value(serde_json::json!({
                "profile": "extended", "joins": joins,
                "components": [
                    {"id": "a", "spelling": "cukta", "kind": "gismu", "locked": "cukt"},
                    {"id": "b", "spelling": "sinxa", "kind": "gismu", "locked": "sinxa"}
                ]
            }))
            .unwrap();
            assert!(build_lujvo(&request).unwrap().candidates.is_empty());
        }
        let request: LujvoRequest = serde_json::from_value(serde_json::json!({
            "profile": "cll", "joins": ["y", "y"],
            "components": [
                {"id": "a", "spelling": "cukta", "kind": "gismu"},
                {"id": "b", "spelling": "sinxa", "kind": "gismu"}
            ]
        }))
        .unwrap();
        assert!(build_lujvo(&request).is_err());
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
        // CLL 4.12 examples 12.1 through 12.4.
        assert_eq!(score(&s(&["zba", "sai"])).unwrap(), 5847);
        assert_eq!(score(&s(&["nun", "y", "nau"])).unwrap(), 6967);
        assert_eq!(score(&s(&["sai", "r", "zba", "ta'u"])).unwrap(), 10385);
        assert_eq!(score(&s(&["zba", "zbas", "y", "sarji"])).unwrap(), 12976);
    }
    #[test]
    fn classic_segmentation_accepts_lujvo_and_rejects_non_lujvo() {
        for word in [
            "jbogri",
            "rokyre'o",
            "basykla",
            "saircli",
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
            assert!(
                !segment_cll(word).unwrap().is_empty(),
                "{word} should be a lujvo"
            );
        }
        for word in [
            "babau",
            "soisai",
            "xlamkai",
            "xlaglymlu",
            "kerlyu'ukerlo",
            "tosmabru",
            "sakli",
            "cukta",
        ] {
            assert!(
                segment_cll(word).unwrap().is_empty(),
                "{word} should not be a lujvo"
            );
        }
    }
    #[test]
    fn segmentation_recovers_the_intended_parts() {
        assert_eq!(
            segment_cll("cuktysni").unwrap(),
            vec![s(&["cukt", "y", "sni"])]
        );
        assert_eq!(segment_cll("ckusni").unwrap(), vec![s(&["cku", "sni"])]);
        assert_eq!(segment_cll("bauryo'a").unwrap().len(), 0);
        assert_eq!(
            segment_cll("ro'inre'o").unwrap(),
            vec![s(&["ro'i", "n", "re'o"])]
        );
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
        assert!(validate(Profile::Extended, &parts, &tokens).is_err());
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
            joins: vec![],
            spelling: None,
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
            joins: vec![],
            spelling: None,
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
            joins: vec![],
            spelling: None,
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
            joins: vec![],
            spelling: None,
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
    #[test]
    fn mz_is_forbidden_under_both_profiles() {
        for profile in [Profile::Cll, Profile::Extended] {
            for word in ["cimza'a", "lemzasli", "kamzu", "mamza", "ka,m,zu"] {
                let analysis = analyze_word(profile, word);
                assert_eq!(analysis.kind, WordKind::Unknown, "{profile:?} {word}");
                assert!(analysis.readings.is_empty());
                assert!(!analysis.diagnostics.is_empty());
                assert!(!is_brivla_core(word));
            }
            let parts = rafsi(&["cim", "za'a"]);
            let tokens = bond(&parts).unwrap();
            assert_eq!(tokens, s(&["cim", "y", "za'a"]));
            assert!(validate(profile, &parts, &tokens).is_ok());
            assert_eq!(
                analyze_word(profile, &tokens.concat()).kind,
                WordKind::Lujvo
            );
            let parts = vec![Part::rafsi("kam"), Part::core("kamzu")];
            assert!(validate(profile, &parts, &bond(&parts).unwrap()).is_err());
            let row = row_choices(
                profile,
                &Component {
                    id: "mz".into(),
                    spelling: "kamzu".into(),
                    kind: "gismu".into(),
                    definition: None,
                    claims: vec![],
                    locked: None,
                },
            );
            assert!(row.choices.is_empty());
        }
        assert!(segment_cll("cimza'a").unwrap().is_empty());
    }
    #[test]
    fn six_part_build_returns_a_sorted_parsed_window() {
        let components: Vec<Component> = [
            ("sakli", &["sal", "sak", "ska", "sa'i"][..]),
            ("bridi", &["bri", "bid", "ri'i"][..]),
            ("klama", &["kla", "lam"][..]),
            ("blaci", &["bla", "lac", "bai"][..]),
            ("cukta", &["cku", "cuk"][..]),
            ("sinxa", &["sni", "sin"][..]),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, (spelling, claims))| Component {
            id: index.to_string(),
            spelling: spelling.into(),
            kind: "gismu".into(),
            definition: None,
            claims: claims
                .iter()
                .map(|rafsi| Claim {
                    rafsi: (*rafsi).into(),
                    pair: format!("pair-{rafsi}"),
                })
                .collect(),
            locked: None,
        })
        .collect();
        for profile in [Profile::Cll, Profile::Extended] {
            let mut request = LujvoRequest {
                joins: vec![],
                spelling: None,
                profile,
                components: components.clone(),
                inventory: Inventory::default(),
                limits: Limits::default(),
            };
            let result = build_lujvo(&request).unwrap();
            assert_eq!(result.considered, 1_440);
            assert!(result.complete);
            assert_eq!(result.candidates.len(), 64);
            let keys = |result: &LujvoResult| {
                result
                    .candidates
                    .iter()
                    .map(|candidate| {
                        (
                            candidate.score,
                            candidate.spelling.clone(),
                            candidate
                                .parts
                                .iter()
                                .map(|part| part.form.clone())
                                .collect::<Vec<_>>(),
                        )
                    })
                    .collect::<Vec<_>>()
            };
            let ordered = keys(&result);
            assert!(ordered.windows(2).all(|pair| pair[0] <= pair[1]));
            for candidate in &result.candidates {
                let parts: Vec<Part> = candidate
                    .parts
                    .iter()
                    .map(|part| Part::rafsi(&part.form))
                    .collect();
                assert_eq!(
                    validate(profile, &parts, &candidate.tokens).unwrap(),
                    candidate.recovered
                );
            }
            request.limits.results = 8;
            assert_eq!(keys(&build_lujvo(&request).unwrap()), ordered[..8]);
        }
    }
    #[test]
    fn extended_outputs_require_real_parse_back() {
        for parts in [
            vec![Part::rafsi("bau"), Part::core("ismu")],
            vec![Part::rafsi("gim"), Part::core("spageti")],
            vec![Part::core("leksiko"), Part::core("ismu")],
            vec![Part::core("fulta"), Part::core("ismu")],
        ] {
            let tokens = bond(&parts).unwrap();
            assert!(
                validate(Profile::Extended, &parts, &tokens).is_err(),
                "{}",
                tokens.concat()
            );
        }
        for parts in [
            vec![Part::rafsi("akt"), Part::core("iismu")],
            vec![Part::rafsi("ful"), Part::core("ismu")],
            vec![Part::rafsi("gim"), Part::core("iismu")],
            vec![Part::rafsi("tce"), Part::rafsi("nel"), Part::core("iismu")],
            vec![Part::core("jenjigu"), Part::rafsi("di'e")],
        ] {
            let tokens = bond(&parts).unwrap();
            let recovered = validate(Profile::Extended, &parts, &tokens).unwrap();
            assert!(
                recovered
                    .iter()
                    .map(|p| &p.text)
                    .eq(parts.iter().map(|p| &p.text))
            );
            let analysis = analyze_word(Profile::Extended, &tokens.concat());
            assert_eq!(analysis.kind, WordKind::Lujvo, "{}", tokens.concat());
            assert_eq!(analysis.readings[0], recovered);
            assert_ne!(
                analyze_word(Profile::Cll, &tokens.concat()).kind,
                WordKind::Lujvo
            );
        }
    }
    #[test]
    fn malformed_clusters_are_not_words_or_cores() {
        assert_eq!(
            analyze_word(Profile::Cll, "sakrsakysakli").kind,
            WordKind::Unknown
        );
        assert_eq!(
            analyze_word(Profile::Extended, "sakrsakysakli").readings[0][0].text,
            "sakrsak"
        );
        for text in [
            "sabkysakli",
            "rsakli",
            "ntadi",
            "leksiko'yismu",
            "fulta'yismu",
        ] {
            for profile in [Profile::Cll, Profile::Extended] {
                assert_eq!(
                    analyze_word(profile, text).kind,
                    WordKind::Unknown,
                    "{text}"
                );
            }
            assert!(!is_brivla_core(text), "{text}");
        }
        assert_eq!(
            analyze_word(Profile::Extended, "gimspageti").kind,
            WordKind::Fuivla
        );
        assert_eq!(
            analyze_word(Profile::Extended, "baurismu").kind,
            WordKind::Unknown
        );
    }
    #[test]
    fn optional_hyphens_are_analysis_only() {
        assert_eq!(
            segment_cll("sairzba").unwrap(),
            vec![s(&["sai", "r", "zba"])]
        );
        assert_eq!(analyze_word(Profile::Cll, "sairzba").kind, WordKind::Lujvo);
        let parts = rafsi(&["sai", "zba"]);
        assert!(validate(Profile::Cll, &parts, &s(&["sai", "r", "zba"])).is_err());
        assert!(validate(Profile::Cll, &parts, &bond(&parts).unwrap()).is_ok());
    }
    #[test]
    fn adversarial_recognition_and_score_have_input_bounds() {
        for count in [8, 12, 16, 24, 30] {
            let text = format!("{}sakli", "sakr".repeat(count));
            let analysis = analyze_word(Profile::Cll, &text);
            assert_eq!(analysis.kind, WordKind::Fuivla, "{text}");
            assert!(analysis.readings.is_empty());
        }
        let text = "sakr".repeat(40);
        assert!(matches!(
            segment_cll(&text),
            Err(BuilderError::ResourceLimit { .. })
        ));
        let text = "a".repeat(2_200_000);
        assert!(matches!(
            score(&[text]),
            Err(BuilderError::ResourceLimit { .. })
        ));
    }

    #[test]
    fn retained_reference_parses_match_profile_results() {
        let evidence: serde_json::Value =
            serde_json::from_str(include_str!("../evidence/word-parses.json")).unwrap();
        for case in evidence["cases"].as_array().unwrap() {
            let word = case["word"].as_str().unwrap();
            for (name, profile) in [("cll-ebnf", Profile::Cll), ("bpfk", Profile::Extended)] {
                let expected = if case["jbotci_kind"] == "lujvo" && case[name]["ok"] == false {
                    "unknown"
                } else {
                    case["jbotci_kind"].as_str().unwrap()
                };
                let analysis = analyze_word(profile, word);
                assert_eq!(
                    serde_json::to_value(analysis.kind).unwrap(),
                    expected,
                    "{name} {word}"
                );
                if analysis.kind == WordKind::Lujvo {
                    let mut tokens = vec![];
                    for part in &analysis.readings[0] {
                        if let Some(join) = &part.join_before {
                            tokens.push(join.clone());
                        }
                        tokens.push(part.text.clone());
                    }
                    assert_eq!(
                        serde_json::to_value(tokens).unwrap(),
                        case["jbotci_tokens"],
                        "{name} {word}"
                    );
                }
            }
        }
    }
    #[test]
    fn builder_rejects_false_extended_winners() {
        let component = |id: &str, word: &str, kind: &str, claims: &[&str]| Component {
            id: id.into(),
            spelling: word.into(),
            kind: kind.into(),
            definition: None,
            locked: None,
            claims: claims
                .iter()
                .map(|r| Claim {
                    rafsi: r.to_string(),
                    pair: format!("pair-{r}"),
                })
                .collect(),
        };
        let request = LujvoRequest {
            joins: vec![],
            spelling: None,
            profile: Profile::Extended,
            components: vec![
                component("a", "bangu", "gismu", &["bau", "ban"]),
                component("b", "ismu", "fuivla", &[]),
            ],
            inventory: Inventory::default(),
            limits: Limits {
                results: 1,
                ..Limits::default()
            },
        };
        let result = build_lujvo(&request).unwrap();
        assert_eq!(result.candidates.len(), 1);
        assert!(result.candidates.iter().any(|c| c.spelling == "bany'ismu"));
        assert!(!result.candidates.iter().any(|c| c.spelling == "baurismu"));
        assert!(result.rejected.iter().any(|c| c.spelling == "baurismu"));
        for candidate in result.candidates {
            assert!(
                candidate
                    .recovered
                    .iter()
                    .map(|p| &p.text)
                    .eq(candidate.parts.iter().map(|p| &p.form))
            );
        }
    }
    #[test]
    fn failed_candidate_recognition_counts_toward_total_work() {
        let parts = vec![Part::rafsi("bau"), Part::core("ismu")];
        let tokens = bond(&parts).unwrap();
        let mut budget = RecognitionBudget::default();
        assert!(validate_checked(Profile::Extended, &parts, &tokens, &mut budget, true).is_err());
        assert!(budget.spent > 0);
        budget.spent = 2_000_000;
        assert!(matches!(
            validate_checked(Profile::Extended, &parts, &tokens, &mut budget, true),
            Err(BuilderError::ResourceLimit { .. })
        ));
    }
    #[test]
    fn extended_core_cache_preserves_work_and_resource_errors() {
        let mut budget = RecognitionBudget::default();
        assert!(budget.core_is_brivla("ismu").unwrap());
        assert!(budget.spent > 0);
        budget.spent = 2_000_000;
        assert!(budget.core_is_brivla("ismu").unwrap());
        assert_eq!(budget.spent, 2_000_000);
        let error = budget.core_is_brivla("iismu").unwrap_err();
        assert!(
            matches!(error, BuilderError::ResourceLimit { ref measure, .. } if measure == "build recognition work")
        );
        assert!(error.to_string().contains("Lock a component form"));
        assert!(!budget.cores.contains_key("iismu"));
        assert!(
            matches!(budget.core_is_brivla(&"a".repeat(129)), Err(BuilderError::ResourceLimit { measure, .. }) if measure == "word bytes")
        );
        assert!(!budget.cores.contains_key(&"a".repeat(129)));
    }
    #[test]
    fn classic_fuivla_analysis_reports_its_recognition_scope() {
        let classic = analyze_word(Profile::Cll, "ismu");
        let extended = analyze_word(Profile::Extended, "ismu");
        assert_eq!(classic.kind, WordKind::Fuivla);
        assert_eq!(extended.kind, WordKind::Fuivla);
        assert!(
            classic
                .diagnostics
                .iter()
                .any(|d| d.contains("extended jbotci lineage")
                    && d.contains("does not establish CLL validity"))
        );
        assert!(extended.diagnostics.is_empty());
        assert!(
            analyze_word(Profile::Cll, "leksiko")
                .diagnostics
                .iter()
                .any(|d| d.contains("does not establish CLL validity"))
        );
    }
    #[test]
    fn row_recognition_exhaustion_is_not_a_linguistic_rejection() {
        let component = Component {
            id: "a".into(),
            spelling: "ismu".into(),
            kind: "fuivla".into(),
            definition: None,
            claims: vec![],
            locked: Some("ismu".into()),
        };
        let row = row_choices_with_parser(Profile::Extended, &component, |_| {
            Err(resource("recognition work", 2, 1))
        });
        assert!(row.choices.is_empty());
        assert!(row.lock_valid);
        assert!(
            row.diagnostics
                .iter()
                .any(|d| d.contains("recognition is incomplete") && d.contains("recognition work"))
        );
        assert!(!row.diagnostics.iter().any(
            |d| d.contains("not a brivla") || d.contains("not one of this component's choices")
        ));
    }
    #[test]
    fn grok_component_exhaustion_preserves_locked_rafsi_builds() {
        for profile in [Profile::Cll, Profile::Extended] {
            let component = Component {
                id: "a".into(),
                spelling: "tca".repeat(40),
                kind: "lujvo".into(),
                definition: None,
                claims: vec![Claim {
                    rafsi: "bau".into(),
                    pair: "pair-bau".into(),
                }],
                locked: Some("bau".into()),
            };
            let analysis = analyze_word(profile, &component.spelling);
            assert_eq!(analysis.kind, WordKind::Unknown);
            assert!(
                analysis
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.contains("recognition work"))
            );
            let result = build_lujvo(&LujvoRequest {
                joins: vec![],
                spelling: None,
                profile,
                components: vec![
                    component,
                    Component {
                        id: "b".into(),
                        spelling: "sinxa".into(),
                        kind: "gismu".into(),
                        definition: None,
                        claims: vec![Claim {
                            rafsi: "sni".into(),
                            pair: "pair-sni".into(),
                        }],
                        locked: Some("sni".into()),
                    },
                ],
                inventory: Inventory::default(),
                limits: Limits::default(),
            })
            .unwrap();
            assert!(result.rows[0].lock_valid);
            assert!(
                result.rows[0]
                    .choices
                    .iter()
                    .any(|choice| choice.form == "bau")
            );
            assert!(
                result.rows[0]
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.contains("recognition is incomplete"))
            );
            assert_eq!(result.candidates.len(), 1);
            assert_eq!(result.candidates[0].spelling, "bausni");
            assert_eq!(
                result.candidates[0]
                    .recovered
                    .iter()
                    .map(|part| part.text.as_str())
                    .collect::<Vec<_>>(),
                vec!["bau", "sni"]
            );
        }
    }
    #[test]
    fn whole_word_lock_on_exhausted_recognition_keeps_listed_rafsi() {
        for profile in [Profile::Cll, Profile::Extended] {
            let spelling = "tca".repeat(40);
            let mut request = LujvoRequest {
                joins: vec![],
                spelling: None,
                profile,
                components: vec![
                    Component {
                        id: "a".into(),
                        spelling: spelling.clone(),
                        kind: "lujvo".into(),
                        definition: None,
                        claims: vec![Claim {
                            rafsi: "bau".into(),
                            pair: "pair-bau".into(),
                        }],
                        locked: Some(spelling.clone()),
                    },
                    Component {
                        id: "b".into(),
                        spelling: "sinxa".into(),
                        kind: "gismu".into(),
                        definition: None,
                        claims: vec![Claim {
                            rafsi: "sni".into(),
                            pair: "pair-sni".into(),
                        }],
                        locked: Some("sni".into()),
                    },
                ],
                inventory: Inventory::default(),
                limits: Limits::default(),
            };
            let result = build_lujvo(&request).unwrap();
            assert_eq!(result.rows[0].lock_valid, profile == Profile::Extended);
            assert!(result.rows[0].recognition_incomplete);
            let fallback = "Candidates use the listed rafsi until recognition finishes.";
            assert!(
                result.rows[0]
                    .diagnostics
                    .iter()
                    .any(|d| d.contains(fallback))
            );
            let policy = if profile == Profile::Extended {
                "The whole-word lock waits for complete recognition."
            } else {
                "The whole-word lock is invalid under the CLL profile."
            };
            assert!(
                result.rows[0]
                    .diagnostics
                    .iter()
                    .any(|d| d.contains(policy))
            );
            assert!(
                result.rows[0]
                    .choices
                    .iter()
                    .all(|choice| choice.form != spelling)
            );
            assert!(
                result.rows[0]
                    .diagnostics
                    .iter()
                    .any(|d| d.contains("recognition is incomplete"))
            );
            assert_eq!(
                request.components[0].locked.as_deref(),
                Some(spelling.as_str())
            );
            assert_eq!(result.candidates.len(), 1);
            assert_eq!(result.candidates[0].spelling, "bausni");
            assert_eq!(
                result.candidates[0]
                    .recovered
                    .iter()
                    .map(|part| part.text.as_str())
                    .collect::<Vec<_>>(),
                vec!["bau", "sni"]
            );
            request.components[0].locked = Some("zzz".into());
            let invalid = build_lujvo(&request).unwrap();
            assert!(!invalid.rows[0].lock_valid);
            assert!(invalid.candidates.is_empty());
            assert!(
                invalid.rows[0]
                    .diagnostics
                    .iter()
                    .any(|d| d.contains("not one of this component's choices"))
            );
            request.components[0].locked = Some(spelling);
            request.components[1].locked = Some("sinx".into());
            let misplaced = build_lujvo(&request).unwrap();
            assert!(misplaced.rows[1].lock_valid);
            assert!(misplaced.candidates.is_empty());
            assert!(
                misplaced
                    .diagnostics
                    .iter()
                    .any(|d| d.contains("cannot stand in position 2"))
            );
        }
    }
    #[test]
    fn only_shared_build_recognition_errors_give_lock_advice() {
        for measure in ["recognition work", "build recognition work"] {
            let message = resource(measure, 2, 1).to_string();
            assert_eq!(
                message.contains("Lock a component form."),
                measure == "build recognition work"
            );
            assert!(!message.contains("fewer results"));
        }
    }
    #[test]
    fn grok_extended_apostrophe_y_apostrophe_is_one_join() {
        for core in ["bangu", "fulta", "leksiko", "spageti"] {
            let word = format!("{core}'y'ismu");
            let analysis = analyze_word(Profile::Extended, &word);
            assert_eq!(analysis.kind, WordKind::Lujvo, "{word}");
            assert_eq!(analysis.readings.len(), 1);
            assert_eq!(analysis.readings[0].len(), 2, "{word}");
            assert_eq!(analysis.readings[0][0].text, core);
            assert_eq!(analysis.readings[0][0].join_before, None);
            assert_eq!(analysis.readings[0][1].text, "ismu");
            assert_eq!(analysis.readings[0][1].join_before.as_deref(), Some("'y'"));
            assert_eq!(analyze_word(Profile::Cll, &word).kind, WordKind::Unknown);
            assert!(segment_cll(&word).unwrap().is_empty());
        }
        assert!(!classic_tokens(&s(&["bau", "'y'", "sakli"])));
    }
    #[test]
    fn grok_extended_part_kinds_use_the_final_component_position() {
        for (word, first, last, join) in [
            ("bangu'ysakli", "bangu", "sakli", "'y"),
            ("gerku'ymlatu", "gerku", "mlatu", "'y"),
            ("bangu'y'ismu", "bangu", "ismu", "'y'"),
        ] {
            let analysis = analyze_word(Profile::Extended, word);
            assert_eq!(analysis.kind, WordKind::Lujvo);
            assert_eq!(
                analysis.readings[0][0],
                RecoveredPart {
                    text: first.into(),
                    kind: PartKind::Core,
                    join_before: None,
                }
            );
            let last_part = analysis.readings[0].last().unwrap();
            assert_eq!(last_part.text, last);
            assert_eq!(last_part.join_before.as_deref(), Some(join));
            assert_eq!(
                last_part.kind,
                if gismu_shape(last).is_some() {
                    PartKind::Rafsi
                } else {
                    PartKind::Core
                }
            );
        }
        let classic = analyze_word(Profile::Cll, "cuktysinxa");
        assert!(
            classic.readings[0]
                .iter()
                .all(|part| part.kind == PartKind::Rafsi)
        );
    }
    #[test]
    fn candidate_recognition_exhaustion_still_refuses_the_build() {
        for profile in [Profile::Cll, Profile::Extended] {
            let request = LujvoRequest {
                joins: vec![],
                spelling: None,
                profile,
                components: (0..40)
                    .map(|index| Component {
                        id: index.to_string(),
                        spelling: "ta".into(),
                        kind: "cmavo".into(),
                        definition: None,
                        claims: vec![Claim {
                            rafsi: "tca".into(),
                            pair: "pair-tca".into(),
                        }],
                        locked: Some("tca".into()),
                    })
                    .collect(),
                inventory: Inventory::default(),
                limits: Limits::default(),
            };
            assert!(
                matches!(build_lujvo(&request), Err(BuilderError::ResourceLimit { measure, value: 50_001, limit: 50_000 }) if measure == "recognition work")
            );
        }
    }
    fn conflict_request() -> LujvoRequest {
        let component = |id: &str, spelling: &str, rafsi: &str| Component {
            id: id.into(),
            spelling: spelling.into(),
            kind: "gismu".into(),
            definition: None,
            locked: None,
            claims: vec![Claim {
                rafsi: rafsi.into(),
                pair: format!("selected-{rafsi}"),
            }],
        };
        LujvoRequest {
            joins: vec![],
            spelling: None,
            profile: Profile::Cll,
            components: vec![
                component("a", "cukta", "cku"),
                component("b", "sinxa", "sni"),
            ],
            inventory: Inventory {
                snapshot: None,
                claims: (0..2)
                    .map(|n| InventoryClaim {
                        rafsi: "cku".into(),
                        word: format!("word-{n}"),
                        spelling: "test".into(),
                        pair: format!("other-{n}"),
                    })
                    .collect(),
            },
            limits: Limits {
                choice_product: 20_000,
                results: 1,
            },
        }
    }
    #[test]
    fn conflicts_are_described_only_for_selected_lujvo_candidates() {
        let mut request = conflict_request();
        let result =
            build_lujvo_with_detail_budget(&request, DetailBudget::new(100, 2, 1_000)).unwrap();
        assert_eq!(result.considered, 4);
        assert_eq!(result.candidates.len(), 1);
        assert_eq!(result.candidates[0].conflicts.len(), 2);
        request.limits.results = 2;
        assert!(
            matches!(build_lujvo_with_detail_budget(&request,DetailBudget::new(100,2,1_000)),Err(BuilderError::ResourceLimit {measure,..}) if measure=="conflict detail rows")
        );
    }
    #[test]
    fn lujvo_conflict_preflight_copies_nothing_when_it_refuses() {
        let request = conflict_request();
        let mut result = build_lujvo(&request).unwrap();
        for candidate in &mut result.candidates {
            candidate.conflicts.clear();
            candidate.unlisted.clear();
        }
        for budget in [
            DetailBudget::new(100, 1, 1_000),
            DetailBudget::new(100, 10, 1),
            DetailBudget::new(1, 10, 1_000),
        ] {
            assert!(matches!(
                add_conflict_details(&mut result.candidates, &request.inventory, &mut { budget }),
                Err(BuilderError::ResourceLimit { .. })
            ));
            assert!(
                result
                    .candidates
                    .iter()
                    .all(|c| c.conflicts.is_empty() && c.unlisted.is_empty())
            );
        }
    }
}
