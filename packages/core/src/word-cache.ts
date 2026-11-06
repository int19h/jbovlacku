/** Serialized word storage. This module starts no calculation or worker. */
export const WORD_CACHE_LIMITS = Object.freeze({
  reuse: 16,
  bytes: 32 * 1024 * 1024,
  output: 4 * 1024 * 1024,
  consumers: 64,
  markers: 128,
  markerBytes: 1024 * 1024,
  markerReservation: 8192,
  readyLifetime: 60_000,
});
/** The host derives these identities from its retained authenticated inventory. */
export interface WordCacheIdentity {
  logical_session: string;
  snapshot: string;
  inventory: string;
  input: string;
  view: string;
  overlay: string | null;
  mode: "site" | "personal";
  build: string;
  contract: string;
  policy: string;
  algorithm: string;
}
export interface WordFailure {
  code:
    | "resource_unavailable"
    | "numeric_unavailable"
    | "ranking_unavailable"
    | "unsupported_calculation";
  limit: string;
  retryable: false;
  background_evaluation_running_at_expiry?: boolean;
}
export interface ReadyWordTicket {
  id: string;
  ready_at: number;
  expires_at: number;
}
export type WordAdmission =
  | { status: "reserved"; reservation: string; key: string }
  | { status: "ready"; ticket: ReadyWordTicket }
  | { status: "failure"; failure: Readonly<WordFailure> }
  | { status: "pending" }
  | { status: "ranking_busy"; retry_after: number };
interface Entry {
  key: string;
  epoch: number;
  bytes: Uint8Array;
  ready: number;
  expiry: number;
  pins: number;
  touched: number;
}
interface Reservation {
  key: string;
  epoch: number;
  bytes: number;
}
const size = (s: string) => new TextEncoder().encode(s).length;
const hash = (s: unknown, prefix = "sha256:") =>
  typeof s === "string" && new RegExp(`^${prefix}[0-9a-f]{64}$`).test(s);
