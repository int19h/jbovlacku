use super::*;
use crate::graph::{Closure, Graph, Node};

#[derive(Clone, Debug)]
enum Chain {
    Valid(Vec<String>),
    Pending(BTreeSet<String>),
    Invalid,
    Resource,
}
fn account(node: &Node) -> Option<AccountKey> {
    Some(AccountKey {
        origin: node.action["origin"].as_str()?.into(),
        account: node.action["account"].as_u64()?,
    })
}
fn same_account(node: &Node, a: &AccountKey) -> bool {
    account(node).as_ref() == Some(a)
}
fn chain(graph: &Graph, id: &str, a: &AccountKey, depth: usize) -> Chain {
    let mut periods = Vec::new();
    let mut seen = BTreeSet::new();
    let mut at = Some(id.to_owned());
    while let Some(id) = at {
        if periods.len() >= depth {
            return Chain::Resource;
        }
        if !seen.insert(id.clone()) {
            return Chain::Invalid;
        }
        let Some(node) = graph.nodes.get(&id) else {
            return Chain::Pending(BTreeSet::from([id]));
        };
        if !node.semantic
            || node.kind != "account.set"
            || node.action["value"] != "claim"
            || !same_account(node, a)
        {
            return Chain::Invalid;
        }
        periods.push(id.clone());
        at = node.action["previous"].as_str().map(str::to_owned);
        if let Some(previous) = &at {
            if let Some(prior) = graph.nodes.get(previous) {
                if !prior.semantic
                    || prior.kind != "account.set"
                    || prior.action["value"] != "claim"
                    || !same_account(prior, a)
                {
                    return Chain::Invalid;
                }
                let carry: Vec<_> = node.action["carry"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect();
                for head in &carry {
                    let Some(c) = graph.structural.get(head) else {
                        continue;
                    };
                    if c.resource {
                        return Chain::Resource;
                    }
                    if c.invalid {
                        return Chain::Invalid;
                    }
                    if c.complete()
                        && (!c.ids.contains(previous)
                            || !graph.structurally_connected(
                                &prior.issuer,
                                &graph.nodes[head].issuer,
                                head,
                            ))
                    {
                        return Chain::Invalid;
                    }
                }
            }
        }
    }
    Chain::Valid(periods)
}
fn witnesses(policy: &Value) -> Vec<String> {
    policy["account_witnesses"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect()
}
/// Cache signed witness ancestry for the keys named by selected policy history.
/// A shared predecessor does not merge two forked successor paths.
fn historical_ancestors(
    graph: &Graph,
    keys: BTreeSet<String>,
) -> BTreeMap<String, BTreeSet<String>> {
    let mut parents: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for n in graph.nodes.values() {
        if !graph.charge(1) {
            break;
        }
        if !n.semantic || n.kind != "identity.accept" {
            continue;
        }
        let Some(t) = n.action["transfer"]
            .as_str()
            .and_then(|id| graph.nodes.get(id))
        else {
            continue;
        };
        if t.semantic
            && t.kind == "identity.transfer"
            && t.action["successor"].as_str() == Some(&n.issuer)
        {
            parents
                .entry(n.issuer.clone())
                .or_default()
                .insert(t.issuer.clone());
        }
    }
    let mut result = BTreeMap::new();
    for key in keys {
        let mut ancestors = BTreeSet::new();
        let mut todo = vec![key.clone()];
        while let Some(at) = todo.pop() {
            if !graph.charge(1) {
                break;
            }
            if !ancestors.insert(at.clone()) {
                continue;
            }
            todo.extend(parents.get(&at).into_iter().flatten().cloned());
        }
        result.insert(key, ancestors);
    }
    result
}
fn groups(
    graph: &Graph,
    keys: &[String],
    historical: Option<&BTreeMap<String, BTreeSet<String>>>,
) -> Vec<BTreeSet<String>> {
    let mut groups: Vec<BTreeSet<String>> = Vec::new();
    for key in keys {
        if graph.resource.get() {
            return Vec::new();
        }
        let mut group = BTreeSet::from([key.clone()]);
        let mut index = 0;
        while index < groups.len() {
            let same = groups[index].iter().any(|other| {
                graph.charge(1);
                historical.map_or_else(
                    || graph.actor(other) == graph.actor(key),
                    |ancestors| ancestors[key].contains(other) || ancestors[other].contains(key),
                )
            });
            if same {
                group.extend(groups.remove(index));
            } else {
                index += 1;
            }
        }
        groups.push(group);
    }
    groups
}
fn observations<'a>(
    graph: &Graph,
    nodes: &[&'a Node],
    group: &BTreeSet<String>,
    historical: bool,
) -> Vec<&'a Node> {
    nodes
        .iter()
        .copied()
        .take_while(|_| !graph.resource.get())
        .filter(|n| {
            if !graph.charge(1) {
                return false;
            }
            (n.body.is_some()
                || n.body_label == "missing"
                || !historical && n.body_label.starts_with("invalid:"))
                && !graph.structural[&n.id].invalid
                && group.iter().any(|key| {
                    if historical {
                        graph.structurally_connected(key, &n.issuer, &n.id)
                    } else {
                        graph.actor(key) == graph.actor(&n.issuer)
                    }
                })
                && (historical || graph.retained(&n.id))
        })
        .collect()
}
fn complete_observation(graph: &Graph, n: &Node, historical: bool) -> bool {
    n.body.is_some()
        && graph.structural[&n.id].complete()
        && (historical || !graph.suspended(&n.issuer))
}
fn observation_missing(graph: &Graph, n: &Node, historical: bool) -> BTreeSet<String> {
    let mut missing = graph.structural[&n.id].missing.clone();
    if n.body.is_none() {
        missing.insert(n.id.clone());
    }
    if !historical && graph.suspended(&n.issuer) {
        for id in graph
            .lifecycle
            .suspended
            .get(&graph.actor(&n.issuer))
            .into_iter()
            .flatten()
        {
            missing.extend(graph.own[id].missing.clone());
        }
    }
    missing
}
#[derive(Default)]
struct Certificates {
    complete: BTreeSet<String>,
    pending: BTreeMap<String, BTreeSet<String>>,
}
fn certificates(graph: &Graph, observations: &[Vec<&Node>], historical: bool) -> Certificates {
    let mut result = Certificates::default();
    let Some(first) = observations.first() else {
        return result;
    };
    let claims: BTreeSet<_> = first
        .iter()
        .filter_map(|n| n.action["claim"].as_str())
        .collect();
    for claim in claims {
        let mut missing = BTreeSet::new();
        let mut possible = true;
        for group in observations {
            let evidence: Vec<_> = group
                .iter()
                .filter(|n| {
                    n.action["claim"].as_str() == Some(claim)
                        && (n.body.is_some() || n.body_label == "missing")
                })
                .collect();
            if evidence.is_empty() {
                possible = false;
                break;
            }
            if evidence
                .iter()
                .any(|n| complete_observation(graph, n, historical))
            {
                continue;
            }
            for n in evidence {
                missing.extend(observation_missing(graph, n, historical));
            }
        }
        if possible {
            if missing.is_empty()
                && observations.iter().all(|group| {
                    group.iter().any(|n| {
                        n.action["claim"].as_str() == Some(claim)
                            && complete_observation(graph, n, historical)
                    })
                })
            {
                result.complete.insert(claim.into());
            } else {
                result.pending.insert(claim.into(), missing);
            }
        }
    }
    result
}
struct PolicyGroups {
    id: String,
    groups: Vec<BTreeSet<String>>,
}
pub(crate) fn evaluate(graph: &Graph, input: &EvaluationInput, result: &mut Evaluation) {
    let Some(policy) = result.policy.clone() else {
        for p in result
            .publications
            .values_mut()
            .filter(|p| p.imported && p.kind == "definition.publish")
        {
            p.status = Status::Unavailable;
            p.reasons.insert("view_unavailable".into());
        }
        for (id, n) in &graph.nodes {
            if n.semantic && n.kind == "import.status" {
                let r = result.receipts.get_mut(id).unwrap();
                r.interpretation = Interpretation::Unavailable;
                r.reasons.insert("view_unavailable".into());
            }
        }
        return;
    };
    let status_authority = policy["account_authority"] == true;
    if !status_authority {
        for (id, n) in &graph.nodes {
            if n.semantic && n.kind == "import.status" {
                let r = result.receipts.get_mut(id).unwrap();
                r.interpretation = Interpretation::Inert;
                r.reasons.insert("account_authority_disabled".into());
            }
        }
    }
    let historical_keys = result.policy_history.values().flat_map(witnesses).collect();
    let historical_ancestors = historical_ancestors(graph, historical_keys);
    let current_groups = groups(graph, &witnesses(&policy), None);
    let historical_groups: Vec<_> = result
        .policy_history
        .iter()
        .map(|(id, body)| PolicyGroups {
            id: id.clone(),
            groups: groups(graph, &witnesses(body), Some(&historical_ancestors)),
        })
        .collect();
    let mut account_observations: BTreeMap<String, Vec<&Node>> = BTreeMap::new();
    let mut status_records: BTreeMap<String, Vec<&Node>> = BTreeMap::new();
    for n in graph.nodes.values().filter(|n| n.semantic) {
        if n.kind == "account.observe" && n.action["result"] == "present" {
            if let Some(a) = account(n) {
                account_observations.entry(a.token()).or_default().push(n);
            }
        } else if n.kind == "import.status" {
            if let Some(target) = n.action["target"].as_str() {
                status_records.entry(target.into()).or_default().push(n);
            }
        }
    }
    let mut all_accounts: BTreeMap<String, AccountKey> = BTreeMap::new();
    for p in result.publications.values() {
        if let Some(a) = &p.account {
            all_accounts.insert(a.token(), a.clone());
        }
    }
    for n in graph
        .nodes
        .values()
        .filter(|n| n.semantic && matches!(n.kind.as_str(), "account.set" | "account.observe"))
    {
        if let Some(a) = account(n) {
            all_accounts.insert(a.token(), a);
        }
    }
    for (token, a) in all_accounts {
        if graph.resource.get() {
            return;
        }
        let nodes = account_observations
            .get(&token)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let current_observations: Vec<_> = current_groups
            .iter()
            .map(|g| observations(graph, nodes, g, false))
            .collect();
        let current_certificates = certificates(graph, &current_observations, false);
        let historical_observations: Vec<Vec<_>> = historical_groups
            .iter()
            .map(|p| {
                p.groups
                    .iter()
                    .map(|g| observations(graph, nodes, g, true))
                    .collect()
            })
            .collect();
        let historical_certificates: Vec<_> = historical_observations
            .iter()
            .map(|obs| certificates(graph, obs, true))
            .collect();
        if graph.resource.get() {
            return;
        }
        let current = &current_certificates.complete;
        let historical: BTreeSet<_> = historical_certificates
            .iter()
            .flat_map(|c| c.complete.iter().chain(c.pending.keys()).cloned())
            .collect();
        let mut chains = BTreeMap::new();
        let mut carries = BTreeMap::new();
        for id in historical
            .iter()
            .chain(current.iter())
            .chain(current_certificates.pending.keys())
        {
            chains
                .entry(id.clone())
                .or_insert_with(|| chain(graph, id, &a, input.limits.claim_depth));
        }
        for value in chains.values() {
            if let Chain::Valid(ids) = value {
                for id in ids {
                    carries.entry(id.clone()).or_insert_with(|| {
                        let heads = graph.nodes[id].action["carry"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .filter_map(|v| v.as_str().map(str::to_owned))
                            .collect::<Vec<_>>();
                        graph.closure(&heads, 1)
                    });
                }
            }
        }
        if graph.resource.get() {
            return;
        }
        let mut local_missing = BTreeMap::new();
        for id in chains.keys() {
            if let Some(n) = graph.nodes.get(id) {
                if !graph.local_complete(&n.issuer, id) {
                    let keys = graph.downstream(&n.issuer);
                    let missing = graph
                        .nodes
                        .values()
                        .filter(|n| {
                            keys.contains(&n.issuer)
                                && (!graph.lifecycle.successor.contains_key(&n.issuer)
                                    || graph.retained(&n.id))
                        })
                        .flat_map(|n| graph.own[&n.id].missing.clone())
                        .collect::<BTreeSet<_>>();
                    local_missing.insert(id.clone(), missing);
                }
            }
        }
        let mut closed = BTreeSet::new();
        let mut missing = BTreeSet::new();
        let mut reasons = BTreeSet::new();
        let mut pending_closure = false;
        for id in historical_certificates.iter().flat_map(|c| &c.complete) {
            match &chains[id] {
                Chain::Valid(periods) => {
                    closed.extend(periods.iter().skip(1).cloned());
                }
                Chain::Pending(ids) => {
                    missing.extend(ids.clone());
                    pending_closure = true;
                    reasons.insert("claim_pending".into());
                }
                Chain::Resource => {
                    pending_closure = true;
                    reasons.insert("resource_unavailable".into());
                }
                Chain::Invalid => {}
            }
        }
        for (claim, ids) in historical_certificates
            .iter()
            .flat_map(|c| &c.pending)
            .chain(current_certificates.pending.iter())
        {
            if !closed.contains(claim) {
                pending_closure = true;
                missing.extend(ids.clone());
                reasons.insert("observation_pending".into());
                reasons.insert("historical_guard".into());
            }
        }
        let mut contributions = BTreeMap::new();
        let mut observation_evidence = BTreeMap::new();
        let mut candidates = BTreeSet::new();
        let mut unanimous = true;
        for (group, observations) in current_groups.iter().zip(&current_observations) {
            let ids: BTreeSet<_> = observations
                .iter()
                .filter(|n| {
                    let id = n.action["claim"].as_str().unwrap_or_default();
                    (current.contains(id) || current_certificates.pending.contains_key(id))
                        && !closed.contains(id)
                })
                .map(|n| n.id.clone())
                .collect();
            let maxima = graph.maxima(ids, false);
            for id in &maxima {
                let n = &graph.nodes[id];
                if !complete_observation(graph, n, false) {
                    pending_closure = true;
                    missing.extend(observation_missing(graph, n, false));
                    reasons.insert(
                        if n.body_label.starts_with("invalid:") {
                            "observation_body_invalid"
                        } else {
                            "observation_pending"
                        }
                        .into(),
                    );
                }
            }
            observation_evidence.insert(graph.actor(group.iter().next().unwrap()), maxima.clone());
            let claims: BTreeSet<String> = maxima
                .iter()
                .filter_map(|id| graph.nodes[id].action["claim"].as_str().map(str::to_owned))
                .collect();
            if claims.len() != 1 {
                unanimous = false;
            }
            candidates.extend(claims.clone());
            contributions.insert(graph.actor(group.iter().next().unwrap()), claims);
        }
        if candidates.len() != 1 {
            unanimous = false;
        }
        if witnesses(&policy).iter().any(|key| graph.suspended(key)) {
            reasons.insert("witness_history_incomplete".into());
        }
        let mut unavailable =
            pending_closure || result.reasons.contains("policy_ancestry_unavailable");
        if result.reasons.contains("policy_ancestry_unavailable") {
            reasons.insert("policy_ancestry_unavailable".into());
        }
        for id in &candidates {
            match &chains[id] {
                Chain::Valid(_) => {}
                Chain::Pending(ids) => {
                    missing.extend(ids.clone());
                    unavailable = true;
                    reasons.insert("claim_pending".into());
                }
                Chain::Invalid => {
                    unavailable = true;
                    reasons.insert("binding_unavailable".into());
                }
                Chain::Resource => {
                    unavailable = true;
                    reasons.insert("resource_unavailable".into());
                }
            }
        }
        if candidates.is_empty() && !historical.is_empty() {
            unavailable = true;
            reasons.insert("historical_guard".into());
            reasons.insert("policy_history_unavailable".into());
        }
        let controller = if unanimous && !unavailable {
            candidates.iter().next().cloned()
        } else {
            None
        };
        let disputed = candidates.len() > 1;
        if disputed {
            reasons.insert("controller_dispute".into());
        }
        let commands = controller
            .as_deref()
            .is_some_and(|id| command_authority(graph, id, &a));
        let mut certificates = Vec::new();
        let mut chain_ids = BTreeSet::new();
        for ((policy_groups, observations), evidence) in historical_groups
            .iter()
            .zip(&historical_observations)
            .zip(&historical_certificates)
        {
            for claim in &evidence.complete {
                let mut evidence = BTreeSet::new();
                for group in observations {
                    let ids = group
                        .iter()
                        .filter(|n| {
                            n.action["claim"].as_str() == Some(claim)
                                && complete_observation(graph, n, true)
                        })
                        .map(|n| n.id.clone())
                        .collect();
                    if let Some(id) = graph.maxima(ids, true).iter().next() {
                        evidence.insert(id.clone());
                    }
                }
                certificates.push(Certificate {
                    policy: policy_groups.id.clone(),
                    claim: claim.clone(),
                    observations: evidence,
                });
                if let Chain::Valid(ids) = &chains[claim] {
                    chain_ids.extend(ids.clone());
                }
            }
        }
        let mut selected_observations = BTreeSet::new();
        if let Some(claim) = &controller {
            for group in &current_observations {
                let ids = group
                    .iter()
                    .filter(|n| {
                        n.action["claim"].as_str() == Some(claim)
                            && complete_observation(graph, n, false)
                    })
                    .map(|n| n.id.clone())
                    .collect();
                if let Some(id) = graph.maxima(ids, false).iter().next() {
                    selected_observations.insert(id.clone());
                }
            }
        }
        for claim in &candidates {
            if let Chain::Valid(ids) = &chains[claim] {
                chain_ids.extend(ids.clone());
            }
        }
        let controller_identity = if commands {
            controller
                .as_ref()
                .and_then(|id| graph.nodes.get(id))
                .map(|n| n.issuer.clone())
        } else {
            None
        };
        let mut state = AccountState {
            account: a.clone(),
            controller,
            candidates: candidates.clone(),
            contributions,
            observation_evidence,
            certificates,
            chain: chain_ids,
            controller_identity,
            current_observations: selected_observations,
            historical,
            closed,
            unavailable,
            disputed,
            commands,
            reasons,
            missing,
        };
        for p in result.publications.values_mut().filter(|p| {
            status_authority
                && p.imported
                && p.kind == "definition.publish"
                && p.account.as_ref() == Some(&a)
        }) {
            p.controller_candidates = state.candidates.clone();
            p.witness_contributions = state.contributions.clone();
            p.claim = state.controller.clone();
            p.controller = state.controller_identity.clone();
            p.observations = state.current_observations.clone();
            p.authority = if state.commands {
                Authority::SourceAccount
            } else {
                Authority::None
            };
            if !state.commands && state.controller.is_some() {
                p.reasons.insert("current_authority_lost".into());
            }
            if state.disputed {
                p.reasons.insert("controller_dispute".into());
            }
            if unavailable {
                p.status = Status::Unavailable;
                p.reasons.extend(state.reasons.clone());
                p.missing.extend(state.missing.clone());
                continue;
            }
            if candidates.is_empty() {
                continue;
            }
            let mut values = Vec::new();
            for id in &candidates {
                let decision = period_chain_status(
                    graph,
                    id,
                    &a,
                    &chains[id],
                    &carries,
                    &local_missing,
                    status_records
                        .get(&p.id)
                        .map(Vec::as_slice)
                        .unwrap_or_default(),
                );
                p.missing.extend(decision.missing.clone());
                state.missing.extend(decision.missing);
                p.status_frontier.extend(decision.frontier);
                if candidates.len() == 1 {
                    p.deciding_claim = decision.claim;
                }
                values.push(decision.status);
            }
            p.status = if values.contains(&Status::Unavailable) {
                Status::Unavailable
            } else if values.contains(&Status::Uncertain) {
                Status::Uncertain
            } else if values.contains(&Status::Conflicted) || values.iter().any(|v| v != &values[0])
            {
                Status::Conflicted
            } else {
                values[0].clone()
            };
            if p.status == Status::Unavailable {
                p.deciding_claim = None;
                p.reasons.insert("carry_history_pending".into());
                p.reasons.insert("carry_or_authority_pending".into());
            }
            if p.status == Status::Uncertain {
                p.authority = Authority::Uncertain;
                p.reasons.insert("controller_authority_uncertain".into());
            }
            if p.reasons.contains("source_selection_conflict") {
                p.status = Status::Unavailable;
            }
        }
        result.accounts.insert(token, state);
    }
    for (id, n) in &graph.nodes {
        if !status_authority || !n.semantic || n.kind != "import.status" {
            continue;
        }
        let claim = n.action["claim"].as_str().unwrap_or_default();
        let allowed = graph.nodes.get(claim).and_then(account).is_some_and(|a| {
            let publication = n.action["target"]
                .as_str()
                .and_then(|t| result.publications.get(t));
            publication.is_some_and(|p| {
                p.imported && p.kind == "definition.publish" && p.account.as_ref() == Some(&a)
            }) && authorized_record(graph, n, claim, &a, None)
        });
        if !allowed {
            if let Some(receipt) = result.receipts.get_mut(id) {
                receipt.interpretation = Interpretation::Inert;
                receipt.reasons.insert("unauthorized_import_status".into());
            }
        }
    }
}
fn command_authority(graph: &Graph, claim: &str, a: &AccountKey) -> bool {
    let n = &graph.nodes[claim];
    if !graph.retained(claim) || !graph.local_complete(&n.issuer, claim) {
        return false;
    }
    let keys = graph.downstream(&n.issuer);
    if !keys.iter().any(|key| {
        !graph.lifecycle.retired.contains(key) && !graph.lifecycle.compromised.contains(key)
    }) {
        return false;
    }
    let ids = graph
        .nodes
        .values()
        .filter(|e| {
            e.semantic
                && e.kind == "account.set"
                && same_account(e, a)
                && keys.contains(&e.issuer)
                && graph.retained(&e.id)
        })
        .map(|e| e.id.clone())
        .collect();
    let maxima = graph.maxima(ids, false);
    maxima.len() == 1 && maxima.contains(claim)
}
fn authorized_record(
    graph: &Graph,
    n: &Node,
    claim: &str,
    a: &AccountKey,
    boundary: Option<&Closure>,
) -> bool {
    let Some(period) = graph.nodes.get(claim) else {
        return false;
    };
    if !graph.structurally_connected(&period.issuer, &n.issuer, &n.id)
        || !graph.follows(&n.id, claim, true)
    {
        return false;
    }
    let past = &graph.structural[&n.id];
    let ids = past
        .ids
        .iter()
        .filter(|id| *id != &n.id)
        .filter(|id| boundary.is_none_or(|b| b.ids.contains(id)))
        .filter(|id| {
            let e = &graph.nodes[*id];
            e.semantic && e.kind == "account.set" && same_account(e, a)
        })
        .cloned()
        .collect();
    let maxima = graph.maxima(ids, true);
    maxima.len() == 1 && maxima.contains(claim)
}
struct Decision {
    status: Status,
    frontier: BTreeSet<String>,
    claim: Option<String>,
    missing: BTreeSet<String>,
}
impl From<Status> for Decision {
    fn from(status: Status) -> Self {
        Self {
            status,
            frontier: BTreeSet::new(),
            claim: None,
            missing: BTreeSet::new(),
        }
    }
}
fn period_chain_status(
    graph: &Graph,
    claim: &str,
    a: &AccountKey,
    chain: &Chain,
    carries: &BTreeMap<String, Closure>,
    local_missing: &BTreeMap<String, BTreeSet<String>>,
    target_records: &[&Node],
) -> Decision {
    let periods = match chain {
        Chain::Valid(p) => p,
        _ => return Status::Unavailable.into(),
    };
    for (index, period) in periods.iter().enumerate() {
        let node = &graph.nodes[period];
        let boundary = if index == 0 {
            None
        } else {
            Some(&carries[&periods[index - 1]])
        };
        if let Some(boundary) = boundary {
            if !boundary.complete() {
                return Decision {
                    status: Status::Unavailable,
                    frontier: BTreeSet::new(),
                    claim: None,
                    missing: boundary.missing.clone(),
                };
            }
        }
        if index == 0 {
            if let Some(missing) = local_missing.get(claim) {
                return Decision {
                    status: Status::Unavailable,
                    frontier: BTreeSet::new(),
                    claim: None,
                    missing: missing.clone(),
                };
            }
        }
        let records: BTreeSet<_> = target_records
            .iter()
            .copied()
            .filter(|n| {
                n.action["claim"].as_str() == Some(period)
                    && boundary.is_none_or(|b| b.ids.contains(&n.id))
                    && authorized_record(graph, n, period, a, boundary)
            })
            .filter(|n| {
                // Terminal transfer excludes old-key commands before cutoff uncertainty is evaluated.
                boundary.is_some()
                    || graph.transfers.get(&n.issuer).is_none_or(|ts| {
                        ts.iter()
                            .all(|t| t != &n.id && graph.own[t].ids.contains(&n.id))
                    })
            })
            .map(|n| n.id.clone())
            .collect();
        if records.is_empty() {
            continue;
        }
        let maxima = graph.maxima(records, true);
        if index == 0 {
            let keys = graph.downstream(&node.issuer);
            if maxima
                .iter()
                .any(|id| !keys.contains(&graph.nodes[id].issuer) || !graph.retained(id))
            {
                return Decision {
                    status: Status::Uncertain,
                    frontier: maxima,
                    claim: Some(period.clone()),
                    missing: BTreeSet::new(),
                };
            }
        }
        let values: BTreeSet<_> = maxima
            .iter()
            .filter_map(|id| graph.nodes[id].action["value"].as_str())
            .collect();
        return Decision {
            status: if values.len() > 1 {
                Status::Conflicted
            } else if values.contains("deprecated") {
                Status::Deprecated
            } else {
                Status::Active
            },
            frontier: maxima,
            claim: Some(period.clone()),
            missing: BTreeSet::new(),
        };
    }
    Status::Active.into()
}
