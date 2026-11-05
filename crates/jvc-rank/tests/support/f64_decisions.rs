use jvc_rank::approximate::{self as a, decisions as d};
use jvc_rank::{rational, Candidate, Eligibility, Limits, Verdict};
use std::collections::BTreeMap;
fn graph(q: Vec<f64>, edges: &[(usize, usize, f64)], refusals: &[(usize, usize)]) -> a::Graph {
    let n = q.len();
    let mut rows = vec![vec![]; n];
    let mut blocked = vec![vec![]; n];
    for &(from, to, share) in edges {
        rows[from].push(a::Edge { to, share });
    }
    for &(from, to) in refusals {
        blocked[to].push(from);
    }
    a::Graph::new(
        (0..n).map(|i| format!("actor-{i:05}")).collect(),
        q,
        rows,
        blocked,
        &Limits::default(),
    )
    .unwrap()
}
fn params(h: f64, alpha: f64, work: u64) -> a::Parameters {
    a::Parameters { h, alpha, work }
}
fn candidate(id: &str, verdicts: Vec<Verdict>) -> Candidate {
    Candidate {
        id: id.into(),
        verdicts,
        eligibility: Eligibility::Eligible,
        deprecated: false,
    }
}
fn margin(m: &d::Margin) -> Vec<u64> {
    let mut v = vec![
        m.depth as u64,
        m.factor.to_bits(),
        m.contribution_mass.to_bits(),
        m.absolute.to_bits(),
        m.value.to_bits(),
        m.graphs.len() as u64,
    ];
    for g in &m.graphs {
        v.extend([
            g.depth as u64,
            g.factor.to_bits(),
            g.flushed_terms,
            g.flush_margin.to_bits(),
        ]);
    }
    v.extend(m.contract.bytes().map(u64::from));
    v
}
fn comparison(c: &d::Comparison) -> Vec<u64> {
    let mut v = vec![
        c.difference.lower.to_bits(),
        c.difference.upper.to_bits(),
        u64::from(c.a_leads()),
        u64::from(c.b_leads()),
    ];
    v.extend(margin(&c.margin));
    v
}
fn layers(l: &d::Layers) -> Vec<u64> {
    let mut v = vec![u64::from(l.comparison_cycle), u64::from(l.incomplete)];
    for row in &l.layers {
        v.push(row.len() as u64);
        for id in row {
            v.extend(id.bytes().map(u64::from));
            v.push(0);
        }
    }
    for id in &l.unavailable {
        v.extend(id.bytes().map(u64::from));
        v.push(0);
    }
    v
}
pub fn numerical_vectors() -> BTreeMap<String, Vec<u64>> {
    use Verdict::*;
    let limits = Limits::default();
    let mut out = BTreeMap::new();
    // The naive opposition sum falls below one and creates a false positive decision.
    let mut q = vec![f64::from_bits(0x3ff0_0000_0000_232f)];
    q.extend([0.1; 10]);
    let g = graph(q, &[], &[]);
    let p = params(0.0, 0.5, 1);
    let r = a::rank(&g, &p, limits.clone()).unwrap();
    let ctx = d::DecisionContext::new(&g, &p, &r, &limits).unwrap();
    let mut verdicts = vec![Bless];
    verdicts.extend([Curse; 10]);
    let c = candidate("margin-crossing", verdicts);
    let score = d::score(&ctx, &c, &limits).unwrap();
    let decision = d::actual_positive_support(Some(&score)).unwrap();
    assert_eq!(score.opposition.upper, 1.0);
    let mut naive = 0.0;
    for _ in 0..10 {
        naive += 0.1;
    }
    assert!(score.support.lower - naive > 1e-12 * (score.support.upper + naive));
    assert_eq!(decision.status, d::ActualSupport::NotEstablished);
    assert!(score.net.lower > 0.0);
    let mut bits = vec![
        score.net.lower.to_bits(),
        decision.status as u64,
        naive.to_bits(),
    ];
    bits.extend(margin(decision.margin.as_ref().unwrap()));
    out.insert(
        "decision-compensation-prevents-margin-crossing".into(),
        bits,
    );

    let g = graph(vec![1e-100], &[], &[]);
    let r = a::rank(&g, &p, limits.clone()).unwrap();
    let ctx = d::DecisionContext::new(&g, &p, &r, &limits).unwrap();
    let a = candidate("a", vec![Bless]);
    let b = candidate("b", vec![Absent]);
    let c = d::difference(&a, &b, &ctx, &limits).unwrap();
    assert!(c.a_leads());
    assert_eq!(c.margin.contribution_mass, 1e-100);
    assert!(c.margin.value < 1e-110);
    out.insert(
        "decision-tiny-mass-has-no-unit-floor".into(),
        comparison(&c),
    );

    let g = graph(vec![1.0, 1.0 - f64::EPSILON], &[], &[]);
    let r = a::rank(&g, &p, limits.clone()).unwrap();
    let ctx = d::DecisionContext::new(&g, &p, &r, &limits).unwrap();
    let c = candidate("residue", vec![Bless, Curse]);
    let score = d::score(&ctx, &c, &limits).unwrap();
    assert!(score.net.lower > 0.0);
    assert_eq!(
        d::actual_positive_support(Some(&score)).unwrap().status,
        d::ActualSupport::NotEstablished
    );
    assert_eq!(
        d::eligible_competitor_potential(Some(&score))
            .unwrap()
            .status,
        d::Potential::Possible
    );
    let threshold = d::meets_threshold(Some(&score), &rational(1, 1_000_000_000_000)).unwrap();
    assert_eq!(threshold.status, d::Threshold::Accepted);
    let mut bits = vec![score.net.lower.to_bits(), threshold.status as u64];
    bits.extend(margin(threshold.margin.as_ref().unwrap()));
    out.insert("decision-tiny-residue-remains-unresolved".into(), bits);

    let g = graph(vec![1.0], &[], &[]);
    let r = a::rank(&g, &p, limits.clone()).unwrap();
    let ctx = d::DecisionContext::new(&g, &p, &r, &limits).unwrap();
    let c = candidate("threshold", vec![Bless]);
    let s = d::score(&ctx, &c, &limits).unwrap();
    let exact = d::meets_threshold(Some(&s), &rational(1, 1)).unwrap();
    assert_eq!(exact.status, d::Threshold::Accepted);
    assert_eq!(
        d::meets_threshold(Some(&s), &rational(2, 1))
            .unwrap()
            .status,
        d::Threshold::NotEstablished
    );
    let subnormal = jvc_rank::Rational::from_float(f64::from_bits(1)).unwrap();
    assert!(d::meets_threshold(Some(&s), &subnormal).is_err());
    let to_zero = jvc_rank::Rational::new(1.into(), num_bigint::BigInt::from(1u8) << 2000usize);
    assert!(d::meets_threshold(Some(&s), &to_zero).is_err());
    assert_eq!(
        d::meets_threshold(None, &rational(1, 1)).unwrap().status,
        d::Threshold::Unavailable
    );
    let mut broken = s.clone();
    broken.net.lower = f64::NAN;
    assert!(d::actual_positive_support(Some(&broken)).is_err());
    out.insert(
        "decision-inclusive-threshold-and-input-guards".into(),
        margin(exact.margin.as_ref().unwrap()),
    );
    let g = graph(
        vec![
            f64::from_bits(f64::MIN_POSITIVE.to_bits() + 1),
            f64::MIN_POSITIVE,
        ],
        &[],
        &[],
    );
    let r = a::rank(&g, &p, limits.clone()).unwrap();
    let ctx = d::DecisionContext::new(&g, &p, &r, &limits).unwrap();
    let s = d::score(
        &ctx,
        &candidate("subnormal-difference", vec![Bless, Curse]),
        &limits,
    )
    .unwrap();
    assert!(s.net.lower.is_subnormal());
    let decision = d::actual_positive_support(Some(&s)).unwrap();
    assert_eq!(decision.status, d::ActualSupport::NotEstablished);
    out.insert(
        "decision-signed-subnormal-difference-remains-available".into(),
        vec![
            s.net.lower.to_bits(),
            decision.margin.unwrap().value.to_bits(),
        ],
    );
    let g = graph(vec![], &[], &[]);
    let r = a::rank(&g, &p, limits.clone()).unwrap();
    let ctx = d::DecisionContext::new(&g, &p, &r, &limits).unwrap();
    let empty = candidate("empty", vec![]);
    let zero = d::score(&ctx, &empty, &limits).unwrap();
    assert_eq!(
        d::actual_positive_support(Some(&zero)).unwrap().status,
        d::ActualSupport::NotEstablished
    );
    let decision = d::actual_positive_support(Some(&zero)).unwrap();
    assert_eq!(decision.margin.as_ref().unwrap().value, 0.0);
    out.insert(
        "decision-empty-graph-zero-margin".into(),
        margin(decision.margin.as_ref().unwrap()),
    );
    assert_eq!(d::relative_factor(0), 1e-12);
    assert!(d::relative_factor(3000) > 1e-12);
    assert_eq!(d::FLUSH_UNIT, 16.0 * f64::MIN_POSITIVE);
    out
}
pub fn comparison_vectors() -> BTreeMap<String, Vec<u64>> {
    use Verdict::*;
    let mut out = BTreeMap::new();
    let limits = Limits::default();
    let g = graph(vec![1e16, 1.0, 0.0], &[], &[]);
    let p = params(0.0, 0.5, 1);
    let r = a::rank(&g, &p, limits.clone()).unwrap();
    let ctx = d::DecisionContext::new(&g, &p, &r, &limits).unwrap();
    let a = candidate("a", vec![Bless, Bless, Absent]);
    let b = candidate("b", vec![Bless, Absent, Absent]);
    let same = d::difference(&a, &b, &ctx, &limits).unwrap();
    assert!(same.a_leads());
    assert_eq!(same.difference.lower, 1.0);
    assert_eq!(same.margin.contribution_mass, 1.0);
    let sa = d::score(&ctx, &a, &limits).unwrap();
    let sb = d::score(&ctx, &b, &limits).unwrap();
    let uncorrelated = d::separate_difference(&sa, &sb).unwrap();
    assert!(!uncorrelated.a_leads());
    assert_eq!(uncorrelated.margin.graphs.len(), 1);
    out.insert(
        "decision-same-graph-cancels-shared-verdict".into(),
        comparison(&same),
    );
    out.insert(
        "decision-separate-masses-do-not-cancel".into(),
        comparison(&uncorrelated),
    );
    let g2 = graph(vec![1e16, 1.0, 0.0], &[], &[]);
    let r2 = a::rank(&g2, &p, limits.clone()).unwrap();
    let ctx2 = d::DecisionContext::new(&g2, &p, &r2, &limits).unwrap();
    let other = d::score(&ctx2, &b, &limits).unwrap();
    let separate = d::separate_difference(&sa, &other).unwrap();
    assert_eq!(separate.margin.graphs.len(), 1);
    out.insert(
        "decision-cloned-graph-margin-details".into(),
        comparison(&separate),
    );
    let twice = d::difference(
        &candidate("bless", vec![Absent, Bless, Absent]),
        &candidate("curse", vec![Absent, Curse, Absent]),
        &ctx,
        &limits,
    )
    .unwrap();
    assert_eq!(twice.margin.contribution_mass, 2.0);
    assert_eq!(twice.difference.lower, 2.0);
    out.insert(
        "decision-opposite-verdict-coefficient-two".into(),
        comparison(&twice),
    );

    let ga = graph(vec![1.0], &[], &[]);
    let gb = graph(vec![2.0, 0.0], &[], &[]);
    let ra = a::rank(&ga, &p, limits.clone()).unwrap();
    let rb = a::rank(&gb, &p, limits.clone()).unwrap();
    let ca = d::DecisionContext::new(&ga, &p, &ra, &limits).unwrap();
    let cb = d::DecisionContext::new(&gb, &p, &rb, &limits).unwrap();
    let aa = candidate("a", vec![Bless]);
    let bb = candidate("b", vec![Bless, Absent]);
    let entries = [
        d::LayerCandidate {
            candidate: &aa,
            context: Some(&ca),
        },
        d::LayerCandidate {
            candidate: &bb,
            context: Some(&cb),
        },
    ];
    let layer = d::nondominated_layers(&entries, &limits).unwrap();
    assert_eq!(layer.layers, vec![vec!["b"], vec!["a"]]);
    assert_eq!(
        d::automatic_selection(&entries, &[], &rational(1, 2), &limits)
            .unwrap()
            .selected
            .as_deref(),
        Some("b")
    );
    assert!(d::nondominated_layers(
        &entries,
        &Limits {
            max_candidate_actor_terms: 3,
            ..limits.clone()
        }
    )
    .is_err());
    out.insert(
        "decision-mixed-graph-layers-and-selection".into(),
        layers(&layer),
    );
    let m = f64::MIN_POSITIVE;
    let fg = graph(vec![m, 1.0, 0.0], &[(0, 2, 0.5)], &[]);
    let fp = params(1.0, 0.5, 1);
    let fr = a::rank(&fg, &fp, limits.clone()).unwrap();
    assert_eq!(fr.progress.work.flushed_terms, 1);
    let fc = d::DecisionContext::new(&fg, &fp, &fr, &limits).unwrap();
    let ident = candidate("identical", vec![Bless, Bless, Bless]);
    let zero = d::difference(&ident, &ident, &fc, &limits).unwrap();
    assert_eq!(zero.margin.contribution_mass, 0.0);
    assert_eq!(zero.margin.absolute, d::FLUSH_UNIT);
    assert_eq!(zero.margin.value, d::FLUSH_UNIT);
    assert!(!zero.a_leads());
    assert!(!zero.b_leads());
    out.insert(
        "decision-counted-absolute-zero-mass".into(),
        comparison(&zero),
    );
    let tiny = candidate(
        "tiny",
        vec![Verdict::Bless, Verdict::Absent, Verdict::Absent],
    );
    let tiny_score = d::score(&fc, &tiny, &limits).unwrap();
    assert_eq!(
        d::actual_positive_support(Some(&tiny_score))
            .unwrap()
            .status,
        d::ActualSupport::NotEstablished
    );
    let counted = d::difference(
        &tiny,
        &candidate("zero", vec![Verdict::Absent; 3]),
        &fc,
        &limits,
    )
    .unwrap();
    assert!(counted.margin.value >= d::FLUSH_UNIT);
    assert!(!counted.a_leads());
    out.insert(
        "decision-counted-flush-allowance-withholds-tiny-lead".into(),
        comparison(&counted),
    );
    let snapshot = fr.clone();
    let snapshot_context = d::DecisionContext::new(&fg, &fp, &snapshot, &limits).unwrap();
    let empty_snapshot = candidate("empty-snapshot", vec![Verdict::Absent; 3]);
    let one = d::score(&fc, &empty_snapshot, &limits).unwrap();
    let two = d::score(&snapshot_context, &empty_snapshot, &limits).unwrap();
    let snapshot_margin = d::separate_difference(&one, &two).unwrap();
    assert_eq!(snapshot_margin.margin.graphs.len(), 1);
    assert_eq!(snapshot_margin.margin.absolute, d::FLUSH_UNIT);
    out.insert(
        "decision-shared-graph-equal-snapshots-count-flush-once".into(),
        comparison(&snapshot_margin),
    );
    let fg2 = graph(vec![m, 2.0, 0.0], &[(0, 2, 0.5)], &[]);
    let fr2 = a::rank(&fg2, &fp, limits.clone()).unwrap();
    let fc2 = d::DecisionContext::new(&fg2, &fp, &fr2, &limits).unwrap();
    let empty = candidate("empty", vec![Absent; 3]);
    let s1 = d::score(&fc, &empty, &limits).unwrap();
    let s2 = d::score(&fc2, &empty, &limits).unwrap();
    let combined = d::separate_difference(&s1, &s2).unwrap();
    assert_eq!(combined.margin.absolute, 2.0 * d::FLUSH_UNIT);
    assert_eq!(combined.margin.graphs.len(), 2);
    assert_eq!(
        d::separate_difference(&s1, &s1).unwrap().margin.absolute,
        d::FLUSH_UNIT
    );
    assert_eq!(
        d::actual_positive_support(Some(&s1))
            .unwrap()
            .margin
            .unwrap()
            .absolute,
        d::FLUSH_UNIT
    );
    assert_eq!(
        d::meets_threshold(Some(&s1), &rational(1, 1))
            .unwrap()
            .margin
            .unwrap()
            .absolute,
        d::FLUSH_UNIT
    );
    assert_eq!(
        d::eligible_competitor_potential(Some(&s1))
            .unwrap()
            .margin
            .unwrap()
            .absolute,
        d::FLUSH_UNIT
    );
    out.insert(
        "decision-counted-separate-absolute-margins".into(),
        comparison(&combined),
    );

    let n = 2301;
    let mut q = vec![0.0; n];
    q[0] = 1.0;
    let edges: Vec<_> = (0..n - 1).map(|i| (i, i + 1, 1.0)).collect();
    let deep = graph(q, &edges, &[]);
    let dp = params(1.0, 0.9, 100_000);
    let dr = a::rank(&deep, &dp, limits.clone()).unwrap();
    let dc = d::DecisionContext::new(&deep, &dp, &dr, &limits).unwrap();
    let mut v = vec![Absent; n];
    v[n - 1] = Bless;
    let s = d::score(&dc, &candidate("deep", v), &limits).unwrap();
    let positive = d::actual_positive_support(Some(&s)).unwrap();
    let m = positive.margin.unwrap();
    assert_eq!(m.depth, n - 1);
    assert!(m.factor > 1e-12);
    out.insert("decision-depth-dependent-factor".into(), margin(&m));
    let mixed = d::separate_difference(&s, &s1).unwrap();
    assert_eq!(mixed.margin.depth, n - 1);
    assert_eq!(mixed.margin.factor, d::relative_factor(n - 1));
    assert_eq!(mixed.margin.absolute, d::FLUSH_UNIT);
    assert_eq!(mixed.margin.graphs.len(), 2);
    out.insert(
        "decision-separate-graphs-use-maximum-depth".into(),
        comparison(&mixed),
    );
    out
}
pub fn potential_vectors() -> BTreeMap<String, Vec<u64>> {
    use Verdict::*;
    let mut out = BTreeMap::new();
    let limits = Limits::default();
    let t = rational(1, 2);
    let g = graph(vec![1.0, 0.0, 0.0], &[(0, 1, 1.0), (1, 2, 1.0)], &[]);
    let p = params(3.0, 0.5, 1);
    let r = a::rank(&g, &p, limits.clone()).unwrap();
    let ctx = d::DecisionContext::new(&g, &p, &r, &limits).unwrap();
    let a = candidate("a", vec![Bless, Absent, Absent]);
    let b = candidate("b", vec![Absent, Absent, Bless]);
    let sa = d::score(&ctx, &a, &limits).unwrap();
    let sb = d::score(&ctx, &b, &limits).unwrap();
    assert_eq!(
        d::actual_positive_support(Some(&sa)).unwrap().status,
        d::ActualSupport::Positive
    );
    assert_eq!(
        d::actual_positive_support(Some(&sb)).unwrap().status,
        d::ActualSupport::NotEstablished
    );
    assert_eq!(
        d::eligible_competitor_potential(Some(&sb)).unwrap().status,
        d::Potential::Possible
    );
    let entries = [
        d::LayerCandidate {
            candidate: &a,
            context: Some(&ctx),
        },
        d::LayerCandidate {
            candidate: &b,
            context: Some(&ctx),
        },
    ];
    let blocked = d::automatic_selection(&entries, &[], &t, &limits).unwrap();
    assert_eq!(blocked.selected, None);
    out.insert(
        "rafsi-overlapping-eligible-potential-blocks".into(),
        vec![
            blocked.candidates[0].actual.as_ref().unwrap().status as u64,
            blocked.candidates[1].actual.as_ref().unwrap().status as u64,
            blocked.candidates[1]
                .eligible_potential
                .as_ref()
                .unwrap()
                .status as u64,
        ],
    );

    let nonpositive = candidate("negative", vec![Curse, Absent, Absent]);
    let sn = d::score(&ctx, &nonpositive, &limits).unwrap();
    assert_eq!(
        d::eligible_competitor_potential(Some(&sn)).unwrap().status,
        d::Potential::Nonpositive
    );
    let entries = [
        entries[0],
        d::LayerCandidate {
            candidate: &nonpositive,
            context: Some(&ctx),
        },
    ];
    let selected = d::automatic_selection(&entries, &[], &t, &limits).unwrap();
    assert_eq!(selected.selected.as_deref(), Some("a"));
    assert!(selected.conditional_on_identified_inventory);
    out.insert(
        "rafsi-nonpositive-competitor-does-not-block".into(),
        vec![
            selected.candidates[1]
                .eligible_potential
                .as_ref()
                .unwrap()
                .status as u64,
        ],
    );
    let unresolved = d::unresolved_pair_potential(Some(&ctx), Some(&b.verdicts), &limits).unwrap();
    assert_eq!(unresolved.status, d::Potential::Possible);
    assert_eq!(
        d::automatic_selection(&entries, std::slice::from_ref(&unresolved), &t, &limits)
            .unwrap()
            .selected,
        None
    );
    out.insert(
        "rafsi-unresolved-pair-retains-gate-independent-potential".into(),
        margin(unresolved.margin.as_ref().unwrap()),
    );
    let missing = d::unresolved_pair_potential(Some(&ctx), None, &limits).unwrap();
    assert_eq!(missing.status, d::Potential::Unavailable);
    assert_eq!(
        d::automatic_selection(&entries, &[missing], &t, &limits)
            .unwrap()
            .selected,
        None
    );
    let unavailable = candidate("missing", vec![Absent; 3]);
    let unknown = [
        entries[0],
        d::LayerCandidate {
            candidate: &unavailable,
            context: None,
        },
    ];
    assert_eq!(
        d::automatic_selection(&unknown, &[], &t, &limits)
            .unwrap()
            .selected,
        None
    );
    let mut ineligible = b.clone();
    ineligible.eligibility = Eligibility::Ineligible;
    let excluded = [
        entries[0],
        d::LayerCandidate {
            candidate: &ineligible,
            context: Some(&ctx),
        },
    ];
    assert_eq!(
        d::automatic_selection(&excluded, &[], &t, &limits)
            .unwrap()
            .selected
            .as_deref(),
        Some("a")
    );
    let raw =
        d::unresolved_pair_potential(Some(&ctx), Some(&ineligible.verdicts), &limits).unwrap();
    assert_eq!(raw.status, d::Potential::Possible);
    assert_eq!(
        d::automatic_selection(&excluded, &[raw], &t, &limits)
            .unwrap()
            .selected,
        None
    );
    out.insert(
        "rafsi-missing-evidence-and-ineligible-gates".into(),
        vec![1],
    );

    let m = f64::MIN_POSITIVE;
    let fg = graph(vec![m, 1.0, 0.0], &[(0, 2, 0.5)], &[]);
    let fp = params(1.0, 0.5, 1);
    let fr = a::rank(&fg, &fp, limits.clone()).unwrap();
    let fc = d::DecisionContext::new(&fg, &fp, &fr, &limits).unwrap();
    let competitor = candidate("flushed", vec![Absent, Absent, Bless]);
    let s = d::score(&fc, &competitor, &limits).unwrap();
    assert_eq!(s.net.upper, 0.0);
    assert!(!s.structural_known_zero());
    assert_eq!(s.direct_reviewers(), 1);
    let potential = d::eligible_competitor_potential(Some(&s)).unwrap();
    assert_eq!(potential.status, d::Potential::Possible);
    assert_eq!(potential.margin.as_ref().unwrap().absolute, d::FLUSH_UNIT);
    out.insert(
        "rafsi-flushed-zero-is-never-structural-zero".into(),
        margin(potential.margin.as_ref().unwrap()),
    );

    for (name, h, alpha, refusals, known_zero) in [
        ("unreachable", 0.0, 0.5, vec![], true),
        ("refused", 1.0, 0.5, vec![(0, 1)], true),
        ("alpha-zero-two-hops", 1.0, 0.0, vec![], true),
        ("permitted", 1.0, 0.5, vec![], false),
    ] {
        let g = graph(vec![1.0, 0.0, 0.0], &[(0, 1, 1.0), (1, 2, 1.0)], &refusals);
        let p = params(h, alpha, 1);
        let r = a::rank(&g, &p, limits.clone()).unwrap();
        let ctx = d::DecisionContext::new(&g, &p, &r, &limits).unwrap();
        let s = d::score(&ctx, &b, &limits).unwrap();
        assert_eq!(s.structural_known_zero(), known_zero);
        let potential = d::eligible_competitor_potential(Some(&s)).unwrap();
        assert_eq!(
            potential.status,
            if known_zero {
                d::Potential::Nonpositive
            } else {
                d::Potential::Possible
            }
        );
        out.insert(
            format!("rafsi-structural-{name}"),
            vec![
                u64::from(s.structural_known_zero()),
                potential.status as u64,
            ],
        );
    }
    let one_hop = candidate("one-hop", vec![Absent, Bless, Absent]);
    let p = params(1.0, 0.0, 1);
    let r = a::rank(&g, &p, limits.clone()).unwrap();
    let ctx = d::DecisionContext::new(&g, &p, &r, &limits).unwrap();
    assert!(!d::score(&ctx, &one_hop, &limits)
        .unwrap()
        .structural_known_zero());
    out.insert("rafsi-alpha-zero-keeps-first-hop-potential".into(), vec![1]);
    out
}
pub fn layer_vectors() -> BTreeMap<String, Vec<u64>> {
    use Verdict::*;
    let mut out = BTreeMap::new();
    let limits = Limits::default();
    let g = graph(vec![1.0, 0.0], &[], &[]);
    let p = params(0.0, 0.5, 1);
    let r = a::rank(&g, &p, limits.clone()).unwrap();
    let ctx = d::DecisionContext::new(&g, &p, &r, &limits).unwrap();
    let a = candidate("a", vec![Absent; 2]);
    let b = candidate("b", vec![Bless, Absent]);
    let mut retired = candidate("c", vec![Bless; 2]);
    retired.deprecated = true;
    let expected = vec![
        vec!["b".to_string()],
        vec!["a".to_string()],
        vec!["c".to_string()],
    ];
    for (i, order) in [[&a, &b, &retired], [&retired, &a, &b], [&b, &retired, &a]]
        .into_iter()
        .enumerate()
    {
        let entries: Vec<_> = order
            .into_iter()
            .map(|candidate| d::LayerCandidate {
                candidate,
                context: Some(&ctx),
            })
            .collect();
        let result = d::nondominated_layers(&entries, &limits).unwrap();
        assert_eq!(result.layers, expected);
        out.insert(
            format!("layers-active-before-deprecated-permutation-{i}"),
            layers(&result),
        );
    }
    let c = d::difference(&b, &a, &ctx, &limits).unwrap();
    let ids = vec!["a".into(), "b".into(), "c".into(), "d".into()];
    let comparisons: Vec<_> = [(0, 1), (2, 0), (1, 2), (0, 3), (1, 3), (2, 3)]
        .into_iter()
        .map(|(a, b)| (a, b, c.clone()))
        .collect();
    let cycle = d::layers_from_comparisons(ids.clone(), &comparisons, &limits).unwrap();
    assert!(cycle.comparison_cycle);
    assert_eq!(cycle.layers, vec![vec!["a", "b", "c"], vec!["d"]]);
    let mut reversed = comparisons.clone();
    reversed.reverse();
    assert_eq!(
        d::layers_from_comparisons(ids.clone(), &reversed, &limits).unwrap(),
        cycle
    );
    out.insert("layers-collapse-comparison-cycles".into(), layers(&cycle));
    assert!(d::layers_from_comparisons(ids.clone(), &comparisons[..5], &limits).is_err());
    let mut bad = comparisons.clone();
    bad[0].2.margin.value = 0.5;
    assert!(d::layers_from_comparisons(ids, &bad, &limits).is_err());
    let missing = candidate("missing", vec![Bless; 2]);
    let partial = d::nondominated_layers(
        &[
            d::LayerCandidate {
                candidate: &a,
                context: Some(&ctx),
            },
            d::LayerCandidate {
                candidate: &missing,
                context: None,
            },
        ],
        &limits,
    )
    .unwrap();
    assert!(partial.incomplete);
    assert!(d::order_unjudged(&mut partial.clone(), &[]).is_err());
    assert_eq!(partial.unavailable, vec!["missing"]);
    out.insert(
        "layers-unavailable-remains-disclosed".into(),
        layers(&partial),
    );

    let defs: Vec<_> = [
        "a-import",
        "b-reviewed",
        "c-native",
        "d-virtual",
        "e-unknown",
    ]
    .iter()
    .map(|id| {
        candidate(
            id,
            if *id == "b-reviewed" {
                vec![Absent, Curse]
            } else {
                vec![Absent; 2]
            },
        )
    })
    .collect();
    let scores: Vec<_> = defs
        .iter()
        .map(|c| d::score(&ctx, c, &limits).unwrap())
        .collect();
    assert_eq!(scores[1].direct_reviewers(), 1);
    assert!(scores[1].structural_known_zero());
    let entries: Vec<_> = defs
        .iter()
        .map(|candidate| d::LayerCandidate {
            candidate,
            context: Some(&ctx),
        })
        .collect();
    let mut result = d::nondominated_layers(&entries, &limits).unwrap();
    let kinds = [
        d::StartingKind::Imported,
        d::StartingKind::VirtualUnreviewed,
        d::StartingKind::NativeReviewed,
        d::StartingKind::VirtualUnreviewed,
        d::StartingKind::NativeReviewed,
    ];
    let data: Vec<_> = defs
        .iter()
        .zip(&scores)
        .zip(kinds)
        .enumerate()
        .map(|(i, ((c, s), k))| {
            d::Presentation::from_score(c.id.clone(), if i == 4 { None } else { Some(s) }, k)
        })
        .collect();
    d::order_unjudged(&mut result, &data).unwrap();
    assert_eq!(
        result.layers,
        vec![vec![
            "c-native",
            "b-reviewed",
            "a-import",
            "d-virtual",
            "e-unknown"
        ]]
    );
    out.insert(
        "layers-reorder-only-known-unjudged-structural-zero-slots".into(),
        layers(&result),
    );
    out
}
pub fn validation_vectors() -> BTreeMap<String, Vec<u64>> {
    use Verdict::*;
    let mut out = BTreeMap::new();
    let limits = Limits::default();
    let g = graph(vec![1.0], &[], &[]);
    let p = params(0.0, 0.5, 1);
    let r = a::rank(&g, &p, limits.clone()).unwrap();
    for i in 0..3 {
        let mut broken = r.clone();
        match i {
            0 => broken.progress.upper = None,
            1 => broken.progress.upper.as_mut().unwrap().complete = false,
            _ => broken.weights[0].upper = f64::INFINITY,
        }
        assert!(d::DecisionContext::new(&g, &p, &broken, &limits).is_err());
    }
    let ctx = d::DecisionContext::new(&g, &p, &r, &limits).unwrap();
    assert!(d::score(&ctx, &candidate("bad", vec![]), &limits).is_err());
    assert_eq!(
        d::actual_positive_support(None).unwrap().status,
        d::ActualSupport::Unavailable
    );
    assert_eq!(
        d::eligible_competitor_potential(None).unwrap().status,
        d::Potential::Unavailable
    );
    let c = candidate("candidate", vec![Bless]);
    let entries = [d::LayerCandidate {
        candidate: &c,
        context: Some(&ctx),
    }];
    assert!(d::automatic_selection(&entries, &[], &rational(0, 1), &limits).is_err());
    let too_small = Limits {
        max_candidate_actor_terms: 0,
        ..limits.clone()
    };
    assert!(d::score(&ctx, &c, &too_small).is_err());
    assert!(d::nondominated_layers(&[entries[0], entries[0]], &limits).is_err());
    out.insert(
        "decisions-refuse-incomplete-invalid-and-oversized-inputs".into(),
        vec![1],
    );
    let g = graph(vec![1.0, 0.0], &[(0, 1, 1.0)], &[]);
    let p = params(1.0, 0.5, 1);
    let r = a::rank(&g, &p, limits.clone()).unwrap();
    let ctx = d::DecisionContext::new(&g, &p, &r, &limits).unwrap();
    let c = candidate("structural", vec![Absent, Bless]);
    let zero_search = Limits {
        max_candidate_actor_terms: 2,
        max_prefixes: 0,
        ..limits
    };
    assert!(!d::score(&ctx, &c, &zero_search)
        .unwrap()
        .structural_known_zero());
    out.insert(
        "decisions-structural-search-limits-never-imply-zero".into(),
        vec![1],
    );
    out
}
pub fn permutation_vectors() -> BTreeMap<String, Vec<u64>> {
    use Verdict::*;
    let mut out = BTreeMap::new();
    let limits = Limits::default();
    let g = graph(
        vec![0.1, 0.2, 0.3],
        &[(0, 1, 0.3), (1, 2, 0.2), (2, 0, 0.1)],
        &[],
    );
    let p = params(3.0, 0.5, 7);
    let r = a::rank(&g, &p, limits.clone()).unwrap();
    let ctx = d::DecisionContext::new(&g, &p, &r, &limits).unwrap();
    let reverse = a::Graph::new(
        g.actors.iter().rev().cloned().collect(),
        g.q.iter().rev().copied().collect(),
        g.rows
            .iter()
            .rev()
            .map(|row| {
                row.iter()
                    .rev()
                    .map(|e| a::Edge {
                        to: 2 - e.to,
                        share: e.share,
                    })
                    .collect()
            })
            .collect(),
        vec![vec![]; 3],
        &limits,
    )
    .unwrap();
    assert_eq!(g, reverse);
    let rr = a::rank(&reverse, &p, limits.clone()).unwrap();
    assert_eq!(r, rr);
    let rc = d::DecisionContext::new(&reverse, &p, &rr, &limits).unwrap();
    let c = [
        candidate("a", vec![Bless, Curse, Absent]),
        candidate("b", vec![Absent, Bless, Curse]),
        candidate("c", vec![Curse, Absent, Bless]),
    ];
    let original = d::difference(&c[0], &c[1], &ctx, &limits).unwrap();
    assert_eq!(
        comparison(&original),
        comparison(&d::difference(&c[0], &c[1], &rc, &limits).unwrap())
    );
    let base = d::nondominated_layers(
        &c.iter()
            .map(|candidate| d::LayerCandidate {
                candidate,
                context: Some(&ctx),
            })
            .collect::<Vec<_>>(),
        &limits,
    )
    .unwrap();
    for (i, order) in [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ]
    .into_iter()
    .enumerate()
    {
        let entries: Vec<_> = order
            .iter()
            .map(|&j| d::LayerCandidate {
                candidate: &c[j],
                context: Some(&rc),
            })
            .collect();
        let result = d::nondominated_layers(&entries, &limits).unwrap();
        assert_eq!(result, base);
        let mut bits = layers(&result);
        bits.extend(comparison(&original));
        out.insert(
            format!("decisions-actor-and-candidate-permutation-{i}"),
            bits,
        );
    }
    out
}

