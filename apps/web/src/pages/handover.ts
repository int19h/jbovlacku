/**
 * Planned handover: a fresh successor key, its backup and backup test, the
 * old key's heads from every configured peer, a preview of the consequences,
 * approval of the successor fingerprint, and both signatures persisted in one
 * transaction before upload. Retries use the stored events.
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
import { loadOwnHistory } from "../data/history.ts";
import {
  askPeers,
  outboxItem,
  queueHandover,
  signWith,
  type HandoverRecord,
  type PeerKnowledge,
} from "../data/lifecycle.ts";
import { savedPeer } from "../data/delivery.ts";
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
  const retiredElsewhere = await app.store.get<HandoverRecord>(
    "keys",
    `handover-of:${old.identity}`,
  );
  if (!context.live()) return;
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
        "Conflicting transfers suspend automatic continuity. Old-key actions that this browser and the configured peers have not seen lose ordinary authority after the transfer. There is no grace period and no undo.",
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
  const historyBox = el("div", { "aria-live": "polite" });
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
  let knowledge: PeerKnowledge[] = [];
  let heads: string[] = [];
  let historyComplete = false;
  let historyFailure: string | null = null;
  let existingTransfer: { id: string; successor: string; peer: string } | null =
    null;
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
  const renderHistory = () => {
    historyBox.replaceChildren();
    if (historyFailure) {
      historyBox.append(
        p(
          `This browser could not establish the old key's history: ${historyFailure}`,
          "notice",
        ),
      );
      return;
    }
    historyBox.append(
      p(
        `${heads.length === 1 ? "One known head" : `${heads.length} known heads`}${historyComplete ? "" : ", with missing predecessors"}. The transfer follows every known head, so all of this work keeps its authority.`,
        "small",
      ),
    );
    if (heads.length > 1)
      historyBox.append(
        p(
          "More than one head means separate device branches. Both are included. Opposite judgments in different branches stay conflicted until a later event resolves them.",
          "small",
        ),
      );
    const list = el("ul", { class: "small" });
    for (const k of knowledge) {
      const item = el("li");
      if (k.status !== "answered") {
        item.append(
          text(
            `${k.peer.label}: did not answer (${k.status}). Its unseen old-key actions, if any, lose ordinary authority after the transfer.`,
          ),
        );
      } else {
        const unseen = k.heads.filter((h) => !heads.includes(h));
        item.append(
          text(
            `${k.peer.label}: ${k.heads.length === 0 ? "no own events" : `${k.heads.length === 1 ? "one head" : `${k.heads.length} heads`}`}${unseen.length ? `, ${unseen.length} not known to this browser` : ""}.`,
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
      }
      list.append(item);
    }
    historyBox.append(list);
    if (existingTransfer)
      historyBox.append(
        p(
          `A transfer by this key already exists on ${existingTransfer.peer} (${existingTransfer.id.slice(0, 20)}…, to ${shortIdentity(existingTransfer.successor)}). A second transfer would freeze continuity. This page offers no new transfer. If you hold that successor key, restore it in this browser and search for its acceptance.`,
          "notice",
        ),
      );
  };
  const acknowledgments = { fingerprint: false, retire: false, unseen: false };
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
    if (historyFailure || existingTransfer) {
      approveBox.append(
        p(
          "The old key's history or an existing transfer blocks the handover. See above.",
          "meta",
        ),
      );
      return;
    }
    const unanswered = knowledge.filter((k) => k.status !== "answered");
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
        `I understand that old-key actions unseen by this browser${unanswered.length ? ` and by ${unanswered.map((k) => k.peer.label).join(", ")}` : ""} lose ordinary authority, and that a conflicting transfer suspends continuity.`,
        acknowledgments.unseen,
        (v) => {
          acknowledgments.unseen = v;
          refresh();
        },
      ),
    );
    const sign = button("Sign the handover", () => void signHandover(), {
      class: "btn btn-primary",
      style: "margin-top:12px",
    });
    sign.disabled = true;
    const refresh = () => {
      sign.disabled = !(
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
        "Both events are saved in this browser together with the new key before anything is sent. Upload can be partial. The key page then shows “Old key retired, acceptance waiting” until both events arrive.",
        "meta",
      ),
    );
  };
  const signHandover = async () => {
    if (!successor || !successorTested) return;
    await session.requireUnlocked("The handover", async () => {
      const oldKey = session.workingKey!;
      if (session.backup?.identity !== old.identity)
        throw new Error("The selected key changed. Reload and start again.");
      const { recipients } = configuredPeers(app);
      const transfer = await signWith(oldKey, old.identity, heads, {
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
  };
  renderKey();
  renderApprove();
  historyBox.append(
    p(
      "Searching this browser and every configured peer for the old key's heads and lifecycle events…",
      "small",
    ),
  );
  try {
    const history = await loadOwnHistory(app.store, old.identity, {
      offline: app.offlineSigning.value,
      signal: context.signal,
    });
    heads = history.frontier;
    historyComplete = history.complete;
    for (const envelope of history.events.values()) {
      if (envelope.header.action.kind === "identity.transfer")
        existingTransfer = {
          id: envelope.id,
          successor: String(envelope.header.action.successor),
          peer: "this browser",
        };
    }
    const { peers } = configuredPeers(app);
    knowledge = await askPeers(peers, old.identity, null, context.signal);
    if (!context.live()) return;
    for (const k of knowledge) {
      for (const t of k.transfers)
        existingTransfer ??= {
          id: t.id,
          successor: t.successor,
          peer: k.peer.label,
        };
      // Include peer heads that this browser did not know. Their envelopes were verified by the history loader for the default peer only.
      for (const head of k.heads)
        if (!heads.includes(head) && history.events.has(head)) heads.push(head);
    }
    heads.sort();
  } catch (error) {
    historyFailure = describe(error);
  }
  if (!context.live()) return;
  renderHistory();
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
          link("Not delivered", "/outbox"),
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
