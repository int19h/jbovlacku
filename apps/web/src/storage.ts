export interface Draft {
  id: string;
  word: string;
  language: string;
  text: string;
  places: string;
  gloss: string;
  notes: string;
  license: string;
  attribution: string;
  kind: string;
  structured: boolean;
}
export interface Receipt {
  id: string;
  admission: string;
  interpretation: string;
  body_status: string;
  cursor: string | null;
  snapshot: string | null;
  view: string;
  reasons: string[];
}
export interface OutboxItem {
  id: string;
  identity: string;
  transport: string;
  state: "ready" | "unknown" | "stored" | "refused";
  receipt?: Receipt;
  error?: string;
}
export interface KeyBackup {
  format: "jbovlacku-key-backup";
  version: 1;
  identity: string;
  jwe: string;
}
export class IdentityConflictError extends Error {
  constructor() {
    super(
      "Another tab selected an identity. This browser kept its existing key. Unlock that identity or keep your backup file.",
    );
  }
}
export class LocalStore {
  private database: Promise<IDBDatabase>;
  constructor(name = "jbovlacku-browser-v1") {
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        for (const name of ["keys", "drafts", "outbox", "heads", "packages"])
          request.result.createObjectStore(name);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(
          new Error(
            "Local storage did not open. Export your draft before closing this page.",
          ),
        );
    });
    // Handle open failure while startup waits for the shared core.
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
  async queue(item: OutboxItem): Promise<void> {
    const record = JSON.parse(item.transport).envelope;
    if (
      record.id !== item.id ||
      record.header.issuer !== item.identity ||
      !Array.isArray(record.header.previous)
    )
      throw new Error("The signed outbox item does not match its identity.");
    const predecessors = new Set<string>(record.header.previous);
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["outbox", "heads"], "readwrite");
      tx.objectStore("outbox").put(item, item.id);
      const heads = tx.objectStore("heads");
      const request = heads.get(item.identity);
      request.onsuccess = () => {
        const current: string[] = request.result ?? [];
        heads.put(
          [
            ...new Set([
              ...current.filter((id) => !predecessors.has(id)),
              item.id,
            ]),
          ].sort(),
          item.identity,
        );
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(
          tx.error ?? new Error("Local storage did not save the signed event."),
        );
      tx.onerror = () => {};
    });
  }
}
