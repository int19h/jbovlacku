use super::{AccountState, Evaluation, Graph, Lifecycle, Node, accounts, saved_actor};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

#[derive(Clone, Copy, Default)]
struct History {
    invalid: bool,
    missing: bool,
}

/// Read the same dependencies as fresh evaluation. Propagate two flags
/// down each edge without building or merging any ancestry sets.
fn structural_histories<'a>(
    nodes: &'a BTreeMap<String, Node>,
    lifecycle: &Lifecycle,
) -> HashMap<&'a str, History> {
    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut entries = HashMap::with_capacity(nodes.len());
    let mut ready = Vec::new();
    for (id, node) in nodes {
        let (parents, missing, invalid, _) = Graph::history_dependencies(nodes, lifecycle, node, 1);
        let history = History {
            invalid,
            missing: !missing.is_empty(),
        };
        entries.insert(id.as_str(), (parents.len(), history));
        if parents.is_empty() {
            ready.push(id.as_str());
        }
        for parent in parents {
            children
                .entry(nodes[&parent].id.as_str())
                .or_default()
                .push(id);
        }
    }
    while let Some(id) = ready.pop() {
        let history = entries[id].1;
        for child in children.get(id).into_iter().flatten() {
            let (left, child_history) = entries.get_mut(child).unwrap();
            child_history.invalid |= history.invalid;
            child_history.missing |= history.missing;
            *left -= 1;
            if *left == 0 {
                ready.push(child);
            }
        }
    }
    entries
        .into_iter()
        .map(|(id, (left, mut history))| {
            history.invalid |= left != 0;
            (id, history)
        })
        .collect()
}

const BINDING: &str = "binding_unavailable";
const CLAIM_PENDING: &str = "claim_pending";
const RESOURCE: &str = "resource_unavailable";
const OBSERVATION_PENDING: &str = "observation_pending";
const HISTORICAL_GUARD: &str = "historical_guard";

#[derive(Clone, Copy)]
struct ClaimPath<'a> {
    steps: usize,
    reason: Option<&'static str>,
    /// Last present claim when the next claim is missing.
    missing_after: Option<&'a str>,
    /// First carry that needs a reachability check. It can make the path invalid.
    unchecked: Option<usize>,
}
impl<'a> ClaimPath<'a> {
    fn end(reason: Option<&'static str>, missing_after: Option<&'a str>) -> Self {
        Self {
            steps: 1,
            reason,
            missing_after,
            unchecked: None,
        }
    }

    fn extend(self, unchecked: bool) -> Self {
        Self {
            steps: self.steps + 1,
            unchecked: if unchecked {
                Some(1)
            } else {
                self.unchecked.map(|step| step + 1)
            },
            ..self
        }
    }

    fn reason(self, depth: usize) -> Option<&'static str> {
        if self.steps > depth {
            Some(RESOURCE)
        } else {
            self.reason
        }
    }
}

pub(super) struct AccountChecks<'a> {
    nodes: &'a BTreeMap<String, Node>,
    histories: HashMap<&'a str, History>,
    claim_paths: HashMap<&'a str, ClaimPath<'a>>,
    pending_observations: HashMap<String, HashSet<String>>,
    policy_pending: bool,
    witness_pending: bool,
}

