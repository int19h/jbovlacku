import type { PublicationStatus } from "../src/model/types.ts";

export function statusFixture(
  event: string,
  state: PublicationStatus["state"] = "active",
): PublicationStatus {
  return {
    event,
    state,
    frontier: [],
    reasons: [],
    deciding_claim: null,
    authority: "none",
    controller: null,
    claim: null,
    account_control: null,
    account_authority_applied: false,
  };
}
