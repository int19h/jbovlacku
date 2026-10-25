//! Word recognition ported from jbotci 3d9fd41d9ed32de26311ee27ec86b6b165985aa1.
//! Contract macros and source diagnostics are removed. Consonant pairs follow CLL.
use crate::phonotactics::{is_initial_pair, is_permissible_pair};
use std::{cell::Cell, ops::Range};
struct ParsedOnset {
    end: usize,
    normalized: String,
}
enum FuhivlaHeadPolicy {
    Standard,
    ExperimentalCgv,
}
#[derive(Clone, Copy)]
struct LujvoPartRange {
    start: usize,
    end: usize,
}
impl LujvoPartRange {
    fn rafsi(start: usize, end: usize) -> Self {
        Self { start, end }
    }
    fn hyphen(start: usize, end: usize) -> Self {
        Self { start, end }
    }
}
#[derive(Clone, Copy)]
struct LujvoParseFailure {
    index: usize,
}
impl LujvoParseFailure {
    fn new(index: usize, _expected: LujvoParseExpectation) -> Self {
        Self { index }
    }
}
enum LujvoParseExpectation {
    FinalOrInitialRafsi,
    InitialOrStandaloneFinalRafsi,
}
struct LujvoRecognitionCache {
    experimental: bool,
    remaining: usize,
    spent: usize,
    exhausted: bool,
    lujvo_from_by_end: Vec<Vec<[Cell<Option<bool>>; 2]>>,
}
impl LujvoRecognitionCache {
    fn charge(&mut self) -> bool {
        if self.remaining == 0 {
            self.exhausted = true;
            false
        } else {
            self.remaining -= 1;
            self.spent += 1;
            true
        }
    }
    fn new(n: usize) -> Self {
        Self {
            experimental: false,
            remaining: 50_000,
            spent: 0,
            exhausted: false,
            lujvo_from_by_end: (0..=n)
                .map(|_| vec![[const { Cell::new(None) }; 2]; n + 1])
                .collect(),
        }
    }
    fn lujvo_from(&self, index: usize, end: usize, has_initial: bool) -> Option<bool> {
        self.lujvo_from_by_end[end][index][usize::from(has_initial)].get()
    }
    fn record_lujvo_from(&mut self, index: usize, end: usize, has_initial: bool, result: bool) {
        self.lujvo_from_by_end[end][index][usize::from(has_initial)].set(Some(result));
    }
}
fn record_lujvo_failure(
    failure: &mut Option<LujvoParseFailure>,
    index: usize,
    has_initial_rafsi: bool,
) {
    let expected = if has_initial_rafsi {
        LujvoParseExpectation::FinalOrInitialRafsi
    } else {
        LujvoParseExpectation::InitialOrStandaloneFinalRafsi
    };
    let candidate = LujvoParseFailure::new(index, expected);
    if failure.is_none_or(|current| candidate.index > current.index) {
        *failure = Some(candidate);
    }
}

fn parse_cmavo_form_chars(chars: &[char]) -> Option<String> {
    let mut normalized = String::new();
    let mut output = Some(&mut normalized);
    parse_cmavo_form_chars_into(chars, &mut output)?;
    Some(normalized)
}

fn matches_cmavo_form_chars(chars: &[char]) -> bool {
    let mut output = None;
    parse_cmavo_form_chars_into(chars, &mut output).is_some()
}

fn parse_cmavo_form_chars_into(chars: &[char], output: &mut Option<&mut String>) -> Option<()> {
    if chars.is_empty() {
        return None;
    }
    if chars.iter().all(|value| matches!(value, 'y' | 'ý')) {
        append_cmavo_chars(output, chars);
        return Some(());
    }
    if chars.len() == 1 && chars[0].is_ascii_digit() {
        append_cmavo_str(output, digit_to_cmavo(chars[0])?);
        return Some(());
    }
    parse_cmavo_form_main_into(chars, output)
}

fn append_cmavo_chars(output: &mut Option<&mut String>, chars: &[char]) {
    if let Some(text) = output.as_mut() {
        text.extend(chars.iter().copied());
    }
}

fn append_cmavo_str(output: &mut Option<&mut String>, value: &str) {
    if let Some(text) = output.as_mut() {
        text.push_str(value);
    }
}

fn append_cmavo_char(output: &mut Option<&mut String>, value: char) {
    if let Some(text) = output.as_mut() {
        text.push(value);
    }
}

fn parse_cmavo_form_main_into(chars: &[char], output: &mut Option<&mut String>) -> Option<()> {
    if chars.first().is_some_and(|value| *value == '\'') || starts_with_cluster(chars, 0) {
        return None;
    }
    for onset in parse_onsets(chars, 0) {
        if with_cmavo_output_rollback(output, |output| {
            append_cmavo_str(output, &onset.normalized);
            parse_cmavo_form_tail_into(chars, onset.end, output)
        })
        .is_some()
        {
            return Some(());
        }
    }
    None
}

fn parse_cmavo_form_tail_into(
    chars: &[char],
    start: usize,
    output: &mut Option<&mut String>,
) -> Option<()> {
    if let Some((semivowel, after_nucleus)) = parse_diphthong_end(chars, start) {
        if after_nucleus == chars.len() {
            append_cmavo_diphthong_nucleus(output, chars[start], semivowel);
            return Some(());
        }
        if chars.get(after_nucleus) == Some(&'\'')
            && with_cmavo_output_rollback(output, |output| {
                append_cmavo_diphthong_nucleus(output, chars[start], semivowel);
                append_cmavo_char(output, '\'');
                parse_cmavo_form_tail_into(chars, after_nucleus + 1, output)
            })
            .is_some()
        {
            return Some(());
        }
    }
    if let Some(after_nucleus) = parse_single_vowel_end(chars, start) {
        let value = chars[start];
        if after_nucleus == chars.len() {
            append_cmavo_single_nucleus(output, value);
            return Some(());
        }
        if chars.get(after_nucleus) == Some(&'\'')
            && with_cmavo_output_rollback(output, |output| {
                append_cmavo_single_nucleus(output, value);
                append_cmavo_char(output, '\'');
                parse_cmavo_form_tail_into(chars, after_nucleus + 1, output)
            })
            .is_some()
        {
            return Some(());
        }
    }
    None
}

fn append_cmavo_diphthong_nucleus(output: &mut Option<&mut String>, first: char, semivowel: char) {
    append_cmavo_char(output, normalize_vowel(first));
    append_cmavo_char(output, semivowel);
}

fn append_cmavo_single_nucleus(output: &mut Option<&mut String>, value: char) {
    let nucleus = if is_y(value) {
        value
    } else {
        normalize_vowel(value)
    };
    append_cmavo_char(output, nucleus);
}

fn with_cmavo_output_rollback(
    output: &mut Option<&mut String>,
    parse: impl FnOnce(&mut Option<&mut String>) -> Option<()>,
) -> Option<()> {
    let original_len = output.as_ref().map(|text| text.len());
    if parse(output).is_some() {
        return Some(());
    }
    if let Some(original_len) = original_len
        && let Some(text) = output.as_mut()
    {
        text.truncate(original_len);
    }
    None
}

fn parse_onsets(chars: &[char], start: usize) -> Vec<ParsedOnset> {
    let mut onsets = Vec::new();
    if let Some(end) = parse_glide_end(chars, start) {
        let glide = match chars[start] {
            'i' | 'í' | 'ĭ' => 'ĭ',
            'u' | 'ú' | 'ŭ' => 'ŭ',
            _ => unreachable!("parse_glide_end only accepts glide starts"),
        };
        onsets.push(ParsedOnset {
            end,
            normalized: glide.to_string(),
        });
    }
    for end in (start..=max_initial_end(chars, start)).rev() {
        if let Some(initial) = parse_initial(chars, start, end) {
            onsets.push(ParsedOnset {
                end,
                normalized: initial,
            });
        }
    }
    onsets
}

fn parse_initial(chars: &[char], start: usize, end: usize) -> Option<String> {
    parse_initial_end(chars, start, end)?;
    Some(chars[start..end].iter().collect())
}

fn max_initial_end(chars: &[char], start: usize) -> usize {
    chars.len().min(start + 3)
}

fn append_parse_onset_ends(chars: &[char], start: usize, ends: &mut Vec<usize>) {
    if let Some(end) = parse_glide_end(chars, start) {
        ends.push(end);
    }
    for end in (start..=max_initial_end(chars, start)).rev() {
        if parse_initial_end(chars, start, end).is_some() {
            ends.push(end);
        }
    }
}

fn has_parse_onset_end(chars: &[char], start: usize, target_end: usize) -> bool {
    if parse_glide_end(chars, start) == Some(target_end) {
        return true;
    }
    target_end >= start
        && target_end <= max_initial_end(chars, start)
        && parse_initial_end(chars, start, target_end).is_some()
}

fn has_parse_onset(chars: &[char], start: usize) -> bool {
    parse_glide_end(chars, start).is_some()
        || (start..=max_initial_end(chars, start))
            .rev()
            .any(|end| parse_initial_end(chars, start, end).is_some())
}

fn parse_initial_end(chars: &[char], start: usize, end: usize) -> Option<usize> {
    if !valid_initial_shape(chars, start, end) {
        return None;
    }
    if end < chars.len() && (is_consonant(chars[end]) || starts_glide(chars, end)) {
        return None;
    }
    Some(end)
}

fn valid_initial_shape(chars: &[char], start: usize, end: usize) -> bool {
    match end - start {
        0 => true,
        1 => is_consonant(chars[start]),
        2 => is_initial_pair(chars[start], chars[start + 1]),
        3 => valid_three_consonant_initial(chars, start),
        _ => false,
    }
}

fn append_parse_nucleus_ends(chars: &[char], start: usize, ends: &mut Vec<usize>) {
    if let Some((_, end)) = parse_diphthong_end(chars, start) {
        ends.push(end);
    }
    if let Some(end) = parse_single_vowel_end(chars, start) {
        ends.push(end);
    }
}

fn has_parse_nucleus_end(chars: &[char], start: usize, target_end: usize) -> bool {
    parse_diphthong_end(chars, start).is_some_and(|(_, end)| end == target_end)
        || parse_single_vowel_end(chars, start) == Some(target_end)
}

