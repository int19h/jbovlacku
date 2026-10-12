/**
 * Local IndexedDB storage. Version 2 adds preferences, the private overlay,
 * delivery groups, and own-history caches, and migrates version 1 outbox rows.
 */
import type { Transport } from "../model/types.ts";

export interface KeyBackup {
  format: "jbovlacku-key-backup";
  version: 1;
  identity: string;
  jwe: string;
}
export type PeerState =
  | "queued"
  | "unknown"
  | "accepted"
  | "refused"
  | "missing-body";
export interface PeerDelivery {
  state: PeerState;
  attempts: number;
  lastAttempt: number | null;
  nextAttempt: number | null;
  error: string | null;
  /** The failure class of the last attempt. */
  failure: "offline" | "timeout" | "server" | "refused" | "unresolved" | null;
  receipt: import("../model/types.ts").Receipt | null;
}
export interface OutboxLabel {
  /** Plain description of the signed action for lists. */
  action: string;
  /** Headword or subject shown in bold. */
  subject: string;
  /** Route to open for the record. */
  href: string;
}
/** The address of a selected recipient, saved with the signed group before any send. */
export interface SavedRecipient {
  /** The resolved origin at signing time, such as "https://example.test". */
  origin: string;
  /** The API base path at that origin, such as "/api/v1". */
  base: string;
  label: string;
}
export interface OutboxItem {
  id: string;
  identity: string;
  transport: string;
  /**
   * Saved addresses by recipient ID. Retries use these, never the current
   * preferences. Rows queued before this field exists have none, and their
   * recipients stay unresolved.
   */
  recipients?: Record<string, SavedRecipient>;
  /** Set by the version 1 migration until the receipt evidence is checked. */
  migrated?: boolean;
  /** Group of records persisted together before any send. */
  group: string;
  /** Dispatch order inside the group. */
  order: number;
  label: OutboxLabel;
  peers: Record<string, PeerDelivery>;
  stopped: boolean;
  /** Local clock when the record was signed. Display only. */
  signedAt: number;
}
export type Preferences = {
  definitionLanguage: string;
  searchMode: "local" | "remote";
  remoteSearchDisclosed: boolean;
  theme: "system" | "light" | "dark";
  firstSignatureAcknowledged: boolean;
  keepUnlocked: boolean;
  myJudgmentsFirst: boolean;
  viewMode: "personal" | "site";
  orthography: "latin" | "zbalermorna";
  /** Configured delivery recipients. "self" is the serving origin. */
  peers: PeerConfig[];
};
export interface PeerConfig {
  id: string;
  /** API base. A relative base means the serving origin. */
  base: string;
  label: string;
}
export const defaultPreferences: Preferences = {
  definitionLanguage: "en",
  searchMode: "local",
  remoteSearchDisclosed: false,
  theme: "system",
  firstSignatureAcknowledged: false,
  keepUnlocked: false,
  myJudgmentsFirst: false,
  viewMode: "site",
  orthography: "latin",
  peers: [{ id: "self", base: "/api/v1", label: "this server" }],
};
export interface BlockedEntry {
  identity: string;
  scope: import("../model/types.ts").TrustScope;
  reason?: string;
}
export interface PrivateTrust {
  issuer: string;
  subject: string;
  scope: import("../model/types.ts").TrustScope;
  value: "heed" | "shun" | "clear";
  weight: import("../lib/format.ts").Rational | null;
}
export interface Overlay {
  version: 1;
  base_view: string | null;
  root_changes: {
    identity: string;
    q: import("../lib/format.ts").Rational | null;
  }[];
  trust: PrivateTrust[];
  blocked: BlockedEntry[];
  work: number | null;
}
export const emptyOverlay = (): Overlay => ({
  version: 1,
  base_view: null,
  root_changes: [],
  trust: [],
  blocked: [],
  work: null,
});
export class IdentityConflictError extends Error {
  constructor() {
    super(
      "Another tab selected an identity. This browser kept its existing key. Unlock that identity or keep your backup file.",
    );
  }
}
const stores = [
  "keys",
  "drafts",
  "outbox",
  "heads",
  "packages",
  "prefs",
  "ownhistory",
  "inventory",
  "records",
  "selections",
];
export class LocalStore {
  /** The open database. Lifecycle transactions span several stores. */
  readonly database: Promise<IDBDatabase>;
  constructor(name = "jbovlacku-browser-v1") {
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 3);
      request.onupgradeneeded = (event) => {
        const db = request.result;
        for (const store of stores)
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
        if (event.oldVersion < 2 && event.oldVersion > 0) {
          const outbox = request.transaction!.objectStore("outbox");
          const cursor = outbox.openCursor();
          cursor.onsuccess = () => {
            const current = cursor.result;
            if (!current) return;
            const old = current.value as {
              id: string;
              identity: string;
              transport: string;
              state: string;
              receipt?: import("../model/types.ts").Receipt;
              error?: string;
            };
            if (!("peers" in old)) current.update(migrateOutboxItem(old));
            current.continue();
          };
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(
          new Error(
            "Local storage did not open. Export your draft before closing this page.",
          ),
        );
      request.onblocked = () =>
        reject(new Error("Local storage is blocked by another open tab."));
    });
    void this.database.catch(() => {});
  }
  async get<T>(store: string, id: string): Promise<T | undefined> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async list<T>(store: string): Promise<T[]> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async keys(store: string): Promise<string[]> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).getAllKeys();
      request.onsuccess = () => resolve(request.result.map(String));
      request.onerror = () => reject(request.error);
    });
  }
  async put(store: string, id: string, value: unknown): Promise<void> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(value, id);
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(
          tx.error ?? new Error("Local storage did not save this change."),
        );
      tx.onerror = () => {};
    });
  }
  /**
   * Reads one outbox record and writes the mutated copy in one transaction, so
   * a concurrent write from a request result or another tab is not overwritten.
   */
  async mergeOutbox(
    id: string,
    mutate: (current: OutboxItem) => OutboxItem,
  ): Promise<OutboxItem | undefined> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("outbox", "readwrite");
      const outbox = tx.objectStore("outbox");
      const request = outbox.get(id);
      let result: OutboxItem | undefined;
      request.onsuccess = () => {
        const current = request.result as OutboxItem | undefined;
        if (!current) return;
        result = mutate(current);
        outbox.put(result, id);
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () =>
        reject(
          tx.error ??
            new Error("Local storage did not save the delivery outcome."),
        );
      tx.onerror = () => {};
    });
  }
  async delete(store: string, id: string): Promise<void> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).delete(id);
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(
          tx.error ?? new Error("Local storage did not delete this record."),
        );
      tx.onerror = () => {};
    });
  }
  async preferences(): Promise<Preferences> {
    const stored = await this.get<Partial<Preferences>>("prefs", "preferences");
    return { ...defaultPreferences, ...(stored ?? {}) };
  }
  async setPreferences(patch: Partial<Preferences>): Promise<Preferences> {
    const next = { ...(await this.preferences()), ...patch };
    await this.put("prefs", "preferences", next);
    return next;
  }
  async overlay(): Promise<Overlay> {
    return (await this.get<Overlay>("prefs", "overlay")) ?? emptyOverlay();
  }
  /** Called after every overlay write, so that local calculations restart. */
  onOverlayChange: (() => void) | null = null;
  async setOverlay(overlay: Overlay): Promise<void> {
    await this.put("prefs", "overlay", overlay);
    this.onOverlayChange?.();
  }
  /** Installs or restores the selected identity without replacing another one. */
  async installIdentity(
    backup: KeyBackup,
    mode: "create" | "restore" = "create",
  ): Promise<void> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("keys", "readwrite");
      const keys = tx.objectStore("keys");
      let failure: Error | undefined;
      const request = keys.get("selected");
      request.onsuccess = () => {
        const selected: KeyBackup | undefined = request.result;
        if (
          selected &&
          (mode !== "restore" || selected.identity !== backup.identity)
        ) {
          failure = new IdentityConflictError();
          tx.abort();
          return;
        }
        keys.put(backup, "selected");
        if (mode === "restore") keys.put(true, `tested:${backup.identity}`);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(
          failure ??
            tx.error ??
            new Error("Local storage did not install this identity."),
        );
      tx.onerror = () => {};
    });
  }
  /**
   * Saves a signed group and advances the remembered heads in one transaction.
   * Nothing is sent before this transaction completes.
   */
  async queueGroup(items: OutboxItem[]): Promise<void> {
    if (!items.length) return;
    const identity = items[0].identity;
    const predecessors = new Set<string>();
    const ids = new Set<string>();
    for (const item of items) {
      const record = (JSON.parse(item.transport) as Transport).envelope;
      if (
        record.id !== item.id ||
        record.header.issuer !== item.identity ||
        item.identity !== identity ||
        !Array.isArray(record.header.previous)
      )
        throw new Error("The signed outbox item does not match its identity.");
      for (const previous of record.header.previous) predecessors.add(previous);
      ids.add(item.id);
    }
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["outbox", "heads", "keys"], "readwrite");
      const outbox = tx.objectStore("outbox");
      const heads = tx.objectStore("heads");
      const keys = tx.objectStore("keys");
      let failure: Error | undefined;
      // A key retired or reported stolen in another tab cannot gain new ordinary records.
      const retired = keys.get(`handover:${identity}`);
      const compromised = keys.get(`compromised:${identity}`);
      const request = heads.get(identity);
      let remaining = 3;
      const proceed = () => {
        if (--remaining) return;
        if (retired.result || compromised.result) {
          failure = new Error(
            retired.result
              ? "This key signed a handover and is retired. The group was not saved or sent."
              : "This key published a compromise notice. The group was not saved or sent.",
          );
          tx.abort();
          return;
        }
        for (const item of items) outbox.put(item, item.id);
        const current: string[] = request.result ?? [];
        heads.put(
          [
            ...new Set([
              ...current.filter((id) => !predecessors.has(id)),
              ...[...ids].filter((id) => !predecessors.has(id)),
            ]),
          ].sort(),
          identity,
        );
      };
      retired.onsuccess = proceed;
      compromised.onsuccess = proceed;
      request.onsuccess = proceed;
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(
          failure ??
            tx.error ??
            new Error("Local storage did not save the signed group."),
        );
      tx.onerror = () => {};
    });
  }
  /**
   * Records own records learned from another peer: the verified envelopes and
   * the heads they add, in one transaction that merges with the heads stored
   * meanwhile. Heads that the new records follow are replaced.
   */
  async recordBranch(
    identity: string,
    envelopes: import("../model/types.ts").Envelope[],
  ): Promise<void> {
    if (!envelopes.length) return;
    for (const envelope of envelopes)
      if (envelope.header.issuer !== identity)
        throw new Error("A learned record does not belong to this identity.");
    const ids = new Set(envelopes.map((e) => e.id));
    const predecessors = new Set(envelopes.flatMap((e) => e.header.previous));
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["ownhistory", "heads"], "readwrite");
      const own = tx.objectStore("ownhistory");
      for (const envelope of envelopes) own.put(envelope, envelope.id);
      const heads = tx.objectStore("heads");
      const request = heads.get(identity);
      request.onsuccess = () => {
        const current: string[] = request.result ?? [];
        heads.put(
          [
            ...new Set([
              ...current.filter((id) => !predecessors.has(id)),
              ...[...ids].filter((id) => !predecessors.has(id)),
            ]),
          ].sort(),
          identity,
        );
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(tx.error ?? new Error("Local storage did not save the branch."));
      tx.onerror = () => {};
    });
  }
  /**
   * Finishes the version 1 migration once the core is available. A migrated
   * row is accepted only when its retained receipt satisfies the same rules
   * as a fresh delivery. Otherwise it stays unknown with its exact bytes.
   */
  async reconcileMigrated(
    classify: (
      item: OutboxItem,
      receipt: import("../model/types.ts").Receipt,
    ) => Promise<{ state: PeerState; error: string | null }>,
  ): Promise<number> {
    let changed = 0;
    for (const item of await this.list<OutboxItem>("outbox")) {
      if (!item.migrated) continue;
      const peer = item.peers.self;
      let next: PeerDelivery = { ...peer };
      if (peer?.receipt) {
        const result = await classify(item, peer.receipt);
        next = {
          ...peer,
          state: result.state,
          error: result.state === "accepted" ? null : result.error,
          nextAttempt:
            result.state === "accepted" || result.state === "refused"
              ? null
              : 0,
        };
      }
      // Classification waited on the network. Another tab or a delivery attempt
      // can have recorded fresh evidence meanwhile. That evidence stays.
      const before = JSON.stringify(peer);
      await this.mergeOutbox(item.id, (stored) => {
        const { migrated, ...rest } = stored;
        if (!migrated) return stored;
        const current = stored.peers.self;
        const unchanged = JSON.stringify(current) === before;
        return {
          ...rest,
          peers: { ...stored.peers, self: unchanged ? next : current },
        };
      });
      changed++;
    }
    return changed;
  }
}
function migrateOutboxItem(old: {
  id: string;
  identity: string;
  transport: string;
  state: string;
  receipt?: import("../model/types.ts").Receipt;
  error?: string;
}): OutboxItem {
  // A stored mark is never accepted here. The receipt is kept, and the
  // reconciliation after the core loads applies the full delivery rules:
  // the receipt must name the stored envelope hash and the required body hash.
  const receipt = old.receipt ?? null;
  const accepted = false;
  const peer: PeerDelivery = {
    state:
      old.state === "refused"
        ? "refused"
        : old.state === "ready"
          ? "queued"
          : "unknown",
    attempts: old.state === "ready" ? 0 : 1,
    lastAttempt: null,
    nextAttempt: old.state === "refused" ? null : 0,
    error: accepted
      ? null
      : old.state === "stored"
        ? "The earlier delivery record is checked against the stored envelope and body hashes before it counts as delivered."
        : (old.error ?? null),
    failure: old.state === "refused" ? "refused" : old.error ? "server" : null,
    receipt,
  };
  let label: OutboxLabel = {
    action: "signed record",
    subject: old.id,
    href: `/definition/${encodeURIComponent(old.id)}`,
  };
  try {
    const transport = JSON.parse(old.transport) as Transport;
    label = describeTransport(transport);
  } catch {}
  return {
    id: old.id,
    identity: old.identity,
    transport: old.transport,
    group: old.id,
    order: 0,
    label,
    peers: { self: peer },
    stopped: false,
    signedAt: 0,
    migrated: true,
  };
}
/** A plain description of a signed record for lists. */
export function describeTransport(transport: Transport): OutboxLabel {
  const action = transport.envelope.header.action;
  const body = transport.body as Record<string, unknown> | null;
  const spelling =
    body && typeof body === "object" && "word" in body
      ? (body.word as { spelling?: string })?.spelling
      : undefined;
  const id = transport.envelope.id;
  switch (action.kind) {
    case "definition.publish":
      return {
        action:
          Array.isArray(action.parents) && action.parents.length
            ? "revised definition"
            : "new definition",
        subject: spelling ?? String(action.word),
        href: `/definition/${encodeURIComponent(id)}`,
      };
    case "rafsi.publish":
      return {
        action:
          `rafsi claim ${body && typeof body.rafsi === "string" ? body.rafsi : ""}`.trim(),
        subject: spelling ?? String(action.word),
        href: `/definition/${encodeURIComponent(id)}`,
      };
    case "judgment.set":
      return {
        action:
          action.value === "bless"
            ? "endorsement"
            : action.value === "curse"
              ? "opposition"
              : "cleared judgment",
        subject: String(action.target),
        href: String(action.target).startsWith("jve1:")
          ? `/definition/${encodeURIComponent(String(action.target))}`
          : `/rafsi-pair/${encodeURIComponent(String(action.target))}`,
      };
    case "trust.set":
      return {
        action:
          action.value === "heed"
            ? "public trust"
            : action.value === "shun"
              ? "public ignore"
              : "cleared trust",
        subject: String(action.subject),
        href: `/identity/${encodeURIComponent(String(action.subject))}`,
      };
    case "identity.transfer":
      return {
        action: "key handover",
        subject: String(action.successor),
        href: `/identity/${encodeURIComponent(String(action.successor))}`,
      };
    case "identity.accept":
      return {
        action: "handover acceptance",
        subject: transport.envelope.header.issuer,
        href: `/identity/${encodeURIComponent(transport.envelope.header.issuer)}`,
      };
    case "identity.compromise":
      return {
        action: "compromise notice",
        subject: transport.envelope.header.issuer,
        href: `/identity/${encodeURIComponent(transport.envelope.header.issuer)}`,
      };
    case "identity.profile":
      return {
        action: "profile",
        subject:
          body && typeof body.name === "string"
            ? body.name
            : transport.envelope.header.issuer,
        href: `/identity/${encodeURIComponent(transport.envelope.header.issuer)}`,
      };
    case "status.set":
      return {
        action:
          action.value === "deprecated"
            ? "retired definition"
            : "restored definition",
        subject: String(action.target),
        href: `/definition/${encodeURIComponent(String(action.target))}`,
      };
    case "report.set":
      return {
        action: "abuse report",
        subject: String(action.subject),
        href: `/identity/${encodeURIComponent(String(action.subject))}`,
      };
    default:
      return {
        action: action.kind,
        subject: id,
        href: `/definition/${encodeURIComponent(id)}`,
      };
  }
}
