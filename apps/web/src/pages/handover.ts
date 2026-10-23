/**
 * Planned handover: a fresh successor key, its backup and backup test, the
 * old key's complete known history from every configured peer, a preview of
 * the consequences, approval of the successor fingerprint, and both
 * signatures persisted in one transaction before upload. The frontier is
 * refreshed before signing, and a changed preview needs renewed approval.
 * Retries use the stored events.
 */
import {
  el,
  p,
  text,
  button,
  link,
  field,
  download,
  describe,
  checkbox,
} from "../lib/dom.ts";
import { fingerprintText, shortIdentity } from "../lib/format.ts";
import { navigate, type RenderContext, type Route } from "../app/router.ts";
import type { App } from "../app/context.ts";
import { createKey, parseBackup, unlockKey } from "../data/keys.ts";
import { loadOwnHistory, type OwnHistory } from "../data/history.ts";
import {
  askPeers,
  fetchBranches,
  LifecycleConflictError,
  outboxItem,
  queueHandover,
  queueRecoveryAcceptance,
  signWith,
  type HandoverRecord,
  type PeerKnowledge,
} from "../data/lifecycle.ts";
import { savedPeer } from "../data/delivery.ts";
import type { Envelope } from "../model/types.ts";
import type { KeyBackup, OutboxItem, SavedRecipient } from "../data/store.ts";
import type { Peer } from "../data/api.ts";

