/**
 * Own history. The client remembers its own branches, unions them with the
 * server's known heads, authenticates every envelope, and derives its own
 * effective registers from the causal graph.
 */
import { utf8, verifyEnvelope } from "../../../../packages/core/src/index.ts";
import {
  getEnvelope,
  getManifest,
  RequestError,
  identityHeads,
  selfPeer,
  type Peer,
  type IdentityHeadsPage,
} from "./api.ts";
import type { LocalStore, OutboxItem } from "./store.ts";
import {
  eventId,
  type Envelope,
  type JudgmentValue,
  type Transport,
  type TrustScope,
  type TrustValue,
} from "../model/types.ts";

/**
 * The largest own history this client handles. The limit covers the verified
 * events of one identity. It is a capacity limit of this browser client, and
 * the message below states it. A larger history needs a client without it.
 */
export const WORK_LIMIT = 4096;
const workLimit = () =>
  new Error(
    `Own history exceeds the browser work limit of ${WORK_LIMIT} events. Signing with this key is unavailable in this browser client. Export the outbox from Not delivered to keep your signed records. A larger history needs a future client without this limit.`,
  );
export interface OwnHistory {
  identity: string;
  /** Snapshot that supplied server heads, or null for offline history. */
  snapshot: string | null;
  /** Maximal own event IDs. */
  frontier: string[];
  /** Every authenticated own envelope by ID. */
  events: Map<string, Envelope>;
  /** True when every reachable predecessor was loaded. */
  complete: boolean;
}
export const SNAPSHOT_SCAN_ATTEMPTS = 3;
/** Only this response means that a pinned inventory needs a new capture. */
export function snapshotExpired(error: unknown): boolean {
  return (
    error instanceof RequestError &&
    error.status === 410 &&
    error.code === "snapshot_expired"
  );
}
export async function loadOwnHistory(
  store: LocalStore,
  identity: string,
  options: {
    offline?: boolean;
    accepted?: boolean;
    signal?: AbortSignal;
    peer?: Peer;
  } = {},
): Promise<OwnHistory> {
  const peer = options.peer ?? selfPeer;
  const historyTimeout = AbortSignal.timeout(120000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, historyTimeout])
    : historyTimeout;
  const check = () => signal.throwIfAborted();
  // A browser storage read that never finishes still ends at the deadline or on cancellation.
  const timed = <T>(read: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const stop = () => reject(signal.reason);
      if (signal.aborted) return stop();
      signal.addEventListener("abort", stop, { once: true });
      read
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", stop));
    });
  const remembered =
    (await timed(store.get<string[]>("heads", identity))) ?? [];
  if (!Array.isArray(remembered) || remembered.some((id) => !eventId(id)))
    throw new Error("Saved own-history head IDs are invalid.");
  if (remembered.length > WORK_LIMIT) throw workLimit();
  const localHeads = new Set(remembered);
  const local = new Map<string, Envelope>();
  for (const item of await timed(store.list<OutboxItem>("outbox")))
    if (item.identity === identity)
      local.set(item.id, (JSON.parse(item.transport) as Transport).envelope);
  // Branches fetched and verified from other peers during a handover. They
  // are known history, so traversal starts from them as well as from the heads.
  for (const envelope of await timed(store.list<Envelope>("ownhistory")))
    if (envelope?.header?.issuer === identity && !local.has(envelope.id)) {
      local.set(envelope.id, envelope);
      localHeads.add(envelope.id);
    }
  // Attempts share the deadline and work budget. Failed captures never enter local storage.
  let work = 0;
  let totalPages = 0;
  let returned = 0;
  for (let attempt = 0; ; attempt++) {
    const known = new Set(localHeads);
    try {
      const completed =
        options.offline || options.accepted
          ? null
          : (await getManifest({ signal, peer })).snapshot;
      const firstPage = options.offline
        ? null
        : await identityHeads(identity, completed, null, { signal, peer });
      const snapshot = firstPage?.snapshot ?? null;
      const verified = new Map<string, Envelope>();
      /** Envelopes fetched from the server in this load. They are kept locally afterwards. */
      const fetched: Envelope[] = [];
      let complete = true;
      const read = async (id: string): Promise<Envelope | null> => {
        check();
        const cached = verified.get(id);
        if (cached) return cached;
        if (++work > WORK_LIMIT) throw workLimit();
        let envelope = local.get(id) ?? null;
        const fromServer = !envelope && Boolean(snapshot);
        if (!envelope && snapshot)
          envelope = await getEnvelope(id, snapshot, { signal, peer });
        if (!envelope) {
          complete = false;
          return null;
        }
        verifyEnvelope(utf8(JSON.stringify(envelope)));
        if (envelope.id !== id || envelope.header.issuer !== identity)
          throw new Error("Own history did not match the signing identity.");
        verified.set(id, envelope);
        if (fromServer) fetched.push(envelope);
        return envelope;
      };
      if (snapshot) {
        let after: string | null = null;
        const cursors = new Set<string>();
        let pages = 0;
        do {
          check();
          pages++;
          if (++totalPages > 64) throw workLimit();
          const page: IdentityHeadsPage =
            pages === 1
              ? firstPage!
              : await identityHeads(identity, snapshot, after, {
                  signal,
                  peer,
                });
          if (page.next !== null && cursors.has(page.next))
            throw new Error(
              "Own-history pagination repeated a cursor. Export the outbox or retry with another server.",
            );
          let previous: string = after ?? "";
          for (const id of page.heads) {
            if (id <= previous)
              throw new Error(
                "Own-history pagination did not advance in event-ID order.",
              );
            previous = id;
          }
          if (
            page.next !== null &&
            (!page.heads.length || page.next !== previous)
          )
            throw new Error(
              "Own-history pagination did not advance to its last returned head.",
            );
          returned += page.heads.length;
          if (returned > WORK_LIMIT) throw workLimit();
          for (const id of page.heads) {
            if (!(await read(id)))
              throw new Error(
                "The server listed an own head that it cannot supply.",
              );
            known.add(id);
            if (known.size > WORK_LIMIT) throw workLimit();
          }
          after = page.next;
          if (after !== null) cursors.add(after);
        } while (after !== null);
      }
      const ancestors = new Set<string>();
      const pending = [...known];
      const visited = new Set<string>();
      while (pending.length) {
        check();
        const id = pending.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const envelope = await read(id);
        if (!envelope) {
          if (!snapshot) continue;
          throw new Error(
            "This browser has no signed record for a remembered history reference. Connect to retrieve it.",
          );
        }
        for (const previous of envelope.header.previous) {
          ancestors.add(previous);
          if (!snapshot && !local.has(previous)) {
            complete = false;
            continue;
          }
          pending.push(previous);
        }
      }
      const frontier = [...known].filter((id) => !ancestors.has(id)).sort();
      if (frontier.length > 64)
        throw new Error(
          "Own history has more than 64 branches, which is the format limit for one record. Signing with this key is unavailable here. Export the outbox from Not delivered to keep your signed records.",
        );
      // Every ancestor was walked, so the fetched records are authenticated
      // history. Keeping them makes the next load local. A storage failure here
      // only costs the next load a fetch.
      if (fetched.length)
        try {
          await timed(store.rememberOwn(identity, fetched));
        } catch {}
      return {
        identity,
        snapshot,
        frontier,
        events: verified,
        complete,
      };
    } catch (error) {
      if (!options.accepted || !snapshotExpired(error)) throw error;
      if (attempt + 1 >= SNAPSHOT_SCAN_ATTEMPTS)
        throw new Error(
          "Own history is incomplete because the server snapshots kept expiring. Retry before signing.",
        );
    }
  }
}
/** Only the frontier, for signing. */
export async function ownHeads(
  store: LocalStore,
  identity: string,
  offline = false,
  signal?: AbortSignal,
): Promise<string[]> {
  return (await loadOwnHistory(store, identity, { offline, signal })).frontier;
}

