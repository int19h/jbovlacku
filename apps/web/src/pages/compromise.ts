/**
 * Compromise notice: the holder chooses the last trusted causal frontier of
 * one key's own history. The preview names the retained and excluded records.
 * Missing history blocks a confident preview. An empty frontier disables all
 * old-key authority and needs explicit approval.
 */
import {
  el,
  p,
  text,
  button,
  link,
  field,
  describe,
  checkbox,
} from "../lib/dom.ts";
import { shortIdentity } from "../lib/format.ts";
import { navigate, type RenderContext, type Route } from "../app/router.ts";
import type { App } from "../app/context.ts";
import { unlockKey } from "../data/keys.ts";
import { loadOwnHistory, type OwnHistory } from "../data/history.ts";
import {
  causalOrder,
  cutoffPreview,
  LifecycleConflictError,
  outboxItem,
  queueCompromise,
  signWith,
} from "../data/lifecycle.ts";
import { configuredPeers } from "./handover.ts";
import type { KeyBackup } from "../data/store.ts";
import type { Envelope } from "../model/types.ts";

function describeEvent(envelope: Envelope): string {
  const action = envelope.header.action;
  switch (action.kind) {
    case "judgment.set":
      return `${action.value === "bless" ? "endorsement" : action.value === "curse" ? "opposition" : "cleared judgment"} on ${String(action.target).slice(0, 16)}…`;
    case "trust.set":
      return `${String(action.value)} ${shortIdentity(String(action.subject))}`;
    case "definition.publish":
      return "definition";
    case "rafsi.publish":
      return "rafsi claim";
    case "identity.profile":
      return "profile";
    case "identity.transfer":
      return `transfer to ${shortIdentity(String(action.successor))}`;
    case "identity.compromise":
      return "compromise notice";
    default:
      return String(action.kind);
  }
}
/** The format limit for the `safe` list of a compromise notice. */
const SAFE_LIMIT = 64;