impl<'a> AccountChecks<'a> {
    pub(super) fn new(nodes: &'a BTreeMap<String, Node>, evaluation: &Evaluation) -> Self {
        let policy_pending = evaluation.reasons.contains("policy_ancestry_unavailable");
        let lifecycle = &evaluation.lifecycle;
        let current_witnesses: HashSet<_> = evaluation
            .policy
            .iter()
            .flat_map(accounts::witnesses)
            .map(|key| saved_actor(lifecycle, &key).to_owned())
            .collect();
        let witness_pending = current_witnesses
            .iter()
            .any(|actor| lifecycle.suspended.contains_key(actor));
        let mut historical_witnesses = HashSet::new();
        let mut ready: Vec<_> = evaluation
            .policy_history
            .values()
            .flat_map(accounts::witnesses)
            .collect();
        let mut successors: HashMap<&str, Vec<&str>> = HashMap::new();
        for node in nodes
            .values()
            .filter(|node| node.semantic && node.kind == "identity.accept")
        {
            let action = node.action.view();
            if let Some(prior) = action
                .index("transfer")
                .as_str()
                .and_then(|id| nodes.get(id))
                && prior.semantic
                && prior.kind == "identity.transfer"
                && prior.action.view().index("successor") == node.issuer.as_str()
            {
                successors
                    .entry(&prior.issuer)
                    .or_default()
                    .push(&node.issuer);
            }
        }
        // Historical groups use structural transfers even if the lifecycle
        // does not accept them. This union bounds where pending evidence can occur.
        while let Some(key) = ready.pop() {
            if historical_witnesses.insert(key.clone()) {
                ready.extend(
                    successors
                        .get(key.as_str())
                        .into_iter()
                        .flatten()
                        .map(|key| (*key).to_owned()),
                );
            }
        }
        let histories = structural_histories(nodes, lifecycle);
        let mut pending_observations: HashMap<String, HashSet<String>> = HashMap::new();
        for node in nodes
            .values()
            .filter(|node| node.semantic && node.kind == "account.observe")
        {
            let action = node.action.view();
            let history = histories[node.id.as_str()];
            let actor = saved_actor(lifecycle, &node.issuer);
            let current = current_witnesses.contains(actor);
            let historical = historical_witnesses.contains(&node.issuer);
            if action.index("result") == "present"
                && !history.invalid
                && (node.body.is_some() || node.body_label == "missing")
                && (((current || historical) && (history.missing || node.body.is_none()))
                    || (current && lifecycle.suspended.contains_key(actor)))
                && let Some(claim) = action.index("claim").as_str()
                && let Some(account) = accounts::account(node)
            {
                pending_observations
                    .entry(account.token())
                    .or_default()
                    .insert(claim.to_owned());
            }
        }
        Self {
            nodes,
            histories,
            claim_paths: HashMap::new(),
            pending_observations,
            policy_pending,
            witness_pending,
        }
    }