pub fn review_permutation_vectors() -> BTreeMap<String, Vec<u64>> {
    use Verdict::*;
    let limits = Limits::default();
    let mut out = BTreeMap::new();
    let high = f64::from_bits(0x40d1_9799_812d_ea12);
    let low = f64::from_bits(0x40d1_9799_812d_ea11);
    let upper = 2.0f64.powi(54);
    let support = high + 2.0;
    // A real unexpanded graph supplies a wide support range at depth zero.
    let ga = graph(
        vec![upper - support, support, 2.0, 0.0],
        &[(0, 1, 1.0), (0, 3, 1e-15)],
        &[],
    );
    let gb = graph(vec![f64::EPSILON; 2], &[], &[]);
    let p = params(1.0, 0.0, 1);
    let ra = a::rank(&ga, &p, limits.clone()).unwrap();
    let rb = a::rank(&gb, &p, limits.clone()).unwrap();
    let ca = d::DecisionContext::new(&ga, &p, &ra, &limits).unwrap();
    let cb = d::DecisionContext::new(&gb, &p, &rb, &limits).unwrap();
    let aa = candidate("a", vec![Absent, Bless, Curse, Absent]);
    let bb = candidate("b", vec![Bless, Curse]);
    let sa = d::score(&ca, &aa, &limits).unwrap();
    let sb = d::score(&cb, &bb, &limits).unwrap();
    assert_eq!(sa.support.upper, upper);
    assert_eq!(sa.opposition.upper, 2.0);
    let ab = d::separate_difference(&sa, &sb).unwrap();
    let ba = d::separate_difference(&sb, &sa).unwrap();
    assert_eq!(ab.margin, ba.margin);
    assert_eq!(ab.margin.contribution_mass.to_bits(), 0x4350_0000_0000_0001);
    assert_eq!(ab.margin.value, high);
    assert!(ab.difference.lower > low);
    assert_eq!(ab.difference.lower, high);
    assert_eq!(ab.difference.lower, -ba.difference.upper);
    assert_eq!(ab.difference.upper, -ba.difference.lower);
    assert!(!ab.a_leads());
    assert!(!ba.b_leads());
    let entries = [
        d::LayerCandidate {
            candidate: &aa,
            context: Some(&ca),
        },
        d::LayerCandidate {
            candidate: &bb,
            context: Some(&cb),
        },
    ];
    let forward = d::nondominated_layers(&entries, &limits).unwrap();
    let reverse = d::nondominated_layers(&[entries[1], entries[0]], &limits).unwrap();
    assert_eq!(forward, reverse);
    assert_eq!(forward.layers, vec![vec!["a", "b"]]);
    assert_eq!(
        d::automatic_selection(&entries, &[], &rational(1, 1), &limits)
            .unwrap()
            .selected,
        None
    );
    let mut values = comparison(&ab);
    values.extend(comparison(&ba));
    values.extend(layers(&forward));
    out.insert(
        "review-canonical-cross-graph-adjacent-margin-boundary".into(),
        values,
    );

    for (i, q) in [[0.1, 0.2], [1e16, 1.0], [1e-100, 1e-101], [upper, 2.0]]
        .into_iter()
        .enumerate()
    {
        let ga = graph(q.to_vec(), &[], &[]);
        let gb = graph(vec![0.3, 0.1], &[], &[]);
        let p = params(0.0, 0.5, 1);
        let ra = a::rank(&ga, &p, limits.clone()).unwrap();
        let rb = a::rank(&gb, &p, limits.clone()).unwrap();
        let ca = d::DecisionContext::new(&ga, &p, &ra, &limits).unwrap();
        let cb = d::DecisionContext::new(&gb, &p, &rb, &limits).unwrap();
        let a = candidate("a", vec![Bless, Curse]);
        let b = candidate("b", vec![Bless, Curse]);
        let sa = d::score(&ca, &a, &limits).unwrap();
        let sb = d::score(&cb, &b, &limits).unwrap();
        let ab = d::separate_difference(&sa, &sb).unwrap();
        let ba = d::separate_difference(&sb, &sa).unwrap();
        assert_eq!(ab.margin, ba.margin);
        assert_eq!(ab.a_leads(), ba.b_leads());
        assert_eq!(ab.b_leads(), ba.a_leads());
        let canon = |v: f64| if v == 0.0 { 0.0 } else { v };
        assert_eq!(
            canon(ab.difference.lower).to_bits(),
            canon(-ba.difference.upper).to_bits()
        );
        assert_eq!(
            canon(ab.difference.upper).to_bits(),
            canon(-ba.difference.lower).to_bits()
        );
        out.insert(format!("review-cross-graph-direction-{i}"), comparison(&ab));
    }
    let g = graph(vec![1e16, 1.0, 0.0], &[], &[]);
    let p = params(0.0, 0.5, 1);
    let r = a::rank(&g, &p, limits.clone()).unwrap();
    let ctx = d::DecisionContext::new(&g, &p, &r, &limits).unwrap();
    let a = candidate("a", vec![Bless, Bless, Absent]);
    let b = candidate("b", vec![Bless, Absent, Absent]);
    let clone = g.clone();
    let snapshot = r.clone();
    let copied = d::DecisionContext::new(&clone, &p, &snapshot, &limits).unwrap();
    let graph_only = d::DecisionContext::new(&clone, &p, &r, &limits).unwrap();
    let ranking_only = d::DecisionContext::new(&g, &p, &snapshot, &limits).unwrap();
    let changed_work = {
        let mut r = r.clone();
        r.progress.work.numerical_operations += 17;
        r
    };
    let same_numbers = d::DecisionContext::new(&g, &p, &changed_work, &limits).unwrap();
    for (i, c) in [&ctx, &graph_only, &ranking_only, &copied, &same_numbers]
        .into_iter()
        .enumerate()
    {
        let entries = [
            d::LayerCandidate {
                candidate: &a,
                context: Some(&ctx),
            },
            d::LayerCandidate {
                candidate: &b,
                context: Some(c),
            },
        ];
        let ranked = d::nondominated_layers(&entries, &limits).unwrap();
        assert_eq!(ranked.layers, vec![vec!["a"], vec!["b"]]);
        assert_eq!(
            d::automatic_selection(&entries, &[], &rational(1, 2), &limits)
                .unwrap()
                .selected
                .as_deref(),
            Some("a")
        );
        assert_eq!(
            d::nondominated_layers(&[entries[1], entries[0]], &limits).unwrap(),
            ranked
        );
        out.insert(
            format!("review-cloned-graph-ranking-cancellation-{i}"),
            layers(&ranked),
        );
    }
    out
}
pub fn review_status_vectors() -> BTreeMap<String, Vec<u64>> {
    use Verdict::*;
    let limits = Limits::default();
    let mut out = BTreeMap::new();
    let g = graph(vec![1.0], &[], &[]);
    let p = params(0.0, 0.5, 1);
    let r = a::rank(&g, &p, limits.clone()).unwrap();
    let ctx = d::DecisionContext::new(&g, &p, &r, &limits).unwrap();
    let mut retired = candidate("retired-blessing", vec![Bless]);
    retired.deprecated = true;
    let s = d::score(&ctx, &retired, &limits).unwrap();
    assert_eq!(
        s.net,
        a::Estimate {
            lower: 0.0,
            upper: 0.0
        }
    );
    assert!(!s.structural_known_zero());
    assert_eq!(s.direct_reviewers(), 1);
    let potential = d::eligible_competitor_potential(Some(&s)).unwrap();
    assert_eq!(potential.status, d::Potential::Possible);
    assert_eq!(
        d::automatic_selection(
            &[d::LayerCandidate {
                candidate: &retired,
                context: Some(&ctx)
            }],
            &[],
            &rational(1, 2),
            &limits
        )
        .unwrap()
        .selected,
        None
    );
    out.insert(
        "review-deprecated-blessing-retains-structural-potential".into(),
        vec![
            potential.status as u64,
            u64::from(s.structural_known_zero()),
        ],
    );

    let mut missing = candidate("missing", vec![Absent]);
    missing.eligibility = Eligibility::Unavailable;
    let known = candidate("known", vec![Absent]);
    let expected =
        a::PreparationError::Graph(jvc_rank::RankError::UnavailableCandidate("missing".into()));
    assert_eq!(d::score(&ctx, &missing, &limits).unwrap_err(), expected);
    assert_eq!(
        d::difference(&known, &missing, &ctx, &limits).unwrap_err(),
        expected
    );
    assert_eq!(
        d::difference(&missing, &known, &ctx, &limits).unwrap_err(),
        expected
    );
    let mut unrevealed = missing.clone();
    unrevealed.verdicts.clear();
    assert_eq!(d::score(&ctx, &unrevealed, &limits).unwrap_err(), expected);
    assert_eq!(
        d::difference(&unrevealed, &known, &ctx, &limits).unwrap_err(),
        expected
    );
    let mut partial = d::nondominated_layers(
        &[d::LayerCandidate {
            candidate: &missing,
            context: None,
        }],
        &limits,
    )
    .unwrap();
    assert_eq!(
        d::order_unjudged(&mut partial, &[]).unwrap_err(),
        a::PreparationError::Graph(jvc_rank::RankError::InvalidGraph(
            "incomplete layers".into()
        ))
    );
    let mut ineligible = known.clone();
    ineligible.eligibility = Eligibility::Ineligible;
    assert_eq!(
        d::nondominated_layers(
            &[d::LayerCandidate {
                candidate: &ineligible,
                context: Some(&ctx)
            }],
            &limits
        )
        .unwrap_err(),
        a::PreparationError::Graph(jvc_rank::RankError::InvalidGraph(
            "candidate is not eligible for ranking layers".into()
        ))
    );
    out.insert(
        "review-unavailable-incomplete-and-ineligible-error-classes".into(),
        vec![1],
    );

    let mut a = candidate("a-import", vec![Absent]);
    let mut z = candidate("z-native", vec![Absent]);
    for deprecated in [false, true] {
        a.deprecated = deprecated;
        z.deprecated = deprecated;
        let sa = d::score(&ctx, &a, &limits).unwrap();
        let sz = d::score(&ctx, &z, &limits).unwrap();
        let mut ranked = d::nondominated_layers(
            &[
                d::LayerCandidate {
                    candidate: &a,
                    context: Some(&ctx),
                },
                d::LayerCandidate {
                    candidate: &z,
                    context: Some(&ctx),
                },
            ],
            &limits,
        )
        .unwrap();
        let presentation = [
            d::Presentation::from_score(a.id.clone(), Some(&sa), d::StartingKind::Imported),
            d::Presentation::from_score(z.id.clone(), Some(&sz), d::StartingKind::NativeReviewed),
        ];
        d::order_unjudged(&mut ranked, &presentation).unwrap();
        assert_eq!(
            ranked.layers,
            if deprecated {
                vec![vec!["a-import", "z-native"]]
            } else {
                vec![vec!["z-native", "a-import"]]
            }
        );
        out.insert(
            format!("review-starting-preference-active-only-{deprecated}"),
            layers(&ranked),
        );
    }
    let g = graph(
        vec![1.0, 0.0, 0.0, 0.0],
        &[
            (0, 1, 0.5),
            (0, 2, 0.5),
            (1, 0, 0.5),
            (1, 2, 0.5),
            (2, 0, 0.5),
            (2, 1, 0.5),
        ],
        &[],
    );
    let p = params(1.0, 0.5, 1000);
    let r = a::rank(&g, &p, limits.clone()).unwrap();
    assert!(r.progress.exploration_complete);
    let ctx = d::DecisionContext::new(&g, &p, &r, &limits).unwrap();
    let c = candidate("unreachable", vec![Absent, Absent, Absent, Bless]);
    assert!(d::score(&ctx, &c, &limits).unwrap().structural_known_zero());
    assert!(d::score(
        &ctx,
        &c,
        &Limits {
            max_candidate_actor_terms: 4,
            ..limits
        }
    )
    .unwrap()
    .structural_known_zero());
    out.insert(
        "review-unreachable-blesser-uses-plain-reachability".into(),
        vec![1],
    );
    out
}
pub fn large_exact_zero_vectors() -> BTreeMap<String, Vec<u64>> {
    use num_traits::{One, Zero};
    use Verdict::*;
    let mut out = BTreeMap::new();
    let count = 200_000usize;
    let unit = 2.0f64.powi(-54);
    let exact_unit = jvc_rank::Rational::new(1.into(), num_bigint::BigInt::from(1u8) << 54usize);
    let exact_support =
        jvc_rank::Rational::one() + &exact_unit * jvc_rank::Rational::from_integer(count.into());
    let mut exact_opposition = jvc_rank::Rational::one();
    for _ in 0..count {
        exact_opposition += &exact_unit;
    }
    assert_eq!(exact_support, exact_opposition);
    assert!((&exact_support - &exact_opposition).is_zero());
    let mut q = vec![1.0 + count as f64 * unit, 1.0];
    q.extend(std::iter::repeat_n(unit, count));
    let n = q.len();
    let limits = Limits {
        max_actors: n,
        ..Limits::default()
    };
    let g = a::Graph::new(
        (0..n).map(|i| format!("actor-{i:06}")).collect(),
        q,
        vec![vec![]; n],
        vec![vec![]; n],
        &limits,
    )
    .unwrap();
    let p = params(0.0, 0.5, 1);
    let r = a::rank(&g, &p, limits.clone()).unwrap();
    assert_eq!(r.progress.depth, 0);
    let ctx = d::DecisionContext::new(&g, &p, &r, &limits).unwrap();
    let mut v = vec![Curse; n];
    v[0] = Bless;
    let c = candidate("large-exact-zero", v);
    let s = d::score(&ctx, &c, &limits).unwrap();
    assert_eq!(
        jvc_rank::Rational::from_float(s.support.lower).unwrap(),
        exact_support
    );
    assert_eq!(
        jvc_rank::Rational::from_float(s.opposition.lower).unwrap(),
        exact_opposition
    );
    assert_eq!(
        s.net,
        a::Estimate {
            lower: 0.0,
            upper: 0.0
        }
    );
    let actual = d::actual_positive_support(Some(&s)).unwrap();
    assert_eq!(actual.status, d::ActualSupport::NotEstablished);
    let mut naive_opposition = 1.0;
    for _ in 0..count {
        naive_opposition += unit;
    }
    let naive_net = s.support.lower - naive_opposition;
    assert!(naive_net > 1e-12 * (s.support.upper + naive_opposition));
    let mut bits = vec![
        s.support.lower.to_bits(),
        s.opposition.lower.to_bits(),
        s.net.lower.to_bits(),
        naive_net.to_bits(),
        actual.status as u64,
    ];
    bits.extend(margin(actual.margin.as_ref().unwrap()));
    out.insert(
        "review-required-200000-term-rational-exact-zero".into(),
        bits,
    );
    out
}

