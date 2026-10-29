//! Linear-time pattern matching with bounded compilation and aggregate input.
use regex::{Regex, RegexBuilder};
use regex_syntax::ast::{self, Ast, ClassSet, ClassSetItem, LiteralKind};
use wasm_bindgen::prelude::*;

const SOURCE_LIMIT: usize = 4096;
const COMPILED_LIMIT: usize = 262_144;
const WORK_LIMIT: usize = 32_000_000;

/// One query owns one matcher. Failed work returns no partial search results.
#[wasm_bindgen]
pub struct SearchPattern {
    regex: Regex,
    weight: usize,
    remaining: usize,
}

fn invalid() -> JsValue {
    JsValue::from_str("pattern_invalid")
}

// Only written literals gain aliases. Escapes, properties, names, flags, and
// range endpoints retain their regular expression meaning.
fn literal(value: &mut ast::Literal) {
    if value.kind != LiteralKind::Verbatim {
        return;
    }
    let plain = jvc_core::strip_acute_accents(&value.c.to_string());
    value.c = match plain.chars().next().unwrap_or(value.c) {
        'h' | 'H' | '’' => '\'',
        c => c,
    };
}
fn class_item(value: &mut ClassSetItem) {
    match value {
        ClassSetItem::Literal(value) => literal(value),
        ClassSetItem::Bracketed(value) => class_set(&mut value.kind),
        ClassSetItem::Union(value) => value.items.iter_mut().for_each(class_item),
        _ => {}
    }
}
fn class_set(value: &mut ClassSet) {
    match value {
        ClassSet::Item(value) => class_item(value),
        ClassSet::BinaryOp(value) => {
            class_set(&mut value.lhs);
            class_set(&mut value.rhs);
        }
    }
}
fn aliases(value: &mut Ast) {
    match value {
        Ast::Literal(value) => literal(value),
        Ast::ClassBracketed(value) => class_set(&mut value.kind),
        Ast::Repetition(value) => aliases(&mut value.ast),
        Ast::Group(value) => aliases(&mut value.ast),
        Ast::Alternation(value) => value.asts.iter_mut().for_each(aliases),
        Ast::Concat(value) => value.asts.iter_mut().for_each(aliases),
        _ => {}
    }
}
fn disables_case_folding(value: &Ast) -> bool {
    let disabled = |flags: &ast::Flags| flags.flag_state(ast::Flag::CaseInsensitive) == Some(false);
    match value {
        Ast::Flags(value) => disabled(&value.flags),
        Ast::Group(value) => {
            matches!(&value.kind, ast::GroupKind::NonCapturing(flags) if disabled(flags))
                || disables_case_folding(&value.ast)
        }
        Ast::Repetition(value) => disables_case_folding(&value.ast),
        Ast::Alternation(value) => value.asts.iter().any(disables_case_folding),
        Ast::Concat(value) => value.asts.iter().any(disables_case_folding),
        _ => false,
    }
}

impl SearchPattern {
    fn compile(source: &str) -> Result<Self, ()> {
        if source.is_empty() || source.len() > SOURCE_LIMIT {
            return Err(());
        }
        let mut ast = ast::parse::ParserBuilder::new()
            .nest_limit(32)
            .build()
            .parse(source)
            .map_err(|_| ())?;
        if disables_case_folding(&ast) {
            return Err(());
        }
        aliases(&mut ast);
        let normalized = ast.to_string();
        let regex = RegexBuilder::new(&normalized)
            .case_insensitive(true)
            .size_limit(COMPILED_LIMIT)
            .dfa_size_limit(COMPILED_LIMIT)
            .nest_limit(32)
            .build()
            .map_err(|_| ())?;
        Ok(Self {
            regex,
            weight: source.len().max(1),
            remaining: WORK_LIMIT,
        })
    }
    fn matches(&mut self, spelling: &str) -> Result<bool, ()> {
        let work = spelling.len().saturating_add(1).saturating_mul(self.weight);
        self.remaining = self.remaining.checked_sub(work).ok_or(())?;
        Ok(self.regex.is_match(spelling))
    }
}

#[wasm_bindgen]
impl SearchPattern {
    #[wasm_bindgen(constructor)]
    pub fn new(source: &str) -> Result<SearchPattern, JsValue> {
        Self::compile(source).map_err(|_| invalid())
    }
    pub fn is_match(&mut self, spelling: &str) -> Result<bool, JsValue> {
        self.matches(spelling)
            .map_err(|_| JsValue::from_str("pattern_timeout"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aliases_preserve_regular_expression_syntax() {
        for (source, spelling) in [
            ("^BA", "bangu"),
            ("nu$", "vecnu"),
            ("(?P<head>h)i", "'i"),
            ("[h]i", "'i"),
            ("dján", "djan"),
            (r"\D+", "bangu"),
            (r"\p{Alphabetic}+", "bangu"),
            (r"\x68", "h"),
            ("[a-h]", "g"),
        ] {
            assert!(
                SearchPattern::compile(source)
                    .unwrap()
                    .matches(spelling)
                    .unwrap()
            );
        }
        assert!(
            !SearchPattern::compile(r"\x68")
                .unwrap()
                .matches("'")
                .unwrap()
        );
        for source in ["[", "(?=a)", r"(a)\1", "a{1000000}", "(?-i)BA"] {
            assert!(SearchPattern::compile(source).is_err());
        }
    }

    #[test]
    fn nested_repetition_is_linear_and_total_work_is_bounded() {
        let mut pattern = SearchPattern::compile("(a+)+$").unwrap();
        let spelling = format!("{}b", "a".repeat(254));
        assert!(!pattern.matches(&spelling).unwrap());
        let mut timed_out = false;
        for _ in 0..20_000 {
            if pattern.matches(&spelling).is_err() {
                timed_out = true;
                break;
            }
        }
        assert!(timed_out);
    }
}
