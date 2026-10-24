use super::*;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Authority {
    Native,
    SourceAccount,
    None,
    Uncertain,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Certificate {
    pub policy: String,
    pub claim: String,
    pub observations: BTreeSet<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct WitnessContribution {
    pub witness: String,
    pub claims: BTreeSet<String>,
    pub observations: BTreeSet<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublicationStatus {
    pub event: String,
    pub state: Status,
    pub frontier: BTreeSet<String>,
    pub reasons: BTreeSet<String>,
    pub controller_candidates: BTreeSet<String>,
    pub deciding_claim: Option<String>,
    pub witness_contributions: Vec<WitnessContribution>,
    pub authority: Authority,
    pub controller: Option<String>,
    pub claim: Option<String>,
    pub observations: BTreeSet<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AccountControl {
    pub snapshot: String,
    pub view: String,
    pub origin: String,
    pub account: u64,
    pub state: String,
    pub controller_candidates: BTreeSet<String>,
    pub contributions: Vec<WitnessContribution>,
    pub certificates: Vec<Certificate>,
    pub chain: BTreeSet<String>,
    pub reasons: BTreeSet<String>,
}
fn contributions(account: &AccountState) -> Vec<WitnessContribution> {
    account
        .contributions
        .iter()
        .map(|(w, claims)| WitnessContribution {
            witness: w.clone(),
            claims: claims.clone(),
            observations: account
                .observation_evidence
                .get(w)
                .cloned()
                .unwrap_or_default(),
        })
        .collect()
}
pub fn publication_status(evaluation: &Evaluation, id: &str) -> Option<PublicationStatus> {
    let p = evaluation.publications.get(id)?;
    let witness_contributions = p
        .account
        .as_ref()
        .and_then(|a| evaluation.accounts.get(&a.token()))
        .map(contributions)
        .unwrap_or_default();
    Some(PublicationStatus {
        event: id.into(),
        state: p.status.clone(),
        frontier: p.status_frontier.clone(),
        reasons: p.reasons.clone(),
        controller_candidates: p.controller_candidates.clone(),
        deciding_claim: p.deciding_claim.clone(),
        witness_contributions,
        authority: p.authority.clone(),
        controller: p.controller.clone(),
        claim: p.claim.clone(),
        observations: p.observations.clone(),
    })
}
pub fn account_control(
    evaluation: &Evaluation,
    snapshot: &str,
    origin: &str,
    account: u64,
) -> AccountControl {
    let key = AccountKey {
        origin: origin.into(),
        account,
    };
    let a = evaluation.accounts.get(&key.token());
    let globally_unavailable = evaluation.policy.is_none()
        || evaluation.reasons.contains("invalid_overlay")
        || evaluation.reasons.contains("resource_unavailable");
    AccountControl {
        snapshot: snapshot.into(),
        view: evaluation.selected_view.clone(),
        origin: origin.into(),
        account,
        state: if globally_unavailable {
            "unavailable".into()
        } else {
            a.map(|a| {
                if a.unavailable {
                    "unavailable"
                } else if a.disputed {
                    "disputed"
                } else if a.controller.is_some() {
                    "controlled"
                } else {
                    "unclaimed"
                }
            })
            .unwrap_or("unclaimed")
            .into()
        },
        controller_candidates: a.map(|a| a.candidates.clone()).unwrap_or_default(),
        contributions: a.map(contributions).unwrap_or_default(),
        certificates: a.map(|a| a.certificates.clone()).unwrap_or_default(),
        chain: a.map(|a| a.chain.clone()).unwrap_or_default(),
        reasons: if globally_unavailable {
            evaluation.reasons.clone()
        } else {
            a.map(|a| a.reasons.clone()).unwrap_or_default()
        },
    }
}