    fn claim_path(&mut self, id: &'a str, state: &AccountState) -> ClaimPath<'a> {
        let valid_claim = |node: &Node| {
            node.semantic
                && node.kind == "account.set"
                && node.action.view().index("value") == "claim"
                && accounts::account(node).as_ref() == Some(&state.account)
        };
        let mut id = id;
        let mut path = Vec::<(&str, bool)>::new();
        let mut positions = HashMap::new();
        let mut summary = loop {
            let Some(node) = self.nodes.get(id) else {
                break ClaimPath::end(Some(CLAIM_PENDING), None);
            };
            if !valid_claim(node) {
                break ClaimPath::end(Some(BINDING), None);
            }
            if let Some(summary) = self.claim_paths.get(id) {
                break *summary;
            }
            if let Some(&start) = positions.get(id) {
                // Each starting point in a cycle takes one lap to detect it.
                // Scan two laps to find the first unchecked carry from each key.
                let ring = &path[start..];
                let mut next = None;
                for i in (0..2 * ring.len()).rev() {
                    let (key, unchecked) = ring[i % ring.len()];
                    if unchecked {
                        next = Some(i);
                    }
                    if i < ring.len() {
                        self.claim_paths.insert(
                            key,
                            ClaimPath {
                                steps: ring.len() + 1,
                                reason: Some(BINDING),
                                missing_after: None,
                                unchecked: next
                                    .filter(|next| *next - i < ring.len())
                                    .map(|next| next - i + 1),
                            },
                        );
                    }
                }
                path.truncate(start);
                break self.claim_paths[id];
            }
            let action = node.action.view();
            let previous_value = action.index("previous");
            let Some(previous) = previous_value.as_str() else {
                let end = ClaimPath::end(None, None);
                self.claim_paths.insert(id, end);
                break end;
            };
            let Some((prior_id, prior)) = self.nodes.get_key_value(previous) else {
                let end = ClaimPath::end(Some(CLAIM_PENDING), Some(id)).extend(false);
                self.claim_paths.insert(id, end);
                break end;
            };
            let mut unchecked = false;
            let mut invalid = !valid_claim(prior);
            for value in action.index("carry").as_array().into_iter().flatten() {
                let Some(head) = value.as_str() else { continue };
                let Some(history) = self.histories.get(head) else {
                    continue;
                };
                invalid |= history.invalid;
                unchecked |= !history.missing
                    && head != previous
                    && self.nodes[head].previous.binary_search(&prior.id).is_err();
            }
            if invalid {
                let end = ClaimPath::end(Some(BINDING), None);
                self.claim_paths.insert(id, end);
                break end;
            }
            positions.insert(id, path.len());
            path.push((id, unchecked));
            id = prior_id;
        };
        while let Some((key, unchecked)) = path.pop() {
            summary = summary.extend(unchecked);
            self.claim_paths.insert(key, summary);
        }
        summary
    }

    pub(super) fn check(
        &mut self,
        token: &str,
        state: &AccountState,
        lifecycle: &Lifecycle,
        depth: usize,
    ) -> Result<(), &'static str> {
        let mut required = BTreeSet::new();
        let mut possible = BTreeSet::new();
        if self.policy_pending {
            required.insert("policy_ancestry_unavailable");
        }
        if self.witness_pending {
            required.insert("witness_history_incomplete");
        }
        if state.disputed {
            required.insert("controller_dispute");
        }
        if state.candidates.is_empty() && !state.historical.is_empty() {
            required.extend([HISTORICAL_GUARD, "policy_history_unavailable"]);
        }
        let pending = self.pending_observations.get(token);
        if pending.is_some_and(|claims| claims.iter().any(|claim| !state.closed.contains(claim))) {
            possible.extend([OBSERVATION_PENDING, HISTORICAL_GUARD]);
        }
        let certified: HashSet<_> = state
            .certificates
            .iter()
            .map(|cert| cert.claim.as_str())
            .collect();
        for claim in &state.historical {
            if !state.closed.contains(claim) && !certified.contains(claim.as_str()) {
                if pending.is_none_or(|claims| !claims.contains(claim.as_str())) {
                    return Err("account_historical_pending");
                }
                required.extend([OBSERVATION_PENDING, HISTORICAL_GUARD]);
            }
        }
        for id in state.observation_evidence.values().flatten() {
            let node = &self.nodes[id];
            let history = self.histories[id.as_str()];
            if history.invalid
                || (node.body.is_none()
                    && node.body_label != "missing"
                    && !node.body_label.starts_with("invalid:"))
            {
                return Err("account_observation_history");
            }
            if node.body.is_none() && !state.missing.contains(id) {
                return Err("account_observation_missing");
            }
            if node.body_label.starts_with("invalid:") {
                required.insert("observation_body_invalid");
            } else if node.body.is_none()
                || history.missing
                || lifecycle
                    .suspended
                    .contains_key(saved_actor(lifecycle, &node.issuer))
            {
                required.insert(OBSERVATION_PENDING);
            }
        }
        for (claim, candidate) in state.candidates.iter().map(|id| (id.as_str(), true)).chain(
            certified
                .into_iter()
                .filter(|id| !state.candidates.contains(*id))
                .map(|id| (id, false)),
        ) {
            let path = if let Some((id, _)) = self.nodes.get_key_value(claim) {
                self.claim_path(id, state)
            } else {
                ClaimPath::end(Some(CLAIM_PENDING), None)
            };
            let reason = path.reason(depth);
            let unchecked = path.unchecked.is_some_and(|step| step <= depth);
            if candidate && unchecked {
                possible.insert(BINDING);
            }
            if let Some(reason) = reason.filter(|reason| candidate || *reason != BINDING) {
                if unchecked && reason != BINDING {
                    if candidate
                        && !state.reasons.contains(reason)
                        && !state.reasons.contains(BINDING)
                    {
                        return Err("account_claim_reason");
                    }
                    possible.insert(reason);
                } else {
                    required.insert(reason);
                    if reason == CLAIM_PENDING {
                        let missing = path.missing_after.map(|id| {
                            let action = self.nodes[id].action.view();
                            action.index("previous").as_str().unwrap().to_owned()
                        });
                        if !state.missing.contains(missing.as_deref().unwrap_or(claim)) {
                            return Err("account_claim_missing");
                        }
                    }
                }
            }
        }
        if !required
            .iter()
            .all(|reason| state.reasons.contains(*reason))
            || state.reasons.iter().any(|reason| {
                !required.contains(reason.as_str()) && !possible.contains(reason.as_str())
            })
            || state.unavailable
                != state.reasons.iter().any(|reason| {
                    !matches!(
                        reason.as_str(),
                        "controller_dispute" | "witness_history_incomplete"
                    )
                })
        {
            return Err("account_availability_reasons");
        }
        Ok(())
    }
}
