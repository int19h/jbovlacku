use super::*;
use serde::ser::SerializeMap;

pub const STATE_EXPORT_VERSION: u8 = 2;

/// The full public state for one evaluation.
#[derive(Serialize)]
pub struct StateExport<'a> {
    state_export_version: u8,
    #[serde(flatten)]
    evaluation: ExportEvaluation<'a>,
    publication_statuses: PublicationStatuses<'a>,
    account_controls: AccountControls<'a>,
}

impl<'a> StateExport<'a> {
    pub fn new(evaluation: &'a Evaluation) -> Self {
        Self {
            state_export_version: STATE_EXPORT_VERSION,
            evaluation: ExportEvaluation(evaluation),
            publication_statuses: PublicationStatuses(evaluation),
            account_controls: AccountControls(evaluation),
        }
    }
}

struct ExportEvaluation<'a>(&'a Evaluation);

impl Serialize for ExportEvaluation<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize_as(serializer, EvaluationEncoding::Export)
    }
}

/// The ranking binding keeps the complete account rows and refers to them
/// from the publications. It also binds the original records and options.
pub(crate) struct RankingSourceEvaluation<'a>(pub &'a Evaluation);

impl Serialize for RankingSourceEvaluation<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0
            .serialize_as(serializer, EvaluationEncoding::RankingSource)
    }
}

pub(super) struct ExportPublications<'a>(pub &'a Evaluation);

impl Serialize for ExportPublications<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_map(self.0.publications.iter().map(|(id, publication)| {
            let (account_control, account_authority_applied) =
                api::publication_account(self.0, publication);
            (
                id,
                ExportPublication {
                    id: &publication.id,
                    issuer: &publication.issuer,
                    kind: &publication.kind,
                    word: &publication.word,
                    language: &publication.language,
                    assignment: &publication.assignment,
                    lineage: &publication.lineage,
                    imported: publication.imported,
                    source: &publication.source,
                    source_record: publication.source_record,
                    account: &publication.account,
                    authority: &publication.authority,
                    controller: &publication.controller,
                    claim: &publication.claim,
                    status_frontier: &publication.status_frontier,
                    deciding_claim: &publication.deciding_claim,
                    missing: &publication.missing,
                    content_available: publication.content_available,
                    eligible: &publication.eligible,
                    status: &publication.status,
                    reasons: &publication.reasons,
                    account_control,
                    account_authority_applied,
                },
            )
        }))
    }
}

#[derive(Serialize)]
struct ExportPublication<'a> {
    id: &'a str,
    issuer: &'a str,
    kind: &'a str,
    word: &'a str,
    language: &'a Option<String>,
    assignment: &'a Option<String>,
    lineage: &'a BTreeMap<String, String>,
    imported: bool,
    source: &'a Option<String>,
    source_record: Option<u64>,
    account: &'a Option<AccountKey>,
    authority: &'a Authority,
    controller: &'a Option<String>,
    claim: &'a Option<String>,
    status_frontier: &'a BTreeSet<String>,
    deciding_claim: &'a Option<String>,
    missing: &'a BTreeSet<String>,
    content_available: bool,
    eligible: &'a Eligibility,
    status: &'a Status,
    reasons: &'a BTreeSet<String>,
    account_control: Option<&'a AccountKey>,
    account_authority_applied: bool,
}

pub(super) struct ExportAccounts<'a>(pub &'a BTreeMap<String, AccountState>);

impl Serialize for ExportAccounts<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_map(self.0.iter().map(|(key, row)| {
            (
                key,
                ExportAccount {
                    account: &row.account,
                    controller: &row.controller,
                    controller_identity: &row.controller_identity,
                    historical: &row.historical,
                    closed: &row.closed,
                    unavailable: row.unavailable,
                    disputed: row.disputed,
                    commands: row.commands,
                    reasons: &row.reasons,
                    missing: &row.missing,
                },
            )
        }))
    }
}

#[derive(Serialize)]
struct ExportAccount<'a> {
    account: &'a AccountKey,
    controller: &'a Option<String>,
    controller_identity: &'a Option<String>,
    historical: &'a BTreeSet<String>,
    closed: &'a BTreeSet<String>,
    unavailable: bool,
    disputed: bool,
    commands: bool,
    reasons: &'a BTreeSet<String>,
    missing: &'a BTreeSet<String>,
}

struct PublicationStatuses<'a>(&'a Evaluation);

impl Serialize for PublicationStatuses<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_map(
            self.0.publications.iter().map(|(id, publication)| {
                (id, api::status_from_publication(self.0, id, publication))
            }),
        )
    }
}

struct AccountControls<'a>(&'a Evaluation);

impl Serialize for AccountControls<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.accounts.len()))?;
        for (key, state) in &self.0.accounts {
            map.serialize_entry(
                key,
                &account_control(self.0, "", &state.account.origin, state.account.account),
            )?;
        }
        map.end()
    }
}
