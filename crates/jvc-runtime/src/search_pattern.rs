//! Linear-time pattern matching with bounded compilation and aggregate input.
use regex_automata::{
    nfa::thompson::{
        self, NFA, State, WhichCaptures,
        pikevm::{Cache, PikeVM},
    },
    util::primitives::StateID,
};
use regex_syntax::ast::{self, Ast, ClassSet, ClassSetItem, LiteralKind};
use wasm_bindgen::prelude::*;

const SOURCE_LIMIT: usize = 4096;
const COMPILED_LIMIT: usize = 2_097_152;
const CANDIDATE_WORK_LIMIT: usize = 262_144;
const WORK_LIMIT: usize = 32_000_000;

/// One query owns one matcher. Failed work returns no partial search results.
#[wasm_bindgen]
pub struct SearchPattern {
    regex: PikeVM,
    cache: Cache,
    states: usize,
    ascii_states: usize,
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
    // A written acute can be its own AST node. An empty node removes it only
    // from literal sequences. Escapes and class/range syntax stay intact.
    if matches!(value, Ast::Literal(v) if v.kind == LiteralKind::Verbatim && v.c == '\u{301}') {
        *value = Ast::empty(*value.span());
        return;
    }
    match value {
        Ast::Literal(value) => literal(value),
        Ast::ClassBracketed(value) => class_set(&mut value.kind),
        Ast::Repetition(value) => {
            aliases(&mut value.ast);
            if matches!(*value.ast, Ast::Empty(_)) {
                // Keep the operator attached to the removed mark, not the
                // preceding literal when the AST is printed and parsed again.
                let span = *value.ast.span();
                *value.ast = Ast::Group(
                    ast::Group {
                        span,
                        kind: ast::GroupKind::NonCapturing(ast::Flags {
                            span,
                            items: vec![],
                        }),
                        ast: Box::new(Ast::empty(span)),
                    }
                    .into(),
                );
            }
        }
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

// Only paths that consume ASCII can run for an ASCII candidate. This is a
// graph property of the actual compiled NFA, not an ASCII rewrite of Unicode
// classes. Non-ASCII candidates use the full compiled state count.
fn ascii_reachable(nfa: &NFA) -> usize {
    let mut visited = vec![false; nfa.states().len()];
    let mut pending = vec![nfa.start_unanchored()];
    while let Some(id) = pending.pop() {
        if std::mem::replace(&mut visited[id.as_usize()], true) {
            continue;
        }
        match &nfa.states()[id.as_usize()] {
            State::ByteRange { trans } => {
                if trans.start < 128 {
                    pending.push(trans.next);
                }
            }
            State::Sparse(trans) => pending.extend(
                trans
                    .transitions
                    .iter()
                    .filter(|t| t.start < 128)
                    .map(|t| t.next),
            ),
            State::Dense(trans) => pending.extend(
                trans.transitions[..128]
                    .iter()
                    .filter(|id| **id != StateID::ZERO)
                    .copied(),
            ),
            State::Look { next, .. } | State::Capture { next, .. } => pending.push(*next),
            State::Union { alternates } => pending.extend(alternates.iter().copied()),
            State::BinaryUnion { alt1, alt2 } => {
                pending.push(*alt1);
                pending.push(*alt2);
            }
            State::Match { .. } | State::Fail => {}
        }
    }
    visited.iter().filter(|v| **v).count().max(1)
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
        let hir = regex_syntax::ParserBuilder::new()
            .case_insensitive(true)
            .nest_limit(32)
            .build()
            .parse(&normalized)
            .map_err(|_| ())?;
        let nfa = NFA::compiler()
            .configure(
                thompson::Config::new()
                    .nfa_size_limit(Some(COMPILED_LIMIT))
                    .which_captures(WhichCaptures::None),
            )
            .build_from_hir(&hir)
            .map_err(|_| ())?;
        let states = nfa.states().len();
        let ascii_states = ascii_reachable(&nfa);
        let regex = PikeVM::new_from_nfa(nfa).map_err(|_| ())?;
        let cache = regex.create_cache();
        Ok(Self {
            regex,
            cache,
            states,
            ascii_states,
            remaining: WORK_LIMIT,
        })
    }
    fn matches(&mut self, spelling: &str) -> Result<bool, ()> {
        let states = if spelling.is_ascii() {
            self.ascii_states
        } else {
            self.states
        };
        let work = spelling.len().saturating_add(1).saturating_mul(states);
        if work > CANDIDATE_WORK_LIMIT {
            return Err(());
        }
        self.remaining = self.remaining.checked_sub(work).ok_or(())?;
        Ok(self.regex.is_match(&mut self.cache, spelling))
    }
}

#[wasm_bindgen]
impl SearchPattern {
    #[wasm_bindgen(constructor)]
    pub fn new(source: &str) -> Result<SearchPattern, JsValue> {
        Self::compile(source).map_err(|_| invalid())
    }
    pub fn states(&self) -> usize {
        self.states
    }
    pub fn ascii_states(&self) -> usize {
        self.ascii_states
    }
    pub fn memory_usage(&self) -> usize {
        self.regex.get_nfa().memory_usage() + self.cache.memory_usage()
    }
    pub fn spent(&self) -> usize {
        WORK_LIMIT - self.remaining
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
    fn removed_acute_repetitions_preserve_scope() {
        for source in ["^dj\u{301}+an$", "^dj\u{301}{2}an$", "^dj\u{301}?an$"] {
            let mut pattern = SearchPattern::compile(source).unwrap();
            assert!(pattern.matches("djan").unwrap());
            assert!(!pattern.matches("djjan").unwrap());
            assert!(!pattern.matches("djjjan").unwrap());
        }
    }

    #[test]
    fn nested_repetition_is_linear_and_total_work_is_bounded() {
        let mut pattern = SearchPattern::compile("(a+)+$").unwrap();
        let spelling = format!("{}b", "a".repeat(254));
        assert!(!pattern.matches(&spelling).unwrap());
        let mut timed_out = false;
        for _ in 0..25_000 {
            if pattern.matches(&spelling).is_err() {
                timed_out = true;
                break;
            }
        }
        assert!(timed_out);
    }
}
