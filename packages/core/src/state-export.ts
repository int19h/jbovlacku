export const STATE_EXPORT_VERSION = 2;

export interface AccountKey {
  origin: string;
  account: number;
}

export type PublicationStatusValue =
  | "active"
  | "deprecated"
  | "conflicted"
  | "uncertain"
  | "unavailable";
export type PublicationAuthority =
  | "native"
  | "source-account"
  | "none"
  | "uncertain";

export interface PublicationStatus {
  event: string;
  state: PublicationStatusValue;
  frontier: string[];
  reasons: string[];
  deciding_claim: string | null;
  authority: PublicationAuthority;
  controller: string | null;
  claim: string | null;
  account_control: AccountKey | null;
  account_authority_applied: boolean;
}

export interface AccountControl extends AccountKey {
  snapshot: string;
  view: string;
  state: "unclaimed" | "controlled" | "disputed" | "unavailable";
  controller_candidates: string[];
  contributions: {
    witness: string;
    claims: string[];
    observations: string[];
  }[];
  certificates: { policy: string; claim: string; observations: string[] }[];
  chain: string[];
  current_observations: string[];
  reasons: string[];
}

export interface ProjectedAccount {
  account: AccountKey;
  controller: string | null;
  controller_identity: string | null;
  historical: string[];
  closed: string[];
  unavailable: boolean;
  disputed: boolean;
  commands: boolean;
  reasons: string[];
  missing: string[];
}

export interface Publication {
  id: string;
  issuer: string;
  kind: string;
  word: string;
  language: string | null;
  assignment: string | null;
  imported: boolean;
  account: AccountKey | null;
  content_available: boolean;
  eligible: string;
  status: PublicationStatusValue;
  account_control: AccountKey | null;
  account_authority_applied: boolean;
  reasons: string[];
}
export interface Evaluation {
  state_export_version: typeof STATE_EXPORT_VERSION;
  selected_view: string;
  available: boolean;
  reasons: string[];
  receipts: Record<
    string,
    { interpretation: string; body: string; reasons: string[] }
  >;
  publications: Record<string, Publication>;
  accounts: Record<string, ProjectedAccount>;
  publication_statuses: Record<string, PublicationStatus>;
  account_controls: Record<string, AccountControl>;
  policy: unknown;
  lifecycle: unknown;
  registers: unknown;
  judgments: unknown;
}
export interface StateDelta {
  version: number;
  base_session: string;
  receipts: Evaluation["receipts"];
  registers: Record<string, unknown>;
  judgments: Record<string, Record<string, unknown>>;
  lifecycle: {
    key_actor: Record<string, string>;
    groups: Record<string, string[]>;
  };
}
export function freezeState<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeState(child);
  }
  return value;
}
export function applyStateDelta(
  parent: Evaluation,
  parentIdentity: string,
  delta: StateDelta | null,
): Evaluation | undefined {
  if (
    parent.state_export_version !== STATE_EXPORT_VERSION ||
    delta?.version !== STATE_EXPORT_VERSION ||
    delta.base_session !== parentIdentity
  )
    return undefined;
  const oldJudgments = parent.judgments as StateDelta["judgments"];
  const judgments = { ...oldJudgments };
  for (const [target, actors] of Object.entries(delta.judgments))
    judgments[target] = { ...oldJudgments[target], ...actors };
  const lifecycle = parent.lifecycle as StateDelta["lifecycle"] &
    Record<string, unknown>;
  return {
    ...parent,
    receipts: { ...parent.receipts, ...delta.receipts },
    registers: {
      ...(parent.registers as Record<string, unknown>),
      ...delta.registers,
    },
    judgments,
    lifecycle: {
      ...lifecycle,
      key_actor: { ...lifecycle.key_actor, ...delta.lifecycle.key_actor },
      groups: { ...lifecycle.groups, ...delta.lifecycle.groups },
    },
  };
}

export function parseStateExport(text: string): Evaluation {
  const state = JSON.parse(text) as Evaluation | null;
  if (state?.state_export_version !== STATE_EXPORT_VERSION) {
    throw new Error("The state export version is unsupported.");
  }
  return state;
}
