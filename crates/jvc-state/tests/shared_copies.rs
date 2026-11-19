//! Copies of state that another state still shares.
//!
//! A fork, an overlay sibling, or a retained prepared input shares
//! structures with a state. These tests count the allocations that an
//! operation makes on the current thread, and compare them with the
//! units the operation charged.

use jvc_core::{
    BodyAvailability, Header, VerifiedEnvelope, body_descriptor, canonical_value, hash_id,
    identity_from_seed, inspect_body, sign_header, verify_envelope, word_id,
};
use jvc_state::{EvaluatedState, EvaluationOptions, Limits, PreparedEvaluationInput};
use serde_json::{Value, json};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::collections::BTreeMap;

struct Counting;

thread_local! {
    static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
}

fn count_allocation() {
    let _ = ALLOCATIONS.try_with(|count| count.set(count.get() + 1));
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count_allocation();
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        count_allocation();
        unsafe { System.realloc(pointer, layout, size) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// Allocations made on this thread while `run` runs.
fn allocations<T>(run: impl FnOnce() -> T) -> (T, usize) {
    let before = ALLOCATIONS.with(Cell::get);
    let result = run();
    (result, ALLOCATIONS.with(Cell::get) - before)
}

fn signed(seed: u8, nonce: usize, previous: Vec<String>, action: Value) -> VerifiedEnvelope {
    signed_with_body(seed, nonce, previous, action, None)
}

fn signed_with_body(
    seed: u8,
    nonce: usize,
    mut previous: Vec<String>,
    action: Value,
    body: Option<&[u8]>,
) -> VerifiedEnvelope {
    previous.sort();
    let header = Header {
        version: 1,
        issuer: identity_from_seed(&[seed; 32]),
        previous,
        nonce: format!("{nonce:032x}"),
        action,
        content: body.map(|bytes| body_descriptor(bytes).unwrap()),
    };
    let raw = sign_header(&[seed; 32], header)
        .unwrap()
        .canonical_envelope()
        .unwrap();
    let event = verify_envelope(&raw).unwrap();
    if let Some(bytes) = body {
        assert!(matches!(
            inspect_body(&event, Some(bytes)),
            BodyAvailability::Valid { .. }
        ));
    }
    event
}

fn view_body(import_sets: Value) -> Vec<u8> {
    canonical_value(&json!({
        "name": "copies", "description": [], "roots": [],
        "rafsi_threshold": {"numerator": 1, "denominator": 1},
        "H": {"numerator": 3, "denominator": 1},
        "alpha": {"numerator": 1, "denominator": 2},
        "excluded": [], "calculation": "simple-routes-bounds-v1", "work": 1000,
        "import_sets": import_sets, "account_witnesses": [],
        "account_authority": false, "notes": []
    }))
    .unwrap()
}

fn view(import_sets: Value) -> (VerifiedEnvelope, Vec<u8>) {
    let body = view_body(import_sets);
    let event = signed_with_body(
        3,
        1,
        vec![],
        json!({"kind": "view.publish", "parents": []}),
        Some(&body),
    );
    (event, body)
}

fn options(view: &VerifiedEnvelope) -> EvaluationOptions {
    EvaluationOptions {
        selected_view: view.id().to_owned(),
        overlay: None,
        limits: Limits::default(),
        import_selections: BTreeMap::new(),
    }
}

fn definition(seed: u8, parents: Vec<String>) -> (VerifiedEnvelope, Vec<u8>) {
    let body: Value = serde_json::from_str(include_str!(
        "../../jvc-core/tests/fixtures/definition.json"
    ))
    .unwrap();
    let word = word_id(&body["word"]).unwrap();
    let bytes = canonical_value(&body).unwrap();
    let event = signed_with_body(
        seed,
        1,
        vec![],
        json!({
            "kind": "definition.publish", "word": word, "parents": parents,
            "origin": "native", "language": "en"
        }),
        Some(&bytes),
    );
    (event, bytes)
}

fn delta(
    state: &EvaluatedState,
    options: &EvaluationOptions,
    event: &VerifiedEnvelope,
    body: Option<&[u8]>,
) -> PreparedEvaluationInput {
    let mut delta = PreparedEvaluationInput::new(options.clone());
    delta.inherit_import_selections(state);
    delta.add_record(event, body);
    delta
}

/// A signed chain from one issuer. Each record names its predecessor
/// and one absent record: the same one at every link, or a new one.
fn missing_chain(records: usize, distinct: bool) -> (EvaluatedState, EvaluationOptions) {
    let (view, body) = view(json!([]));
    let options = options(&view);
    let mut prepared = PreparedEvaluationInput::new(options.clone());
    prepared.add_record(&view, Some(&body));
    let mut last: Option<String> = None;
    for i in 0..records {
        let absent = format!("jve1:{:064x}", if distinct { i + 1 } else { 1 });
        let previous = last.into_iter().chain([absent]).collect();
        let event = signed(9, i, previous, json!({"kind": "identity.merge"}));
        last = Some(event.id().to_owned());
        prepared.add_record(&event, None);
    }
    let state = prepared.into_state();
    assert!(state.evaluation().available);
    (state, options)
}

/// Allocations and charged units of a native definition appended to a
/// state whose overlay sibling is alive.
fn forked_append(records: usize, distinct: bool) -> (usize, usize) {
    let (base, options) = missing_chain(records, distinct);
    let sibling = base.with_overlay(None);
    let before = base.consumed_work();
    let (event, body) = definition(77, vec![]);
    let delta = delta(&base, &options, &event, Some(&body));
    let (next, count) = allocations(|| base.advance(delta, &[]));
    assert_eq!(next.statistics().incremental_records, 1);
    assert!(next.evaluation().available);
    assert!(!sibling.evaluation().publications.contains_key(event.id()));
    (count, next.consumed_work() - before)
}

#[test]
fn fork_append_does_not_copy_nested_missing_ids() {
    // Each chain record keeps its own set of missing IDs. With a new
    // absent ID per link, the sets hold 1, 2, ... N IDs. Detaching the
    // closure map from the sibling must not copy those sets: the
    // charge counts one unit per closure.
    for records in [8, 96] {
        let (repeated, repeated_units) = forked_append(records, false);
        let (distinct, distinct_units) = forked_append(records, true);
        eprintln!(
            "records={records} repeated_allocations={repeated} distinct_allocations={distinct} \
             units={distinct_units}"
        );
        assert_eq!(repeated_units, distinct_units, "records={records}");
        assert!(
            distinct <= repeated + 16,
            "records={records}: distinct IDs made {distinct} allocations, \
             repeated IDs {repeated}, at {distinct_units} units"
        );
        assert!(
            distinct <= 8 * distinct_units,
            "records={records}: {distinct} allocations at {distinct_units} units"
        );
    }
}

#[test]
fn overlay_change_does_not_copy_graph_indexes() {
    // The graph's own indexes (layout boundaries, missing IDs per
    // issuer, lifecycle) are shared by the overlay sibling. The call
    // charges nothing, so it must not copy them.
    let mut counts = Vec::new();
    for records in [8, 96] {
        let (base, _) = missing_chain(records, true);
        let before = base.consumed_work();
        let (sibling, count) = allocations(|| base.with_overlay(None));
        assert_eq!(sibling.consumed_work(), before);
        eprintln!("records={records} overlay_allocations={count}");
        counts.push(count);
    }
    assert!(
        counts[1] <= counts[0] + 8,
        "overlay change made {} allocations at 8 records and {} at 96",
        counts[0],
        counts[1]
    );
}

/// A view whose selection lists `pending` absent records, and its state.
fn pending_view(pending: usize) -> (VerifiedEnvelope, Vec<u8>, EvaluationOptions) {
    let list: Vec<String> = (0..pending).map(|i| format!("jve1:{i:064x}")).collect();
    let digest = hash_id("sha256:", b"", &canonical_value(&json!(list)).unwrap());
    let (view, body) = view(json!([{
        "source": "source",
        "importer": identity_from_seed(&[3; 32]),
        "selection": digest
    }]));
    let mut options = options(&view);
    options.import_selections.insert(digest, list);
    (view, body, options)
}

#[test]
fn append_charges_unresolved_index_shared_with_overlay_sibling() {
    // The first append detaches the results from the sibling; the
    // unresolved index stays shared. The second append adds a missing
    // parent to the index, which copies it.
    for pending in [1usize, 4096] {
        let mut units = Vec::new();
        for hold in [false, true] {
            let (view, body, input_options) = pending_view(pending);
            let options = {
                let mut options = input_options.clone();
                options.import_selections.clear();
                options
            };
            let mut prepared = PreparedEvaluationInput::new(input_options.clone());
            prepared.add_record(&view, Some(&body));
            let base = prepared.into_state();
            let sibling = hold.then(|| base.with_overlay(None));
            let (first, first_body) = definition(28, vec![]);
            let first_delta = delta(&base, &options, &first, Some(&first_body));
            let after_first = base.advance(first_delta, &[]);
            assert_eq!(after_first.statistics().incremental_records, 1);
            let (parent, _) = definition(66, vec![]);
            let (second, second_body) = definition(35, vec![parent.id().to_owned()]);
            let second_delta = delta(&after_first, &options, &second, Some(&second_body));
            let before = after_first.consumed_work();
            let next = after_first.advance(second_delta, &[]);
            assert_eq!(next.statistics().incremental_records, 1);
            units.push(next.consumed_work() - before);
            drop(sibling);
        }
        eprintln!(
            "pending={pending} unshared_units={} shared_units={}",
            units[0], units[1]
        );
        assert!(
            units[1] >= units[0] + pending,
            "pending={pending}: unshared append {} units, shared append {} units",
            units[0],
            units[1]
        );
    }
}

#[test]
fn append_charges_node_map_held_by_prepared_input() {
    for records in [8usize, 512] {
        let mut units = Vec::new();
        for hold in [false, true] {
            let (view, body) = view(json!([]));
            let options = options(&view);
            let mut prepared = PreparedEvaluationInput::new(options.clone());
            prepared.add_record(&view, Some(&body));
            for i in 0..records {
                prepared.add_record(
                    &signed(9, i, vec![], json!({"kind": "identity.merge"})),
                    None,
                );
            }
            let holder = hold.then(|| prepared.clone());
            let base = prepared.into_state();
            let before = base.consumed_work();
            let (event, event_body) = definition(77, vec![]);
            let delta = delta(&base, &options, &event, Some(&event_body));
            let next = base.advance(delta, &[]);
            assert_eq!(next.statistics().incremental_records, 1);
            units.push(next.consumed_work() - before);
            if let Some(holder) = holder {
                assert_eq!(holder.into_state().event_count(), records + 1);
            }
        }
        eprintln!(
            "records={records} unshared_units={} held_units={}",
            units[0], units[1]
        );
        assert!(
            units[1] >= units[0] + records,
            "records={records}: unshared append {} units, shared append {} units",
            units[0],
            units[1]
        );
    }
}

#[test]
fn exhausted_empty_advance_skips_selection_that_was_never_admitted() {
    // A refused evaluation that stopped before admitting the selection
    // read only its length. Changing one ID in a selection of the same
    // length then needs no comparison and no rebuild, at any limit the
    // selection cannot fit in. A limit that admits it still compares.
    for ids in [32usize, 4096] {
        for (limit, admitted) in [
            (ids - 1, false),
            (ids, false),
            (ids + 1, false),
            (ids * 4, true),
        ] {
            let list: Vec<String> = (0..ids).map(|i| format!("jve1:{i:064x}")).collect();
            let digest = hash_id("sha256:", b"", &canonical_value(&json!(list)).unwrap());
            let (view, body) = view(json!([{
                "source": "fixture",
                "importer": identity_from_seed(&[3; 32]),
                "selection": digest.clone()
            }]));
            let mut options = options(&view);
            options.limits.traversal = Some(limit);
            options.import_selections.insert(digest, list);
            let mut prepared = PreparedEvaluationInput::new(options.clone());
            prepared.add_record(&view, Some(&body));
            let state = prepared.into_state();
            let mut changed = options.clone();
            *changed
                .import_selections
                .values_mut()
                .next()
                .unwrap()
                .last_mut()
                .unwrap() = format!("jve1:{ids:064x}");
            let mut fresh = PreparedEvaluationInput::new(changed.clone());
            fresh.add_record(&view, Some(&body));
            let fresh = fresh.into_state();
            if admitted {
                assert!(state.evaluation().available, "ids={ids} limit={limit}");
            } else {
                assert!(!state.evaluation().available, "ids={ids} limit={limit}");
                assert!(
                    state.evaluation().policy.is_some(),
                    "ids={ids} limit={limit}"
                );
            }
            let next = state.advance(PreparedEvaluationInput::new(changed), &[]);
            assert_eq!(
                next.evaluation(),
                fresh.evaluation(),
                "ids={ids} limit={limit}"
            );
            eprintln!(
                "ids={ids} limit={limit} reason={:?} units={}",
                next.statistics().reason,
                next.consumed_work()
            );
            let expected = admitted.then(|| "configuration_changed".to_owned());
            assert_eq!(
                next.statistics().reason,
                expected,
                "ids={ids} limit={limit}"
            );
        }
    }
}

#[test]
fn state_clone_does_not_copy_the_overlay() {
    // A fork clones the state, and an overlay change clones it before
    // it sets the new overlay. Neither charges anything, so neither may
    // copy the old overlay, whatever its size.
    let mut counts = Vec::new();
    for entries in [1usize, 4096] {
        let (view, body) = view(json!([]));
        let mut options = options(&view);
        let blocked: Vec<Value> = (0..entries)
            .map(|i| json!({"identity": format!("entry-{i}"), "scope": {"kind": "all"}}))
            .collect();
        options.overlay = Some(
            json!({
                "version": 1, "base_view": view.id(), "root_changes": [],
                "trust": [], "blocked": blocked, "work": null
            })
            .into(),
        );
        let mut prepared = PreparedEvaluationInput::new(options);
        prepared.add_record(&view, Some(&body));
        let state = prepared.into_state();
        let (fork, fork_count) = allocations(|| state.clone());
        let (sibling, overlay_count) = allocations(|| state.with_overlay(None));
        assert_eq!(fork.consumed_work(), state.consumed_work());
        assert_eq!(sibling.consumed_work(), state.consumed_work());
        eprintln!(
            "entries={entries} clone_allocations={fork_count} overlay_allocations={overlay_count}"
        );
        counts.push((fork_count, overlay_count));
    }
    assert!(
        counts[1].0 <= counts[0].0 + 8 && counts[1].1 <= counts[0].1 + 8,
        "allocations at 1 and 4096 overlay entries: {counts:?}"
    );
}

/// A view with two import sets: the first selection names one ID, the
/// second 32 IDs. The first is supplied wrong, so evaluation finds it
/// invalid; the limit then runs out on the second.
fn two_selection_state(
    limit: usize,
    mode: usize,
) -> (EvaluatedState, EvaluationOptions, VerifiedEnvelope, Vec<u8>) {
    let right = vec![format!("jve1:{:064x}", 1)];
    let wrong = vec![format!("jve1:{:064x}", 2)];
    let long: Vec<String> = (100..132).map(|i| format!("jve1:{i:064x}")).collect();
    let digest =
        |ids: &Vec<String>| hash_id("sha256:", b"", &canonical_value(&json!(ids)).unwrap());
    let (first, second) = (digest(&right), digest(&long));
    let importer = identity_from_seed(&[3; 32]);
    let (view, body) = view(json!([
        {"source": "a", "importer": importer, "selection": first},
        {"source": "b", "importer": importer, "selection": second}
    ]));
    let mut options = options(&view);
    options.limits.traversal = Some(limit);
    options.import_selections.insert(first.clone(), wrong);
    options.import_selections.insert(second, long);
    let mut prepared = PreparedEvaluationInput::new(options.clone());
    prepared.add_record(&view, Some(&body));
    let mut state = prepared.into_state();
    match mode {
        1 => {
            state = EvaluatedState::restore_host_checkpoint(&state.checkpoint("s").unwrap(), "s")
                .unwrap();
        }
        2 => {
            let row = jvc_state::HostVerifiedRecord::extract_with(
                view.id(),
                view.header(),
                inspect_body(&view, Some(&body)),
                |_| (),
            )
            .0;
            state = EvaluatedState::restore_host_result_checkpoint(
                &state.result_checkpoint("s").unwrap(),
                "s",
                vec![row],
            )
            .unwrap();
        }
        _ => {}
    }
    options.import_selections.insert(first, right);
    (state, options, view, body)
}

#[test]
fn corrected_selection_after_restore_matches_fresh_evaluation() {
    // Live, after a full restore, and after a results restore, an empty
    // advance that corrects the invalid first selection must give the
    // same evaluation as a fresh one with the corrected selection.
    for mode in 0..3 {
        for limit in [15usize, 24, 64] {
            let (state, corrected, view, body) = two_selection_state(limit, mode);
            assert!(
                state
                    .evaluation()
                    .reasons
                    .contains("import_selection_unavailable"),
                "mode={mode} limit={limit}"
            );
            let mut fresh = PreparedEvaluationInput::new(corrected.clone());
            fresh.add_record(&view, Some(&body));
            let fresh = fresh.into_state();
            let next = state.advance(PreparedEvaluationInput::new(corrected), &[]);
            eprintln!(
                "mode={mode} limit={limit} reason={:?} reasons={:?}",
                next.statistics().reason,
                next.evaluation().reasons
            );
            assert_eq!(
                next.evaluation(),
                fresh.evaluation(),
                "mode={mode} limit={limit}"
            );
            assert_eq!(
                next.consumed_work(),
                fresh.consumed_work(),
                "mode={mode} limit={limit}"
            );
        }
    }
}

/// Judgments from one issuer for one definition, `roots` of them as
/// separate roots joined by `identity.merge` records of at most 16
/// predecessors, and one more judgment after the final merge.
fn many_heads(roots: usize) -> (EvaluatedState, PreparedEvaluationInput) {
    let (view, view_body) = view(json!([]));
    let options = options(&view);
    let (definition, definition_body) = definition(22, vec![]);
    let mut prepared = PreparedEvaluationInput::new(options.clone());
    prepared.add_record(&view, Some(&view_body));
    prepared.add_record(&definition, Some(&definition_body));
    let vote = json!({"kind": "judgment.set", "target": definition.id(), "value": "bless"});
    let mut parents = Vec::new();
    for i in 0..roots {
        let event = signed(23, i, vec![], vote.clone());
        prepared.add_record(&event, None);
        parents.push(event.id().to_owned());
    }
    let mut nonce = roots;
    while parents.len() > 1 {
        let mut links = Vec::new();
        for group in parents.chunks(16) {
            let event = signed(23, nonce, group.to_vec(), json!({"kind": "identity.merge"}));
            nonce += 1;
            prepared.add_record(&event, None);
            links.push(event.id().to_owned());
        }
        parents = links;
    }
    let state = prepared.into_state();
    let next = signed(23, nonce, parents, vote);
    let delta = delta(&state, &options, &next, None);
    (state, delta)
}

#[test]
fn judgment_append_over_many_register_heads_rebuilds() {
    // The fast path tests every current head against the new closure.
    // Up to a fixed number of heads it appends; past it, it rebuilds.
    for (roots, fast) in [(8usize, true), (64, false), (256, false)] {
        let (state, delta) = many_heads(roots);
        let next = state.advance(delta, &[]);
        eprintln!(
            "roots={roots} incremental={} reason={:?}",
            next.statistics().incremental_records,
            next.statistics().reason
        );
        if fast {
            assert_eq!(next.statistics().incremental_records, 1, "roots={roots}");
        } else {
            assert_eq!(
                next.statistics().reason.as_deref(),
                Some("register_heads"),
                "roots={roots}"
            );
        }
    }
}

#[test]
fn state_clone_does_not_copy_the_previous_judgment_changes() {
    let mut counts = Vec::new();
    for votes in [1usize, 256] {
        let (view, view_body) = view(json!([]));
        let options = options(&view);
        let (definition, definition_body) = definition(22, vec![]);
        let mut prepared = PreparedEvaluationInput::new(options.clone());
        prepared.add_record(&view, Some(&view_body));
        prepared.add_record(&definition, Some(&definition_body));
        let vote = json!({"kind": "judgment.set", "target": definition.id(), "value": "bless"});
        prepared.add_record(&signed(23, 0, vec![], vote.clone()), None);
        let base = prepared.into_state();
        let mut batch = PreparedEvaluationInput::new(options.clone());
        for i in 1..=votes {
            batch.add_record(&signed(23, i, vec![], vote.clone()), None);
        }
        let state = base.advance(batch, &[]);
        assert_eq!(state.judgment_changes().unwrap().receipts.len(), votes);
        let (fork, clone_count) = allocations(|| state.clone());
        let (sibling, overlay_count) = allocations(|| state.with_overlay(None));
        assert_eq!(fork.consumed_work(), state.consumed_work());
        assert_eq!(sibling.consumed_work(), state.consumed_work());
        eprintln!(
            "votes={votes} clone_allocations={clone_count} overlay_allocations={overlay_count}"
        );
        counts.push((clone_count, overlay_count));
    }
    assert!(
        counts[1].0 <= counts[0].0 + 8 && counts[1].1 <= counts[0].1 + 8,
        "allocations at 1 and 256 changed receipts: {counts:?}"
    );
}