/** The configured peers as saved addresses and request peers. */
export function configuredPeers(app: App): {
  recipients: Record<string, SavedRecipient>;
  peers: Peer[];
} {
  const recipients: Record<string, SavedRecipient> = {};
  const peers: Peer[] = [];
  for (const configured of app.session.preferences.peers) {
    const url = new URL(configured.base, location.origin);
    recipients[configured.id] = {
      origin: url.origin,
      base: url.pathname.replace(/\/$/, ""),
      label: configured.label === "this server" ? url.host : configured.label,
    };
    peers.push({
      id: configured.id,
      base: `${url.origin}${url.pathname.replace(/\/$/, "")}`,
      label: recipients[configured.id].label,
    });
  }
  return { recipients, peers };
}
/** The delivery state of a stored handover, from the outbox. */
export async function handoverState(
  app: App,
  record: HandoverRecord,
): Promise<{
  transfer: OutboxItem | null;
  accept: OutboxItem | null;
  transferDone: boolean;
  acceptDone: boolean;
}> {
  const items = await app.delivery.items();
  const transfer = items.find((i) => i.id === record.transfer) ?? null;
  const accept = items.find((i) => i.id === record.accept) ?? null;
  const done = (item: OutboxItem | null) =>
    item !== null &&
    Object.values(item.peers).every((peer) => peer.state === "accepted");
  return {
    transfer,
    accept,
    transferDone: done(transfer),
    acceptDone: done(accept),
  };
}
/** Everything the preview depends on. A changed digest needs renewed approval. */
interface Gathered {
  history: OwnHistory;
  knowledge: PeerKnowledge[];
  heads: string[];
  fetched: number;
  /** The heads stored in this browser when the preview was made. The write compares them again. */
  storedHeads: string[];
  existingTransfer: { id: string; successor: string; peer: string } | null;
  compromised: string | null;
  transfer: Envelope | null;
  acceptances: { id: string; peer: string }[];
  recoveryBlocked: string | null;
  /** Why the ordinary handover is blocked, or null. */
  blocked: string | null;
  digest: string;
}
/** A peer whose scan stopped early, answered against the API contract, or listed claims it could not prove. */
function scanIncomplete(k: PeerKnowledge): boolean {
  return k.outcome === "partial" || k.outcome === "malformed";
}
/** A peer that could not be reached at all. */
function unanswered(k: PeerKnowledge): boolean {
  return k.outcome === "unreachable";
}
export async function handoverPage(
  _route: Route,
  context: RenderContext,
  app: App,
) {
  const { main } = context;
  const { session } = app;
  context.title("Move to a new key");
  main.className = "";
  main.append(el("h1", { class: "page", text: "Move to a new key" }));
  if (!session.storageAvailable || !session.backup) {
    main.append(
      p(
        "Create or restore your key first. A handover needs the old key in this browser.",
        "notice",
      ),
      link("Your key", "/identity", { class: "btn" }),
    );
    return;
  }
  const old = session.backup;
  const existing = await app.store.get<HandoverRecord>(
    "keys",
    `handover:${old.identity}`,
  );
  if (!context.live()) return;
  if (existing) {
    main.append(
      p(
        "This key already signed a handover. The stored events are reused for retries. No new signature is offered.",
        "small",
      ),
    );
    renderExisting(main, app, existing);
    return;
  }
  const compromisedMark = await app.store.get<string>(
    "keys",
    `compromised:${old.identity}`,
  );
  const retiredElsewhere = await app.store.get<HandoverRecord>(
    "keys",
    `handover-of:${old.identity}`,
  );
  if (!context.live()) return;
  if (compromisedMark) {
    main.append(
      p(
        "This key published a compromise notice. A transfer after a compromise never restores inherited continuity, so this page offers no handover.",
        "notice",
      ),
    );
    return;
  }
  if (retiredElsewhere)
    main.append(
      p(
        `This key is the successor of ${shortIdentity(retiredElsewhere.old)}. A second handover would retire it in turn.`,
        "meta",
      ),
    );
  main.append(
    el(
      "div",
      { class: "stack small", style: "margin:8px 0 16px" },
      p(
        "The old key signs a transfer naming the new key and then retires. Ordinary actions from the old key stop. The new key signs an acceptance as its first and only first event.",
      ),
      p(
        "Every branch that this browser or a configured peer reports is fetched, verified, and included, so known work keeps its authority. Conflicting transfers suspend automatic continuity. Old-key actions that nobody here has seen lose ordinary authority after the transfer. There is no grace period and no undo.",
      ),
    ),
  );
  // Step 1: the successor key.
  const step1 = el("section", { "aria-labelledby": "s1" });
  step1.append(
    el("h2", {
      id: "s1",
      class: "section",
      text: "1. Create and back up the new key",
    }),
  );
  let successor: { backup: KeyBackup; key: CryptoKey } | null = null;
  let successorTested = false;
  const keyBox = el("div");
  step1.append(keyBox);
  main.append(step1);
  // Step 2: known history.
  const step2 = el("section", { "aria-labelledby": "s2" });
  step2.append(
    el("h2", {
      id: "s2",
      class: "section",
      text: "2. Known history of the old key",
    }),
  );
  const historyBox = el("div", {
    "aria-live": "polite",
    role: "region",
    "aria-label": "Known history",
  });
  step2.append(historyBox);
  main.append(step2);
  // Step 3: approval and signatures.
  const step3 = el("section", { "aria-labelledby": "s3" });
  step3.append(
    el("h2", { id: "s3", class: "section", text: "3. Approve and sign" }),
  );
  const approveBox = el("div");
  step3.append(approveBox);
  main.append(step3);
  let gathered: Gathered | null = null;
  let gatherFailure: string | null = null;
  let signing = false;
  const renderKey = () => {
    keyBox.replaceChildren();
    if (!successor) {
      const form = el("form", { class: "card", "aria-label": "New key" });
      const pass = field("New passphrase for the new key", {
        type: "password",
        autocomplete: "new-password",
        required: true,
        hint: "At least 12 characters. It protects the new key's backup.",
      });
      const repeat = field("Repeat passphrase", {
        type: "password",
        autocomplete: "new-password",
        required: true,
      });
      const error = el("p", { class: "notice", role: "alert" });
      error.hidden = true;
      const submit = el("button", {
        type: "submit",
        class: "btn btn-primary",
        text: "Create the new key",
      });
      form.append(
        pass.wrapper,
        repeat.wrapper,
        error,
        el("div", { class: "actions" }, submit),
      );
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (pass.input.value.length < 12) {
          error.textContent = "Use at least 12 characters.";
          error.hidden = false;
          return;
        }
        if (pass.input.value !== repeat.input.value) {
          error.textContent = "The passphrases differ.";
          error.hidden = false;
          return;
        }
        submit.disabled = true;
        try {
          successor = await createKey(pass.input.value);
          pass.input.value = "";
          repeat.input.value = "";
          renderKey();
          renderApprove();
        } catch (failure) {
          error.textContent = describe(failure);
          error.hidden = false;
          submit.disabled = false;
        }
      });
      keyBox.append(form);
      return;
    }
    const card = el("div", {
      class: "card",
      role: "region",
      "aria-label": "New key",
    });
    card.append(
      p("New key fingerprint", "meta"),
      el("p", {
        class: "fingerprint",
        text: fingerprintText(successor.backup.identity),
      }),
      p(
        "Download the encrypted backup, then test it below. The handover cannot be signed before the test passes. The new key is not installed until both signatures are saved.",
        "small",
      ),
      button(
        "Download the new key's backup",
        () =>
          download(
            `jbovlacku-key-backup-${successor!.backup.identity.slice(8, 16)}.json`,
            JSON.stringify(successor!.backup, null, 2),
          ),
        { class: "btn" },
      ),
    );
    const test = el("form", {
      style:
        "margin-top:12px;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end",
      "aria-label": "Backup test",
    });
    const file = field("Backup file", { type: "file", wrapperClass: "" });
    const pass = field("Its passphrase", {
      type: "password",
      autocomplete: "off",
      wrapperClass: "",
    });
    const submit = el("button", {
      type: "submit",
      class: "btn",
      text: "Test the backup",
    });
    const outcome = el("p", {
      class: "small",
      role: "status",
      style: "flex-basis:100%;margin:0",
    });
    test.append(file.wrapper, pass.wrapper, submit, outcome);
    test.addEventListener("submit", async (event) => {
      event.preventDefault();
      const chosen = (file.input as HTMLInputElement).files?.[0];
      if (!chosen) {
        outcome.textContent = "Choose the downloaded backup file.";
        return;
      }
      submit.disabled = true;
      try {
        const imported = parseBackup(await chosen.text());
        if (imported.identity !== successor!.backup.identity)
          throw new Error("This file belongs to another key.");
        await unlockKey(imported, pass.input.value);
        successorTested = true;
        outcome.textContent = "The backup opens and recovers the new key.";
        pass.input.value = "";
        renderApprove();
      } catch (failure) {
        successorTested = false;
        outcome.textContent = `The backup test failed: ${describe(failure)}`;
      } finally {
        submit.disabled = false;
      }
    });
    card.append(test);
    keyBox.append(card);
  };
  /** Loads the old key's history, asks every peer, fetches reported branches, and computes the frontier. */
  const gather = async (accepted = false): Promise<Gathered> => {
    const storedHeads = [
      ...((await app.store.get<string[]>("heads", old.identity)) ?? []),
    ].sort();
    const history = await loadOwnHistory(app.store, old.identity, {
      offline: app.offlineSigning.value,
      accepted,
      signal: context.signal,
    });
    let existingTransfer: Gathered["existingTransfer"] = null;
    let compromised: string | null = null;
    const { peers } = configuredPeers(app);
    let knowledge = await askPeers(peers, old.identity, null, context.signal);
    let blocked: string | null = null;
    let fetched = 0;
    if (!history.complete)
      blocked =
        "Part of this key's history is missing from this browser and its server. The ordinary handover needs the complete known history.";
    for (const k of knowledge)
      if (scanIncomplete(k) || k.unverified.length)
        blocked ??= `${k.peer.label}: ${k.status}. The ordinary handover needs a complete scan of every configured peer.`;
    if (!blocked) {
      try {
        fetched = (
          await fetchBranches(app.store, history, knowledge, context.signal)
        ).fetched;
      } catch (error) {
        blocked = describe(error);
      }
    }
    // Lifecycle state comes from the complete authenticated union, including fetched branches.
    for (const envelope of history.events.values()) {
      if (envelope.header.action.kind === "identity.transfer")
        existingTransfer = {
          id: envelope.id,
          successor: String(envelope.header.action.successor),
          peer: "this browser",
        };
      if (envelope.header.action.kind === "identity.compromise")
        compromised = "this browser";
    }
    for (const k of knowledge) {
      for (const t of k.transfers)
        existingTransfer ??= {
          id: t.id,
          successor: t.successor,
          peer: k.peer.label,
        };
      if (k.compromises.length) compromised ??= k.peer.label;
    }
    const transferIds = new Set([
      ...[...history.events.values()]
        .filter((event) => event.header.action.kind === "identity.transfer")
        .map((event) => event.id),
      ...knowledge.flatMap((k) => k.transfers.map((t) => t.id)),
    ]);
    let transfer: Envelope | null = null;
    let recoveryBlocked: string | null = null;
    const acceptances: Gathered["acceptances"] = [];
    if (existingTransfer) {
      // A discovered transfer retires ordinary signing even if its acceptance is lost.
      const db = await app.store.database;
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("keys", "readwrite");
        const keys = tx.objectStore("keys");
        const request = keys.get(`transfer-known:${old.identity}`);
        request.onsuccess = () =>
          keys.put(
            transferIds.size !== 1 ||
              (request.result && request.result !== existingTransfer!.id)
              ? "conflicting-transfers"
              : existingTransfer!.id,
            `transfer-known:${old.identity}`,
          );
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      knowledge = await askPeers(
        peers,
        old.identity,
        existingTransfer.successor,
        context.signal,
      );
      for (const k of knowledge) {
        for (const t of k.transfers) transferIds.add(t.id);
        if (k.compromises.length) compromised ??= k.peer.label;
        for (const a of k.acceptances)
          if (a.transfer === existingTransfer.id)
            acceptances.push({ id: a.id, peer: k.peer.label });
      }
      if (
        !peers.length ||
        knowledge.some(
          (k) => k.outcome !== "complete" || !k.complete || k.unverified.length,
        )
      )
        recoveryBlocked =
          "Recovery needs a complete answer from every configured peer. An unanswered or incomplete peer blocks it.";
      if (transferIds.size !== 1)
        recoveryBlocked =
          "Conflicting transfers block recovery. No acceptance can be signed here.";
      if (blocked || compromised)
        recoveryBlocked ??=
          "The old key's history or compromise state blocks recovery.";
      transfer = history.events.get(existingTransfer.id) ?? null;
      if (
        !transfer ||
        transfer.id !== existingTransfer.id ||
        transfer.header.issuer !== old.identity ||
        transfer.header.action.kind !== "identity.transfer" ||
        transfer.header.action.successor !== existingTransfer.successor
      )
        recoveryBlocked =
          "The transfer could not be authenticated. Recovery is blocked.";
      const successorHistory = await loadOwnHistory(
        app.store,
        existingTransfer.successor,
        { signal: context.signal, accepted },
      );
      for (const event of successorHistory.events.values())
        if (
          event.header.action.kind === "identity.accept" &&
          event.header.action.transfer === existingTransfer.id
        )
          acceptances.push({
            id: event.id,
            peer: "this browser and its server",
          });
      if (
        !successorHistory.complete ||
        successorHistory.events.size ||
        knowledge.some((k) => k.successorEvents.length)
      )
        recoveryBlocked ??=
          "The successor already has history or an acceptance. Reuse its signed records. Recovery cannot sign another first event.";
      if (acceptances.length)
        recoveryBlocked =
          "An authenticated acceptance exists. Reuse that record. Do not sign another acceptance.";
    }
    const heads = [...history.frontier].sort();
    const digest = JSON.stringify({
      heads,
      existingTransfer,
      compromised,
      blocked,
      recoveryBlocked,
      acceptances,
      peers: knowledge.map((k) => [k.peer.id, k.outcome, k.status, k.heads]),
    });
    return {
      history,
      knowledge,
      heads,
      fetched,
      storedHeads,
      existingTransfer,
      compromised,
      blocked,
      transfer,
      acceptances,
      recoveryBlocked,
      digest,
    };
  };
  const renderHistory = () => {
    historyBox.replaceChildren();
    if (gatherFailure) {
      historyBox.append(
        p(
          `This browser could not establish the old key's history: ${gatherFailure}`,
          "notice",
        ),
      );
      return;
    }
    if (!gathered) {
      historyBox.append(
        p(
          "Searching this browser and every configured peer for the old key's heads and lifecycle events…",
          "small",
        ),
      );
      return;
    }
    const g = gathered;
    historyBox.append(
      p(
        `${g.heads.length === 1 ? "One known head" : `${g.heads.length} known heads`} over ${g.history.events.size} verified record${g.history.events.size === 1 ? "" : "s"}${g.fetched ? `, ${g.fetched} fetched from other peers` : ""}. The transfer follows every known head, so all of this work keeps its authority.`,
        "small",
      ),
    );
    if (g.heads.length > 1)
      historyBox.append(
        p(
          "More than one head means separate device branches. Every branch is included. Opposite judgments in different branches stay conflicted until a later event resolves them.",
          "small",
        ),
      );
    const list = el("ul", { class: "small" });
    for (const k of g.knowledge) {
      const item = el("li");
      if (k.outcome === "complete") {
        item.append(
          text(
            `${k.peer.label}: ${k.heads.length === 0 ? "no own events" : k.heads.length === 1 ? "one head" : `${k.heads.length} heads`}, scan complete.`,
          ),
        );
        if (k.transfers.length)
          item.append(
            text(
              ` It holds a transfer by this key to ${k.transfers.map((t) => shortIdentity(t.successor)).join(", ")}.`,
              "warn",
            ),
          );
        if (k.compromises.length)
          item.append(
            text(" It holds a compromise notice by this key.", "warn"),
          );
      } else if (scanIncomplete(k) || k.unverified.length) {
        item.append(text(`${k.peer.label}: ${k.status}.`, "warn"));
      } else {
        item.append(
          text(
            `${k.peer.label}: did not answer (${k.status}). Its unseen old-key actions, if any, lose ordinary authority after the transfer.`,
          ),
        );
      }
      list.append(item);
    }
    historyBox.append(list);
    if (g.blocked) historyBox.append(p(g.blocked, "notice"));
    if (g.compromised)
      historyBox.append(
        p(
          `A compromise notice by this key exists on ${g.compromised}. A transfer after a compromise never restores inherited continuity. This page offers no handover.`,
          "notice",
        ),
      );
    if (g.existingTransfer)
      historyBox.append(
        p(
          `A transfer by this key already exists on ${g.existingTransfer.peer} (${g.existingTransfer.id.slice(0, 20)}…, to ${shortIdentity(g.existingTransfer.successor)}). A second transfer would freeze continuity. This page offers no new transfer. The acceptance search below names any authenticated result. Use the successor backup only for the recovery flow below.`,
          "notice",
        ),
      );
  };
  const renderRecovery = () => {
    const g = gathered;
    if (!g?.existingTransfer) return;
    const box = el("section", {
      class: "card",
      "aria-label": "Acceptance recovery",
    });
    historyBox.append(box);
    box.append(
      el("h3", { text: "Acceptance search" }),
      p(`Transfer ${g.existingTransfer.id}`, "fingerprint"),
    );
    for (const found of g.acceptances)
      box.append(
        el(
          "p",
          { class: "small" },
          text(`${found.peer}: authenticated acceptance `),
          link(found.id, `/definition/${encodeURIComponent(found.id)}`, {
            class: "touch-link",
          }),
        ),
      );
    if (g.recoveryBlocked) {
      box.append(p(g.recoveryBlocked, "notice"));
      return;
    }
    box.append(
      p(
        "Every configured peer answered. No acceptance for this transfer was found. Negative answers do not prove global absence.",
        "small",
      ),
    );
    const form = el("form", { "aria-label": "Recover a lost acceptance" });
    const file = field("Successor backup file", {
      type: "file",
      required: true,
    });
    const pass = field("Successor backup passphrase", {
      type: "password",
      autocomplete: "off",
      required: true,
    });
    let fingerprint = false;
    let hidden = false;
    const submit = el("button", {
      type: "submit",
      class: "btn btn-primary",
      text: "Sign one recovery acceptance",
    });
    submit.disabled = true;
    const refresh = () => {
      submit.disabled = !fingerprint || !hidden || signing;
    };
    form.append(
      file.wrapper,
      pass.wrapper,
      checkbox(
        `I checked the successor fingerprint ${fingerprintText(g.existingTransfer.successor)}.`,
        false,
        (v) => {
          fingerprint = v;
          refresh();
        },
      ),
      checkbox(
        "I understand that an undiscovered acceptance can later freeze continuity. This signs one new acceptance, not a safe retry. No new transfer is signed, and the old key stays retired.",
        false,
        (v) => {
          hidden = v;
          refresh();
        },
      ),
      submit,
    );
    box.append(form);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (signing || !fingerprint || !hidden) return;
      signing = true;
      submit.disabled = true;
      try {
        const chosen = file.input.files?.[0];
        if (!chosen) throw new Error("Choose the successor backup file.");
        if (chosen.size > 16384) throw new Error("The backup exceeds 16 KiB.");
        const backup = parseBackup(await chosen.text());
        if (backup.identity !== g.existingTransfer!.successor)
          throw new Error(
            "This backup does not recover the transfer's successor key.",
          );
        const key = await unlockKey(backup, pass.input.value);
        pass.input.value = "";
        const fresh = await gather(true);
        if (!context.live()) return;
        if (
          fresh.digest !== g.digest ||
          fresh.recoveryBlocked ||
          !fresh.transfer
        ) {
          gathered = fresh;
          renderHistory();
          renderRecovery();
          app.announce(
            "The acceptance search changed. Review the new result before recovery.",
          );
          return;
        }
        const transport = await signWith(key, backup.identity, [], {
          kind: "identity.accept",
          transfer: fresh.transfer.id,
        });
        const { recipients } = configuredPeers(app);
        const record = await queueRecoveryAcceptance(
          app.store,
          fresh.transfer,
          outboxItem(transport, crypto.randomUUID(), 0, recipients),
          old,
          backup,
        );
        session.adoptSuccessor(backup, key);
        app.own.invalidate();
        await app.delivery.invalidate();
        void app.delivery
          .deliver(record.transfer, true)
          .then(() => app.delivery.deliver(record.accept, true));
        navigate("/identity");
        app.announce(
          "One recovery acceptance is saved and uploading. The old key stays retired.",
        );
      } catch (error) {
        app.announce(describe(error));
      } finally {
        signing = false;
        refresh();
      }
    });
  };
  const acknowledgments = { fingerprint: false, retire: false, unseen: false };
  let approvedDigest: string | null = null;
  const renderApprove = () => {
    approveBox.replaceChildren();
    if (!successor) {
      approveBox.append(p("Create the new key first.", "meta"));
      return;
    }
    if (!successorTested) {
      approveBox.append(p("Test the new key's backup first.", "meta"));
      return;
    }
    if (!gathered || gatherFailure) {
      approveBox.append(
        p("The old key's history is not established yet.", "meta"),
      );
      return;
    }
    const g = gathered;
    if (g.blocked || g.existingTransfer || g.compromised) {
      approveBox.append(
        p(
          "The old key's state blocks the handover. See above. Nothing is signed.",
          "meta",
        ),
      );
      return;
    }
    const down = g.knowledge.filter(unanswered);
    approvedDigest = g.digest;
    approveBox.append(
      checkbox(
        `I checked the new key fingerprint ${fingerprintText(successor.backup.identity)}.`,
        acknowledgments.fingerprint,
        (v) => {
          acknowledgments.fingerprint = v;
          refresh();
        },
      ),
      checkbox(
        "I understand that the old key retires now, that there is no undo, and that an old-key holder can still disrupt references that rely on the old key.",
        acknowledgments.retire,
        (v) => {
          acknowledgments.retire = v;
          refresh();
        },
      ),
      checkbox(
        `I understand that old-key actions unseen by this browser and the answering peers${down.length ? `, and anything held only by ${down.map((k) => k.peer.label).join(", ")}, which did not answer,` : ""} lose ordinary authority, and that a conflicting transfer suspends continuity.`,
        acknowledgments.unseen,
        (v) => {
          acknowledgments.unseen = v;
          refresh();
        },
      ),
    );
    const sign = button("Sign the handover", () => void signHandover(sign), {
      class: "btn btn-primary",
      style: "margin-top:12px",
    });
    sign.disabled = true;
    const refresh = () => {
      sign.disabled =
        signing ||
        !(
          acknowledgments.fingerprint &&
          acknowledgments.retire &&
          acknowledgments.unseen
        );
    };
    approveBox.append(
      el(
        "div",
        { class: "actions" },
        sign,
        link("Cancel", "/identity", { class: "btn btn-quiet" }),
      ),
    );
    approveBox.append(
      p(
        "The known history is checked again right before signing. If it changed, the preview updates and needs your approval again. Both events are saved in this browser together with the new key before anything is sent. Upload can be partial. The key page then shows “Old key retired, acceptance waiting” until both events arrive.",
        "meta",
      ),
    );
  };
  const resetApproval = () => {
    acknowledgments.fingerprint = false;
    acknowledgments.retire = false;
    acknowledgments.unseen = false;
  };
  const signHandover = async (sign: HTMLButtonElement) => {
    if (!successor || !successorTested || signing) return;
    signing = true;
    sign.disabled = true;
    sign.textContent = "Checking the known history…";
    try {
      await session.requireUnlocked("The handover", async () => {
        // Refresh the frontier. A changed preview needs renewed approval.
        let fresh: Gathered;
        try {
          fresh = await gather(true);
        } catch (error) {
          gatherFailure = describe(error);
          gathered = null;
          renderHistory();
          renderRecovery();
          renderApprove();
          return;
        }
        if (!context.live()) return;
        if (fresh.digest !== approvedDigest) {
          gathered = fresh;
          gatherFailure = null;
          resetApproval();
          renderHistory();
          renderRecovery();
          renderApprove();
          app.announce(
            "The known history changed. Review the updated preview and approve again.",
          );
          return;
        }
        gathered = fresh;
        sign.textContent = "Signing…";
        const oldKey = session.workingKey!;
        if (session.backup?.identity !== old.identity)
          throw new Error("The selected key changed. Reload and start again.");
        const { recipients } = configuredPeers(app);
        const transfer = await signWith(oldKey, old.identity, fresh.heads, {
          kind: "identity.transfer",
          successor: successor!.backup.identity,
        });
        const accept = await signWith(
          successor!.key,
          successor!.backup.identity,
          [],
          { kind: "identity.accept", transfer: transfer.envelope.id },
        );
        const group = crypto.randomUUID();
        const record = await queueHandover(app.store, {
          transfer: outboxItem(transfer, group, 0, recipients),
          accept: outboxItem(accept, group, 1, recipients),
          successor: successor!.backup,
          old,
          successorTested,
          expectedHeads: fresh.storedHeads,
        });
        session.adoptSuccessor(successor!.backup, successor!.key);
        app.own.invalidate();
        await app.delivery.invalidate();
        void app.delivery
          .deliver(record.transfer, true)
          .then(() => app.delivery.deliver(record.accept, true));
        navigate("/identity");
        app.announce("Old key retired. The handover is saved and uploading.");
      });
    } catch (error) {
      app.announce(describe(error));
      if (error instanceof LifecycleConflictError) {
        resetApproval();
        try {
          gathered = await gather();
          gatherFailure = null;
        } catch (failure) {
          gatherFailure = describe(failure);
          gathered = null;
        }
        if (!context.live()) return;
        renderHistory();
        renderRecovery();
        renderApprove();
      }
    } finally {
      signing = false;
      if (sign.isConnected) {
        sign.textContent = "Sign the handover";
        sign.disabled =
          !(
            acknowledgments.fingerprint &&
            acknowledgments.retire &&
            acknowledgments.unseen
          ) || !gathered;
      }
    }
  };
  renderKey();
  renderHistory();
  renderRecovery();
  renderApprove();
  try {
    gathered = await gather();
  } catch (error) {
    gatherFailure = describe(error);
  }
  if (!context.live()) return;
  renderHistory();
  renderRecovery();
  renderApprove();
}
/** The status of a stored handover, for the key page and this page. */
export function renderExisting(
  container: HTMLElement,
  app: App,
  record: HandoverRecord,
) {
  const box = el("div", {
    class: "card",
    role: "region",
    "aria-label": "Handover status",
    "aria-live": "polite",
  });
  container.append(box);
  const update = async () => {
    const state = await handoverState(app, record);
    box.replaceChildren();
    const line =
      state.transferDone && state.acceptDone
        ? "Handover complete. The new key is active, and the old key is retired."
        : state.transferDone
          ? "Old key retired, acceptance waiting."
          : state.acceptDone
            ? "Acceptance delivered, transfer waiting."
            : "Old key retired locally. Both events are waiting to upload.";
    box.append(
      el("p", {
        class: "small",
        style: "font-weight:650;margin:0",
        text: line,
      }),
    );
    box.append(
      p(
        `Old key ${shortIdentity(record.old)} → new key ${shortIdentity(record.successor)}. Transfer ${record.transfer.slice(0, 20)}…, acceptance ${record.accept.slice(0, 20)}….`,
        "meta",
      ),
    );
    const peerLine = (item: OutboxItem | null, name: string) => {
      if (!item) return p(`${name}: not in this browser's outbox.`, "meta");
      return p(
        `${name}: ${Object.entries(item.peers)
          .map(
            ([id, peer]) => `${savedPeer(item, id)?.label ?? id} ${peer.state}`,
          )
          .join(", ")}.`,
        "meta",
      );
    };
    box.append(
      peerLine(state.transfer, "Transfer"),
      peerLine(state.accept, "Acceptance"),
    );
    if (!(state.transferDone && state.acceptDone))
      box.append(
        el(
          "p",
          { class: "small" },
          text(
            "Retries reuse the stored events and look the receipt up by event ID first. No replacement acceptance is ever signed automatically. ",
          ),
          link("Not delivered", "/outbox", { class: "touch-link" }),
        ),
      );
    else
      box.append(
        p(
          "Your public trust choices and judgments move through the continuity group once peers see the acceptance. People who heed the old key can migrate their heed to the new key; that is their signed choice. A view publisher can replace the old root entry. Retired-key possession can still disrupt references that rely on the old key.",
          "small",
        ),
      );
  };
  void update();
  const unsubscribe = app.delivery.subscribe(() => void update());
  const observer = new MutationObserver(() => {
    if (!box.isConnected) {
      unsubscribe();
      observer.disconnect();
    }
  });
  queueMicrotask(() =>
    observer.observe(document.body, { childList: true, subtree: true }),
  );
}
