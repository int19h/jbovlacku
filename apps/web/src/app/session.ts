/**
 * The local signing identity. The encrypted backup stays in storage. The
 * working key stays in memory and locks after 15 idle minutes unless the
 * session setting applies.
 */
import { setPreferredView } from "../data/api.ts";
import { el, p, button, field, describe, link, append } from "../lib/dom.ts";
import { createKey, parseBackup, unlockKey } from "../data/keys.ts";
import {
  IdentityConflictError,
  type KeyBackup,
  type LocalStore,
  type Preferences,
} from "../data/store.ts";
import { navigate } from "./router.ts";

export const IDLE_LOCK_MS = 15 * 60 * 1000;
export type SessionListener = (session: Session) => void;
export class Session {
  backup: KeyBackup | undefined;
  workingKey: CryptoKey | undefined;
  keepUnlocked = false;
  storageAvailable = true;
  preferences!: Preferences;
  private lockTimer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<SessionListener>();
  /** A pending action to resume after the key is created or unlocked. */
  pending: { description: string; run: () => Promise<void> } | null = null;
  constructor(public store: LocalStore) {
    window.addEventListener("pagehide", () => {
      this.lock();
    });
  }
  async load() {
    try {
      this.preferences = await this.store.preferences();
      setPreferredView(this.preferences.view);
      this.backup = await this.store.get<KeyBackup>("keys", "selected");
    } catch {
      this.storageAvailable = false;
      this.preferences = (await import("../data/store.ts")).defaultPreferences;
    }
  }
  subscribe(listener: SessionListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed() {
    for (const listener of this.listeners) listener(this);
  }
  get unlocked() {
    return Boolean(this.backup && this.workingKey);
  }
  get identity() {
    return this.backup?.identity;
  }
  /** Records a signing action and restarts the idle timer. */
  touch() {
    clearTimeout(this.lockTimer);
    if (!this.keepUnlocked && this.workingKey)
      this.lockTimer = setTimeout(() => this.lock("idle"), IDLE_LOCK_MS);
  }
  lock(reason: "idle" | "user" = "user") {
    this.workingKey = undefined;
    this.keepUnlocked = false;
    clearTimeout(this.lockTimer);
    this.changed();
    void reason;
  }
  async setKeepUnlocked(value: boolean) {
    this.keepUnlocked = value;
    this.touch();
    this.changed();
  }
  async setPreferences(patch: Partial<Preferences>) {
    this.preferences = await this.store.setPreferences(patch);
    if ("view" in patch) setPreferredView(this.preferences.view);
    this.changed();
    return this.preferences;
  }
  async backupTested(): Promise<boolean> {
    if (!this.backup) return false;
    return Boolean(
      await this.store.get<boolean>("keys", `tested:${this.backup.identity}`),
    );
  }
  /** Switches to the successor key after a persisted handover. The old key stays stored as retired. */
  adoptSuccessor(backup: KeyBackup, key: CryptoKey) {
    this.backup = backup;
    this.workingKey = key;
    this.touch();
    this.changed();
  }
  /** Retired keys kept for archive access and compromise notices. */
  async retiredBackups(): Promise<KeyBackup[]> {
    if (!this.storageAvailable) return [];
    const ids = (await this.store.keys("keys")).filter((k) =>
      k.startsWith("retired:"),
    );
    const backups: KeyBackup[] = [];
    for (const id of ids) {
      const backup = await this.store.get<KeyBackup>("keys", id);
      if (backup && backup.identity !== this.backup?.identity)
        backups.push(backup);
    }
    return backups;
  }
  /** Why ordinary signing is disabled for an identity, or null. */
  async signingDisabled(identity: string): Promise<string | null> {
    if (await this.store.get("keys", `compromised:${identity}`))
      return "This key published a compromise notice. Ordinary actions from it are disabled.";
    if (
      (await this.store.get("keys", `handover:${identity}`)) ||
      (await this.store.get("keys", `transfer-known:${identity}`))
    )
      return "This key signed a handover and is retired. Ordinary actions from it are disabled.";
    return null;
  }
  async markBackupTested() {
    if (!this.backup) return;
    await this.store.put("keys", `tested:${this.backup.identity}`, true);
    this.changed();
  }
  private async install(candidate: KeyBackup, mode: "create" | "restore") {
    try {
      await this.store.installIdentity(candidate, mode);
    } catch (error) {
      if (error instanceof IdentityConflictError) {
        const selected = await this.store.get<KeyBackup>("keys", "selected");
        if (selected?.identity !== this.backup?.identity) {
          this.backup = selected;
          this.lock();
        }
      }
      throw error;
    }
  }
  async create(passphrase: string) {
    if (!this.storageAvailable)
      throw new Error(
        "Restore browser storage access and reload before creating a key.",
      );
    const created = await createKey(passphrase);
    await this.install(created.backup, "create");
    this.backup = created.backup;
    this.workingKey = created.key;
    this.touch();
    this.changed();
    return created.backup;
  }
  async importBackup(file: File, passphrase: string) {
    if (file.size > 16384) throw new Error("The backup exceeds 16 KiB.");
    const imported = parseBackup(await file.text());
    if (this.identity && imported.identity !== this.identity)
      throw new Error(
        "This backup belongs to another identity. This browser keeps its selected key.",
      );
    const opened = await unlockKey(imported, passphrase);
    await this.install(imported, "restore");
    this.workingKey = opened;
    this.backup = imported;
    this.touch();
    this.changed();
    return imported;
  }
  /** Decrypts a backup file and compares the recovered identity. Does not replace the key. */
  async testBackup(file: File, passphrase: string) {
    if (!this.backup) throw new Error("There is no key to test.");
    if (file.size > 16384) throw new Error("The backup exceeds 16 KiB.");
    const imported = parseBackup(await file.text());
    if (imported.identity !== this.backup.identity)
      throw new Error(
        "This backup belongs to another identity. It does not recover the key in this browser.",
      );
    await unlockKey(imported, passphrase);
    await this.markBackupTested();
  }
  async unlock(passphrase: string) {
    if (!this.backup) throw new Error("There is no key in this browser.");
    this.workingKey = await unlockKey(this.backup, passphrase);
    this.touch();
    this.changed();
  }
  /**
   * Makes sure that a working key is available, then runs the action.
   * Without a key, the action waits at /identity and resumes after creation or unlock.
   */
  async requireUnlocked(description: string, run: () => Promise<void>) {
    if (this.unlocked) {
      await run();
      return;
    }
    if (!this.storageAvailable)
      throw new Error(
        "Browser storage is unavailable. Restore storage access and reload before signing.",
      );
    if (!this.backup) {
      this.pending = { description, run };
      navigate("/identity");
      return;
    }
    const unlocked = await this.unlockDialog(description);
    if (unlocked) await run();
  }
  /** Runs the pending action after a key is available. */
  async resumePending() {
    const pending = this.pending;
    if (!pending || !this.unlocked) return false;
    this.pending = null;
    await pending.run();
    return true;
  }
  private unlockDialog(description: string): Promise<boolean> {
    return new Promise((resolve) => {
      const opener = document.activeElement as HTMLElement | null;
      const dialog = el("dialog", {
        class: "sheet",
        "aria-labelledby": "unlock-title",
      });
      const pass = field("Passphrase", {
        type: "password",
        autocomplete: "current-password",
        required: true,
      });
      const error = el("p", { class: "notice", role: "alert" });
      error.hidden = true;
      const form = el("form", { method: "dialog" });
      const submit = el("button", {
        type: "submit",
        class: "btn btn-primary",
        text: "Unlock",
      });
      const cancel = button("Cancel", () => dialog.close("cancel"), {
        class: "btn btn-quiet",
      });
      append(
        form,
        el("h2", { id: "unlock-title", text: "Unlock your key" }),
        p(
          `${description} needs your signature. Unlock the key stored in this browser.`,
          "small",
        ),
        pass.wrapper,
        error,
        el("div", { class: "actions" }, submit, cancel),
      );
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        submit.disabled = true;
        try {
          await this.unlock(pass.input.value);
          pass.input.value = "";
          dialog.close("unlocked");
        } catch (failure) {
          error.textContent = describe(failure);
          error.hidden = false;
          submit.disabled = false;
          pass.input.focus();
        }
      });
      dialog.addEventListener("close", () => {
        resolve(dialog.returnValue === "unlocked");
        dialog.remove();
        opener?.focus();
      });
      dialog.append(form);
      document.body.append(dialog);
      dialog.showModal();
      pass.input.focus();
    });
  }
  /** The one-time explanation before the first public signature. */
  async firstSignatureDisclosure(): Promise<boolean> {
    if (this.preferences.firstSignatureAcknowledged) return true;
    return new Promise((resolve) => {
      const opener = document.activeElement as HTMLElement | null;
      const dialog = el("dialog", {
        class: "sheet",
        "aria-labelledby": "first-sign-title",
      });
      const proceed = button(
        "Continue",
        async () => {
          await this.setPreferences({ firstSignatureAcknowledged: true });
          dialog.close("ok");
        },
        { class: "btn btn-primary" },
      );
      const cancel = button("Not now", () => dialog.close("cancel"), {
        class: "btn btn-quiet",
      });
      append(
        dialog,
        el("h2", {
          id: "first-sign-title",
          text: "Before your first public signature",
        }),
        el(
          "div",
          { class: "stack small" },
          p(
            "Judgments and public trust choices are signed public records. Other servers can copy them.",
          ),
          p("Undo adds a record. It does not erase the earlier public record."),
          p("Keep a backup. Losing this key can make this identity unusable."),
          p(
            "This website supplies the code that uses your key. A compromised website can misuse it.",
          ),
          el(
            "p",
            {},
            "Your ",
            link("key page", "/identity"),
            " offers a backup test and lock controls.",
          ),
        ),
        el(
          "div",
          { class: "actions", style: "margin-top:14px" },
          proceed,
          cancel,
        ),
      );
      dialog.addEventListener("close", () => {
        resolve(dialog.returnValue === "ok");
        dialog.remove();
        opener?.focus();
      });
      document.body.append(dialog);
      dialog.showModal();
      proceed.focus();
    });
  }
}
