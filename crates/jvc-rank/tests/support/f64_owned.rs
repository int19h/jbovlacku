use jvc_rank::{approximate as a, Limits, RankError};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};

type Vectors = BTreeMap<String, Vec<u64>>;
fn fields(c: a::AllocationCharge) -> [usize; 9] {
    [
        c.sums,
        c.prefixes,
        c.visited,
        c.estimates,
        c.graph_actors,
        c.graph_edges,
        c.graph_refusals,
        c.string_bytes,
        c.indices,
    ]
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Ledger {
    live: [usize; 9],
    peak: [usize; 9],
    reserved: [usize; 9],
    released: [usize; 9],
    calls: usize,
    releases: usize,
}
struct Account {
    ledger: Mutex<Ledger>,
    fail: Option<usize>,
    cap: Option<[usize; 9]>,
}
impl Account {
    fn new(fail: Option<usize>, cap: Option<[usize; 9]>) -> Arc<Self> {
        Arc::new(Self {
            ledger: Mutex::new(Ledger::default()),
            fail,
            cap,
        })
    }
    fn snapshot(&self) -> Ledger {
        self.ledger.lock().unwrap().clone()
    }
    fn empty(&self) {
        let l = self.snapshot();
        assert_eq!(l.live, [0; 9]);
        assert_eq!(l.reserved, l.released);
    }
}
impl a::AllocationAccount for Account {
    fn reserve(&self, charge: a::AllocationCharge) -> Result<(), a::PreparationError> {
        let mut l = self.ledger.lock().unwrap();
        l.calls += 1;
        let c = fields(charge);
        if self.fail == Some(l.calls)
            || self
                .cap
                .is_some_and(|cap| (0..9).any(|i| l.live[i] + c[i] > cap[i]))
        {
            return Err(a::PreparationError::Graph(RankError::ResourceLimit(
                "test allocation",
            )));
        }
        for (i, c) in c.into_iter().enumerate() {
            l.live[i] += c;
            l.peak[i] = l.peak[i].max(l.live[i]);
            l.reserved[i] += c;
        }
        Ok(())
    }
    fn release(&self, charge: a::AllocationCharge) {
        let mut l = self.ledger.lock().unwrap();
        l.releases += 1;
        for (i, c) in fields(charge).into_iter().enumerate() {
            assert!(l.live[i] >= c, "double release at {i}");
            l.live[i] -= c;
            l.released[i] += c;
        }
    }
}
fn graph(
    n: usize,
    edges: &[(usize, usize, f64)],
    roots: &[f64],
    refusals: &[(usize, usize)],
) -> Arc<a::Graph> {
    let mut rows = vec![vec![]; n];
    let mut blocked = vec![vec![]; n];
    for &(from, to, share) in edges {
        rows[from].push(a::Edge { to, share });
    }
    for &(from, to) in refusals {
        blocked[to].push(from);
    }
    Arc::new(
        a::Graph::new(
            (0..n).map(|i| format!("a-{i:05}")).collect(),
            roots.to_vec(),
            rows,
            blocked,
            &Limits::default(),
        )
        .unwrap(),
    )
}
fn fixture() -> Arc<a::Graph> {
    graph(
        4,
        &[
            (0, 1, 0.3),
            (0, 2, 0.3),
            (1, 2, 0.5),
            (1, 3, 0.5),
            (2, 1, 0.5),
            (2, 3, 0.5),
        ],
        &[1e12, 1e-8, 2e-8, 0.0],
        &[(1, 3)],
    )
}
fn encoded(r: &a::Ranking) -> Vec<u64> {
    let mut out = Vec::new();
    for e in &r.weights {
        out.extend([e.lower.to_bits(), e.upper.to_bits()]);
    }
    let p = &r.progress;
    let w = &p.work;
    out.extend([
        p.initialization_complete as u64,
        p.completed_work,
        p.complete_stages as u64,
        p.depth as u64,
        p.frontier_prefixes as u64,
        p.next_stage_work,
        p.exploration_complete as u64,
        p.peak_prefixes as u64,
        w.numerical_operations,
        w.initialization_operations,
        w.route_operations,
        w.estimate_operations,
        w.edge_attempts,
        w.refusal_tests,
        w.matrix_edge_visits,
        w.flushed_terms,
    ]);
    if let Some(u) = &p.upper {
        out.extend([
            u.operations,
            u.matrix_edge_visits,
            u.complete_vectors as u64,
            u.complete as u64,
            u.failed as u64,
        ]);
    }
    out
}
fn task(
    g: Arc<a::Graph>,
    p: &a::Parameters,
    limits: Limits,
    account: Arc<Account>,
) -> a::OwnedTask {
    a::OwnedTask::new(g, p, limits, account).unwrap_or_else(|e| panic!("construction: {e}"))
}
fn complete(t: &mut a::OwnedTask, quantum: u64) {
    let mut previous = t.progress().progress.work.flushed_terms;
    let mut operations = 0;
    for _ in 0..2_000_000 {
        let before = t.progress().progress.work.numerical_operations;
        let done = t.step(quantum).unwrap_or_else(|e| panic!("step: {e:?}"));
        let after = t.progress();
        let usage = t.last_slice_usage();
        assert!(usage.numerical_operations <= quantum);
        assert_eq!(
            after.progress.work.numerical_operations - before,
            usage.numerical_operations
        );
        assert_eq!(
            usage.numerical_operations,
            usage.initialization_operations + usage.route_operations + usage.estimate_operations
        );
        assert!(after.progress.work.flushed_terms >= previous);
        previous = after.progress.work.flushed_terms;
        operations += usage.numerical_operations;
        if done {
            assert_eq!(operations, after.progress.work.numerical_operations);
            assert_eq!(after.phase, a::TaskPhase::Ready);
            return;
        }
        assert!(t.result().is_none(), "incomplete upper leaked a result");
    }
    panic!("task did not finish")
}
fn invalid(t: &mut a::OwnedTask, account: &Account) {
    let p = t.progress();
    let u = t.last_slice_usage().clone();
    let l = account.snapshot();
    let pointer = t.result().map(|r| r.ranking().weights.as_ptr());
    assert!(t.step(0).is_err());
    assert_eq!(t.progress(), p);
    assert_eq!(*t.last_slice_usage(), u);
    assert_eq!(account.snapshot(), l);
    assert_eq!(t.result().map(|r| r.ranking().weights.as_ptr()), pointer);
    if p.phase != a::TaskPhase::Ready {
        assert!(t.take_result().is_err());
        assert_eq!(t.progress(), p);
        assert_eq!(account.snapshot(), l);
    }
}
pub fn step_vectors() -> Vectors {
    let mut out = Vectors::new();
    for budget in [1, 5, 6, 7, 1000] {
        for quantum in [1, 2, 17, 4096] {
            let g = fixture();
            let account = Account::new(None, None);
            let p = a::Parameters {
                work: budget,
                alpha: 0.9,
                ..Default::default()
            };
            let expected = a::rank(&g, &p, Limits::default()).unwrap();
            let mut t = task(g.clone(), &p, Limits::default(), account.clone());
            complete(&mut t, quantum);
            if budget == 6 {
                assert_eq!(t.progress().progress.completed_work, 6);
            }
            assert_eq!(encoded(t.result().unwrap().ranking()), encoded(&expected));
            assert_eq!(Arc::strong_count(&g), 1, "ready result retained the graph");
            let before = account.snapshot();
            assert!(t.step(1).unwrap());
            assert_eq!(t.last_slice_usage().numerical_operations, 0);
            assert_eq!(account.snapshot(), before);
            let ptr = t.result().unwrap().ranking().weights.as_ptr();
            let result = t.take_result().unwrap();
            assert_eq!(result.ranking().weights.as_ptr(), ptr);
            assert_eq!(account.snapshot(), before);
            assert_eq!(t.progress().phase, a::TaskPhase::Taken);
            invalid(&mut t, &account);
            drop(t);
            assert_eq!(account.snapshot(), before);
            out.insert(
                format!("owned-budget-{budget}-step-{quantum}"),
                encoded(result.ranking()),
            );
            drop(result);
            account.empty();
        }
    }
    for (name, g, p) in [
        ("empty", graph(0, &[], &[], &[]), a::Parameters::default()),
        (
            "zero-h",
            fixture(),
            a::Parameters {
                h: 0.0,
                ..Default::default()
            },
        ),
        (
            "zero-alpha",
            fixture(),
            a::Parameters {
                alpha: 0.0,
                ..Default::default()
            },
        ),
    ] {
        let account = Account::new(None, None);
        let expected = a::rank(&g, &p, Limits::default()).unwrap();
        let mut t = task(g, &p, Limits::default(), account.clone());
        complete(&mut t, 1);
        assert_eq!(encoded(t.result().unwrap().ranking()), encoded(&expected));
        out.insert(
            format!("owned-{name}"),
            encoded(t.result().unwrap().ranking()),
        );
        drop(t);
        account.empty();
    }
    out
}
pub fn invalid_and_release_vectors() -> Vectors {
    let mut out = Vectors::new();
    let g = fixture();
    let p = a::Parameters {
        work: 7,
        ..Default::default()
    };
    let account = Account::new(None, None);
    let mut t = task(g.clone(), &p, Limits::default(), account.clone());
    let mut phases = BTreeSet::new();
    let mut pending = false;
    loop {
        let before = t.progress();
        phases.insert(format!("{:?}", before.phase));
        invalid(&mut t, &account);
        pending |= before
            .pending_stage
            .as_ref()
            .is_some_and(|p| p.operations > 0);
        if before.phase == a::TaskPhase::Ready {
            break;
        }
        t.step(1).unwrap();
    }
    assert_eq!(
        phases,
        BTreeSet::from([
            "Initialization".into(),
            "Routes".into(),
            "Upper".into(),
            "Ready".into()
        ])
    );
    assert!(pending);
    let result = t.take_result().unwrap();
    invalid(&mut t, &account);
    assert!(t.step(1).is_err());
    drop(result);
    drop(t);
    account.empty();
    out.insert(
        "owned-invalid-all-phases".into(),
        vec![phases.len() as u64, pending as u64],
    );
    for cancel_phase in [
        a::TaskPhase::Initialization,
        a::TaskPhase::Routes,
        a::TaskPhase::Upper,
        a::TaskPhase::Ready,
    ] {
        let account = Account::new(None, None);
        let mut t = task(g.clone(), &p, Limits::default(), account.clone());
        while t.progress().phase != cancel_phase {
            t.step(1).unwrap();
        }
        if cancel_phase == a::TaskPhase::Routes {
            while !t
                .progress()
                .pending_stage
                .as_ref()
                .is_some_and(|p| p.operations > 0)
            {
                t.step(1).unwrap();
            }
        }
        let before = t.progress();
        let usage = t.last_slice_usage().clone();
        t.cancel();
        assert_eq!(t.progress().phase, a::TaskPhase::Cancelled);
        assert_eq!(t.progress().progress, before.progress);
        assert_eq!(*t.last_slice_usage(), usage);
        account.empty();
        let l = account.snapshot();
        t.cancel();
        invalid(&mut t, &account);
        assert!(t.step(1).is_err());
        assert_eq!(account.snapshot(), l);
        drop(t);
        assert_eq!(account.snapshot(), l);
        out.insert(
            format!("owned-cancel-{cancel_phase:?}"),
            vec![
                before.progress.work.numerical_operations,
                before.progress.work.flushed_terms,
            ],
        );
    }
    out
}
pub fn allocation_vectors() -> Vectors {
    let mut out = Vectors::new();
    let g = fixture();
    for p in [
        a::Parameters {
            work: 0,
            ..Default::default()
        },
        a::Parameters {
            work: 10_000_001,
            ..Default::default()
        },
        a::Parameters {
            h: f64::NAN,
            ..Default::default()
        },
    ] {
        let account = Account::new(None, None);
        assert!(a::OwnedTask::new(g.clone(), &p, Limits::default(), account.clone()).is_err());
        assert_eq!(account.snapshot(), Ledger::default());
    }
    let p = a::Parameters {
        work: 1000,
        ..Default::default()
    };
    // Retained input capacity must not hide behind small logical lengths.
    let mut spare = (*g).clone();
    spare.actors.reserve_exact(16);
    spare.q.reserve_exact(32);
    spare.rows[0].reserve_exact(32);
    spare.refusals[0].reserve_exact(16);
    spare.actors[0].reserve_exact(128);
    let mut cap = [usize::MAX; 9];
    cap[4] = g.actors.len();
    let account = Account::new(None, Some(cap));
    assert!(a::OwnedTask::new(Arc::new(spare), &p, Limits::default(), account.clone()).is_err());
    account.empty();
    let account = Account::new(None, None);
    let mut t = task(g.clone(), &p, Limits::default(), account.clone());
    complete(&mut t, 17);
    let baseline = account.snapshot();
    drop(t);
    account.empty();
    assert_eq!(baseline.live[3], g.actors.len());
    assert!(baseline
        .live
        .iter()
        .enumerate()
        .all(|(i, &n)| i == 3 || n == 0));
    // Refuse every reservation site in the same deterministic computation.
    for call in 1..=baseline.calls {
        let account = Account::new(Some(call), None);
        match a::OwnedTask::new(g.clone(), &p, Limits::default(), account.clone()) {
            Err(_) => {}
            Ok(mut t) => {
                loop {
                    match t.step(17) {
                        Ok(false) => {}
                        Ok(true) => panic!("reservation {call} was not refused"),
                        Err(_) => break,
                    }
                }
                assert_eq!(t.progress().phase, a::TaskPhase::Failed);
                assert!(t.result().is_none());
                account.empty();
                invalid(&mut t, &account);
                let l = account.snapshot();
                assert!(t.step(17).is_err());
                assert_eq!(account.snapshot(), l);
            }
        }
        account.empty();
    }
    // Inclusive account boundaries accept the observed peak in every category.
    let account = Account::new(None, Some(baseline.peak));
    let mut t = task(g.clone(), &p, Limits::default(), account.clone());
    complete(&mut t, 1);
    drop(t);
    account.empty();
    let mut cap = baseline.peak;
    cap[3] = g.actors.len() - 1;
    let account = Account::new(None, Some(cap));
    let mut t = task(g, &p, Limits::default(), account.clone());
    loop {
        if t.step(4096).is_err() {
            break;
        }
        assert!(t.result().is_none());
    }
    assert_eq!(t.progress().phase, a::TaskPhase::Failed);
    assert!(t.result().is_none());
    account.empty();
    out.insert(
        "owned-allocation-refusals".into(),
        vec![baseline.calls as u64, baseline.releases as u64],
    );
    out
}
pub fn limit_vectors() -> Vectors {
    let mut out = Vectors::new();
    let g = graph(2, &[(0, 1, 1.0)], &[1.0, 0.0], &[]);
    let p = a::Parameters::default();
    for (prefixes, visited, success) in [(2, 3, true), (1, 3, false), (2, 2, false)] {
        let limits = Limits {
            max_prefixes: prefixes,
            max_visited_actor_entries: visited,
            ..Default::default()
        };
        let account = Account::new(None, None);
        let mut t = task(g.clone(), &p, limits, account.clone());
        let mut failed = false;
        loop {
            match t.step(1) {
                Ok(false) => {}
                Ok(true) => break,
                Err(_) => {
                    failed = true;
                    break;
                }
            }
        }
        assert_eq!(!failed, success);
        out.insert(
            format!("owned-live-limits-{prefixes}-{visited}"),
            vec![
                t.progress().progress.completed_work,
                t.progress().progress.work.numerical_operations,
                success as u64,
            ],
        );
        drop(t);
        account.empty();
    }
    let g = graph(3, &[(0, 1, 0.5), (0, 2, 0.5)], &[1.0, 0.0, 0.0], &[]);
    let p = a::Parameters {
        work: 1,
        ..Default::default()
    };
    for (matrix, success) in [(130, true), (129, false)] {
        let limits = Limits {
            max_matrix_edge_visits: matrix,
            ..Default::default()
        };
        let account = Account::new(None, None);
        let mut t = task(g.clone(), &p, limits, account.clone());
        let mut failure = None;
        loop {
            match t.step(1) {
                Ok(false) => assert!(t.result().is_none()),
                Ok(true) => break,
                Err(e) => {
                    failure = Some(e);
                    break;
                }
            }
        }
        assert_eq!(failure.is_none(), success);
        let progress = t.progress();
        assert_eq!(progress.progress.completed_work, 0);
        assert_eq!(progress.progress.work.matrix_edge_visits, matrix);
        if let Some(f) = failure {
            assert!(t.result().is_none());
            assert_eq!(t.last_slice_usage().numerical_operations, 1);
            assert!(f.progress.upper.as_ref().unwrap().failed);
            assert!(!f.progress.upper.as_ref().unwrap().complete);
            assert_eq!(f.progress.upper.as_ref().unwrap().complete_vectors, 64);
        }
        out.insert(
            format!("owned-matrix-{matrix}"),
            vec![
                progress.progress.work.numerical_operations,
                matrix,
                success as u64,
            ],
        );
        drop(t);
        account.empty();
    }
    let g = graph(
        4,
        &[(0, 1, 1.0), (1, 2, 0.5), (1, 3, 0.5)],
        &[1.0, 0.0, 0.0, 0.0],
        &[(3, 1), (3, 2), (2, 3)],
    );
    let limits = Limits {
        max_refusal_tests: 2,
        ..Default::default()
    };
    let account = Account::new(None, None);
    let mut t = task(g, &a::Parameters::default(), limits, account.clone());
    let mut saw_pending = false;
    let failure = loop {
        match t.step(1) {
            Ok(false) => {
                let s = t.progress();
                if s.progress.complete_stages == 1
                    && s.pending_stage
                        .as_ref()
                        .is_some_and(|p| p.refusal_tests > 0)
                {
                    assert_eq!(s.progress.work.refusal_tests, 1);
                    saw_pending = true;
                }
            }
            Ok(true) => panic!("refusal ceiling must fail"),
            Err(f) => break f,
        }
    };
    assert!(saw_pending);
    assert_eq!(failure.progress.work.refusal_tests, 2);
    assert_eq!(t.progress().progress.work.refusal_tests, 1);
    assert_eq!(t.progress().progress.completed_work, 1);
    assert_eq!(t.last_slice_usage().numerical_operations, 1);
    account.empty();
    out.insert(
        "owned-refusal-pending-and-failure".into(),
        vec![
            failure.progress.work.numerical_operations,
            failure.progress.work.refusal_tests,
            t.progress().progress.work.refusal_tests,
        ],
    );
    out
}
pub fn flushing_vectors() -> Vectors {
    let mut out = Vectors::new();
    for (name, g, p) in [
        (
            "initial",
            graph(2, &[], &[f64::MIN_POSITIVE, 1.0], &[]),
            a::Parameters {
                h: 0.5,
                ..Default::default()
            },
        ),
        (
            "route",
            graph(
                3,
                &[(0, 1, f64::MIN_POSITIVE), (0, 2, 0.5)],
                &[0.5, 0.0, 0.0],
                &[],
            ),
            a::Parameters {
                h: 1.0,
                ..Default::default()
            },
        ),
        (
            "upper",
            graph(
                3,
                &[(0, 1, 0.5), (0, 2, f64::MIN_POSITIVE)],
                &[0.5, 0.0, 0.0],
                &[],
            ),
            a::Parameters {
                h: 1.0,
                work: 1,
                ..Default::default()
            },
        ),
    ] {
        let expected = a::rank(&g, &p, Limits::default()).unwrap();
        assert!(expected.progress.work.flushed_terms > 0);
        for step in [1, 7, 4096] {
            let account = Account::new(None, None);
            let mut t = task(g.clone(), &p, Limits::default(), account.clone());
            complete(&mut t, step);
            assert_eq!(encoded(t.result().unwrap().ranking()), encoded(&expected));
            out.insert(
                format!("owned-flush-{name}-{step}"),
                encoded(t.result().unwrap().ranking()),
            );
            drop(t);
            account.empty();
        }
    }
    let length = 1100;
    let mut roots = vec![0.0; length + 2];
    roots[0] = 1.0;
    roots[length + 1] = 1.0;
    let edges: Vec<_> = (0..length).map(|i| (i, i + 1, 1.0)).collect();
    let g = graph(length + 2, &edges, &roots, &[]);
    let p = a::Parameters {
        h: 1.0,
        ..Default::default()
    };
    let expected = a::rank(&g, &p, Limits::default()).unwrap();
    assert_eq!(expected.progress.work.flushed_terms, 1);
    for step in [1, 31, 4096] {
        let account = Account::new(None, None);
        let mut t = task(g.clone(), &p, Limits::default(), account.clone());
        complete(&mut t, step);
        assert_eq!(encoded(t.result().unwrap().ranking()), encoded(&expected));
        assert_eq!(t.result().unwrap().ranking().weights[length + 1].lower, 1.0);
        out.insert(
            format!("owned-long-flushing-chain-{step}"),
            encoded(t.result().unwrap().ranking()),
        );
        drop(t);
        account.empty();
    }
    let g = graph(1, &[], &[f64::MAX], &[]);
    let account = Account::new(None, None);
    let mut t = task(
        g,
        &a::Parameters {
            h: 100.0,
            ..Default::default()
        },
        Limits::default(),
        account.clone(),
    );
    let f = t.step(1).unwrap_err();
    assert_eq!(f.cause, a::PreparationError::NumericUnavailable);
    assert_eq!(f.progress.work.numerical_operations, 1);
    assert_eq!(t.last_slice_usage().initialization_operations, 1);
    account.empty();
    invalid(&mut t, &account);
    out.insert(
        "owned-failed-operation".into(),
        vec![f.progress.work.numerical_operations],
    );
    out
}
#[allow(dead_code)]
pub fn vectors() -> Vectors {
    let mut out = step_vectors();
    out.extend(invalid_and_release_vectors());
    out.extend(allocation_vectors());
    out.extend(limit_vectors());
    out.extend(flushing_vectors());
    out
}
