//! Rafsi and gismu shapes of CLL chapter 4. Ported from jbotci.
use crate::phonotactics::{is_consonant, is_initial_pair, is_permissible_pair, is_vowel};
use serde::{Deserialize, Serialize};

/// The shape of one rafsi or gismu form, with its CLL 4.12 shape rank.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RafsiShape {
    Cvccv,
    Cvcc,
    Ccvcv,
    Ccvc,
    Cvc,
    #[serde(rename = "cv'v")]
    CvhV,
    Ccv,
    Cvv,
    /// A form outside the CLL table. The extended scorer ranks it zero.
    Other,
}
impl RafsiShape {
    /// The CLL 4.12 shape score. `Other` is the extension rank zero.
    pub const fn score(self) -> i32 {
        match self {
            Self::Cvccv => 1,
            Self::Cvcc => 2,
            Self::Ccvcv => 3,
            Self::Ccvc => 4,
            Self::Cvc => 5,
            Self::CvhV => 6,
            Self::Ccv => 7,
            Self::Cvv => 8,
            Self::Other => 0,
        }
    }
    pub fn is_short(self) -> bool {
        matches!(self, Self::Cvc | Self::CvhV | Self::Ccv | Self::Cvv)
    }
}
fn classify_char(value: char) -> Option<char> {
    if is_vowel(value) {
        Some('V')
    } else if is_consonant(value) {
        Some('C')
    } else if value == '\'' {
        Some('\'')
    } else if value == 'y' {
        Some('Y')
    } else {
        None
    }
}
/// The shape of a whole form. Forms with other letters or lengths are Other.
pub fn rafsi_shape(text: &str) -> RafsiShape {
    let pattern: Option<String> = text.chars().map(classify_char).collect();
    let Some(pattern) = pattern else {
        return RafsiShape::Other;
    };
    match pattern.as_str() {
        "CVCCV" => RafsiShape::Cvccv,
        "CVCC" => RafsiShape::Cvcc,
        "CCVCV" => RafsiShape::Ccvcv,
        "CCVC" => RafsiShape::Ccvc,
        "CVC" => RafsiShape::Cvc,
        "CV'V" => RafsiShape::CvhV,
        "CCV" => RafsiShape::Ccv,
        "CVV" => RafsiShape::Cvv,
        _ => RafsiShape::Other,
    }
}
/// The two gismu shapes of CLL 4.4.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GismuShape {
    Ccvcv,
    Cvccv,
}
/// Classifies a five-letter gismu. The consonant pair must be permissible,
/// and an initial pair must be able to begin a word.
pub fn gismu_shape(word: &str) -> Option<GismuShape> {
    let letters: Vec<char> = word.chars().collect();
    if letters.len() != 5 {
        return None;
    }
    match rafsi_shape(word) {
        RafsiShape::Cvccv if is_permissible_pair(letters[2], letters[3]) => Some(GismuShape::Cvccv),
        RafsiShape::Ccvcv if is_initial_pair(letters[0], letters[1]) => Some(GismuShape::Ccvcv),
        _ => None,
    }
}
/// Whether a short rafsi spelling is well formed under CLL 4.6. A CCV form
/// needs an initial pair. A CVV form without an apostrophe needs one of the
/// four falling diphthongs ai, ei, oi, au.
pub fn is_short_rafsi_form(form: &str) -> bool {
    let letters: Vec<char> = form.chars().collect();
    match rafsi_shape(form) {
        RafsiShape::Cvc => true,
        RafsiShape::Ccv => is_initial_pair(letters[0], letters[1]),
        RafsiShape::CvhV => true,
        RafsiShape::Cvv => matches!(
            (letters[1], letters[2]),
            ('a', 'i') | ('e', 'i') | ('o', 'i') | ('a', 'u')
        ),
        _ => false,
    }
}
/// Every short rafsi that a gismu could claim under CLL 4.6, sorted, without duplicates.
pub fn possible_short_rafsi(gismu: &str) -> Vec<String> {
    let Some(shape) = gismu_shape(gismu) else {
        return Vec::new();
    };
    let l: Vec<char> = gismu.chars().collect();
    let mut forms: Vec<String> = Vec::new();
    let mut push = |form: String| {
        if is_short_rafsi_form(&form) {
            forms.push(form);
        }
    };
    match shape {
        GismuShape::Cvccv => {
            push(format!("{}{}{}", l[0], l[1], l[2]));
            push(format!("{}{}{}", l[0], l[1], l[3]));
            push(format!("{}{}'{}", l[0], l[1], l[4]));
            push(format!("{}{}{}", l[0], l[1], l[4]));
            push(format!("{}{}{}", l[2], l[3], l[4]));
            push(format!("{}{}{}", l[0], l[2], l[1]));
        }
        GismuShape::Ccvcv => {
            push(format!("{}{}{}", l[0], l[2], l[3]));
            push(format!("{}{}{}", l[1], l[2], l[3]));
            push(format!("{}{}'{}", l[0], l[2], l[4]));
            push(format!("{}{}{}", l[0], l[2], l[4]));
            push(format!("{}{}'{}", l[1], l[2], l[4]));
            push(format!("{}{}{}", l[1], l[2], l[4]));
            push(format!("{}{}{}", l[0], l[1], l[2]));
        }
    }
    forms.sort();
    forms.dedup();
    forms
}
/// The long forms every gismu has: the four-letter stem for nonfinal use and
/// the five-letter form for final use. `brod` is reserved (CLL 4.5), so
/// `broda` and its family have no stem.
pub fn universal_gismu_forms(gismu: &str) -> Option<(Option<String>, String)> {
    gismu_shape(gismu)?;
    let stem: String = gismu.chars().take(4).collect();
    let stem = if stem == "brod" { None } else { Some(stem) };
    Some((stem, gismu.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn derives_every_cvccv_short_rafsi() {
        assert_eq!(
            possible_short_rafsi("sakli"),
            vec!["kli", "sa'i", "sai", "sak", "sal", "ska"]
        );
    }
    #[test]
    fn derives_every_ccvcv_short_rafsi() {
        assert_eq!(
            possible_short_rafsi("bridi"),
            vec!["bi'i", "bid", "bri", "ri'i", "rid"]
        );
        assert_eq!(
            possible_short_rafsi("blaci"),
            vec!["ba'i", "bac", "bai", "bla", "la'i", "lac", "lai"]
        );
    }
    #[test]
    fn skips_ccv_forms_with_impermissible_initial_clusters() {
        assert_eq!(
            possible_short_rafsi("banli"),
            vec!["ba'i", "bai", "bal", "ban"]
        );
    }
    #[test]
    fn non_gismu_shapes_derive_no_short_rafsi() {
        for word in [
            "",
            "sakl",
            "sakliu",
            "coi",
            "jetcybolxada",
            "sákli",
            "toldu ",
            "mzaku",
        ] {
            assert!(possible_short_rafsi(word).is_empty(), "{word}");
            assert_eq!(gismu_shape(word), None, "{word}");
        }
        assert_eq!(gismu_shape("toldu"), Some(GismuShape::Cvccv));
        assert_eq!(possible_short_rafsi("toldu"), vec!["to'u", "tod", "tol"]);
    }
    #[test]
    fn short_rafsi_shapes_validate_the_whole_spelling() {
        for form in ["sal", "ska", "sa'i", "sai", "sei", "soi", "sau"] {
            assert!(is_short_rafsi_form(form), "{form}");
        }
        for form in [
            "sal!", "sa'i ", "sae", "sia", "sa", "salk", "", "nra", "bna", "sái",
        ] {
            assert!(!is_short_rafsi_form(form), "{form}");
        }
    }
    #[test]
    fn universal_forms_follow_cll() {
        assert_eq!(
            universal_gismu_forms("cukta"),
            Some((Some("cukt".into()), "cukta".into()))
        );
        assert_eq!(universal_gismu_forms("broda"), Some((None, "broda".into())));
        assert_eq!(universal_gismu_forms("coi"), None);
    }
}