#[allow(dead_code)]
pub fn vectors() -> BTreeMap<String, Vec<u64>> {
    let mut out = numerical_vectors();
    out.extend(comparison_vectors());
    out.extend(potential_vectors());
    out.extend(layer_vectors());
    out.extend(validation_vectors());
    out.extend(permutation_vectors());
    out.extend(review_permutation_vectors());
    out.extend(review_status_vectors());
    out.extend(large_exact_zero_vectors());
    out.extend(stage_two_vectors());
    out
}

pub fn stage_two_vectors() -> BTreeMap<String, Vec<u64>> {
    use Verdict::*;
    let mut out = BTreeMap::new();
    let limits = Limits::default();
    // An unreachable blesser cannot remove ordinary dense-community layers.
    for k in 8..=12 {
        let mut q = vec![0.0; k + 1];
        q[0] = 1.0;
        let edges: Vec<_> = (0..k)
            .flat_map(|from| {
                (0..k)
                    .filter(move |&to| to != from)
                    .map(move |to| (from, to, 1.0 / 16.0))
            })
            .collect();
        let g = graph(q, &edges, &[]);
        let p = params(3.0, 0.5, 1_000_000);
        let r = a::rank(&g, &p, limits.clone()).unwrap();
        assert!(r.progress.exploration_complete);
        let ctx = d::DecisionContext::new(&g, &p, &r, &limits).unwrap();
        let mut signs = vec![Absent; k + 1];
        signs[k] = Bless;
        let unreachable = candidate("unreachable", signs);
        let mut signs = vec![Absent; k + 1];
        signs[0] = Bless;
        let winner = candidate("winner", signs);
        let entries = [
            d::LayerCandidate {
                candidate: &winner,
                context: Some(&ctx),
            },
            d::LayerCandidate {
                candidate: &unreachable,
                context: Some(&ctx),
            },
        ];
        let ranked = d::nondominated_layers(&entries, &limits).unwrap();
        assert!(!ranked.incomplete);
        let selection = d::automatic_selection(&entries, &[], &rational(1, 2), &limits).unwrap();
        assert_eq!(selection.selected.as_deref(), Some("winner"));
        let s = d::score(&ctx, &unreachable, &limits).unwrap();
        assert!(s.structural_known_zero());
        out.insert(format!("review-dense-cluster-{k}"), layers(&ranked));
    }
    // Many permutations share each visited-set/endpoint state. The blesser
    // is reachable without refusals, so only the merged proof establishes zero.
    let k = 12;
    let mut q = vec![0.0; k + 1];
    q[0] = 1.0;
    let mut edges: Vec<_> = (0..k)
        .flat_map(|from| {
            (0..k)
                .filter(move |&to| to != from)
                .map(move |to| (from, to, 1.0 / 16.0))
        })
        .collect();
    edges.extend((0..k).map(|from| (from, k, 1.0 / 16.0)));
    let g = graph(q, &edges, &[(0, k)]);
    let p = params(3.0, 0.5, 1_000_000);
    let r = a::rank(&g, &p, limits.clone()).unwrap();
    let ctx = d::DecisionContext::new(&g, &p, &r, &limits).unwrap();
    let mut signs = vec![Absent; k + 1];
    signs[k] = Bless;
    let c = candidate("refused-dense-blesser", signs);
    let s = d::score(&ctx, &c, &limits).unwrap();
    assert!(s.structural_known_zero());
    assert_eq!(
        d::eligible_competitor_potential(Some(&s)).unwrap().status,
        d::Potential::Nonpositive
    );
    out.insert("review-dense-refusal-search-merges-states".into(), vec![1]);
    // A reachable blesser is blocked by a root refusal. Exhaustion is unknown.
    let g = graph(
        vec![1.0, 0.0, 0.0, 0.0],
        &[
            (0, 1, 0.5),
            (0, 2, 0.5),
            (1, 2, 0.5),
            (2, 1, 0.5),
            (1, 3, 0.5),
            (2, 3, 0.5),
        ],
        &[(0, 3)],
    );
    let p = params(3.0, 0.5, 1000);
    let r = a::rank(&g, &p, limits.clone()).unwrap();
    let ctx = d::DecisionContext::new(&g, &p, &r, &limits).unwrap();
    let c = candidate("blocked", vec![Absent, Absent, Absent, Bless]);
    assert!(d::score(&ctx, &c, &limits).unwrap().structural_known_zero());
    let tight = Limits {
        max_candidate_actor_terms: 4,
        ..limits.clone()
    };
    let s = d::score(&ctx, &c, &tight).unwrap();
    assert!(!s.structural_known_zero());
    assert_eq!(
        d::eligible_competitor_potential(Some(&s)).unwrap().status,
        d::Potential::Possible
    );
    assert!(
        !d::nondominated_layers(
            &[d::LayerCandidate {
                candidate: &c,
                context: Some(&ctx)
            }],
            &tight
        )
        .unwrap()
        .incomplete
    );
    out.insert("review-structural-exhaustion-is-unknown".into(), vec![1]);

    // Estimate snapshots share a graph but carry separate dropped mass.
    let g = graph(vec![f64::MIN_POSITIVE, 1.0, 0.0], &[(0, 2, 0.5)], &[]);
    let p = params(3.0, 0.5, 100);
    let r = a::rank(&g, &p, limits.clone()).unwrap();
    let mut later = r.clone();
    later.progress.depth = 2;
    later.progress.work.flushed_terms = 3;
    let first = d::DecisionContext::new(&g, &p, &r, &limits).unwrap();
    let second = d::DecisionContext::new(&g, &p, &later, &limits).unwrap();
    let empty = candidate("empty", vec![Absent; 3]);
    let one = d::score(&first, &empty, &limits).unwrap();
    let two = d::score(&second, &empty, &limits).unwrap();
    let forward = d::separate_difference(&one, &two).unwrap();
    let reverse = d::separate_difference(&two, &one).unwrap();
    assert_eq!(forward.margin, reverse.margin);
    assert_eq!(forward.margin.graphs.len(), 2);
    assert_eq!(forward.margin.depth, 2);
    assert_eq!(forward.margin.absolute, 4.0 * d::FLUSH_UNIT);
    assert_eq!(
        forward
            .margin
            .graphs
            .iter()
            .map(|g| g.flushed_terms)
            .collect::<Vec<_>>(),
        vec![1, 3]
    );
    out.insert(
        "review-distinct-snapshots-sum-allowances".into(),
        comparison(&forward),
    );

    let g = graph(vec![1.0], &[], &[]);
    let p = params(0.0, 0.5, 1);
    let r = a::rank(&g, &p, limits.clone()).unwrap();
    for (name, h, alpha) in [
        ("h", 101.0, 0.5),
        ("alpha", 0.0, 1.0),
        ("negative-h", -1.0, 0.5),
        ("negative-alpha", 0.0, -0.1),
    ] {
        assert!(matches!(
            d::DecisionContext::new(&g, &params(h, alpha, 1), &r, &limits),
            Err(a::PreparationError::Graph(
                jvc_rank::RankError::InvalidParameters(_)
            ))
        ));
        out.insert(format!("review-invalid-parameter-{name}"), vec![1]);
    }
    for (name, approximate, complete) in [
        ("not-approximate", false, true),
        ("incomplete", true, false),
    ] {
        let mut bad = r.clone();
        bad.numerically_approximate = approximate;
        if !complete {
            bad.progress.upper = None;
        }
        assert!(matches!(
            d::DecisionContext::new(&g, &p, &bad, &limits),
            Err(a::PreparationError::Graph(
                jvc_rank::RankError::InvalidGraph(_)
            ))
        ));
        out.insert(format!("review-invalid-binding-{name}"), vec![1]);
    }
    let ctx = d::DecisionContext::new(&g, &p, &r, &limits).unwrap();
    let winner = candidate("winner", vec![Bless]);
    let s = d::score(&ctx, &winner, &limits).unwrap();
    for threshold in [rational(0, 1), rational(-1, 1)] {
        assert!(matches!(
            d::meets_threshold(Some(&s), &threshold),
            Err(a::PreparationError::Graph(
                jvc_rank::RankError::InvalidParameters(_)
            ))
        ));
        assert!(matches!(
            d::automatic_selection(&[], &[], &threshold, &limits),
            Err(a::PreparationError::Graph(
                jvc_rank::RankError::InvalidParameters(_)
            ))
        ));
    }
    out.insert("review-invalid-threshold-class".into(), vec![1]);

    let mut retired = candidate("retired", vec![Bless]);
    retired.deprecated = true;
    let retired_score = d::score(&ctx, &retired, &limits).unwrap();
    assert_eq!(retired_score.direct_reviewers(), 1);
    assert_eq!(retired_score.effective_direct_reviewers(), 0);
    let mut ineligible = winner.clone();
    ineligible.id = "ineligible".into();
    ineligible.eligibility = Eligibility::Ineligible;
    let iscore = d::score(&ctx, &ineligible, &limits).unwrap();
    assert_eq!(iscore.direct_reviewers(), 1);
    assert_eq!(iscore.effective_direct_reviewers(), 0);
    let entries = [
        d::LayerCandidate {
            candidate: &winner,
            context: Some(&ctx),
        },
        d::LayerCandidate {
            candidate: &ineligible,
            context: None,
        },
    ];
    let selected = d::automatic_selection(&entries, &[], &rational(1, 2), &limits).unwrap();
    assert_eq!(selected.selected.as_deref(), Some("winner"));
    let gate = &selected.candidates[0];
    assert_eq!(gate.eligibility, Eligibility::Ineligible);
    assert!(gate.actual.is_none() && gate.threshold.is_none() && gate.eligible_potential.is_none());
    out.insert(
        "review-effective-reviewers-and-ineligible-gate".into(),
        vec![1],
    );
    let entries = [
        entries[0],
        d::LayerCandidate {
            candidate: &retired,
            context: None,
        },
    ];
    let mut ranked = d::nondominated_layers(&entries, &limits).unwrap();
    assert!(!ranked.incomplete);
    assert_eq!(ranked.layers, vec![vec!["winner"], vec!["retired"]]);
    d::order_unjudged(&mut ranked, &[]).unwrap();
    out.insert(
        "review-retired-layer-without-context".into(),
        layers(&ranked),
    );
    let unresolved = d::unresolved_pair_potential(Some(&ctx), Some(&[Curse]), &limits).unwrap();
    assert_eq!(unresolved.status, d::Potential::Nonpositive);
    assert_eq!(
        d::automatic_selection(&entries[..1], &[unresolved], &rational(1, 2), &limits)
            .unwrap()
            .selected
            .as_deref(),
        Some("winner")
    );
    let mut missing = winner.clone();
    missing.id = "missing-evidence".into();
    missing.eligibility = Eligibility::Unavailable;
    let entries = [
        entries[0],
        d::LayerCandidate {
            candidate: &missing,
            context: None,
        },
    ];
    let selection = d::automatic_selection(&entries, &[], &rational(1, 2), &limits).unwrap();
    assert_eq!(selection.selected, None);
    assert_eq!(
        selection.candidates[0].eligibility,
        Eligibility::Unavailable
    );
    assert_eq!(
        selection.candidates[0]
            .eligible_potential
            .as_ref()
            .unwrap()
            .status,
        d::Potential::Unavailable
    );
    out.insert(
        "review-unresolved-and-missing-evidence-channels".into(),
        vec![1],
    );

    // Both chains have the same exact product, in different multiplication orders.
    let length = 4402;
    let n = 2 * (length + 1);
    let mut edges = Vec::new();
    let mut q = vec![0.0; n];
    q[0] = 1.0;
    q[length + 1] = 1.0;
    for chain in 0..2 {
        for hop in 0..length {
            edges.push((
                chain * (length + 1) + hop,
                chain * (length + 1) + hop + 1,
                if (hop + chain) % 2 == 0 {
                    0.999_999
                } else {
                    0.999_998
                },
            ));
        }
    }
    let g = graph(q, &edges, &[]);
    let p = params(3.0, 0.9, 100_000);
    let r = a::rank(&g, &p, limits.clone()).unwrap();
    assert_ne!(
        r.weights[length].lower.to_bits(),
        r.weights[n - 1].lower.to_bits()
    );
    let ctx = d::DecisionContext::new(&g, &p, &r, &limits).unwrap();
    let mut signs = vec![Absent; n];
    signs[length] = Bless;
    let one = candidate("one", signs);
    let mut signs = vec![Absent; n];
    signs[n - 1] = Bless;
    let two = candidate("two", signs);
    for (name, a, b) in [("forward", &one, &two), ("reverse", &two, &one)] {
        let compared = d::difference(a, b, &ctx, &limits).unwrap();
        assert!(!compared.a_leads() && !compared.b_leads());
        assert_eq!(compared.margin.depth, length);
        assert!(compared.margin.factor > 1e-12);
        let mut encoded = comparison(&compared);
        encoded.extend([
            r.weights[length].lower.to_bits(),
            r.weights[n - 1].lower.to_bits(),
        ]);
        out.insert(format!("review-long-equal-chains-{name}"), encoded);
    }
    out
}
