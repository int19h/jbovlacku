//! Documented language weight profiles with pinned source references.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PresetLanguage {
    /// The definition-language tag used in formation sources.
    pub language: String,
    pub name: String,
    /// The relative weight numerator. The profile denominator is shared.
    pub numerator: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Preset {
    pub id: String,
    pub label: String,
    /// What the table records, in plain words.
    pub description: String,
    pub source_url: String,
    /// SHA-256 of the cited source bytes, recorded in evidence/presets.json.
    pub source_digest: String,
    /// A second reference when one exists.
    pub reference_url: Option<String>,
    pub denominator: u32,
    pub languages: Vec<PresetLanguage>,
}
const LANGSTAT: &str = "https://lojban.org/files/etymology/langstat99.htm";
const CLL_4_14: &str = "https://lojban.github.io/cll/4/14/";
const GIMYZBA: &str = "https://github.com/lynn/lynn.github.io/blob/567f4ada91/gimyzba/index.html";
const GIMYZBA_FIRST_COMMIT: &str = "https://github.com/lynn/lynn.github.io/commit/567f4ada91";
const GIMYZBA_README_2020: &str = "https://github.com/lynn/gimyzba/blob/b413e2b/README.md";
fn language(language: &str, name: &str, numerator: u32) -> PresetLanguage {
    PresetLanguage {
        language: language.into(),
        name: name.into(),
        numerator,
    }
}
/// The documented presets, in display order.
pub fn builder_presets() -> Vec<Preset> {
    vec![
        Preset {
            id: "cll-1995".into(),
            label: "CLL 1995".into(),
            description: "The updated six-language table of CLL chapter 4.14. The archive dates it to 1995.".into(),
            source_url: CLL_4_14.into(),
            source_digest: "ba8c352f9a2ae390a45f46d1b062534da2cc9280ca0ea9d3f507db38c312fb3f".into(),
            reference_url: Some(LANGSTAT.into()),
            denominator: 1000,
            languages: vec![language("cmn", "Mandarin Chinese", 347), language("hin", "Hindi", 196), language("eng", "English", 160), language("spa", "Spanish", 123), language("rus", "Russian", 89), language("ara", "Arabic", 85)],
        },
        Preset {
            id: "cll-1987".into(),
            label: "CLL 1987".into(),
            description: "The original 1987 gismu-remaking table of the Lojban language-statistics archive. It is not the rounded 1985 table of CLL.".into(),
            source_url: LANGSTAT.into(),
            source_digest: "5975cfcf8f4d5941810b50dd523ed2f1effa84e6c34fd47d2103ebcc150147f9".into(),
            reference_url: Some(CLL_4_14.into()),
            denominator: 1000,
            languages: vec![language("cmn", "Mandarin Chinese", 360), language("hin", "Hindi", 156), language("eng", "English", 208), language("spa", "Spanish", 116), language("rus", "Russian", 87), language("ara", "Arabic", 73)],
        },
        Preset {
            id: "ilmen6".into(),
            label: "Ilmen 6".into(),
            description: "The six-language table of lynn's gimyzba page, labeled there as first and second language speakers. It first appears in that page's first commit of 2026-06-16. The attribution to Ilmen is by name only, and the page names no population source.".into(),
            source_url: GIMYZBA.into(),
            source_digest: "2da167c4d5f66146d6083e36793d9142dc6fcf5e150ca8d702a09b75764dfaa7".into(),
            reference_url: Some(GIMYZBA_FIRST_COMMIT.into()),
            denominator: 1000,
            languages: vec![language("eng", "English", 339), language("cmn", "Mandarin Chinese", 255), language("hin", "Hindi", 136), language("spa", "Spanish", 126), language("ara", "Arabic", 74), language("fra", "French", 70)],
        },
        Preset {
            id: "ilmen8".into(),
            label: "Ilmen 8".into(),
            description: "The eight-language table that the lynn/gimyzba README credits to Ilmen. The README states no population data or method for deriving the weights.".into(),
            source_url: GIMYZBA.into(),
            source_digest: "2da167c4d5f66146d6083e36793d9142dc6fcf5e150ca8d702a09b75764dfaa7".into(),
            reference_url: Some(GIMYZBA_README_2020.into()),
            denominator: 1000,
            languages: vec![language("cmn", "Mandarin Chinese", 271), language("eng", "English", 170), language("spa", "Spanish", 130), language("hin", "Hindi", 125), language("ara", "Arabic", 104), language("ben", "Bengali", 76), language("rus", "Russian", 64), language("por", "Portuguese", 60)],
        },
        Preset {
            id: "ilmen12".into(),
            label: "Ilmen 12".into(),
            description: "The twelve-language table of lynn's gimyzba page. Its numerators sum to 999. It first appears in that page's first commit of 2026-06-16 and differs from Ilmen's 2016 table. The attribution to Ilmen is by name only, and the page names no population source.".into(),
            source_url: GIMYZBA.into(),
            source_digest: "2da167c4d5f66146d6083e36793d9142dc6fcf5e150ca8d702a09b75764dfaa7".into(),
            reference_url: Some(GIMYZBA_FIRST_COMMIT.into()),
            denominator: 1000,
            languages: vec![language("cmn", "Mandarin Chinese", 238), language("eng", "English", 160), language("spa", "Spanish", 113), language("hin", "Hindi", 108), language("ara", "Arabic", 90), language("ben", "Bengali", 66), language("rus", "Russian", 55), language("por", "Portuguese", 52), language("msa", "Malay", 32), language("jpn", "Japanese", 30), language("deu", "German", 29), language("fra", "French", 26)],
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preset_sums_and_sources() {
        let presets = builder_presets();
        let sum = |id: &str| {
            presets
                .iter()
                .find(|p| p.id == id)
                .unwrap()
                .languages
                .iter()
                .map(|l| l.numerator)
                .sum::<u32>()
        };
        assert_eq!(sum("cll-1987"), 1000);
        assert_eq!(sum("cll-1995"), 1000);
        assert_eq!(sum("ilmen6"), 1000);
        assert_eq!(sum("ilmen8"), 1000);
        assert_eq!(sum("ilmen12"), 999);
        for preset in &presets {
            assert!(preset.source_url.starts_with("https://"));
            assert_eq!(preset.source_digest.len(), 64);
            let mut languages: Vec<&str> = preset
                .languages
                .iter()
                .map(|l| l.language.as_str())
                .collect();
            languages.sort();
            languages.dedup();
            assert_eq!(
                languages.len(),
                preset.languages.len(),
                "{} repeats a language",
                preset.id
            );
        }
    }
    #[test]
    fn retained_source_tables_match_every_named_preset() {
        let evidence: serde_json::Value =
            serde_json::from_str(include_str!("../evidence/presets.json")).unwrap();
        for preset in builder_presets() {
            let table = evidence["tables"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["id"] == preset.id)
                .unwrap();
            let rows: Vec<_> = preset
                .languages
                .iter()
                .map(|l| serde_json::json!([l.language, l.numerator]))
                .collect();
            assert_eq!(serde_json::to_value(rows).unwrap(), table["weights"]);
            assert!(
                evidence["sources"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|s| s["sha256"] == preset.source_digest)
            );
        }
    }
}