function identityKey(i: WordCacheIdentity): string {
  if (
    !i ||
    ![i.snapshot, i.inventory, i.input, i.build, i.policy].every((v) =>
      hash(v),
    ) ||
    !hash(i.view, "jve1:") ||
    ![i.logical_session, i.contract, i.algorithm].every(
      (v) => typeof v === "string" && v.length > 0 && v.length <= 128,
    ) ||
    !(
      (i.mode === "site" && i.overlay === null) ||
      (i.mode === "personal" && hash(i.overlay))
    )
  )
    throw new Error("invalid ranking identity");
  // Explicit field order excludes caller property order and physical worker identity.
  return JSON.stringify([
    i.logical_session,
    i.snapshot,
    i.inventory,
    i.input,
    i.view,
    i.overlay,
    i.mode,
    i.build,
    i.contract,
    i.policy,
    i.algorithm,
  ]);
}
/** Keep this object in the logical session owner across evaluation-worker repair. */
export class WordResultCache {
  #identity: string | null = null;
  #epoch = 0;
  #sequence = 0;
  #clock = 0;
  #touch = 0;
  #disposed = false;
  #entries = new Map<string, Entry>();
  #reservations = new Map<string, Reservation>();
  #markers = new Map<
    string,
    { failure: Readonly<WordFailure>; bytes: number }
  >();
  #tickets = new Map<string, Entry>();
  bind(identity: WordCacheIdentity): boolean {
    const key = identityKey(identity);
    this.#alive();
    if (key === this.#identity) return false; // Repair with the same logical identity preserves markers.
    this.#identity = key;
    this.#epoch += 1;
    this.#reservations.clear();
    this.#markers.clear();
    for (const [key, e] of this.#entries)
      if (e.pins === 0) this.#entries.delete(key);
    return true;
  }
  #alive() {
    if (this.#disposed) throw new Error("word cache is disposed");
  }
  #time(now: number) {
    this.#alive();
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now < this.#clock ||
      now > Number.MAX_SAFE_INTEGER - WORD_CACHE_LIMITS.readyLifetime
    )
      throw new Error("invalid ranking clock");
    this.#clock = now;
    for (const [id, e] of this.#tickets)
      if (e.expiry <= now) {
        e.pins -= 1;
        this.#tickets.delete(id);
      }
    for (const [key, e] of this.#entries)
      if (e.expiry <= now && e.pins === 0) this.#entries.delete(key);
    this.#prune();
  }
  #id(prefix: string) {
    if (this.#sequence === Number.MAX_SAFE_INTEGER)
      throw new Error("ranking identifier limit");
    return prefix + ++this.#sequence;
  }
  #key(word: string, reviewers: number | null): string {
    this.#alive();
    if (
      this.#identity === null ||
      !hash(word, "jvw1:") ||
      (reviewers !== null &&
        (!Number.isSafeInteger(reviewers) || reviewers < 0 || reviewers > 128))
    )
      throw new Error("invalid word cache key");
    return JSON.stringify([this.#epoch, this.#identity, word, reviewers]);
  }
  #bytes() {
    return (
      [...this.#entries.values()].reduce((n, e) => n + e.bytes.byteLength, 0) +
      [...this.#reservations.values()].reduce((n, r) => n + r.bytes, 0)
    );
  }
  #markerBytes() {
    return (
      [...this.#markers.values()].reduce((n, m) => n + m.bytes, 0) +
      this.#reservations.size * WORD_CACHE_LIMITS.markerReservation
    );
  }
  #prune() {
    const free = [...this.#entries.values()]
      .filter((e) => e.pins === 0)
      .sort((a, b) => a.touched - b.touched);
    for (const e of free)
      if (e.epoch !== this.#epoch) this.#entries.delete(e.key);
    const current = free.filter((e) => e.epoch === this.#epoch);
    for (const e of current.slice(
      0,
      Math.max(0, current.length - WORD_CACHE_LIMITS.reuse),
    ))
      this.#entries.delete(e.key);
  }
  #pin(e: Entry): ReadyWordTicket | null {
    if (
      this.#tickets.size + this.#reservations.size >=
      WORD_CACHE_LIMITS.consumers
    )
      return null;
    const id = this.#id("ticket-");
    e.pins += 1;
    e.touched = ++this.#touch;
    this.#tickets.set(id, e);
    return { id, ready_at: e.ready, expires_at: e.expiry };
  }
  reserve(
    word: string,
    reviewers: number | null,
    now: number,
    outputBytes: number = WORD_CACHE_LIMITS.output,
  ): WordAdmission {
    const key = this.#key(word, reviewers);
    if (
      !Number.isSafeInteger(outputBytes) ||
      outputBytes <= 0 ||
      outputBytes > WORD_CACHE_LIMITS.output
    )
      throw new Error("invalid result reservation");
    this.#time(now);
    const marker = this.#markers.get(key);
    if (marker) return { status: "failure", failure: marker.failure };
    const entry = this.#entries.get(key);
    if (entry) {
      const ticket = this.#pin(entry);
      return ticket
        ? { status: "ready", ticket }
        : { status: "ranking_busy", retry_after: 1 };
    }
    if ([...this.#reservations.values()].some((r) => r.key === key))
      return { status: "pending" };
    if (
      this.#markers.size + this.#reservations.size >=
        WORD_CACHE_LIMITS.markers ||
      this.#markerBytes() + WORD_CACHE_LIMITS.markerReservation >
        WORD_CACHE_LIMITS.markerBytes
    )
      return { status: "ranking_busy", retry_after: 1 };
    const free = [...this.#entries.values()]
      .filter((e) => e.pins === 0)
      .sort((a, b) => a.touched - b.touched);
    while (this.#bytes() + outputBytes > WORD_CACHE_LIMITS.bytes && free.length)
      this.#entries.delete(free.shift()!.key);
    if (
      this.#bytes() + outputBytes > WORD_CACHE_LIMITS.bytes ||
      this.#tickets.size + this.#reservations.size >=
        WORD_CACHE_LIMITS.consumers
    )
      return { status: "ranking_busy", retry_after: 1 };
    const reservation = this.#id("reservation-");
    this.#reservations.set(reservation, {
      key,
      epoch: this.#epoch,
      bytes: outputBytes,
    });
    return { status: "reserved", reservation, key };
  }
  complete(
    reservation: string,
    bytes: Uint8Array,
    now: number,
  ): ReadyWordTicket {
    this.#time(now);
    const r = this.#reservations.get(reservation);
    if (!r || r.epoch !== this.#epoch)
      throw new Error("stale word reservation");
    if (
      !(bytes instanceof Uint8Array) ||
      !(bytes.buffer instanceof ArrayBuffer) ||
      bytes.byteOffset !== 0 ||
      bytes.byteLength !== bytes.buffer.byteLength
    )
      throw new Error("result requires an owned byte buffer");
    if (bytes.byteLength > r.bytes) {
      this.fail(
        reservation,
        {
          code: "resource_unavailable",
          limit: "output_bytes",
          retryable: false,
        },
        now,
      );
      throw new Error("word result exceeds its reservation");
    }
    if (
      this.#tickets.size + this.#reservations.size >
      WORD_CACHE_LIMITS.consumers
    )
      throw new Error("ranking_busy");
    // Detach the caller's buffer. The cache retains exactly one serialized copy.
    const owned = structuredClone(bytes, { transfer: [bytes.buffer] });
    this.#reservations.delete(reservation);
    const entry: Entry = {
      key: r.key,
      epoch: r.epoch,
      bytes: owned,
      ready: now,
      expiry: now + WORD_CACHE_LIMITS.readyLifetime,
      pins: 0,
      touched: ++this.#touch,
    };
    this.#entries.set(r.key, entry);
    const ticket = this.#pin(entry)!;
    this.#prune();
    return ticket;
  }
  read(
    ticket: string,
    now: number,
  ): { bytes: Uint8Array; ready_at: number; expires_at: number } | null {
    this.#time(now);
    const entry = this.#tickets.get(ticket);
    return entry
      ? {
          bytes: entry.bytes.slice(),
          ready_at: entry.ready,
          expires_at: entry.expiry,
        }
      : null;
  }
  cancelTicket(ticket: string, now: number): void {
    this.#time(now);
    const entry = this.#tickets.get(ticket);
    if (entry) {
      entry.pins -= 1;
      this.#tickets.delete(ticket);
      this.#prune();
    }
  }
  cancelReservation(reservation: string): void {
    this.#alive();
    this.#reservations.delete(reservation);
  }
  fail(
    reservation: string,
    failure: WordFailure,
    now: number,
  ): Readonly<WordFailure> {
    this.#time(now);
    const r = this.#reservations.get(reservation);
    if (!r) throw new Error("stale word reservation");
    if (
      !failure ||
      ![
        "resource_unavailable",
        "numeric_unavailable",
        "ranking_unavailable",
        "unsupported_calculation",
      ].includes(failure.code) ||
      failure.retryable !== false ||
      typeof failure.limit !== "string" ||
      failure.limit.length > 128 ||
      (failure.background_evaluation_running_at_expiry !== undefined &&
        typeof failure.background_evaluation_running_at_expiry !== "boolean")
    )
      throw new Error("invalid word failure");
    const fixed: Readonly<WordFailure> = Object.freeze({
      code: failure.code,
      limit: failure.limit,
      retryable: false,
      ...(failure.background_evaluation_running_at_expiry === undefined
        ? {}
        : {
            background_evaluation_running_at_expiry:
              failure.background_evaluation_running_at_expiry,
          }),
    });
    const bytes = size(r.key) + size(JSON.stringify(fixed));
    if (bytes > WORD_CACHE_LIMITS.markerReservation)
      throw new Error("word marker exceeds its reservation");
    this.#reservations.delete(reservation);
    this.#markers.set(r.key, { failure: fixed, bytes });
    return fixed;
  }
  deadline(
    reservation: string,
    backgroundEvaluationRunningAtExpiry: boolean,
    now: number,
  ): Readonly<WordFailure> {
    return this.fail(
      reservation,
      {
        code: "resource_unavailable",
        limit: "deadline",
        retryable: false,
        background_evaluation_running_at_expiry:
          backgroundEvaluationRunningAtExpiry,
      },
      now,
    );
  }
  statistics() {
    this.#alive();
    return {
      bytes: this.#bytes(),
      ready: this.#entries.size,
      pinned: [...this.#entries.values()].filter((e) => e.pins > 0).length,
      consumers: this.#tickets.size + this.#reservations.size,
      reservations: this.#reservations.size,
      markers: this.#markers.size,
      marker_bytes: this.#markerBytes(),
    };
  }
  dispose(): void {
    this.#entries.clear();
    this.#reservations.clear();
    this.#markers.clear();
    this.#tickets.clear();
    this.#identity = null;
    this.#disposed = true;
  }
}