fn has_parse_nucleus_end_at_or_before(chars: &[char], start: usize, limit: usize) -> bool {
    parse_diphthong_end(chars, start).is_some_and(|(_, end)| end <= limit)
        || parse_single_vowel_end(chars, start).is_some_and(|end| end <= limit)
}

fn parse_diphthong_end(chars: &[char], start: usize) -> Option<(char, usize)> {
    let (semivowel, end) = raw_diphthong_end(chars, start)?;
    if next_non_comma_index(chars, end)
        .is_some_and(|next| matches_diphthong_semivowel(chars[next], semivowel))
    {
        return None;
    }
    if starts_with_nucleus(chars, end) {
        return None;
    }
    Some((semivowel, end))
}

fn matches_diphthong_semivowel(value: char, semivowel: char) -> bool {
    match semivowel {
        'ĭ' => matches!(value, 'i' | 'í' | 'ĭ'),
        'ŭ' => matches!(value, 'u' | 'ú' | 'ŭ'),
        _ => false,
    }
}

fn parse_single_vowel_end(chars: &[char], start: usize) -> Option<usize> {
    let value = *chars.get(start)?;
    if value == 'y' || value == 'ý' {
        let end = start + 1;
        if starts_with_nucleus(chars, end) {
            return None;
        }
        return Some(end);
    }
    if !is_vowel(value) && !matches!(value, 'ĭ' | 'ŭ') {
        return None;
    }
    let end = start + 1;
    if starts_with_nucleus(chars, end) {
        return None;
    }
    Some(end)
}

fn parse_glide_end(chars: &[char], start: usize) -> Option<usize> {
    starts_glide(chars, start).then_some(start + 1)
}

fn starts_with_nucleus(chars: &[char], start: usize) -> bool {
    if start >= chars.len() {
        return false;
    }
    parse_diphthong_end(chars, start).is_some() || parse_single_vowel_end(chars, start).is_some()
}

fn starts_with_cluster(chars: &[char], start: usize) -> bool {
    chars
        .get(start)
        .zip(chars.get(start + 1))
        .is_some_and(|(first, second)| is_consonant(*first) && is_consonant(*second))
}

fn blocks_word_shape(chars: &[char], allow_mz: bool) -> bool {
    has_invalid_apostrophe(chars)
        || has_digit_followed_by_nucleus(chars)
        || has_geminated_consonant(chars)
        || has_y_hiatus(chars)
        || has_vowel_hiatus(chars)
        || has_voicing_mismatch(chars)
        || has_forbidden_consonant_triple(chars)
        || has_forbidden_consonant_pair(chars, allow_mz)
}

fn has_voicing_mismatch(chars: &[char]) -> bool {
    voicing_mismatch_range(chars).is_some()
}

fn has_invalid_apostrophe(chars: &[char]) -> bool {
    invalid_apostrophe_range(chars).is_some()
}

fn invalid_apostrophe_range(chars: &[char]) -> Option<Range<usize>> {
    chars.iter().enumerate().find_map(|(index, value)| {
        (*value == '\''
            && (!previous_non_comma(chars, index)
                .is_some_and(|(_, previous)| can_precede_apostrophe(previous))
                || !starts_with_nucleus(chars, index + 1)))
        .then_some(index..index + 1)
    })
}

fn can_precede_apostrophe(value: char) -> bool {
    is_vowel(value) || is_y(value) || matches!(value, 'ĭ' | 'ŭ')
}

fn has_geminated_consonant(chars: &[char]) -> bool {
    geminated_consonant_range(chars).is_some()
}

fn geminated_consonant_range(chars: &[char]) -> Option<Range<usize>> {
    chars.iter().enumerate().find_map(|(index, value)| {
        if !is_consonant(*value) {
            return None;
        }
        let next = next_non_comma_index(chars, index + 1)?;
        (chars[next] == *value).then_some(index..next + 1)
    })
}

fn has_forbidden_consonant_triple(chars: &[char]) -> bool {
    forbidden_consonant_triple_range(chars).is_some()
}

fn forbidden_consonant_triple_range(chars: &[char]) -> Option<Range<usize>> {
    let mut first = None;
    let mut second = None;
    for (index, value) in chars.iter().copied().enumerate() {
        if !is_consonant(value) {
            first = None;
            second = None;
            continue;
        }
        if matches!(
            (first, second, value),
            (Some('n'), Some('d'), 'j' | 'z') | (Some('n'), Some('t'), 'c' | 's')
        ) {
            return Some(index - 2..index + 1);
        }
        first = second;
        second = Some(value);
    }
    None
}

fn has_forbidden_consonant_pair(chars: &[char], allow_mz: bool) -> bool {
    forbidden_consonant_pair_range(chars, allow_mz).is_some()
}

fn forbidden_consonant_pair_range(chars: &[char], allow_mz: bool) -> Option<Range<usize>> {
    chars.iter().enumerate().find_map(|(index, value)| {
        if !is_consonant(*value) {
            return None;
        }
        let next = next_non_comma_index(chars, index + 1)?;
        (is_consonant(chars[next])
            && !is_permissible_pair(*value, chars[next])
            && !(allow_mz && *value == 'm' && chars[next] == 'z'))
            .then_some(index..next + 1)
    })
}

fn has_digit_followed_by_nucleus(chars: &[char]) -> bool {
    digit_followed_by_nucleus_range(chars).is_some()
}

fn digit_followed_by_nucleus_range(chars: &[char]) -> Option<Range<usize>> {
    chars.iter().enumerate().find_map(|(index, value)| {
        if !value.is_ascii_digit() {
            return None;
        }
        let next = next_non_comma_index(chars, index + 1)?;
        starts_with_nucleus(chars, next).then_some(index..nucleus_end_for_span(chars, next))
    })
}

fn has_y_hiatus(chars: &[char]) -> bool {
    y_hiatus_range(chars).is_some()
}

fn y_hiatus_range(chars: &[char]) -> Option<Range<usize>> {
    chars.iter().enumerate().find_map(|(index, value)| {
        if !is_y(*value) {
            return None;
        }
        let next = next_non_comma_index(chars, index + 1)?;
        (!is_y(chars[next]) && starts_with_nucleus(chars, next))
            .then_some(index..nucleus_end_for_span(chars, next))
    })
}

fn is_vowel(value: char) -> bool {
    base_vowel(value).is_some()
}

fn base_vowel(value: char) -> Option<char> {
    match value {
        'a' | 'á' => Some('a'),
        'e' | 'é' => Some('e'),
        'i' | 'í' => Some('i'),
        'o' | 'ó' => Some('o'),
        'u' | 'ú' => Some('u'),
        _ => None,
    }
}

fn normalize_vowel(value: char) -> char {
    match value {
        'á' => 'á',
        'é' => 'é',
        'í' => 'í',
        'ó' => 'ó',
        'ú' => 'ú',
        'ĭ' => 'i',
        'ŭ' => 'u',
        _ => base_vowel(value).unwrap_or(value),
    }
}

fn is_consonant(value: char) -> bool {
    matches!(
        value,
        'b' | 'c'
            | 'd'
            | 'f'
            | 'g'
            | 'j'
            | 'k'
            | 'l'
            | 'm'
            | 'n'
            | 'p'
            | 'r'
            | 's'
            | 't'
            | 'v'
            | 'x'
            | 'z'
    )
}

fn starts_glide(chars: &[char], index: usize) -> bool {
    matches!(
        chars.get(index).copied(),
        Some('i' | 'í' | 'ĭ' | 'u' | 'ú' | 'ŭ')
    ) && next_starts_nucleus(chars, index + 1)
}

fn next_starts_nucleus(chars: &[char], mut index: usize) -> bool {
    while chars.get(index) == Some(&',') {
        index += 1;
    }
    starts_with_nucleus(chars, index)
}

fn previous_non_comma(chars: &[char], index: usize) -> Option<(usize, char)> {
    let mut cursor = index;
    while cursor > 0 {
        cursor -= 1;
        let value = chars[cursor];
        if value != ',' {
            return Some((cursor, value));
        }
    }
    None
}

fn cgv_range(chars: &[char]) -> Option<Range<usize>> {
    for (index, value) in chars.iter().copied().enumerate() {
        if !matches!(value, 'i' | 'í' | 'ĭ' | 'u' | 'ú' | 'ŭ') || !starts_glide(chars, index) {
            continue;
        }
        if let Some((previous_index, previous)) = previous_non_comma(chars, index)
            && is_consonant(previous)
        {
            return Some(previous_index..glide_end_for_span(chars, index));
        }
    }
    None
}

fn voicing_mismatch_range(chars: &[char]) -> Option<Range<usize>> {
    chars.iter().enumerate().find_map(|(index, value)| {
        let first_voicing = obstruent_voicing(*value)?;
        let next = next_non_comma_index(chars, index + 1)?;
        let second_voicing = obstruent_voicing(chars[next])?;
        (first_voicing != second_voicing).then_some(index..next + 1)
    })
}

fn obstruent_voicing(value: char) -> Option<bool> {
    match value {
        'b' | 'd' | 'g' | 'j' | 'v' | 'z' => Some(true),
        'c' | 'f' | 'k' | 'p' | 's' | 't' | 'x' => Some(false),
        _ => None,
    }
}

fn nucleus_end_for_span(chars: &[char], start: usize) -> usize {
    raw_diphthong_end(chars, start)
        .map(|(_, end)| end)
        .unwrap_or(start + 1)
}

fn glide_end_for_span(chars: &[char], start: usize) -> usize {
    next_non_comma_index(chars, start + 1)
        .filter(|next| starts_with_nucleus(chars, *next))
        .map(|next| nucleus_end_for_span(chars, next))
        .unwrap_or(start + 1)
}

fn is_gismu_chars(chars: &[char], allow_mz: bool) -> bool {
    match chars {
        [a, b, c, d, e] => {
            (is_consonant(*a)
                && is_vowel(*b)
                && is_consonant(*c)
                && is_consonant(*d)
                && is_vowel(*e)
                && (is_permissible_pair(*c, *d) || (allow_mz && *c == 'm' && *d == 'z')))
                || (is_initial_pair(*a, *b) && is_vowel(*c) && is_consonant(*d) && is_vowel(*e))
        }
        _ => false,
    }
}

