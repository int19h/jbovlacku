use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
#[derive(Default)]
struct Permit {
    calls: AtomicUsize,
}
impl AllocationAccount for Permit {
    fn reserve(&self, _: AllocationCharge) -> Result<()> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn release(&self, _: AllocationCharge) {}
}
#[test]
fn count_overflow_fails_before_the_account_changes() {
    let account = Arc::new(Permit::default());
    let mut lease = Lease::new(account.clone());
    lease
        .grow(AllocationCharge {
            sums: usize::MAX,
            ..Default::default()
        })
        .unwrap();
    assert!(lease
        .grow(AllocationCharge {
            sums: 1,
            ..Default::default()
        })
        .is_err());
    assert_eq!(account.calls.load(Ordering::SeqCst), 1);
    assert_eq!(lease.charge.sums, usize::MAX);
}
fn sums(e: &Engine) -> Vec<(u64, u64)> {
    let mut values = e.lower.clone();
    values.extend(e.frontier.iter().map(|(_, s)| *s));
    if let Some(p) = &e.pending {
        values.extend_from_slice(&p.lower);
        values.extend(p.next.values().copied());
    }
    if let Some(u) = &e.upper {
        values.extend_from_slice(&u.values);
        values.extend_from_slice(&u.vector);
        values.extend_from_slice(&u.output);
        values.push(u.initial);
    }
    values
        .iter()
        .map(|s| (s.total.to_bits(), s.correction.to_bits()))
        .collect()
}
#[test]
fn slices_keep_both_parts_of_every_compensated_sum() {
    let graph = Arc::new(
        Graph::new(
            (0..4).map(|i| i.to_string()).collect(),
            vec![1e12, 1e-8, 2e-8, 3e-8],
            (0..4)
                .map(|i| {
                    (0..4)
                        .filter(|&j| j != i)
                        .map(|to| Edge { to, share: 0.3 })
                        .collect()
                })
                .collect(),
            vec![vec![]; 4],
            &Limits::default(),
        )
        .unwrap(),
    );
    let parameters = Parameters {
        work: 12,
        alpha: 0.9,
        ..Default::default()
    };
    let mut fine = OwnedTask::new(
        graph.clone(),
        &parameters,
        Limits::default(),
        Arc::new(Permit::default()),
    )
    .unwrap();
    let mut coarse = OwnedTask::new(
        graph,
        &parameters,
        Limits::default(),
        Arc::new(Permit::default()),
    )
    .unwrap();
    let mut correction = false;
    loop {
        let done = coarse.step(17).unwrap();
        let goal = coarse.progress().progress.work.numerical_operations;
        while fine.progress().progress.work.numerical_operations < goal {
            fine.step(1).unwrap();
        }
        if done {
            if fine.result().is_none() {
                assert!(fine.step(1).unwrap());
            }
            assert_eq!(
                fine.result().unwrap().ranking(),
                coarse.result().unwrap().ranking()
            );
            break;
        }
        let before = sums(coarse.engine.as_ref().unwrap());
        correction |= before.iter().any(|&(_, c)| c != 0);
        assert_eq!(before, sums(fine.engine.as_ref().unwrap()));
        let snapshot = coarse.progress();
        assert!(coarse.step(0).is_err());
        assert_eq!(coarse.progress(), snapshot);
        assert_eq!(sums(coarse.engine.as_ref().unwrap()), before);
    }
    assert!(correction, "fixture must exercise nonzero corrections");
}
