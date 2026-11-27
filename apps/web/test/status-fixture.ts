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

export function statusFixtures(
  events: readonly string[],
  state?: (index: number) => PublicationStatus["state"],
): PublicationStatus[] {
  return events
    .map((event, index) => statusFixture(event, state?.(index)))
    .sort((a, b) => a.event.localeCompare(b.event));
}
