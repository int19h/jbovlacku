/** Shared application services handed to every page. */
import type { LocalStore } from "../data/store.ts";
import type { DeliveryEngine } from "../data/delivery.ts";
import type { Session } from "./session.ts";
import type { Signer } from "./actions.ts";
import type { Shell } from "./shell.ts";
import {
  deriveRegisters,
  loadOwnHistory,
  type OwnRegisters,
} from "../data/history.ts";
import { describe } from "../lib/dom.ts";

/** Cached own registers. Known state comes from authenticated own history only. */
export class OwnState {
  private cache: Promise<OwnRegisters | null> | null = null;
  private listeners = new Set<() => void>();
  constructor(
    private store: LocalStore,
    private session: Session,
    private offline: () => boolean,
  ) {
    session.subscribe(() => {
      if (!session.backup) this.invalidate();
    });
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Returns the registers, or null when they cannot be established. */
  registers(): Promise<OwnRegisters | null> {
    const identity = this.session.identity;
    if (!identity || !this.session.storageAvailable)
      return Promise.resolve(null);
    if (!this.cache) {
      this.cache = loadOwnHistory(this.store, identity, {
        offline: this.offline(),
      })
        .then((history) => deriveRegisters(history))
        .catch((error) => {
          this.lastError = describe(error);
          return null;
        });
    }
    return this.cache;
  }
  lastError: string | null = null;
  invalidate() {
    this.cache = null;
    this.lastError = null;
    for (const listener of this.listeners) listener();
  }
}
export interface App {
  store: LocalStore;
  session: Session;
  delivery: DeliveryEngine;
  signer: Signer;
  shell: Shell;
  own: OwnState;
  offlineSigning: { value: boolean };
  announce(message: string): void;
}
