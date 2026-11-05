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
    let equality = d::meets_threshold(Some(&zero), &rational(0, 1)).unwrap();
    assert_eq!(equality.status, d::Threshold::Accepted);
    assert_eq!(equality.margin.as_ref().unwrap().value, 0.0);
    out.insert(
        "decision-inclusive-zero-margin-equality".into(),
        margin(equality.margin.as_ref().unwrap()),
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
    assert_eq!(separate.margin.graphs.len(), 2);
    out.insert(
        "decision-distinct-graph-margin-details".into(),
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
        "decision-shared-graph-different-snapshots-count-flush-once".into(),
        comparison(&snapshot_margin),
    );
    let fg2 = fg.clone();
    let fr2 = fr.clone();
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
            blocked.candidates[0].actual.status as u64,
            blocked.candidates[1].actual.status as u64,
            blocked.candidates[1].eligible_potential.status as u64,
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
        vec![selected.candidates[1].eligible_potential.status as u64],
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
    assert!(d::score(&ctx, &c, &zero_search).is_err());
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

#[allow(dead_code)]
pub fn vectors() -> BTreeMap<String, Vec<u64>> {
    let mut out = numerical_vectors();
    out.extend(comparison_vectors());
    out.extend(potential_vectors());
    out.extend(layer_vectors());
    out.extend(validation_vectors());
    out.extend(permutation_vectors());
    out
}
