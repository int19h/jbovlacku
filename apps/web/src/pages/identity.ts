/** Your key: the local identity, backup test, lock state, and key lifecycle entry points. */
import {
  el,
  p,
  link,
  text,
  button,
  field,
  describe,
  icon,
  switchControl,
  download,
  disclosure,
  checkbox,
} from "../lib/dom.ts";
import { fingerprintText, shortIdentity } from "../lib/format.ts";
import {
  navigate,
  routes,
  type RenderContext,
  type Route,
} from "../app/router.ts";
import type { App } from "../app/context.ts";
import { renderExisting } from "./handover.ts";
import type { HandoverRecord } from "../data/lifecycle.ts";
import { identityProfile, profileName } from "../components/attribution.ts";

export async function identityPage(
  route: Route,
  context: RenderContext,
  app: App,
) {
  const { main } = context;
  const { session } = app;
  context.title("Your key");
  main.className = "";
  if (!session.storageAvailable) {
    main.append(
      el("h1", { class: "page", text: "Browser storage unavailable" }),
      p(
        "Restore browser storage access and reload before using keys, drafts, or delivery.",
        "notice",
      ),
    );
    return;
  }
  let unsubscribePage = () => {};
  const rerender = () => {
    unsubscribePage();
    if (!context.live()) return;
    main.replaceChildren();
    void identityPage(route, context, app);
  };
  if (!session.backup) {
    renderCreate(main, app, rerender);
    return;
  }
  const backup = session.backup;
  const head = el("div", { class: "word-head" });
  // The display name is the server's effective profile claim for this key.
  const name = profileName(await identityProfile(backup.identity));
  if (!context.live()) return;
  head.append(
    el(
      "h1",
      { style: "font-size:32px;letter-spacing:-0.02em;font-weight:680" },
      el("bdi", { text: name ?? shortIdentity(backup.identity) }),
    ),
    link("public page", routes.identity(backup.identity), { class: "small" }),
    link("Edit public profile", `${routes.identity(backup.identity)}#edit`, {
      class: "btn btn-quiet",
      style: "margin-left:auto;font-size:14px",
    }),
  );
  main.append(
    head,
    el("p", {
      class: "fingerprint",
      style: "margin-top:4px",
      text: fingerprintText(backup.identity),
    }),
  );
  if (session.pending) {
    const resume = el("div", { class: "notice", style: "margin-top:16px" });
    resume.append(
      text(`${session.pending.description} is waiting for your key. `),
    );
    if (session.unlocked)
      resume.append(
        button(
          "Continue",
          async () => {
            try {
              await session.resumePending();
            } catch (error) {
              app.announce(describe(error));
            }
            rerender();
          },
          { class: "btn btn-primary" },
        ),
      );
    else resume.append(text("Unlock below to continue."));
    main.append(resume);
  }
  // Lifecycle state: a handover that produced or retired this key, and retired keys kept here.
  const handoverOf = await app.store.get<HandoverRecord>(
    "keys",
    `handover-of:${backup.identity}`,
  );
  const handoverFrom = await app.store.get<HandoverRecord>(
    "keys",
    `handover:${backup.identity}`,
  );
  const disabled = await session.signingDisabled(backup.identity);
  const retiredKeys = await session.retiredBackups();
  if (!context.live()) return;
  if (disabled) main.append(p(disabled, "notice"));
  if (handoverOf) renderExisting(main, app, handoverOf);
  else if (handoverFrom) renderExisting(main, app, handoverFrom);
  for (const retired of retiredKeys)
    main.append(
      el(
        "p",
        { class: "small" },
        text(
          `Retired key ${shortIdentity(retired.identity)} stays in this browser for archive access and compromise notices. Ordinary actions from it are disabled. `,
        ),
        link("Report it stolen", "/identity/compromise"),
      ),
    );
  const tested = await session.backupTested();
  if (!context.live()) return;
  if (!tested) {
    const banner = el("div", {
      class: "notice",
      style:
        "margin-top:20px;display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px",
      role: "region",
      "aria-label": "Backup test",
    });
    banner.append(
      el(
        "p",
        { style: "flex:1 1 260px" },
        el("strong", { text: "Test your backup." }),
        text(
          " If you lose this key, nobody can restore it. Open the backup file once to be sure that it unlocks this identity.",
        ),
      ),
      button("Test the backup", () => (testForm.hidden = false), {
        class: "btn btn-primary",
      }),
      button(
        "Download again",
        () =>
          download(
            `jbovlacku-key-backup-${backup.identity.slice(8, 16)}.json`,
            JSON.stringify(backup, null, 2),
          ),
        { class: "btn btn-quiet", style: "color:var(--warn)" },
      ),
    );
    main.append(banner);
    const testForm = backupTestForm(app, rerender);
    testForm.hidden = true;
    main.append(testForm);
  } else
    main.append(
      p(
        "Your backup test passed in this browser. This does not prove that you still keep a durable copy.",
        "meta",
      ),
    );
  const rows = el("div", { style: "margin-top:24px" });
  // Lock state.
  const lockRow = el("div", { class: "row" });
  const renderLock = () => {
    lockRow.replaceChildren();
    lockRow.append(
      icon(session.unlocked ? "unlock" : "lock", "", 20),
      el(
        "span",
        { class: "t" },
        el("span", {
          class: "lock-state",
          text: session.unlocked ? "Unlocked" : "Locked",
        }),
        el("small", {
          text: session.unlocked
            ? session.keepUnlocked
              ? "Stays unlocked until you lock it or close the tab."
              : "Locks after 15 minutes without a signing action, or when you close the tab."
            : "Unlock with your passphrase to sign.",
        }),
      ),
    );
    if (session.unlocked)
      lockRow.append(
        button(
          "Lock",
          () => {
            session.lock();
          },
          { class: "btn" },
        ),
      );
    else {
      const form = el("form", {
        style: "display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end",
      });
      const pass = field("Passphrase", {
        type: "password",
        autocomplete: "current-password",
        required: true,
        wrapperClass: "",
      });
      pass.wrapper.style.flex = "1 1 200px";
      const submit = el("button", {
        type: "submit",
        class: "btn",
        text: "Unlock",
      });
      form.append(pass.wrapper, submit);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        submit.disabled = true;
        try {
          await session.unlock(pass.input.value);
          pass.input.value = "";
          app.announce("Your key is unlocked for this session.");
          if (session.pending) {
            try {
              await session.resumePending();
            } catch (error) {
              app.announce(describe(error));
            }
          }
        } catch (error) {
          app.announce(describe(error));
          submit.disabled = false;
        }
      });
      lockRow.append(form);
    }
  };
  renderLock();
  let shownLock = `${session.unlocked}|${session.keepUnlocked}`;
  const unsubscribeLock = (unsubscribePage = session.subscribe(() => {
    const next = `${session.unlocked}|${session.keepUnlocked}`;
    if (!context.live() || next === shownLock) return;
    shownLock = next;
    renderLock();
    stayUnlocked.setAttribute("aria-checked", String(session.keepUnlocked));
    stayUnlocked.querySelector(".state")!.textContent = session.keepUnlocked
      ? "On"
      : "Off";
  }));
  context.signal.addEventListener("abort", unsubscribeLock, { once: true });
  const stayUnlocked = switchControl(
    "Stay unlocked this session",
    session.keepUnlocked,
    async (value) => {
      await session.setKeepUnlocked(value);
    },
  );
  rows.append(lockRow);
  rows.append(
    el(
      "div",
      { class: "row" },
      el(
        "span",
        { class: "t", style: "padding-left:36px" },
        text("Stay unlocked this session"),
      ),
      stayUnlocked,
    ),
  );
  rows.append(
    el(
      "div",
      { class: "row" },
      el(
        "span",
        { class: "t", style: "padding-left:36px" },
        text("Lensisku account"),
        el("small", {
          text: "Not linked. Linking lets you manage definitions imported from your account. This server has no account witness service, so linking is unavailable here.",
        }),
      ),
      el("span", { class: "meta", text: "Unavailable" }),
    ),
  );
  const importRow = el("div", { class: "row" });
  importRow.append(
    el(
      "span",
      { class: "t", style: "padding-left:36px" },
      text("Other key"),
      el("small", {
        text: "Open a backup from another device. Importing a different key is refused while this one is selected.",
      }),
    ),
    button(
      "Import",
      () => {
        importForm.hidden = !importForm.hidden;
      },
      { class: "btn" },
    ),
  );
  rows.append(importRow);
  const importForm = importBackupForm(app, rerender, "restore");
  importForm.hidden = true;
  rows.append(importForm);
  rows.append(
    el(
      "div",
      { class: "row" },
      el(
        "span",
        { class: "t", style: "padding-left:36px" },
        text("Move to a new key"),
        el("small", {
          text: "The old key signs the handover and then retires.",
        }),
      ),
      disabled || handoverFrom
        ? el("span", { class: "meta", text: "Unavailable for this key" })
        : link("Start", "/identity/transfer", {
            class: "btn",
          }),
    ),
    el(
      "div",
      { class: "row", style: "border-bottom:1px solid var(--line)" },
      el(
        "span",
        { class: "t", style: "padding-left:36px" },
        text("Key stolen?"),
        el("small", {
          text: "Publish a notice that cuts off everything after a point you choose.",
        }),
      ),
      link("Report", "/identity/compromise", {
        class: "btn btn-warn",
      }),
    ),
  );
  main.append(rows);
  main.append(
    el(
      "div",
      { class: "actions", style: "margin-top:16px" },
      button(
        "Download the encrypted backup",
        () =>
          download(
            `jbovlacku-key-backup-${backup.identity.slice(8, 16)}.json`,
            JSON.stringify(backup, null, 2),
          ),
        { class: "btn" },
      ),
    ),
    p(
      "A key backup contains no drafts or undelivered records. Export those from Settings and Not delivered.",
      "meta",
    ),
  );
  const offline = checkbox(
    "Sign from history saved in this browser only",
    app.offlineSigning.value,
    (value) => {
      app.offlineSigning.value = value;
    },
  );
  main.append(
    disclosure("Offline signing", () => [
      offline,
      p(
        "This option works without a connection. Other devices can have newer branches. A restored key has no saved event history.",
        "meta",
      ),
    ]),
  );
  main.append(
    p(
      "This site supplies the code that uses your key. A compromised site can misuse it. Nothing here can reset or recover a key for you.",
      "meta",
    ),
  );
  if (!session.preferences.firstSignatureAcknowledged)
    main.append(
      p(
        "Judgments and public trust choices are signed public records. Undo adds a record. It does not erase the earlier public record.",
        "meta",
      ),
    );
}
function renderCreate(main: HTMLElement, app: App, rerender: () => void) {
  const { session } = app;
  main.append(
    el("h1", { class: "page", text: "Your key" }),
    p(
      "A key is one Ed25519 pair that this browser creates. The private key signs your publications and judgments. It never leaves this browser unencrypted.",
      "small",
    ),
  );
  if (session.pending)
    main.append(
      p(
        `${session.pending.description} will continue after you create or import a key.`,
        "notice",
      ),
    );
  main.append(
    p(
      "Lost your key? Import its backup below, or create a new identity. Nothing can recover a key without its backup, and no successor exists unless the old key signed a handover. Contacts can trust the new identity. That does not rewrite old signatures or hide the loss.",
      "small",
    ),
  );
  if (!isSecureContext)
    main.append(
      p(
        "Key creation needs localhost or HTTPS. This address supports reading only.",
        "notice",
      ),
    );
  const form = el("form", {
    class: "card",
    style: "margin-top:16px",
    "aria-label": "Create a key",
  });
  form.append(
    el("h2", { class: "section", style: "margin-top:0", text: "Create a key" }),
  );
  const pass = field("New passphrase", {
    type: "password",
    autocomplete: "new-password",
    required: true,
    hint: "The passphrase encrypts the backup. Nobody can reset it.",
  });
  const repeat = field("Repeat passphrase", {
    type: "password",
    autocomplete: "new-password",
    required: true,
  });
  const reveal = button(
    "Reveal passphrases",
    () => {
      const type = pass.input.type === "password" ? "text" : "password";
      pass.input.type = type;
      repeat.input.type = type;
      reveal.textContent =
        type === "password" ? "Reveal passphrases" : "Hide passphrases";
    },
    { class: "btn btn-quiet" },
  );
  const submit = el("button", {
    type: "submit",
    class: "btn btn-primary",
    text: "Create a key",
  });
  submit.disabled = !isSecureContext;
  form.append(
    pass.wrapper,
    repeat.wrapper,
    el("div", { class: "actions" }, submit, reveal),
  );
  form.append(
    el(
      "div",
      { class: "stack small", style: "margin-top:14px" },
      p("Keep a backup. Losing this key can make this identity unusable."),
      p(
        "This website supplies the code that uses your key. A compromised website can misuse it.",
      ),
      p("After creation, download the encrypted backup and test it once."),
    ),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (pass.input.value !== repeat.input.value) {
      app.announce("The passphrases do not match.");
      return;
    }
    submit.disabled = true;
    try {
      const created = await session.create(pass.input.value);
      pass.input.value = repeat.input.value = "";
      download(
        `jbovlacku-key-backup-${created.identity.slice(8, 16)}.json`,
        JSON.stringify(created, null, 2),
      );
      app.announce(
        "Your key is created and unlocked. The encrypted backup download started. Test it below.",
      );
      if (session.pending) {
        try {
          await session.resumePending();
        } catch (error) {
          app.announce(describe(error));
        }
      }
      rerender();
    } catch (error) {
      app.announce(describe(error));
      submit.disabled = false;
      if (session.backup) rerender();
    }
  });
  main.append(form);
  const importForm = importBackupForm(app, rerender, "restore");
  main.append(importForm);
}
function importBackupForm(
  app: App,
  rerender: () => void,
  mode: "restore",
): HTMLFormElement {
  const form = el("form", {
    class: "card",
    style: "margin-top:16px",
    "aria-label": "Import an encrypted backup",
  });
  form.append(
    el("h2", {
      class: "section",
      style: "margin-top:0",
      text: "Import an encrypted backup",
    }),
  );
  if (app.session.backup)
    form.append(
      p(
        "Only a backup of the identity selected in this browser can be opened here. Another identity is refused.",
        "meta",
      ),
    );
  form.append(
    p(
      "Importing a key into another web origin changes who supplies its signer code. Only import keys on origins you trust.",
      "meta",
    ),
  );
  const file = field("Backup file", { type: "file", required: true });
  file.input.accept = ".json,application/json";
  const pass = field("Backup passphrase", {
    type: "password",
    autocomplete: "current-password",
    required: true,
  });
  const reveal = button(
    "Reveal passphrase",
    () => {
      pass.input.type = pass.input.type === "password" ? "text" : "password";
    },
    { class: "btn btn-quiet" },
  );
  const submit = el("button", {
    type: "submit",
    class: "btn",
    text: "Open backup locally",
  });
  form.append(
    file.wrapper,
    pass.wrapper,
    el("div", { class: "actions" }, submit, reveal),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const selected = file.input.files?.[0];
    if (!selected) {
      app.announce("Select a backup file.");
      return;
    }
    submit.disabled = true;
    try {
      await app.session.importBackup(selected, pass.input.value);
      pass.input.value = "";
      app.announce("The backup opened locally. Keep the file in a safe place.");
      if (app.session.pending) {
        try {
          await app.session.resumePending();
        } catch (error) {
          app.announce(describe(error));
        }
      }
      rerender();
    } catch (error) {
      app.announce(describe(error));
      submit.disabled = false;
      if (app.session.backup) rerender();
    }
  });
  void mode;
  return form;
}
function backupTestForm(app: App, rerender: () => void): HTMLFormElement {
  const form = el("form", {
    class: "card",
    style: "margin-top:12px",
    "aria-label": "Test the backup",
  });
  form.append(
    el("h2", {
      class: "section",
      style: "margin-top:0",
      text: "Test the backup",
    }),
    p(
      "Select the downloaded file and enter its passphrase. The test decrypts the file here and compares the recovered identity. Nothing leaves the browser.",
      "small",
    ),
  );
  const file = field("Backup file", { type: "file", required: true });
  file.input.accept = ".json,application/json";
  const pass = field("Backup passphrase", {
    type: "password",
    autocomplete: "current-password",
    required: true,
  });
  const submit = el("button", {
    type: "submit",
    class: "btn btn-primary",
    text: "Run the test",
  });
  const skip = button(
    "Skip for now",
    () => {
      app.announce(
        "Without a tested backup, losing this browser's storage loses the key. The reminder stays until a test passes.",
      );
      form.hidden = true;
    },
    { class: "btn btn-quiet" },
  );
  form.append(
    file.wrapper,
    pass.wrapper,
    el("div", { class: "actions" }, submit, skip),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const selected = file.input.files?.[0];
    if (!selected) {
      app.announce("Select a backup file.");
      return;
    }
    submit.disabled = true;
    try {
      await app.session.testBackup(selected, pass.input.value);
      pass.input.value = "";
      app.announce("The backup unlocked and matches this identity.");
      rerender();
    } catch (error) {
      app.announce(describe(error));
      submit.disabled = false;
    }
  });
  return form;
}
void navigate;
