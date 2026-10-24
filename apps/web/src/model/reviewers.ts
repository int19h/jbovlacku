/**
 * Route notes for a reviewer with no route in the shown view. The reasons come
 * from the calculation result. A version 2 local calculation can name a block
 * from the reader's own public shun, from a private choice, or both. Without a
 * reason the note stays generic. This client infers no reason from its own
 * registers or from another snapshot.
 */
import type { ReviewerDetail } from "./types.ts";
export const PUBLIC_SHUN_NOTE =
  "blocked in your personal view by your public shun";
export const PRIVATE_BLOCK_NOTE = "blocked by your private choice";
export const GENERIC_BLOCK_NOTE = "blocked in this view";
export const NO_ROUTE_NOTE = "no route in this view";
export function routeNote(reviewer: ReviewerDetail): string {
  if (reviewer.public_shun_block && reviewer.private_block)
    return `${PUBLIC_SHUN_NOTE} and ${PRIVATE_BLOCK_NOTE}`;
  if (reviewer.public_shun_block) return PUBLIC_SHUN_NOTE;
  if (reviewer.private_block) return PRIVATE_BLOCK_NOTE;
  if (reviewer.blocked) return GENERIC_BLOCK_NOTE;
  return NO_ROUTE_NOTE;
}
/** The influence text when the result gives no weight: a blocked reviewer has none. */
export function influenceText(reviewer: ReviewerDetail): string {
  return reviewer.blocked ? "0" : "unavailable";
}
