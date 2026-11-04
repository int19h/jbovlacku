import { sourceDate } from "../lib/source-date.ts";
export { sourceDate } from "../lib/source-date.ts";
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

const profileCache = new Map<string, { response: IdentityResponse }>();
const profileRequests = new Map<string, Promise<IdentityResponse>>();
const profileVersions = new Map<string, symbol>();
/** Reads a profile after any required materialization wait at the call site. */
export async function identityProfile(
  identity: string,
  options: { fresh?: boolean; signal?: AbortSignal } = {},
): Promise<IdentityResponse> {
  options.signal?.throwIfAborted();
  if (options.fresh) forgetProfile(identity);
  const cached = profileCache.get(identity);
  if (cached) return cached.response;
  // A page owns its cancellation signal. Do not borrow another reader's request.
  if (!options.signal) {
    const existing = profileRequests.get(identity);
    if (existing) return existing;
  }
  let version = profileVersions.get(identity);
  if (!version) profileVersions.set(identity, (version = Symbol()));
  // Cache freshness does not start another receipt wait in getIdentity.
  const pending = getIdentity(identity, { signal: options.signal }).then(
    (response) => {
      options.signal?.throwIfAborted();
      if (profileVersions.get(identity) === version) {
        const entry = { response };
        profileCache.set(identity, entry);
        setTimeout(() => {
          if (profileCache.get(identity) === entry)
            profileCache.delete(identity);
        }, 60000);
      }
      return response;
    },
  );
  if (!options.signal) {
    profileRequests.set(identity, pending);
    const clear = () => {
      if (profileRequests.get(identity) === pending)
        profileRequests.delete(identity);
    };
    void pending.then(clear, clear);
  }
  return pending;
}
/** Invalidates cached and in-flight profiles from before a known change. */
export function forgetProfile(identity: string) {
  profileVersions.set(identity, Symbol());
  profileCache.delete(identity);
  profileRequests.delete(identity);
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
    void identityProfile(identity)
      .then((response) => {
        const known = profileName(response);
        if (known && anchor.isConnected) label.textContent = known;
      })
      .catch(() => {});
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
      evidence?: { kind?: string; source?: { url?: string | null } };
    } | null;
    dates?: Record<string, string | null>;
  };
  record?: { kind?: string; id?: string | number };
  snapshot?: string;
  locator?: string;
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
      const evidenceUrl = account?.evidence?.source?.url;
      let external = false;
      if (typeof evidenceUrl === "string") {
        try {
          external = new URL(evidenceUrl).protocol === "https:";
        } catch {}
      }
      const anchor = link(
        label,
        external
          ? evidenceUrl!
          : `/definition/${encodeURIComponent(envelope.id)}#source-${envelope.id}`,
        external ? { rel: "noopener noreferrer", target: "_blank" } : {},
      );
      const weak = account?.evidence?.kind === "username-lookup";
      anchor.title = weak
        ? "Username lookup only. This evidence does not establish source authorship."
        : account
          ? `${legacy.source ?? "Imported"} account ${account.account} evidence`
          : `${legacy.source ?? "Imported"} source author, without account evidence`;
      if (!external)
        anchor.addEventListener("click", () => {
          const source = document.getElementById(`source-${envelope.id}`);
          if (source instanceof HTMLDetailsElement) source.open = true;
        });
      node.append(anchor);
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
