use super::*;
use std::borrow::Cow;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Authority {
    Native,
    SourceAccount,
    None,
    Uncertain,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Certificate {
    pub policy: String,
    pub claim: String,
    pub observations: BTreeSet<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WitnessContribution {
    pub witness: String,
    pub claims: BTreeSet<String>,
    pub observations: BTreeSet<String>,
}
pub type PublicationStatus = PublicationStatusRef<'static>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PublicationStatusRef<'a> {
    pub event: Cow<'a, str>,
    pub state: Status,
    pub frontier: Cow<'a, BTreeSet<String>>,
    pub reasons: Cow<'a, BTreeSet<String>>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub deciding_claim: Option<Cow<'a, str>>,
    pub authority: Authority,
    #[serde(deserialize_with = "Option::deserialize")]
    pub controller: Option<Cow<'a, str>>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub claim: Option<Cow<'a, str>>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub account_control: Option<Cow<'a, AccountKey>>,
    pub account_authority_applied: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
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
    pub current_observations: BTreeSet<String>,
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
    let PublicationStatusRef {
        event,
        state,
        frontier,
        reasons,
        deciding_claim,
        authority,
        controller,
        claim,
        account_control,
        account_authority_applied,
    } = publication_status_ref(evaluation, id)?;
    Some(PublicationStatusRef {
        event: Cow::Owned(event.into_owned()),
        state,
        frontier: Cow::Owned(frontier.into_owned()),
        reasons: Cow::Owned(reasons.into_owned()),
        deciding_claim: deciding_claim.map(|id| Cow::Owned(id.into_owned())),
        authority,
        controller: controller.map(|id| Cow::Owned(id.into_owned())),
        claim: claim.map(|id| Cow::Owned(id.into_owned())),
        account_control: account_control.map(|account| Cow::Owned(account.into_owned())),
        account_authority_applied,
    })
}

pub(crate) fn publication_account<'a>(
    evaluation: &Evaluation,
    publication: &'a Publication,
) -> (Option<&'a AccountKey>, bool) {
    let account = publication
        .account
        .as_ref()
        .filter(|account| evaluation.accounts.contains_key(&account.token()));
    let applied = account.is_some()
        && publication.imported
        && publication.kind == "definition.publish"
        && evaluation
            .policy
            .as_ref()
            .is_some_and(|policy| policy.view().index("account_authority").as_bool() == Some(true));
    (account, applied)
}

pub fn publication_status_ref<'a>(
    evaluation: &'a Evaluation,
    id: &str,
) -> Option<PublicationStatusRef<'a>> {
    let (event, publication) = evaluation.publications.get_key_value(id)?;
    Some(status_from_publication(evaluation, event, publication))
}

pub(crate) fn status_from_publication<'a>(
    evaluation: &Evaluation,
    event: &'a str,
    publication: &'a Publication,
) -> PublicationStatusRef<'a> {
    let (account, applied) = publication_account(evaluation, publication);
    PublicationStatusRef {
        event: Cow::Borrowed(event),
        state: publication.status.clone(),
        frontier: Cow::Borrowed(&publication.status_frontier),
        reasons: Cow::Borrowed(&publication.reasons),
        deciding_claim: publication.deciding_claim.as_deref().map(Cow::Borrowed),
        authority: publication.authority.clone(),
        controller: publication.controller.as_deref().map(Cow::Borrowed),
        claim: publication.claim.as_deref().map(Cow::Borrowed),
        account_control: account.map(Cow::Borrowed),
        account_authority_applied: applied,
    }
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
        current_observations: a
            .map(|a| a.current_observations.clone())
            .unwrap_or_default(),
        reasons: if globally_unavailable {
            evaluation.reasons.clone()
        } else {
            a.map(|a| a.reasons.clone()).unwrap_or_default()
        },
    }
}
