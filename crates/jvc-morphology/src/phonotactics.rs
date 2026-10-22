//! Letters and consonant pairs of CLL chapter 3. Ported from jbotci.

/// The class of a consonant pair under CLL 3.6 and 3.7.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairClass {
    /// The pair cannot stand inside a word without a hyphen.
    Forbidden,
    /// The pair can stand inside a word but cannot begin one.
    Permissible,
    /// The pair can begin a word. Every initial pair is permissible.
    Initial,
}
impl PairClass {
    pub fn is_permissible(self) -> bool {
        !matches!(self, Self::Forbidden)
    }
    pub fn is_initial(self) -> bool {
        matches!(self, Self::Initial)
    }
}
pub const CONSONANTS: &str = "bcdfgjklmnprstvxz";
pub const VOWELS: &str = "aeiou";
const CONSONANT_ORDER: &str = "rlnmbvdgjzscxktfp";
use PairClass::{Forbidden as F, Initial as I, Permissible as P};
// CLL 3.6 defines permissible consonant pairs; CLL 3.7 defines the smaller
// subset that can begin ordinary words.
const PAIR_MATRIX: [[PairClass; 17]; 17] = [
    [F, P, P, P, P, P, P, P, P, P, P, P, P, P, P, P, P],
    [P, F, P, P, P, P, P, P, P, P, P, P, P, P, P, P, P],
    [P, P, F, P, P, P, P, P, P, P, P, P, P, P, P, P, P],
    [I, I, P, F, P, P, P, P, P, F, P, P, P, P, P, P, P],
    [I, I, P, P, F, P, P, P, P, P, F, F, F, F, F, F, F],
    [I, I, P, P, P, F, P, P, P, P, F, F, F, F, F, F, F],
    [I, P, P, P, P, P, F, P, I, I, F, F, F, F, F, F, F],
    [I, I, P, P, P, P, P, F, P, P, F, F, F, F, F, F, F],
    [P, P, P, I, I, I, I, I, F, F, F, F, F, F, F, F, F],
    [P, P, P, I, I, I, I, I, F, F, F, F, F, F, F, F, F],
    [I, I, I, I, F, F, F, F, F, F, F, F, P, I, I, I, I],
    [I, I, I, I, F, F, F, F, F, F, F, F, F, I, I, I, I],
    [I, I, P, P, F, F, F, F, F, F, P, F, F, F, P, P, P],
    [I, I, P, P, F, F, F, F, F, F, P, P, F, F, P, P, P],
    [I, P, P, P, F, F, F, F, F, F, I, I, P, P, F, P, P],
    [I, I, P, P, F, F, F, F, F, F, P, P, P, P, P, F, P],
    [I, I, P, P, F, F, F, F, F, F, P, P, P, P, P, P, F],
];
pub fn is_vowel(value: char) -> bool {
    matches!(value, 'a' | 'e' | 'i' | 'o' | 'u')
}
pub fn is_consonant(value: char) -> bool {
    CONSONANTS.contains(value)
}
/// The class of a pair of consonants, or None when either letter is not a consonant.
pub fn pair_class(first: char, second: char) -> Option<PairClass> {
    let a = CONSONANT_ORDER.find(first)?;
    let b = CONSONANT_ORDER.find(second)?;
    Some(PAIR_MATRIX[a][b])
}
pub fn is_initial_pair(first: char, second: char) -> bool {
    pair_class(first, second).is_some_and(PairClass::is_initial)
}
pub fn is_permissible_pair(first: char, second: char) -> bool {
    pair_class(first, second).is_some_and(PairClass::is_permissible)
}
/// Lowercase Lojban letters and apostrophes only. Returns None otherwise.
pub fn normalize_word(text: &str) -> Option<String> {
    let mut out = String::new();
    for value in text.trim().chars() {
        let lower = value.to_ascii_lowercase();
        match lower {
            '’' | 'h' => out.push('\''),
            'y' | '\'' => out.push(lower),
            _ if is_vowel(lower) || is_consonant(lower) => out.push(lower),
            ',' => {}
            _ => return None,
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classifies_pairs_from_cll() {
        assert_eq!(pair_class('b', 'l'), Some(PairClass::Initial));
        assert_eq!(pair_class('n', 'l'), Some(PairClass::Permissible));
        assert_eq!(pair_class('m', 'z'), Some(PairClass::Forbidden));
        assert_eq!(pair_class('b', 'n'), Some(PairClass::Permissible));
        assert_eq!(pair_class('c', 'x'), Some(PairClass::Forbidden));
        assert_eq!(pair_class('a', 'b'), None);
        assert!(is_initial_pair('s', 'k'));
        assert!(!is_initial_pair('n', 'r'));
        assert!(!is_initial_pair('b', 'n'));
    }
    #[test]
    fn normalizes_case_and_rejects_other_characters() {
        assert_eq!(normalize_word(" Sakli "), Some("sakli".into()));
        assert_eq!(normalize_word("sa'i"), Some("sa'i".into()));
        assert_eq!(normalize_word("sa,kli"), Some("sakli".into()));
        assert_eq!(normalize_word("sákli"), None);
        assert_eq!(normalize_word("sahi"), Some("sa'i".into()));
        assert_eq!(normalize_word("wakli"), None);
        assert_eq!(normalize_word(""), None);
    }
}