#[allow(clippy::if_same_then_else)]
fn lujvo_from_until_with_cache(
    chars: &[char],
    index: usize,
    end: usize,
    has_initial_rafsi: bool,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    if let Some(result) = cache.lujvo_from(index, end, has_initial_rafsi) {
        return result;
    }
    let result = if index >= end {
        false
    } else if has_initial_rafsi && lujvo_core_part_ranges_until(chars, index, end, cache).is_some()
    {
        true
    } else if !has_initial_rafsi
        && lujvo_core_part_ranges_until(chars, index, end, cache)
            .is_some_and(|ranges| ranges.len() > 1)
    {
        true
    } else if !has_initial_rafsi && is_lujvo_final_rafsi_alone_until(chars, index, end) {
        true
    } else {
        initial_rafsi_ends_until_with_cache(chars, index, end, cache)
            .into_iter()
            .any(|next| next > index && lujvo_from_until_with_cache(chars, next, end, true, cache))
    };
    cache.record_lujvo_from(index, end, has_initial_rafsi, result);
    result
}

fn lujvo_part_ranges_from_with_cache(
    chars: &[char],
    index: usize,
    end: usize,
    has_initial_rafsi: bool,
    failure: &mut Option<LujvoParseFailure>,
    cache: &mut LujvoRecognitionCache,
) -> Option<Vec<LujvoPartRange>> {
    if !cache.charge() {
        return None;
    }
    if index >= end {
        record_lujvo_failure(failure, index, has_initial_rafsi);
        return None;
    }
    if has_initial_rafsi
        && let Some(ranges) = lujvo_core_part_ranges_until(chars, index, end, cache)
    {
        return Some(ranges);
    }
    if !has_initial_rafsi
        && let Some(ranges) = lujvo_core_part_ranges_until(chars, index, end, cache)
        && ranges.len() > 1
    {
        return Some(ranges);
    }
    if !has_initial_rafsi && is_lujvo_final_rafsi_alone_until(chars, index, end) {
        return Some(vec![LujvoPartRange::rafsi(index, end)]);
    }
    for next in initial_rafsi_ends_until_with_cache(chars, index, end, cache) {
        if next <= index {
            continue;
        }
        let Some(mut rest) =
            lujvo_part_ranges_from_with_cache(chars, next, end, true, failure, cache)
        else {
            continue;
        };
        let mut ranges = initial_rafsi_ranges(chars, index, next)?;
        ranges.append(&mut rest);
        return Some(ranges);
    }
    record_lujvo_failure(failure, index, has_initial_rafsi);
    None
}

fn initial_rafsi_ranges(chars: &[char], start: usize, end: usize) -> Option<Vec<LujvoPartRange>> {
    if let Some(hyphen_start) = (start + 1..end).find(|index| is_rafsi_hyphen_start(chars, *index))
    {
        return Some(vec![
            LujvoPartRange::rafsi(start, hyphen_start),
            LujvoPartRange::hyphen(hyphen_start, end),
        ]);
    }
    if let Some(hyphen_start) = cvv_rafsi_hyphen_start_for_initial_end(chars, start, end) {
        return Some(vec![
            LujvoPartRange::rafsi(start, hyphen_start),
            LujvoPartRange::hyphen(hyphen_start, end),
        ]);
    }
    Some(vec![LujvoPartRange::rafsi(start, end)])
}

fn is_rafsi_hyphen_start(chars: &[char], index: usize) -> bool {
    chars.get(index).is_some_and(|value| is_y(*value))
        || (chars.get(index) == Some(&'\'')
            && chars.get(index + 1).is_some_and(|value| is_y(*value)))
}

fn starts_with_cvcy_lujvo_chars_with_cache(
    chars: &[char],
    index: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    let Some(base_end) = cvc_rafsi_end(chars, index) else {
        return false;
    };
    if base_end >= end || !chars.get(base_end).is_some_and(|value| is_y(*value)) {
        return false;
    }
    let mut after_hyphen = base_end + 1;
    if chars.get(after_hyphen) == Some(&'\'') {
        after_hyphen += 1;
    }
    after_hyphen <= end && lujvo_from_until_with_cache(chars, after_hyphen, end, true, cache)
}