export type RegisterState<V> =
  | { known: true; value: V | null; conflicted: false; events: string[] }
  | { known: true; value: null; conflicted: true; events: string[] }
  | { known: false };
export const unknownRegister = { known: false } as const;
export function scopeKey(scope: TrustScope) {
  return `${scope.kind}|${scope.word}|${scope.language}`;
}
export interface OwnRegisters {
  complete: boolean;
  judgments: Map<string, RegisterState<JudgmentValue>>;
  trust: Map<string, RegisterState<TrustValue>>;
  profile: RegisterState<string>;
  /** Event IDs of this identity's publications. */
  publications: string[];
}
/**
 * Resolves this identity's own registers. For each register, the maximal
 * events without a causally later event for the same register are retained.
 */
export function deriveRegisters(history: OwnHistory): OwnRegisters {
  const events = history.events;
  const groups = new Map<
    string,
    { kind: "judgment" | "trust" | "profile"; key: string; ids: string[] }
  >();
  const publications: string[] = [];
  for (const envelope of events.values()) {
    const action = envelope.header.action;
    let key: string | null = null;
    let kind: "judgment" | "trust" | "profile" | null = null;
    if (action.kind === "judgment.set") {
      key = String(action.target);
      kind = "judgment";
    } else if (action.kind === "trust.set") {
      key = `${String(action.subject)}|${scopeKey(action.scope as TrustScope)}`;
      kind = "trust";
    } else if (action.kind === "identity.profile") {
      key = "profile";
      kind = "profile";
    } else if (
      action.kind === "definition.publish" ||
      action.kind === "rafsi.publish"
    ) {
      publications.push(envelope.id);
    }
    if (!key || !kind) continue;
    const groupKey = `${kind}|${key}`;
    const group = groups.get(groupKey) ?? { kind, key, ids: [] };
    group.ids.push(envelope.id);
    groups.set(groupKey, group);
  }
  /**
   * The group members that no other member follows. One walk over the
   * ancestors of every member finds them. A member reached by that walk has
   * a causally later member, so it is not maximal.
   */
  const maximalOf = (ids: string[]): string[] => {
    if (ids.length < 2) return ids;
    const members = new Set(ids);
    const reached = new Set<string>();
    const stack = ids.flatMap((id) => events.get(id)?.header.previous ?? []);
    while (stack.length) {
      const next = stack.pop()!;
      if (reached.has(next)) continue;
      reached.add(next);
      for (const previous of events.get(next)?.header.previous ?? [])
        stack.push(previous);
    }
    return ids.filter((id) => members.has(id) && !reached.has(id));
  };
  const resolve = <V>(
    ids: string[],
    value: (envelope: Envelope) => V,
  ): RegisterState<V> => {
    const maximal = maximalOf(ids);
    const values = new Set(
      maximal.map((id) => JSON.stringify(value(events.get(id)!))),
    );
    if (values.size === 1)
      return {
        known: true,
        value: JSON.parse([...values][0]) as V,
        conflicted: false,
        events: maximal.sort(),
      };
    return {
      known: true,
      value: null,
      conflicted: true,
      events: maximal.sort(),
    };
  };
  const judgments = new Map<string, RegisterState<JudgmentValue>>();
  const trust = new Map<string, RegisterState<TrustValue>>();
  let profile: RegisterState<string> = {
    known: true,
    value: null,
    conflicted: false,
    events: [],
  };
  for (const group of groups.values()) {
    if (group.kind === "judgment")
      judgments.set(
        group.key,
        resolve(group.ids, (e) => e.header.action.value as JudgmentValue),
      );
    else if (group.kind === "trust")
      trust.set(
        group.key,
        resolve(group.ids, (e) => e.header.action.value as TrustValue),
      );
    else profile = resolve(group.ids, (e) => e.id);
  }
  return {
    complete: history.complete,
    judgments,
    trust,
    profile,
    publications: publications.sort(),
  };
}