export async function compromisePage(
  _route: Route,
  context: RenderContext,
  app: App,
) {
  const { main } = context;
  const { session } = app;
  context.title("Report a stolen key");
  main.className = "";
  main.append(el("h1", { class: "page", text: "Report a stolen key" }));
  if (!session.storageAvailable) {
    main.append(
      p(
        "Restore browser storage access and reload before signing a notice.",
        "notice",
      ),
    );
    return;
  }
  const candidates: KeyBackup[] = [];
  if (session.backup) candidates.push(session.backup);
  for (const retired of await session.retiredBackups())
    candidates.push(retired);
  if (!context.live()) return;
  if (!candidates.length) {
    main.append(
      p(
        "There is no key in this browser. A notice needs the key it is about. Restore its backup first.",
        "notice",
      ),
      link("Your key", "/identity", { class: "btn" }),
    );
    return;
  }
  main.append(
    el(
      "div",
      { class: "stack small", style: "margin:8px 0 16px" },
      p(
        "A compromise notice cuts off everything after a point you choose. Records up to that frontier keep their authority. Later records of this key stay visible but lose authority. The notice is terminal and cannot be cleared.",
      ),
      p(
        "The notice cannot prove which holder is legitimate. Another holder of the stolen key can publish another cutoff. This is not an abuse report about someone else's key.",
      ),
    ),
  );
  const keyField = field("Which key", {
    options: candidates.map((c) => ({
      value: c.identity,
      label: `${shortIdentity(c.identity)}${c.identity === session.backup?.identity ? " (selected)" : " (retired)"}`,
    })),
    value: candidates[0].identity,
  });
  main.append(keyField.wrapper);
  const historyBox = el("section", { "aria-labelledby": "h-history" });
  historyBox.append(
    el("h2", {
      id: "h-history",
      class: "section",
      text: "Choose the last trusted records",
    }),
  );
  const listBox = el("div", { "aria-live": "polite" });
  historyBox.append(listBox);
  main.append(historyBox);
  const previewBox = el("section", { "aria-labelledby": "h-preview" });
  previewBox.append(
    el("h2", { id: "h-preview", class: "section", text: "Preview" }),
  );
  const previewBody = el("div", {
    role: "region",
    "aria-label": "Cutoff preview",
    "aria-live": "polite",
  });
  previewBox.append(previewBody);
  main.append(previewBox);
  const actionBox = el("div", { class: "actions", style: "margin-top:16px" });
  main.append(actionBox);
  let history: OwnHistory | null = null;
  /** The heads stored in this browser when the preview was made. The write compares them again. */
  let storedHeads: string[] = [];
  let failure: string | null = null;
  const safe = new Set<string>();
  let approveEmpty = false;
  let acknowledge = false;
  const renderList = () => {
    listBox.replaceChildren();
    if (failure) {
      listBox.append(
        p(`The key's history could not be established: ${failure}`, "notice"),
      );
      return;
    }
    if (!history) {
      listBox.append(
        p(
          "Loading the key's own history from this browser and the server…",
          "small",
        ),
      );
      return;
    }
    if (!history.complete)
      listBox.append(
        p(
          "Part of this key's history is missing from this browser and the server. The preview cannot be confident. Missing records are shown as missing, not treated as safe. Connect to a server that holds the full history, or restore the exported outbox, before signing.",
          "notice",
        ),
      );
    const { order } = causalOrder(history);
    if (!order.length)
      listBox.append(
        p(
          "This key has no known records. An empty frontier is the only choice.",
          "small",
        ),
      );
    const ul = el("ul", {
      class: "small",
      style:
        "list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:6px",
      "aria-label": "Own records in causal order",
    });
    const boxes: HTMLInputElement[] = [];
    /** The format allows at most SAFE_LIMIT named records. Unchecked boxes close at the limit. */
    const applyLimit = () => {
      const full = safe.size >= SAFE_LIMIT;
      for (const box of boxes) {
        box.disabled = full && !box.checked;
        box.title = box.disabled
          ? `At most ${SAFE_LIMIT} records can be named. Clear one to name another.`
          : "";
      }
      limitLine.textContent = `${safe.size} of ${SAFE_LIMIT} records named.${full ? " The limit is reached. Everything a named record follows is retained too, so name the latest record of each branch." : ""}`;
    };
    const limitLine = el("p", { class: "meta", "aria-live": "polite" });
    for (const envelope of order) {
      const input = el("input", {
        type: "checkbox",
        id: `safe-${envelope.id.slice(5, 21)}`,
      });
      input.checked = safe.has(envelope.id);
      input.addEventListener("change", () => {
        if (input.checked && safe.size >= SAFE_LIMIT) {
          input.checked = false;
          return;
        }
        if (input.checked) safe.add(envelope.id);
        else safe.delete(envelope.id);
        applyLimit();
        renderPreview();
      });
      boxes.push(input);
      ul.append(
        el(
          "li",
          {},
          el(
            "label",
            { class: "check", for: input.id },
            input,
            text(` ${describeEvent(envelope)} `),
            text(envelope.id.slice(0, 20) + "…", "meta"),
          ),
        ),
      );
    }
    listBox.append(
      ul,
      limitLine,
      p(
        `Choose the last records you trust. Everything they follow is retained too. A notice names at most ${SAFE_LIMIT} records. Leave every box empty to disable all authority of this key.`,
        "meta",
      ),
    );
    applyLimit();
  };
  const renderPreview = () => {
    previewBody.replaceChildren();
    if (!history || failure) return;
    const preview = cutoffPreview(history, [...safe]);
    const nameOf = (id: string) =>
      `${describeEvent(history!.events.get(id)!)} (${id.slice(0, 16)}…)`;
    previewBody.append(
      p(
        `Retained: ${preview.retained.length === 0 ? "nothing" : preview.retained.map(nameOf).join("; ")}.`,
        "small",
      ),
    );
    previewBody.append(
      p(
        `Excluded: ${preview.excluded.length === 0 ? "nothing" : preview.excluded.map(nameOf).join("; ")}.`,
        "small",
      ),
    );
    if (!history.complete)
      previewBody.append(
        p("Missing records are not listed and are not retained.", "warn"),
      );
    if (safe.size === 0)
      previewBody.append(
        p(
          "An empty frontier disables all old-key authority, including every judgment, trust choice, and status action of this key.",
          "notice",
        ),
      );
    renderActions();
  };
  const renderActions = () => {
    actionBox.replaceChildren();
    if (!history || failure) return;
    const approvals = el("div", { class: "stack", style: "flex-basis:100%" });
    approvals.append(
      checkbox(
        "I understand that this notice cannot prove which holder is legitimate and cannot be cleared.",
        acknowledge,
        (v) => {
          acknowledge = v;
          renderActions();
        },
      ),
    );
    if (safe.size === 0)
      approvals.append(
        checkbox(
          "I approve disabling all authority of this key.",
          approveEmpty,
          (v) => {
            approveEmpty = v;
            renderActions();
          },
        ),
      );
    const sign = button("Sign the notice", () => void signNotice(), {
      class: "btn btn-warn",
    });
    sign.disabled =
      !acknowledge || (safe.size === 0 && !approveEmpty) || !history.complete;
    if (!history.complete)
      sign.title = "Missing history blocks a confident notice.";
    actionBox.append(
      approvals,
      el(
        "div",
        { class: "actions" },
        sign,
        link("Cancel", "/identity", { class: "btn btn-quiet" }),
      ),
    );
  };
  const load = async () => {
    history = null;
    failure = null;
    safe.clear();
    renderList();
    previewBody.replaceChildren();
    actionBox.replaceChildren();
    try {
      storedHeads = [
        ...((await app.store.get<string[]>("heads", keyField.input.value)) ??
          []),
      ].sort();
      history = await loadOwnHistory(app.store, keyField.input.value, {
        offline: app.offlineSigning.value,
        signal: context.signal,
      });
    } catch (error) {
      failure = describe(error);
    }
    if (!context.live()) return;
    renderList();
    renderPreview();
  };
  keyField.input.addEventListener("change", () => void load());
  let signing = false;
  /** Opens a retired key through a masked passphrase field. Never a visible prompt. */
  const unlockRetired = (backup: KeyBackup): Promise<CryptoKey | null> =>
    new Promise((resolve) => {
      const opener = document.activeElement as HTMLElement | null;
      const dialog = el("dialog", {
        class: "sheet",
        "aria-labelledby": "retired-unlock-title",
      });
      const pass = field("Passphrase of the retired key", {
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
      let key: CryptoKey | null = null;
      form.append(
        el("h2", {
          id: "retired-unlock-title",
          text: `Unlock the retired key ${shortIdentity(backup.identity)}`,
        }),
        p(
          "The notice needs that key's signature. The passphrase stays in this dialog and is not stored.",
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
          key = await unlockKey(backup, pass.input.value);
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
        pass.input.value = "";
        resolve(dialog.returnValue === "unlocked" ? key : null);
        dialog.remove();
        opener?.focus();
      });
      dialog.append(form);
      document.body.append(dialog);
      dialog.showModal();
      pass.input.focus();
    });
  const signNotice = async () => {
    if (!history || signing) return;
    signing = true;
    const buttons = actionBox.querySelectorAll("button");
    for (const b of buttons) b.disabled = true;
    try {
      const identity = keyField.input.value;
      const backup = candidates.find((c) => c.identity === identity)!;
      let key: CryptoKey | undefined;
      if (session.backup?.identity === identity && session.unlocked)
        key = session.workingKey;
      if (!key) key = (await unlockRetired(backup)) ?? undefined;
      if (!key) return;
      const frontier = history.frontier;
      const { recipients } = configuredPeers(app);
      const transport = await signWith(key, identity, frontier, {
        kind: "identity.compromise",
        safe: [...safe].sort(),
      });
      await queueCompromise(
        app.store,
        outboxItem(transport, crypto.randomUUID(), 0, recipients),
        storedHeads,
      );
      app.own.invalidate();
      await app.delivery.invalidate();
      void app.delivery.deliver(transport.envelope.id, true);
      navigate("/identity");
      app.announce(
        "The compromise notice is saved and uploading. Ordinary actions from this key are disabled.",
      );
    } catch (error) {
      app.announce(describe(error));
      if (error instanceof LifecycleConflictError) await load();
    } finally {
      signing = false;
      renderActions();
    }
  };
  await load();
}