fn lujvo_core_part_ranges_until(
    chars: &[char],
    index: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> Option<Vec<LujvoPartRange>> {
    if !cache.charge() {
        return None;
    }
    if is_gismu_slice(chars, index, end, cache.experimental)
        || is_short_final_rafsi_slice(chars, index, end)
        || is_cvv_final_rafsi_slice(chars, index, end)
        || is_fuhivla_shape_slice_with_cache(chars, index, end, cache)
    {
        return Some(vec![LujvoPartRange::rafsi(index, end)]);
    }
    let split = stressed_initial_rafsi_short_final_split_with_cache(chars, index, end, cache)?;
    let mut ranges = initial_rafsi_ranges(chars, index, split)?;
    ranges.push(LujvoPartRange::rafsi(split, end));
    Some(ranges)
}

fn is_lujvo_final_rafsi_alone_until(chars: &[char], index: usize, end: usize) -> bool {
    is_cvv_final_rafsi_slice(chars, index, end)
}

fn initial_rafsi_ends_until_with_cache(
    chars: &[char],
    index: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> Vec<usize> {
    if !cache.charge() {
        return Vec::new();
    }
    let mut ends = Vec::new();
    let extended = extended_rafsi_ends_until_with_cache(chars, index, end, cache);
    ends.extend(extended.iter().copied());
    ends.extend(
        y_rafsi_ends(chars, index)
            .into_iter()
            .filter(|next| *next <= end),
    );
    if !any_extended_rafsi_starts_until_with_cache(chars, index, end, cache) {
        ends.extend(y_less_rafsi_ends(chars, index).into_iter().filter(|next| {
            *next <= end && !any_extended_rafsi_starts_until_with_cache(chars, *next, end, cache)
        }));
    }

    let mut preferred_ends = Vec::new();
    for end in ends {
        if !preferred_ends.contains(&end) {
            preferred_ends.push(end);
        }
    }
    preferred_ends
}

fn any_extended_rafsi_starts_until_with_cache(
    chars: &[char],
    index: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    if cache.experimental {
        return index < end
            && (is_fuhivla_shape_slice_with_cache(chars, index, end, cache)
                || !fuhivla_rafsi_base_ends_until_with_cache(chars, index, end, cache).is_empty()
                || ((index + 1)..=end).any(|next| {
                    stressed_fuhivla_rafsi_slice_with_cache(chars, index, next, cache)
                }));
    }
    index < end
        && (is_fuhivla_shape_slice_with_cache(chars, index, end, cache)
            || !extended_rafsi_ends_until_with_cache(chars, index, end, cache).is_empty()
            || !stressed_extended_rafsi_ends_until_with_cache(chars, index, end, cache).is_empty())
}

fn stressed_extended_rafsi_ends_until_with_cache(
    chars: &[char],
    index: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> Vec<usize> {
    if !cache.charge() {
        return Vec::new();
    }
    ((index + 1)..=end)
        .filter(|next| stressed_extended_rafsi_slice_with_cache(chars, index, *next, cache))
        .collect()
}

fn extended_rafsi_ends_until_with_cache(
    chars: &[char],
    index: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> Vec<usize> {
    if !cache.charge() {
        return Vec::new();
    }
    let mut ends = Vec::new();
    for base_end in fuhivla_rafsi_base_ends_until_with_cache(chars, index, end, cache) {
        if let Some(next) = rafsi_hyphen_end(chars, base_end)
            && next <= end
        {
            ends.push(next);
        }
    }
    if cache.experimental {
        ends.extend(
            hy_rafsi_ends(chars, index)
                .into_iter()
                .filter(|next| *next <= end),
        );
    } else {
        for base_end in brivla_head_ends_until_with_cache(chars, index, end, cache) {
            if chars[index..base_end].iter().any(|value| is_y(*value)) {
                continue;
            }
            if let Some(next) = hy_rafsi_hyphen_end(chars, base_end)
                && next <= end
            {
                ends.push(next);
            }
        }
    }
    ends
}

fn stressed_initial_rafsi_short_final_split_with_cache(
    chars: &[char],
    start: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> Option<usize> {
    if !cache.charge() {
        return None;
    }
    (start + 1..end).rev().find(|split| {
        is_short_final_rafsi_slice(chars, *split, end)
            && stressed_initial_rafsi_slice_with_cache(chars, start, *split, cache)
    })
}

fn stressed_initial_rafsi_slice_with_cache(
    chars: &[char],
    start: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    stressed_extended_rafsi_slice_with_cache(chars, start, end, cache)
        || stressed_y_rafsi_slice(chars, start, end)
        || stressed_y_less_rafsi_slice(chars, start, end)
}

fn stressed_extended_rafsi_slice_with_cache(
    chars: &[char],
    start: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    (if cache.experimental {
        hy_rafsi_slice(chars, start, end)
    } else {
        stressed_brivla_rafsi_slice_with_cache(chars, start, end, cache)
    }) || stressed_fuhivla_rafsi_slice_with_cache(chars, start, end, cache)
}

fn stressed_y_rafsi_slice(chars: &[char], start: usize, end: usize) -> bool {
    y_rafsi_slice(chars, start, end)
}

fn stressed_y_less_rafsi_slice(chars: &[char], start: usize, end: usize) -> bool {
    y_less_rafsi_ends(chars, start)
        .into_iter()
        .any(|rafsi_end| rafsi_end == end)
}

fn stressed_brivla_rafsi_slice_with_cache(
    chars: &[char],
    start: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    if end < start + 3
        || chars.get(end - 2) != Some(&'\'')
        || !chars.get(end - 1).is_some_and(|value| is_y(*value))
    {
        return false;
    }
    let stress_end = end - 2;
    brivla_head_ends_until_with_cache(chars, start, stress_end, cache)
        .into_iter()
        .filter(|head_end| *head_end < stress_end)
        .any(|head_end| {
            stressed_syllable_ends_for_profile(chars, head_end, stress_end, cache.experimental)
                .into_iter()
                .any(|syllable_end| syllable_end == stress_end)
        })
}

fn stressed_fuhivla_rafsi_slice_with_cache(
    chars: &[char],
    start: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    if end < start + 2 || !chars.get(end - 1).is_some_and(|value| is_y(*value)) {
        return false;
    }
    let base_end = end - 1;
    fuhivla_head_ends_until_with_cache(chars, start, base_end, cache)
        .into_iter()
        .filter(|head_end| *head_end < base_end)
        .any(|head_end| {
            stressed_syllable_ends_for_profile(chars, head_end, base_end, cache.experimental)
                .into_iter()
                .any(|stressed_end| {
                    consonantal_chain_then_onset(chars, stressed_end, base_end, cache.experimental)
                })
        })
}

fn consonantal_chain_then_onset(
    chars: &[char],
    index: usize,
    end: usize,
    experimental: bool,
) -> bool {
    if (experimental && chars.get(index) == Some(&'\'') && index + 1 == end)
        || ((experimental || chars.get(index) != Some(&'\''))
            && has_parse_onset_end(chars, index, end))
    {
        return true;
    }
    consonantal_syllable_ends(chars, index, end)
        .into_iter()
        .any(|next| next > index && consonantal_chain_then_onset(chars, next, end, experimental))
}

fn fuhivla_rafsi_base_ends_until_with_cache(
    chars: &[char],
    index: usize,
    lookahead_end: usize,
    cache: &mut LujvoRecognitionCache,
) -> Vec<usize> {
    if !cache.charge() {
        return Vec::new();
    }
    let mut ends = Vec::new();
    for base_end in (index + 1)..lookahead_end {
        if rafsi_hyphen_end(chars, base_end).is_some()
            && fuhivla_rafsi_base_slice_with_cache(chars, index, base_end, lookahead_end, cache)
        {
            ends.push(base_end);
        }
    }
    ends
}

fn fuhivla_rafsi_base_slice_with_cache(
    chars: &[char],
    start: usize,
    end: usize,
    lookahead_end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    if start >= end
        || chars[start..end].iter().any(|value| is_y(*value))
        || unstressed_syllable_ends_for_fuhivla(chars, start, end).is_empty()
    {
        return false;
    }
    fuhivla_head_ends_until_with_cache(chars, start, lookahead_end, cache)
        .into_iter()
        .filter(|head_end| *head_end > start && *head_end < end)
        .any(|head_end| {
            (cache.experimental && chars.get(head_end) == Some(&'\'') && head_end + 1 == end)
                || ((cache.experimental || chars.get(head_end) != Some(&'\''))
                    && has_parse_onset_end(chars, head_end, end))
        })
}

fn brivla_head_ends_until_with_cache(
    chars: &[char],
    index: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> Vec<usize> {
    if !cache.charge() {
        return Vec::new();
    }
    if index > end
        || chars.get(index) == Some(&'\'')
        || !starts_with_onset(chars, index)
        || cmavo_word_slice_with_cache(chars, index, end, cache)
        || slinkuhi_slice_with_cache(chars, index, end, cache)
    {
        return Vec::new();
    }

    brivla_head_ends_without_lookahead(chars, index, end)
}

fn fuhivla_head_ends_until_with_cache(
    chars: &[char],
    index: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> Vec<usize> {
    if !cache.charge() {
        return Vec::new();
    }
    if rafsi_string_starts_slice_with_cache(chars, index, end, cache) {
        return Vec::new();
    }
    brivla_head_ends_until_with_cache(chars, index, end, cache)
}

fn brivla_head_ends_without_lookahead(chars: &[char], index: usize, end: usize) -> Vec<usize> {
    let mut ends = vec![index];
    let mut stack = vec![index];
    while let Some(start) = stack.pop() {
        for syllable_end in unstressed_syllable_ends_for_fuhivla(chars, start, end) {
            if syllable_end > start && !ends.contains(&syllable_end) {
                ends.push(syllable_end);
                stack.push(syllable_end);
            }
        }
    }
    ends.sort_unstable();
    ends
}

fn slinkuhi_slice_with_cache(
    chars: &[char],
    start: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    start < end
        && !rafsi_string_starts_slice_with_cache(chars, start, end, cache)
        && is_consonant(chars[start])
        && rafsi_string_starts_slice_with_cache(chars, start + 1, end, cache)
}

fn rafsi_string_starts_slice_with_cache(
    chars: &[char],
    start: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    start < end
        && ((start + 1)..=end).any(|word_end| {
            rafsi_string_slice_for_lookahead_with_cache(chars, start, word_end, end, cache)
        })
}

fn rafsi_string_slice_for_lookahead_with_cache(
    chars: &[char],
    start: usize,
    end: usize,
    lookahead_end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    rafsi_string_from_with_cache(chars, start, end, lookahead_end, cache)
}

fn rafsi_string_from_with_cache(
    chars: &[char],
    start: usize,
    end: usize,
    lookahead_end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    if start >= end {
        return false;
    }
    let mut cursor = start;
    while cursor < end {
        let Some(next) = greedy_y_less_rafsi_end(chars, cursor, end, lookahead_end) else {
            break;
        };
        cursor = next;
    }
    rafsi_string_ending_with_cache(chars, cursor, end, lookahead_end, cache)
}

fn greedy_y_less_rafsi_end(
    chars: &[char],
    index: usize,
    end: usize,
    lookahead_end: usize,
) -> Option<usize> {
    y_less_rafsi_ends(chars, index).into_iter().find(|next| {
        *next <= end && y_less_rafsi_is_unstressed_in_context(chars, index, *next, lookahead_end)
    })
}

fn y_less_rafsi_is_unstressed_in_context(
    chars: &[char],
    start: usize,
    end: usize,
    context_end: usize,
) -> bool {
    if cvc_rafsi_end(chars, start) == Some(end) {
        return !nucleus_is_stressed_in_context(chars, start + 1, start + 2, context_end);
    }
    if ccv_rafsi_end(chars, start) == Some(end) {
        return !nucleus_is_stressed_in_context(chars, start + 2, start + 3, context_end);
    }
    cvv_rafsi_is_unstressed_in_context(chars, start, end, context_end)
}

// Preserve the pinned parser branch order.
#[allow(clippy::if_same_then_else)]
fn cvv_rafsi_is_unstressed_in_context(
    chars: &[char],
    start: usize,
    end: usize,
    context_end: usize,
) -> bool {
    if start >= end || !is_consonant(chars[start]) {
        return false;
    }
    for vowel_end in vowel_pair_ends(chars, start + 1) {
        let rafsi_end = if end == vowel_end {
            Some(vowel_end)
        } else if r_hyphen_end(chars, vowel_end) == Some(end) {
            Some(end)
        } else if n_hyphen_end(chars, vowel_end) == Some(end) {
            Some(end)
        } else {
            None
        };
        if rafsi_end.is_none() {
            continue;
        }
        if chars.get(start + 2) == Some(&'\'') && vowel_end == start + 4 {
            return !nucleus_is_stressed_in_context(chars, start + 1, start + 2, context_end)
                && !nucleus_is_stressed_in_context(chars, start + 3, start + 4, context_end);
        }
        if vowel_end == start + 3 {
            return !nucleus_is_stressed_in_context(chars, start + 1, vowel_end, context_end);
        }
    }
    false
}

fn nucleus_is_stressed_in_context(
    chars: &[char],
    start: usize,
    end: usize,
    context_end: usize,
) -> bool {
    syllable_has_explicit_stress(chars, start, end)
        || nucleus_has_implicit_stress(chars, end, context_end)
}

fn nucleus_has_implicit_stress(chars: &[char], index: usize, context_end: usize) -> bool {
    let mut stack = vec![index];
    let mut after_consonants_or_glides = Vec::new();
    while let Some(cursor) = stack.pop() {
        if after_consonants_or_glides.contains(&cursor) {
            continue;
        }
        after_consonants_or_glides.push(cursor);
        if cursor < context_end && is_consonant(chars[cursor]) {
            stack.push(cursor + 1);
        }
        if let Some(glide_end) = parse_glide_end(chars, cursor)
            && glide_end <= context_end
        {
            stack.push(glide_end);
        }
    }

    after_consonants_or_glides
        .into_iter()
        .any(|cursor| stress_tail_reaches_boundary(chars, cursor, context_end))
}

fn stress_tail_reaches_boundary(chars: &[char], index: usize, context_end: usize) -> bool {
    let mut after_h = vec![index];
    if index < context_end && chars.get(index) == Some(&'\'') {
        after_h.push(index + 1);
    }
    after_h.into_iter().any(|cursor| {
        let mut after_y = vec![cursor];
        if cursor < context_end && chars.get(cursor).is_some_and(|value| is_y(*value)) {
            after_y.push(cursor + 1);
        }
        after_y.into_iter().any(|syllable_start| {
            syllable_ends(chars, syllable_start, context_end)
                .into_iter()
                .any(|syllable_end| syllable_end == context_end)
        })
    })
}

fn rafsi_string_ending_with_cache(
    chars: &[char],
    start: usize,
    end: usize,
    lookahead_end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    (is_gismu_slice_for_rafsi_string(chars, start, end, lookahead_end, cache.experimental)
        && post_word_slice_with_cache(chars, end, lookahead_end, cache))
        || (is_cvv_final_rafsi_slice_for_rafsi_string(chars, start, end, lookahead_end)
            && post_word_slice_with_cache(chars, end, lookahead_end, cache))
        || y_less_rafsi_ends(chars, start).into_iter().any(|mid| {
            mid > start
                && mid < end
                && is_short_final_rafsi_slice_for_rafsi_string(chars, mid, end, lookahead_end)
                && post_word_slice_with_cache(chars, end, lookahead_end, cache)
        })
        || y_rafsi_slice(chars, start, end)
        || hy_rafsi_slice(chars, start, end)
        || (cache.experimental && initial_pair_y_ending(chars, start, end))
}
fn initial_pair_y_ending(chars: &[char], start: usize, end: usize) -> bool {
    let pair_y = |index| {
        index + 3 == end
            && is_initial_pair(chars[index], chars[index + 1])
            && chars[index + 2] == 'y'
    };
    (start + 3 <= end && pair_y(start))
        || y_less_rafsi_ends(chars, start)
            .into_iter()
            .any(|next| next + 3 <= end && pair_y(next))
}

// Preserve the pinned parser branch order.
#[allow(clippy::if_same_then_else)]
fn is_gismu_slice_for_rafsi_string(
    chars: &[char],
    start: usize,
    end: usize,
    lookahead_end: usize,
    allow_mz: bool,
) -> bool {
    if end != start + 5 {
        return false;
    }
    let final_start = if is_initial_pair(chars[start], chars[start + 1])
        && is_vowel(chars[start + 2])
        && is_consonant(chars[start + 3])
        && is_vowel(chars[start + 4])
    {
        start + 3
    } else if is_consonant(chars[start])
        && is_vowel(chars[start + 1])
        && is_consonant(chars[start + 2])
        && is_consonant(chars[start + 3])
        && is_vowel(chars[start + 4])
        && (is_permissible_pair(chars[start + 2], chars[start + 3])
            || (allow_mz && chars[start + 2] == 'm' && chars[start + 3] == 'z'))
    {
        start + 3
    } else {
        return false;
    };
    syllable_is_stressed_in_context(chars, start, final_start, lookahead_end)
        && final_syllable_slice_in_context(chars, final_start, end, lookahead_end)
}

fn is_cvv_final_rafsi_slice_for_rafsi_string(
    chars: &[char],
    start: usize,
    end: usize,
    lookahead_end: usize,
) -> bool {
    end == start + 4
        && is_consonant(chars[start])
        && is_vowel(chars[start + 1])
        && chars[start + 2] == '\''
        && is_vowel(chars[start + 3])
        && syllable_is_stressed_in_context(chars, start, start + 2, lookahead_end)
        && final_syllable_slice_in_context(chars, start + 3, end, lookahead_end)
}

fn is_short_final_rafsi_slice_for_rafsi_string(
    chars: &[char],
    start: usize,
    end: usize,
    lookahead_end: usize,
) -> bool {
    is_short_final_rafsi_slice(chars, start, end)
        && final_syllable_slice_in_context(chars, start, end, lookahead_end)
}

fn syllable_is_stressed_in_context(
    chars: &[char],
    start: usize,
    syllable_end: usize,
    context_end: usize,
) -> bool {
    syllable_has_explicit_stress(chars, start, syllable_end)
        || stressed_syllable_has_implicit_stress(chars, start, syllable_end, context_end)
}

fn final_syllable_slice_in_context(
    chars: &[char],
    start: usize,
    end: usize,
    context_end: usize,
) -> bool {
    final_syllable_slice(chars, start, end)
        && !stressed_syllable_has_implicit_stress(chars, start, end, context_end)
}

fn post_word_slice_with_cache(
    chars: &[char],
    index: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    let Some(next) = next_non_comma_index(chars, index) else {
        return true;
    };
    next >= end
        || (!starts_with_pause_required_nucleus(chars, next)
            && lojban_word_slice_with_cache(chars, next, end, cache))
}

fn y_rafsi_ends(chars: &[char], index: usize) -> Vec<usize> {
    let mut ends = Vec::new();
    for base_end in long_rafsi_ends(chars, index)
        .into_iter()
        .chain(cvc_rafsi_end(chars, index))
    {
        if chars.get(base_end).is_some_and(|value| is_y(*value)) {
            let mut end = base_end + 1;
            if chars.get(end) == Some(&'\'') {
                end += 1;
            }
            ends.push(end);
        }
    }
    ends
}

fn y_rafsi_slice(chars: &[char], start: usize, end: usize) -> bool {
    long_rafsi_ends(chars, start)
        .into_iter()
        .chain(cvc_rafsi_end(chars, start))
        .any(|base_end| rafsi_hyphen_end(chars, base_end) == Some(end))
}

fn y_less_rafsi_ends(chars: &[char], index: usize) -> Vec<usize> {
    if !y_rafsi_ends(chars, index).is_empty() || !hy_rafsi_ends(chars, index).is_empty() {
        return Vec::new();
    }

    let mut ends = Vec::new();
    if let Some(end) = cvc_rafsi_end(chars, index) {
        ends.push(end);
    }
    if let Some(end) = ccv_rafsi_end(chars, index) {
        ends.push(end);
    }
    ends.extend(initial_cvv_rafsi_ends(chars, index));
    ends.retain(|end| chars.get(*end) != Some(&'\''));
    ends
}

fn hy_rafsi_slice(chars: &[char], start: usize, end: usize) -> bool {
    hy_rafsi_ends(chars, start)
        .into_iter()
        .any(|hy_rafsi_end| hy_rafsi_end == end)
}

fn hy_rafsi_ends(chars: &[char], index: usize) -> Vec<usize> {
    let mut ends = Vec::new();
    for base_end in long_rafsi_ends(chars, index) {
        if chars.get(base_end).is_some_and(|value| is_vowel(*value))
            && let Some(end) = hy_rafsi_hyphen_end(chars, base_end + 1)
        {
            ends.push(end);
        }
    }
    for base_end in ccv_rafsi_end(chars, index)
        .into_iter()
        .chain(cvv_rafsi_base_ends(chars, index))
    {
        if let Some(end) = hy_rafsi_hyphen_end(chars, base_end) {
            ends.push(end);
        }
    }
    ends
}

fn rafsi_hyphen_end(chars: &[char], index: usize) -> Option<usize> {
    if chars.get(index).is_some_and(|value| is_y(*value)) {
        let mut end = index + 1;
        if chars.get(end) == Some(&'\'') {
            end += 1;
        }
        Some(end)
    } else {
        None
    }
}

fn hy_rafsi_hyphen_end(chars: &[char], index: usize) -> Option<usize> {
    if chars.get(index) == Some(&'\'') && chars.get(index + 1).is_some_and(|value| is_y(*value)) {
        let mut end = index + 2;
        if chars.get(end) == Some(&'\'') {
            end += 1;
        }
        Some(end)
    } else {
        None
    }
}

fn long_rafsi_ends(chars: &[char], index: usize) -> Vec<usize> {
    let mut ends = Vec::new();
    if index + 4 <= chars.len()
        && is_initial_pair(chars[index], chars[index + 1])
        && is_vowel(chars[index + 2])
        && is_consonant(chars[index + 3])
    {
        ends.push(index + 4);
    }
    if index + 4 <= chars.len()
        && is_consonant(chars[index])
        && is_vowel(chars[index + 1])
        && is_consonant(chars[index + 2])
        && is_consonant(chars[index + 3])
    {
        ends.push(index + 4);
    }
    ends
}

fn cvc_rafsi_end(chars: &[char], index: usize) -> Option<usize> {
    (index + 3 <= chars.len()
        && is_consonant(chars[index])
        && is_vowel(chars[index + 1])
        && is_consonant(chars[index + 2]))
    .then_some(index + 3)
}

fn ccv_rafsi_end(chars: &[char], index: usize) -> Option<usize> {
    (index + 3 <= chars.len()
        && is_initial_pair(chars[index], chars[index + 1])
        && is_vowel(chars[index + 2]))
    .then_some(index + 3)
}

fn initial_cvv_rafsi_ends(chars: &[char], index: usize) -> Vec<usize> {
    let mut ends = Vec::new();
    for base_end in cvv_rafsi_base_ends(chars, index) {
        if let Some(end) = r_hyphen_end(chars, base_end).or_else(|| n_hyphen_end(chars, base_end)) {
            ends.push(end);
        }
        ends.push(base_end);
    }
    ends
}

fn cvv_rafsi_base_ends(chars: &[char], index: usize) -> Vec<usize> {
    let mut ends = Vec::new();
    if index < chars.len() && is_consonant(chars[index]) {
        ends.extend(vowel_pair_ends(chars, index + 1));
    }
    ends
}

fn cvv_rafsi_hyphen_start_for_initial_end(
    chars: &[char],
    start: usize,
    end: usize,
) -> Option<usize> {
    cvv_rafsi_base_ends(chars, start)
        .into_iter()
        .find(|base_end| {
            r_hyphen_end(chars, *base_end) == Some(end)
                || n_hyphen_end(chars, *base_end) == Some(end)
        })
}

fn r_hyphen_end(chars: &[char], index: usize) -> Option<usize> {
    (chars.get(index) == Some(&'r')
        && chars
            .get(index + 1)
            .is_some_and(|value| is_consonant(*value)))
    .then_some(index + 1)
}

fn n_hyphen_end(chars: &[char], index: usize) -> Option<usize> {
    (chars.get(index) == Some(&'n') && chars.get(index + 1) == Some(&'r')).then_some(index + 1)
}

fn vowel_pair_ends(chars: &[char], index: usize) -> Vec<usize> {
    let mut ends = Vec::new();
    if index + 3 <= chars.len()
        && is_vowel(chars[index])
        && chars[index + 1] == '\''
        && is_vowel(chars[index + 2])
    {
        ends.push(index + 3);
    }
    if index + 2 <= chars.len() && is_diphthong_pair(chars[index], chars[index + 1]) {
        ends.push(index + 2);
    }
    ends
}

fn is_gismu_slice(chars: &[char], start: usize, end: usize, allow_mz: bool) -> bool {
    end > start && is_gismu_chars(&chars[start..end], allow_mz)
}

fn is_short_final_rafsi_slice(chars: &[char], start: usize, end: usize) -> bool {
    if start >= end {
        return false;
    }
    if end == start + 3
        && is_consonant(chars[start])
        && is_diphthong_pair(chars[start + 1], chars[start + 2])
    {
        return true;
    }
    if end == start + 3
        && is_initial_pair(chars[start], chars[start + 1])
        && is_vowel(chars[start + 2])
    {
        return true;
    }
    end == start + 4
        && is_consonant(chars[start])
        && is_vowel(chars[start + 1])
        && chars[start + 2] == '\''
        && is_vowel(chars[start + 3])
}

fn is_cvv_final_rafsi_slice(chars: &[char], start: usize, end: usize) -> bool {
    if start >= end || !is_consonant(chars[start]) {
        return false;
    }
    vowel_pair_ends(chars, start + 1)
        .into_iter()
        .any(|vowel_end| vowel_end == end)
}

fn is_fuhivla_shape_slice_with_cache(
    chars: &[char],
    start: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    is_fuhivla_shape_slice_with_y_policy_with_cache(chars, start, end, false, cache)
}

fn is_fuhivla_shape_slice_with_y_policy_with_cache(
    chars: &[char],
    start: usize,
    end: usize,
    allows_y: bool,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    if end <= start
        || end - start < 4
        || !ends_with_vocalic_nucleus(chars, start, end)
        || count_vocalic_nuclei(chars, start, end) < 2
        || (!allows_y && chars[start..end].iter().any(|value| is_y(*value)))
        || has_vowel_hiatus(&chars[start..end])
        || !parse_fuhivla_shape_with_cache(chars, start, end, cache)
    {
        return false;
    }
    if rafsi_string_slice_for_lookahead_with_cache(chars, start, end, end, cache)
        || slinkuhi_slice_with_cache(chars, start, end, cache)
        || has_blocking_cmavo_prefix_slice_with_cache(chars, start, end, cache)
        || (if cache.experimental {
            let prefix = cvc_rafsi_end(chars, start).or_else(|| ccv_rafsi_end(chars, start));
            prefix.is_some_and(|after| {
                after < end && chars[after] != 'r' && starts_cgv_sequence(chars, after, end)
            })
        } else {
            invalid_initial_rafsi_continuation(chars, start, end)
        })
        || invalid_vowel_initial_fuhivla_shape_with_cache(chars, start, end, cache)
    {
        return false;
    }
    if !starts_with_valid_word_onset(chars, start) {
        return false;
    }
    let slice = &chars[start..end];
    slice.iter().any(|value| is_consonant(*value))
        && has_consonant_cluster(slice)
        && !is_cmavo_slice(chars, start, end)
}

fn has_blocking_cmavo_prefix_slice_with_cache(
    chars: &[char],
    start: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    if start >= end {
        return false;
    }
    cmavo_word_slice_with_cache(chars, start, end, cache)
}

fn cmavo_post_word_slice_with_cache(
    chars: &[char],
    prefix_start: usize,
    prefix_end: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    let Some(index) = next_non_comma_index(chars, prefix_end) else {
        return true;
    };
    if index >= end {
        return true;
    }
    if starts_with_pause_required_nucleus(chars, index)
        && !indicator_cmavo_boundary_slice_with_cache(
            chars,
            prefix_start,
            prefix_end,
            index,
            end,
            cache,
        )
    {
        return false;
    }
    lojban_word_slice_with_cache(chars, index, end, cache)
}

fn indicator_cmavo_boundary_slice_with_cache(
    chars: &[char],
    prefix_start: usize,
    prefix_end: usize,
    index: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    is_indicator_cmavo_slice(chars, prefix_start, prefix_end)
        && !starts_with_nucleus(chars, index)
        && indicator_cmavo_starts_slice_with_cache(chars, index, end, cache)
}

fn indicator_cmavo_starts_slice_with_cache(
    chars: &[char],
    start: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    if start >= end {
        return false;
    }
    ((start + 1)..=end).any(|word_end| {
        is_indicator_cmavo_slice(chars, start, word_end)
            && cmavo_post_word_slice_with_cache(chars, start, word_end, end, cache)
    })
}

fn is_indicator_cmavo_slice(chars: &[char], start: usize, end: usize) -> bool {
    if start >= end {
        return false;
    }
    parse_cmavo_form_chars(&chars[start..end])
        .is_some_and(|text| INDICATORS.contains(&text.as_str()))
}

fn lojban_word_slice_with_cache(
    chars: &[char],
    start: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    if start >= end {
        return false;
    }
    is_cmevla_slice(chars, start, end, cache.experimental)
        || cmavo_word_slice_with_cache(chars, start, end, cache)
        || brivla_word_slice_with_cache(chars, start, end, cache)
}

fn cmavo_word_slice_with_cache(
    chars: &[char],
    start: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    if start >= end
        || is_cmevla_slice(chars, start, end, cache.experimental)
        || starts_with_cvcy_lujvo_chars_with_cache(chars, start, end, cache)
    {
        return false;
    }
    ((start + 1)..=end).any(|word_end| {
        is_cmavo_slice(chars, start, word_end)
            && cmavo_post_word_slice_with_cache(chars, start, word_end, end, cache)
    })
}

fn is_slihykru(chars: &[char], start: usize, end: usize) -> bool {
    ccv_rafsi_end(chars, start).is_some_and(|after| {
        after + 2 < end
            && chars.get(after) == Some(&'\'')
            && chars.get(after + 1) == Some(&'y')
            && starts_with_onset(&chars[..end], after + 2)
    })
}

fn brivla_word_slice_with_cache(
    chars: &[char],
    start: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    !(cache.experimental && is_slihykru(chars, start, end))
        && !cmavo_word_slice_with_cache(chars, start, end, cache)
        && (is_gismu_slice(chars, start, end, cache.experimental)
            || is_lujvo_slice_with_cache(chars, start, end, cache)
            || is_fuhivla_shape_slice_with_cache(chars, start, end, cache))
}

fn is_lujvo_slice_with_cache(
    chars: &[char],
    start: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    !(cache.experimental && is_slihykru(chars, start, end))
        && chars[start..end].iter().all(|value| is_lujvo_char(*value))
        && !cmavo_word_slice_with_cache(chars, start, end, cache)
        && !is_fuhivla_shape_slice_with_cache(chars, start, end, cache)
        && lujvo_from_until_with_cache(chars, start, end, false, cache)
}

fn is_cmevla_slice(chars: &[char], start: usize, end: usize, allow_mz: bool) -> bool {
    start < end
        && chars[end - 1].is_ascii_lowercase()
        && is_consonant(chars[end - 1])
        && !blocks_word_shape(&chars[start..end], allow_mz)
}

fn starts_with_pause_required_nucleus(chars: &[char], start: usize) -> bool {
    let Some(start) = next_non_comma_index(chars, start) else {
        return false;
    };
    starts_with_nucleus(chars, start)
}

fn ends_with_vocalic_nucleus(chars: &[char], start: usize, end: usize) -> bool {
    start < end
        && chars
            .get(end - 1)
            .is_some_and(|value| is_vowel(*value) || matches!(*value, 'ĭ' | 'ŭ'))
}

fn count_vocalic_nuclei(chars: &[char], start: usize, end: usize) -> usize {
    let mut count = 0;
    let mut index = start;
    while index < end {
        if let Some((_, nucleus_end)) = parse_diphthong_end(chars, index)
            && nucleus_end <= end
        {
            count += 1;
            index = nucleus_end;
        } else if let Some(nucleus_end) = parse_single_vowel_end(chars, index)
            && nucleus_end <= end
        {
            count += 1;
            index = nucleus_end;
        } else {
            index += 1;
        }
    }
    count
}

fn invalid_initial_rafsi_continuation(chars: &[char], start: usize, end: usize) -> bool {
    let prefix_end = cvc_rafsi_end(chars, start).or_else(|| ccv_rafsi_end(chars, start));
    let Some(prefix_end) = prefix_end else {
        return false;
    };
    bad_lujvo_prefix_continuation(chars, prefix_end, end)
}

fn bad_lujvo_prefix_continuation(chars: &[char], index: usize, end: usize) -> bool {
    if index >= end {
        return false;
    }
    if chars[index] == 'r' {
        return starts_t_l(chars, index + 1, end) || starts_n_liquid(chars, index + 1, end);
    }
    starts_affricate_liquid(chars, index, end)
        || starts_jr_vowel(chars, index, end)
        || starts_consonantal_then_forbidden_initial(chars, index, end)
        || starts_gn_vowel(chars, index, end)
        || starts_cgv_sequence(chars, index, end)
}

fn starts_forbidden_initial_pair(chars: &[char], index: usize, end: usize) -> bool {
    index + 1 < end
        && is_consonant(chars[index])
        && is_consonant(chars[index + 1])
        && !is_initial_pair(chars[index], chars[index + 1])
}

fn starts_n_liquid(chars: &[char], index: usize, end: usize) -> bool {
    index + 1 < end && chars[index] == 'n' && is_liquid(chars[index + 1])
}

fn starts_t_l(chars: &[char], index: usize, end: usize) -> bool {
    index + 1 < end && chars[index] == 't' && chars[index + 1] == 'l'
}

fn starts_affricate_liquid(chars: &[char], index: usize, end: usize) -> bool {
    index + 2 < end
        && matches!(
            (chars[index], chars[index + 1]),
            ('d', 'j' | 'z') | ('t', 'c' | 's')
        )
        && is_liquid(chars[index + 2])
}

fn starts_jr_vowel(chars: &[char], index: usize, end: usize) -> bool {
    index + 2 < end && chars[index] == 'j' && chars[index + 1] == 'r' && is_vowel(chars[index + 2])
}

fn starts_consonantal_then_forbidden_initial(chars: &[char], index: usize, end: usize) -> bool {
    index + 3 < end
        && is_consonant(chars[index])
        && is_syllabic(chars[index + 1])
        && starts_forbidden_initial_pair(chars, index + 2, end)
}

fn starts_gn_vowel(chars: &[char], index: usize, end: usize) -> bool {
    index + 2 < end && chars[index] == 'g' && chars[index + 1] == 'n' && is_vowel(chars[index + 2])
}

fn starts_cgv_sequence(chars: &[char], index: usize, end: usize) -> bool {
    index < end && is_consonant(chars[index]) && starts_glide(chars, index + 1)
}

fn invalid_vowel_initial_fuhivla_shape_with_cache(
    chars: &[char],
    start: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    chars
        .get(start)
        .is_some_and(|value| is_vowel(*value) || matches!(value, 'ĭ' | 'ŭ'))
        && !parse_fuhivla_shape_with_cache(chars, start, end, cache)
}

fn parse_fuhivla_shape_with_cache(
    chars: &[char],
    start: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    parse_fuhivla_shape_with_head_policy_with_cache(
        chars,
        start,
        end,
        FuhivlaHeadPolicy::Standard,
        cache,
    ) || parse_experimental_cgv_fuhivla_shape_with_cache(chars, start, end, cache)
}

fn parse_experimental_cgv_fuhivla_shape_with_cache(
    chars: &[char],
    start: usize,
    end: usize,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    has_cgv_sequence_slice(chars, start, end)
        && parse_fuhivla_shape_with_head_policy_with_cache(
            chars,
            start,
            end,
            FuhivlaHeadPolicy::ExperimentalCgv,
            cache,
        )
}

fn has_cgv_sequence_slice(chars: &[char], start: usize, end: usize) -> bool {
    cgv_range(&chars[start..end]).is_some()
}

fn parse_fuhivla_shape_with_head_policy_with_cache(
    chars: &[char],
    start: usize,
    end: usize,
    head_policy: FuhivlaHeadPolicy,
    cache: &mut LujvoRecognitionCache,
) -> bool {
    if !cache.charge() {
        return false;
    }
    fuhivla_head_ends_for_fuhivla_with_cache(chars, start, end, head_policy, cache)
        .into_iter()
        .any(|head_end| {
            stressed_syllable_ends_for_profile(chars, head_end, end, cache.experimental)
                .into_iter()
                .any(|stressed_end| consonantal_chain_then_final(chars, stressed_end, end))
        })
}

fn fuhivla_head_ends_for_fuhivla_with_cache(
    chars: &[char],
    start: usize,
    end: usize,
    head_policy: FuhivlaHeadPolicy,
    cache: &mut LujvoRecognitionCache,
) -> Vec<usize> {
    if !cache.charge() {
        return Vec::new();
    }
    match head_policy {
        FuhivlaHeadPolicy::Standard => fuhivla_head_ends_until_with_cache(chars, start, end, cache),
        FuhivlaHeadPolicy::ExperimentalCgv => {
            brivla_head_ends_until_with_cache(chars, start, end, cache)
        }
    }
}

fn unstressed_syllable_ends_for_fuhivla(chars: &[char], index: usize, end: usize) -> Vec<usize> {
    let mut ends: Vec<usize> = syllable_ends(chars, index, end)
        .into_iter()
        .filter(|syllable_end| {
            !syllable_has_explicit_stress(chars, index, *syllable_end)
                && !stressed_syllable_has_implicit_stress(chars, index, *syllable_end, end)
        })
        .collect();
    ends.extend(consonantal_syllable_ends(chars, index, end));
    ends.sort_unstable();
    ends.dedup();
    ends
}

fn stressed_syllable_ends_for_profile(
    chars: &[char],
    index: usize,
    end: usize,
    experimental: bool,
) -> Vec<usize> {
    if !experimental {
        return stressed_syllable_ends_for_fuhivla(chars, index, end);
    }
    syllable_ends(chars, index, end)
        .into_iter()
        .filter(|after| {
            syllable_has_explicit_stress(chars, index, *after)
                || consonantal_chain_then_final(chars, *after, end)
        })
        .collect()
}

fn stressed_syllable_ends_for_fuhivla(chars: &[char], index: usize, end: usize) -> Vec<usize> {
    syllable_ends(chars, index, end)
        .into_iter()
        .filter(|syllable_end| {
            syllable_has_explicit_stress(chars, index, *syllable_end)
                || stressed_syllable_has_implicit_stress(chars, index, *syllable_end, end)
        })
        .collect()
}

fn stressed_syllable_has_implicit_stress(
    chars: &[char],
    start: usize,
    syllable_end: usize,
    end: usize,
) -> bool {
    if final_syllable_slice(chars, syllable_end, end) {
        return true;
    }
    syllable_can_end_without_coda(chars, start, syllable_end)
        && consonantal_syllable_ends(chars, syllable_end, end)
            .into_iter()
            .any(|next| next > syllable_end && consonantal_chain_then_final(chars, next, end))
}

fn syllable_can_end_without_coda(chars: &[char], start: usize, syllable_end: usize) -> bool {
    brivla_onset_has_nucleus_end(chars, start, syllable_end, true)
}

fn consonantal_chain_then_final(chars: &[char], index: usize, end: usize) -> bool {
    if final_syllable_slice(chars, index, end) {
        return true;
    }
    consonantal_syllable_ends(chars, index, end)
        .into_iter()
        .any(|next| next > index && consonantal_chain_then_final(chars, next, end))
}

fn final_syllable_slice(chars: &[char], start: usize, end: usize) -> bool {
    !syllable_has_explicit_stress(chars, start, end)
        && brivla_onset_has_nucleus_end(chars, start, end, true)
}

fn syllable_ends(chars: &[char], index: usize, end: usize) -> Vec<usize> {
    let mut ends = Vec::new();
    let mut onset_ends = Vec::with_capacity(6);
    let mut nucleus_ends = Vec::with_capacity(2);
    append_brivla_onset_ends_unsorted(chars, index, &mut onset_ends);
    for onset_end in onset_ends.iter().copied() {
        if chars.get(onset_end).is_some_and(|value| is_y(*value)) {
            continue;
        }
        nucleus_ends.clear();
        append_parse_nucleus_ends(chars, onset_end, &mut nucleus_ends);
        for nucleus_end in nucleus_ends.iter().copied() {
            if nucleus_end <= end {
                ends.push(nucleus_end);
                ends.extend(coda_ends(chars, nucleus_end, end));
            }
        }
    }
    ends.sort_unstable();
    ends.dedup();
    ends
}

fn consonantal_syllable_ends(chars: &[char], index: usize, end: usize) -> Vec<usize> {
    if index >= end
        || !is_consonant(chars[index])
        || !chars
            .get(index + 1)
            .is_some_and(|value| is_syllabic(*value))
    {
        return Vec::new();
    }
    coda_ends(chars, index + 1, end)
        .into_iter()
        .filter(|coda_end| *coda_end > index + 1)
        .collect()
}

fn coda_ends(chars: &[char], index: usize, end: usize) -> Vec<usize> {
    let mut ends = Vec::with_capacity(2);
    ends.push(index);
    if index < end
        && is_consonant(chars[index])
        && !starts_any_syllable(chars, index, end)
        && starts_any_syllable(chars, index + 1, end)
    {
        ends.push(index + 1);
    }
    ends
}

fn starts_any_syllable(chars: &[char], index: usize, end: usize) -> bool {
    if index >= end {
        return false;
    }
    if !consonantal_syllable_ends(chars, index, end).is_empty() {
        return true;
    }
    brivla_onset_has_nucleus_end_at_or_before(chars, index, end)
}

fn append_brivla_onset_ends_unsorted(chars: &[char], index: usize, ends: &mut Vec<usize>) {
    append_parse_onset_ends(chars, index, ends);
    if let Some(end) = experimental_cgv_brivla_onset_end(chars, index) {
        ends.push(end);
    }
    if chars.get(index) == Some(&'\'') {
        ends.push(index + 1);
    }
}

fn brivla_onset_has_nucleus_end(
    chars: &[char],
    index: usize,
    nucleus_end: usize,
    skip_y_onset: bool,
) -> bool {
    if let Some(onset_end) = parse_glide_end(chars, index)
        && brivla_onset_candidate_has_nucleus_end(chars, onset_end, nucleus_end, skip_y_onset)
    {
        return true;
    }
    for onset_end in (index..=max_initial_end(chars, index)).rev() {
        if parse_initial_end(chars, index, onset_end).is_some()
            && brivla_onset_candidate_has_nucleus_end(chars, onset_end, nucleus_end, skip_y_onset)
        {
            return true;
        }
    }
    if let Some(onset_end) = experimental_cgv_brivla_onset_end(chars, index)
        && brivla_onset_candidate_has_nucleus_end(chars, onset_end, nucleus_end, skip_y_onset)
    {
        return true;
    }
    chars.get(index) == Some(&'\'')
        && brivla_onset_candidate_has_nucleus_end(chars, index + 1, nucleus_end, skip_y_onset)
}

fn brivla_onset_candidate_has_nucleus_end(
    chars: &[char],
    onset_end: usize,
    nucleus_end: usize,
    skip_y_onset: bool,
) -> bool {
    (!skip_y_onset || !chars.get(onset_end).is_some_and(|value| is_y(*value)))
        && has_parse_nucleus_end(chars, onset_end, nucleus_end)
}

fn brivla_onset_has_nucleus_end_at_or_before(chars: &[char], index: usize, limit: usize) -> bool {
    if let Some(onset_end) = parse_glide_end(chars, index)
        && has_parse_nucleus_end_at_or_before(chars, onset_end, limit)
    {
        return true;
    }
    for onset_end in (index..=max_initial_end(chars, index)).rev() {
        if parse_initial_end(chars, index, onset_end).is_some()
            && has_parse_nucleus_end_at_or_before(chars, onset_end, limit)
        {
            return true;
        }
    }
    if let Some(onset_end) = experimental_cgv_brivla_onset_end(chars, index)
        && has_parse_nucleus_end_at_or_before(chars, onset_end, limit)
    {
        return true;
    }
    chars.get(index) == Some(&'\'') && has_parse_nucleus_end_at_or_before(chars, index + 1, limit)
}

fn experimental_cgv_brivla_onset_end(chars: &[char], index: usize) -> Option<usize> {
    let max_initial_end = (index + 3).min(chars.len());
    (index + 1..=max_initial_end).rev().find_map(|initial_end| {
        (valid_initial_shape(chars, index, initial_end) && starts_glide(chars, initial_end))
            .then(|| next_non_comma_index(chars, initial_end + 1))
            .flatten()
    })
}

fn syllable_has_explicit_stress(chars: &[char], start: usize, end: usize) -> bool {
    chars[start..end].iter().any(|value| {
        matches!(
            value,
            'á' | 'é' | 'í' | 'ó' | 'ú' | 'Á' | 'É' | 'Í' | 'Ó' | 'Ú'
        )
    })
}

fn is_syllabic(value: char) -> bool {
    matches!(value, 'l' | 'm' | 'n' | 'r')
}

fn has_consonant_cluster(chars: &[char]) -> bool {
    chars
        .windows(2)
        .any(|pair| is_consonant(pair[0]) && is_consonant(pair[1]))
}

fn has_vowel_hiatus(chars: &[char]) -> bool {
    vowel_hiatus_range(chars).is_some()
}

fn vowel_hiatus_range(chars: &[char]) -> Option<Range<usize>> {
    for index in 0..chars.len() {
        if !is_vowel(chars[index]) && !matches!(chars[index], 'ĭ' | 'ŭ') {
            continue;
        }
        if starts_repeated_glide_diphthong_sequence(chars, index) {
            let next = next_non_comma_index(chars, index + 1).unwrap_or(index + 1);
            return Some(index..nucleus_end_for_span(chars, next));
        }
        if starts_glide(chars, index) {
            continue;
        }
        if parse_diphthong_end(chars, index).is_some() {
            continue;
        }
        if next_non_comma_index(chars, index + 1).is_some_and(|next| starts_glide(chars, next)) {
            continue;
        }
        if let Some(next) = next_non_comma_index(chars, index + 1)
            && starts_with_nucleus(chars, next)
        {
            return Some(index..nucleus_end_for_span(chars, next));
        }
    }
    None
}

fn raw_diphthong_end(chars: &[char], start: usize) -> Option<(char, usize)> {
    let first = base_vowel(*chars.get(start)?)?;
    // The PEG spells each vowel as `comma* [aA]` and so on, so a comma between
    // the two halves of a falling diphthong does not break it - it only marks
    // where the writer wants the syllable read. Glide detection already skips
    // commas; the two have to agree, or `zo,is.` would be rejected as hiatus
    // while `zoi,s.` is accepted.
    let second_index = next_non_comma_index(chars, start + 1)?;
    let semivowel = match (first, chars[second_index]) {
        ('a', 'i' | 'í' | 'ĭ') | ('e', 'i' | 'í' | 'ĭ') | ('o', 'i' | 'í' | 'ĭ') => 'ĭ',
        ('a', 'u' | 'ú' | 'ŭ') => 'ŭ',
        _ => return None,
    };
    Some((semivowel, second_index + 1))
}

fn starts_repeated_glide_diphthong_sequence(chars: &[char], index: usize) -> bool {
    let semivowel = match chars.get(index).copied() {
        Some('i' | 'í' | 'ĭ') => 'ĭ',
        Some('u' | 'ú' | 'ŭ') => 'ŭ',
        _ => return false,
    };
    next_non_comma_index(chars, index + 1)
        .and_then(|nucleus_start| raw_diphthong_end(chars, nucleus_start))
        .and_then(|(diphthong_semivowel, diphthong_end)| {
            (diphthong_semivowel == semivowel)
                .then(|| next_non_comma_index(chars, diphthong_end))
                .flatten()
        })
        .is_some_and(|next| matches_diphthong_semivowel(chars[next], semivowel))
}

fn next_non_comma_index(chars: &[char], mut index: usize) -> Option<usize> {
    while chars.get(index) == Some(&',') {
        index += 1;
    }
    (index < chars.len()).then_some(index)
}

fn is_cmavo_slice(chars: &[char], start: usize, end: usize) -> bool {
    if start >= end {
        return false;
    }
    matches_cmavo_form_chars(&chars[start..end])
}

fn starts_with_onset(chars: &[char], index: usize) -> bool {
    index <= chars.len()
        && (has_parse_onset(chars, index)
            || experimental_cgv_brivla_onset_end(chars, index).is_some())
}

fn starts_with_valid_word_onset(chars: &[char], index: usize) -> bool {
    let Some(first) = chars.get(index).copied() else {
        return false;
    };
    if is_vowel(first) || is_y(first) || matches!(first, 'ĭ' | 'ŭ') {
        return true;
    }
    if !is_consonant(first) {
        return false;
    }
    let Some(second) = chars.get(index + 1).copied() else {
        return true;
    };
    if !is_consonant(second) {
        return true;
    }
    if chars
        .get(index + 2)
        .is_some_and(|value| is_consonant(*value))
    {
        valid_three_consonant_initial(chars, index)
            && !chars
                .get(index + 3)
                .is_some_and(|value| is_consonant(*value))
    } else {
        is_initial_pair(first, second)
    }
}

fn valid_three_consonant_initial(chars: &[char], index: usize) -> bool {
    let (Some(first), Some(second), Some(third)) = (
        chars.get(index).copied(),
        chars.get(index + 1).copied(),
        chars.get(index + 2).copied(),
    ) else {
        return false;
    };
    is_sibilant(first)
        && is_initial_pair(first, second)
        && is_initial_pair(second, third)
        && is_liquid(third)
}

fn is_sibilant(value: char) -> bool {
    matches!(value, 'c' | 's' | 'j' | 'z')
}

fn is_liquid(value: char) -> bool {
    matches!(value, 'l' | 'r')
}

fn is_lujvo_char(value: char) -> bool {
    is_consonant(value) || is_vowel(value) || is_y(value) || matches!(value, '\'' | 'ĭ' | 'ŭ')
}

fn is_diphthong_pair(first: char, second: char) -> bool {
    matches!(
        (base_vowel(first), base_semivowel(second)),
        (Some('a'), Some('i'))
            | (Some('e'), Some('i'))
            | (Some('o'), Some('i'))
            | (Some('a'), Some('u'))
    )
}

fn base_semivowel(value: char) -> Option<char> {
    match value {
        'i' | 'í' | 'ĭ' => Some('i'),
        'u' | 'ú' | 'ŭ' => Some('u'),
        _ => None,
    }
}

fn is_y(value: char) -> bool {
    matches!(value, 'y' | 'ý')
}

fn digit_to_cmavo(value: char) -> Option<&'static str> {
    Some(match value {
        '0' => "no",
        '1' => "pa",
        '2' => "re",
        '3' => "ci",
        '4' => "vo",
        '5' => "mu",
        '6' => "xa",
        '7' => "ze",
        '8' => "bi",
        '9' => "so",
        _ => return None,
    })
}
const INDICATORS: &[&str] = &[
    "a'a", "a'e", "a'i", "a'o", "a'u", "ai", "ai'i", "au", "ba'a", "ba'u", "be'u", "bi'u", "bu'o",
    "ca'e", "cai", "cu'ei", "cu'i", "da'i", "da'o", "dai", "do'a", "e'a", "e'e", "e'ei", "e'i",
    "e'o", "e'u", "ei", "fu'au", "fu'e", "fu'i", "fu'o", "ga'i", "ge'e", "ia", "ie", "i'a", "i'e",
    "i'i", "i'o", "i'u", "ii", "io", "iu", "ja'o", "je'u", "ji'a", "ji'ei", "jo'a", "ju'a", "ju'o",
    "ju'oi", "ka'u", "kau", "ke'u", "ki'a", "ko'oi", "ku'i", "la'a", "le'o", "li'a", "li'o",
    "li'oi", "mi'u", "mu'a", "na'i", "o'a", "o'e", "o'i", "o'o", "o'u", "oi", "oi'a", "pa'e",
    "pau", "pe'a", "pe'i", "pei", "po'o", "ra'u", "re'e", "ri'e", "ro'a", "ro'e", "ro'i", "ro'o",
    "ro'u", "ru'a", "ru'e", "sa'a", "sa'e", "sa'u", "sai", "se'a", "se'i", "se'o", "sei'i", "si'a",
    "si'au", "so'ei", "su'a", "ta'o", "ta'u", "ti'e", "to'u", "ua", "ue", "ue'i", "u'a", "u'e",
    "u'i", "u'o", "u'u", "ui", "uo", "uu", "va'i", "vu'e", "xo'o", "xu", "za'a", "zo'o", "zu'u",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Gismu,
    Lujvo,
    Fuhivla,
    Cmavo,
    Cmevla,
    Unknown,
}
pub(crate) struct Reading {
    pub kind: Kind,
    pub tokens: Vec<String>,
    pub spent: usize,
}
pub(crate) const MAX_WORD_BYTES: usize = 128;
pub(crate) fn parse_profile(
    word: &str,
    profile: crate::lujvo::Profile,
) -> Result<Reading, crate::lujvo::BuilderError> {
    parse_with_profile(word, 50_000, profile == crate::lujvo::Profile::Extended)
}
pub(crate) fn parse(word: &str) -> Result<Reading, crate::lujvo::BuilderError> {
    parse_with_limit(word, 50_000)
}
fn parse_with_limit(word: &str, limit: usize) -> Result<Reading, crate::lujvo::BuilderError> {
    parse_with_profile(word, limit, false)
}
fn parse_with_profile(
    word: &str,
    limit: usize,
    experimental: bool,
) -> Result<Reading, crate::lujvo::BuilderError> {
    use crate::lujvo::BuilderError;
    if word.len() > MAX_WORD_BYTES {
        return Err(BuilderError::ResourceLimit {
            measure: "word bytes".into(),
            value: word.len() as u64,
            limit: MAX_WORD_BYTES as u64,
        });
    }
    let chars: Vec<char> = word.chars().collect();
    let end = chars.len();
    let mut cache = LujvoRecognitionCache::new(end);
    cache.remaining = limit;
    cache.experimental = experimental;
    let mut tokens = Vec::new();
    let kind = if blocks_word_shape(&chars, experimental) {
        Kind::Unknown
    } else if is_gismu_slice(&chars, 0, end, experimental) {
        Kind::Gismu
    } else if is_cmevla_slice(&chars, 0, end, experimental) {
        Kind::Cmevla
    } else if is_cmavo_slice(&chars, 0, end) {
        Kind::Cmavo
    } else if is_lujvo_slice_with_cache(&chars, 0, end, &mut cache) {
        if let Some(ranges) =
            lujvo_part_ranges_from_with_cache(&chars, 0, end, false, &mut None, &mut cache)
        {
            tokens = ranges
                .iter()
                .map(|r| chars[r.start..r.end].iter().collect())
                .collect();
            Kind::Lujvo
        } else {
            Kind::Unknown
        }
    } else if is_fuhivla_shape_slice_with_cache(&chars, 0, end, &mut cache) {
        Kind::Fuhivla
    } else {
        Kind::Unknown
    };
    if cache.exhausted {
        return Err(BuilderError::ResourceLimit {
            measure: "recognition work".into(),
            value: cache.spent as u64 + 1,
            limit: limit as u64,
        });
    }
    Ok(Reading {
        kind,
        tokens,
        spent: cache.spent,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exhaustion_invalidates_even_a_successful_branch() {
        assert!(matches!(
            parse_with_limit("ckusni", 1),
            Err(crate::lujvo::BuilderError::ResourceLimit { .. })
        ));
        assert!(matches!(
            parse_with_limit("gimspageti", 1),
            Err(crate::lujvo::BuilderError::ResourceLimit { .. })
        ));
        let chars: Vec<char> = "ckusni".chars().collect();
        let mut cache = LujvoRecognitionCache::new(chars.len());
        cache.remaining = 0;
        assert!(!is_lujvo_slice_with_cache(
            &chars,
            0,
            chars.len(),
            &mut cache
        ));
        assert!(cache.exhausted);
    }
}
