/**
 * Author attribution. Native authors link to their signing identity. Imported
 * authors link to source evidence without impersonating a signing identity.
 */
import { el, link, text } from "../lib/dom.ts";
import { fingerprintText, shortIdentity } from "../lib/format.ts";
import type {
  DefinitionBody,
  Envelope,
  IdentityResponse,
} from "../model/types.ts";
import { getIdentity } from "../data/api.ts";

const profileCache = new Map<string, Promise<IdentityResponse | null>>();
/** The effective profile of an identity from this server, cached for the page session. */
export function identityProfile(
  identity: string,
): Promise<IdentityResponse | null> {
  let pending = profileCache.get(identity);
  if (!pending) {
    pending = getIdentity(identity).catch(() => null);
    profileCache.set(identity, pending);
    setTimeout(() => profileCache.delete(identity), 60000);
  }
  return pending;
}
/** The display name of a known, unconflicted profile, or null. */
export function profileName(response: IdentityResponse | null): string | null {
  if (!response || response.profile.state !== "known") return null;
  const body = response.profile.claims[0]?.body;
  return body && typeof body.name === "string" && body.name.trim()
    ? body.name
    : null;
}

export interface Attribution {
  node: HTMLElement;
  /** A date string with provenance, or null. */
  date: string | null;
}
/** A link to an identity page. The title carries the fingerprint. Names use <bdi>. */
export function identityLink(
  identity: string,
  name?: string | null,
  options: { resolve?: boolean } = {},
): HTMLAnchorElement {
  const label = el("bdi", { text: name ?? shortIdentity(identity) });
  const anchor = link(label, `/identity/${encodeURIComponent(identity)}`);
  anchor.title = fingerprintText(identity);
  anchor.className = "identity-link";
  if (!name && options.resolve !== false)
    void identityProfile(identity).then((response) => {
      const known = profileName(response);
      if (known && anchor.isConnected) label.textContent = known;
    });
  return anchor;
}
interface LegacyShape {
  source?: string;
  attribution?: {
    author?: string | null;
    editor?: string | null;
    author_account?: {
      origin?: string;
      account?: number;
      evidence?: { kind?: string };
    } | null;
    dates?: Record<string, string | null>;
  };
  record?: { kind?: string; id?: string | number };
  snapshot?: string;
  locator?: string;
}
export function sourceDate(body: DefinitionBody | null): string | null {
  const legacy = body?.legacy as LegacyShape | null;
  if (!legacy) return null;
  const dates = legacy.attribution?.dates ?? {};
  const candidates = [
    dates.created_at,
    dates.created,
    dates.updated_at,
    dates.updated,
  ];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      const date = new Date(parsed);
      return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getUTCMonth()]} ${date.getUTCFullYear()}`;
    }
  }
  return null;
}
/** Author line for a definition: imported source author with evidence, or the signing identity. */
export function attribution(
  envelope: Envelope,
  body: DefinitionBody | null,
  names?: Map<string, string>,
): Attribution {
  const node = el("span", { class: "attribution" });
  const legacy = body?.legacy as LegacyShape | null;
  if (legacy) {
    const author =
      typeof legacy.attribution?.author === "string"
        ? legacy.attribution.author
        : null;
    const account = legacy.attribution?.author_account;
    if (author) {
      const label = el("bdi", { text: author });
      if (
        account &&
        typeof account.origin === "string" &&
        Number.isSafeInteger(account.account)
      ) {
        const anchor = link(label, `${account.origin}/`, {
          rel: "noopener noreferrer",
          target: "_blank",
        });
        anchor.title = `${legacy.source ?? "Imported"} account ${account.account} at ${account.origin}`;
        node.append(anchor);
      } else {
        label.title = `${legacy.source ?? "Imported"} source author, without account evidence`;
        node.append(label);
      }
    } else node.append(text(`${legacy.source ?? "Imported"} author unknown`));
    node.append(
      text(" · imported by "),
      identityLink(envelope.header.issuer, names?.get(envelope.header.issuer)),
    );
    return { node, date: sourceDate(body) };
  }
  node.append(
    identityLink(envelope.header.issuer, names?.get(envelope.header.issuer)),
  );
  return { node, date: null };
}
