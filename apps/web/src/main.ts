import "./style.css";
import {
  initializeCore,
  prepareSigning,
  finishSigning,
  wordId,
  canonicalize,
  utf8,
  inspectBody,
} from "../../../packages/core/src/index.ts";
import {
  LocalStore,
  IdentityConflictError,
  type Draft,
  type KeyBackup,
  type OutboxItem,
} from "./storage.ts";
import { createKey, parseBackup, unlockKey } from "./keys.ts";
import {
  api,
  getEnvelope,
  getBody,
  ownHeads,
  sendItem,
  downloadPackage,
  type PackageEntry,
  validateCachedPackage,
} from "./api.ts";
import { el, link, button, richText, download, visibleJson } from "./render.ts";
const store = new LocalStore();
let storageAvailable = true;
let workingKey: CryptoKey | undefined;
let backup: KeyBackup | undefined;
let lockTimer: ReturnType<typeof setTimeout> | undefined;
let keepUnlocked = false;
let revision = 0;
let busy = false;
let offlineSigning = false;
const root = document.querySelector<HTMLDivElement>("#app")!;
const header = el("header");
const brand = link("jbovlacku", "/");
brand.className = "brand";
const nav = el("nav");
nav.setAttribute("aria-label", "Main navigation");
nav.append(
  link("Search", "/search"),
  link("Add", "/new"),
  link("Identity", "/identity"),
  link("Outbox", "/outbox"),
);
header.append(brand, nav);
const main = el("main");
main.id = "main";
const notice = el(
  "p",
  "Local prototype. Contributions here use disposable test identities.",
  "prototype",
);
const status = el("p", "", "notice");
status.setAttribute("role", "status");
status.setAttribute("aria-live", "polite");
const storageWarning = el(
  "p",
  "Browser storage is unavailable. You can read online. Drafts, keys, signing, and downloaded search are disabled. Restore storage access and reload this page.",
  "warning",
);
storageWarning.setAttribute("role", "alert");
storageWarning.hidden = true;
root.append(header, notice, storageWarning, status, main);
function report(error: unknown) {
  status.textContent = error instanceof Error ? error.message : String(error);
}
function run(action: () => Promise<void>) {
  return async () => {
    if (busy) return;
    busy = true;
    try {
      await action();
    } catch (error) {
      report(error);
    } finally {
      busy = false;
    }
  };
}
function navigate(href: string) {
  history.pushState(null, "", href);
  void render(true);
}
document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const anchor = target.closest<HTMLAnchorElement>("a");
  if (
    !anchor ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    anchor.download ||
    anchor.target
  )
    return;
  const url = new URL(anchor.href);
  if (url.origin !== location.origin || url.hash) return;
  event.preventDefault();
  navigate(url.pathname + url.search);
});
window.addEventListener("popstate", () => void render(true));
function lock() {
  workingKey = undefined;
  clearTimeout(lockTimer);
  status.textContent = "The signing key is locked.";
  if (location.pathname === "/identity") void render();
}
function touch() {
  clearTimeout(lockTimer);
  if (!keepUnlocked) lockTimer = setTimeout(lock, 15 * 60 * 1000);
}
window.addEventListener("pagehide", () => {
  workingKey = undefined;
});
function field(
  form: HTMLElement,
  label: string,
  name: string,
  value?: string,
  multiline?: false,
): HTMLInputElement;
function field(
  form: HTMLElement,
  label: string,
  name: string,
  value: string,
  multiline: true,
): HTMLTextAreaElement;
function field(
  form: HTMLElement,
  label: string,
  name: string,
  value: string,
  multiline: boolean,
): HTMLInputElement | HTMLTextAreaElement;
function field(
  form: HTMLElement,
  label: string,
  name: string,
  value = "",
  multiline = false,
): HTMLInputElement | HTMLTextAreaElement {
  const wrapper = el("label", label);
  const input = multiline ? el("textarea") : el("input");
  input.name = name;
  input.value = value;
  wrapper.append(input);
  form.append(wrapper);
  return input;
}
function fingerprint(identity: string): HTMLElement {
  const value = el("bdi", identity, "fingerprint");
  value.dir = "ltr";
  return value;
}
function heading(title: string, description?: string) {
  const titleNode = el("h1", title);
  titleNode.tabIndex = -1;
  main.replaceChildren(titleNode);
  document.title = `${title} · jbovlacku`;
  if (description) main.append(el("p", description));
}
async function queue(action: Record<string, unknown>, body: unknown) {
  if (!storageAvailable)
    throw new Error(
      "Restore browser storage access and reload before signing.",
    );
  if (!backup || !workingKey)
    throw new Error("Unlock your identity before signing.");
  const signingIdentity = backup.identity;
  const previous = await ownHeads(store, signingIdentity, offlineSigning);
  if (!workingKey || backup?.identity !== signingIdentity)
    throw new Error("Unlock this identity again before signing.");
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
  const signingKey = workingKey;
  const prepared = prepareSigning(
    signingIdentity,
    previous,
    nonce,
    action,
    body,
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      signingKey,
      prepared.signing_bytes as BufferSource,
    ),
  );
  if (workingKey !== signingKey)
    throw new Error(
      "The key was locked before the signed event was saved. Sign the draft again.",
    );
  const result = finishSigning(prepared, signature);
  const transport = canonicalize(
    utf8(JSON.stringify({ envelope: result.envelope, body: result.body })),
  );
  await store.queue({
    id: result.envelope.id,
    identity: backup.identity,
    transport,
    state: "ready",
  });
  touch();
  navigate("/outbox");
  status.textContent =
    "Ready to send. The signed event is saved in this browser.";
}
function warnings() {
  const box = el("div", undefined, "warning");
  box.append(
    el("p", "Keep a backup."),
    el(
      "p",
      "If you lose every copy of this key, nobody can recover this identity.",
    ),
    el(
      "p",
      "This website supplies the code that uses your key. A compromised website can misuse it.",
    ),
  );
  return box;
}
function signingMode() {
  const box = el("div");
  const label = el("label", "Sign from history saved in this browser only");
  const input = el("input");
  input.type = "checkbox";
  input.checked = offlineSigning;
  input.disabled = !storageAvailable;
  input.onchange = () => {
    offlineSigning = input.checked;
  };
  label.append(input);
  box.append(
    label,
    el(
      "p",
      "This option works offline. Other devices can have newer branches. A restored key has no saved event history.",
      "muted",
    ),
  );
  return box;
}
async function installIdentity(
  candidate: KeyBackup,
  mode: "create" | "restore",
) {
  try {
    await store.installIdentity(candidate, mode);
  } catch (error) {
    if (error instanceof IdentityConflictError) {
      backup = await store.get<KeyBackup>("keys", "selected");
      workingKey = undefined;
      clearTimeout(lockTimer);
      await render();
    }
    throw error;
  }
}
async function identityPage(current: number) {
  heading(
    "Your identity",
    "The browser keeps your encrypted key. The private key and passphrase stay on this device.",
  );
  main.append(warnings());
  if (backup) {
    main.append(
      fingerprint(backup.identity),
      el("p", workingKey ? "Unlocked for this session." : "Locked."),
    );
    const saved = await store.get<boolean>("keys", `tested:${backup.identity}`);
    if (current !== revision) return;
    if (!saved)
      main.append(
        el(
          "p",
          "Export your backup and reopen it below to test recovery.",
          "warning",
        ),
      );
    main.append(
      button("Export encrypted key backup", () =>
        download("jbovlacku-key-backup.json", JSON.stringify(backup, null, 2)),
      ),
    );
    if (workingKey) {
      main.append(button("Lock", lock));
      const label = el("label", "Keep unlocked for this session");
      const input = el("input");
      input.type = "checkbox";
      input.checked = keepUnlocked;
      input.onchange = () => {
        keepUnlocked = input.checked;
        touch();
      };
      label.append(input);
      main.append(label);
    } else {
      const form = el("form");
      const pass = field(form, "Passphrase", "passphrase");
      pass.type = "password";
      pass.autocomplete = "current-password";
      const submit = el("button", "Unlock");
      form.append(submit);
      form.onsubmit = (event) => {
        event.preventDefault();
        void run(async () => {
          workingKey = await unlockKey(backup!, pass.value);
          pass.value = "";
          touch();
          await render();
        })();
      };
      main.append(form);
    }
  } else {
    const form = el("form");
    const pass = field(form, "New passphrase", "passphrase");
    pass.type = "password";
    pass.autocomplete = "new-password";
    pass.required = true;
    const repeat = field(form, "Repeat passphrase", "repeat");
    repeat.type = "password";
    repeat.autocomplete = "new-password";
    repeat.required = true;
    form.append(
      button("Reveal passphrases", () => {
        const type = pass.type === "password" ? "text" : "password";
        pass.type = type;
        repeat.type = type;
      }),
      el("button", "Create a disposable identity"),
    );
    form.onsubmit = (event) => {
      event.preventDefault();
      void run(async () => {
        if (pass.value !== repeat.value)
          throw new Error("The passphrases do not match.");
        const created = await createKey(pass.value);
        await installIdentity(created.backup, "create");
        backup = created.backup;
        workingKey = created.key;
        pass.value = "";
        repeat.value = "";
        touch();
        await render();
      })();
    };
    main.append(form);
  }
  const restore = el("form");
  restore.append(
    el("h2", backup ? "Test or import a backup" : "Import an encrypted backup"),
  );
  const file = field(restore, "Backup file", "backup-file");
  file.type = "file";
  file.accept = ".json,application/json";
  file.required = true;
  const pass = field(restore, "Backup passphrase", "backup-passphrase");
  pass.type = "password";
  pass.autocomplete = "current-password";
  pass.required = true;
  restore.append(
    button("Reveal passphrase", () => {
      pass.type = pass.type === "password" ? "text" : "password";
    }),
    el("button", "Open backup locally"),
  );
  restore.onsubmit = (event) => {
    event.preventDefault();
    void run(async () => {
      const selected = file.files?.[0];
      if (!selected) throw new Error("Select a backup file.");
      if (selected.size > 16384) throw new Error("The backup exceeds 16 KiB.");
      const imported = parseBackup(await selected.text());
      const opened = await unlockKey(imported, pass.value);
      await installIdentity(imported, "restore");
      workingKey = opened;
      backup = imported;
      pass.value = "";
      touch();
      await render();
      status.textContent =
        "The backup opened locally. Keep the file in a safe place.";
    })();
  };
  main.append(restore);
  main.append(
    el(
      "p",
      "A key backup contains no drafts or signed outbox events. Export those separately.",
    ),
  );
}
function draftBody(draft: Draft, structured: boolean) {
  const descriptions = draft.places
    .split("\n")
    .filter((line) => line.trim() !== "");
  const places = descriptions.map((description, index) => ({
    index: index + 1,
    glosses: [],
    description: [[description]],
    type_hints: [],
    defaults: [],
    constraints: [],
    derivation: [],
  }));
  const text = draft.text
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((paragraph) => {
      if (!structured) return [paragraph];
      const nodes: (string | number)[] = [];
      for (const fragment of paragraph.split(/([①-⑳])/u)) {
        if (!fragment) continue;
        const n = fragment.codePointAt(0)! - 0x245f;
        if (fragment.length === 1 && n >= 1 && n <= 20) {
          if (n > places.length)
            throw new Error(`Declare place ${n} before using its marker.`);
          nodes.push(n);
        } else nodes.push(fragment);
      }
      return nodes;
    });
  return {
    word: { language: "jbo" as const, spelling: draft.word.normalize("NFC") },
    language: draft.language,
    text,
    frame: places.length
      ? {
          role: "predicate",
          arity: { mode: "fixed", count: places.length },
          places,
          tail: null,
          constraints: [],
        }
      : null,
    operands: [],
    glosses: draft.gloss
      ? [{ language: draft.language, text: draft.gloss, sense: null }]
      : [],
    notes: draft.notes ? [[draft.notes]] : [],
    etymology: { text: [], formation: null, compound: null },
    examples: [],
    classification: { kind: draft.kind, selmaho: [] },
    labels: [],
    sources: [],
    license: {
      expression: draft.license,
      url: null,
      attribution: draft.attribution,
    },
    legacy: null,
  };
}
async function draftPage(current: number) {
  heading(
    "Add a definition",
    "Drafts stay in this browser. Signing saves an event in the outbox. Sending publishes it to this local test server.",
  );
  const draft = (await store.get<Draft>("drafts", "current").catch((error) => {
    report(error);
    return undefined;
  })) ?? {
    id: "current",
    word: "",
    language: "en",
    text: "",
    places: "",
    gloss: "",
    notes: "",
    license: "",
    attribution: "",
    kind: "other",
    structured: false,
  };
  if (current !== revision) return;
  const form = el("form");
  const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  for (const [label, key, multiline] of [
    ["Lojban word", "word", false],
    ["Definition language", "language", false],
    ["Definition", "text", true],
    ["Place descriptions, one per line", "places", true],
    ["Gloss", "gloss", false],
    ["Notes", "notes", true],
    ["License expression", "license", false],
    ["Attribution", "attribution", false],
  ] as const) {
    const input = field(form, label, key, draft[key], multiline);
    inputs.set(key, input);
    if (["word", "language", "text", "license"].includes(key))
      input.required = true;
    input.oninput = () => {
      draft[key] = input.value;
      void store.put("drafts", "current", { ...draft }).catch(report);
    };
  }
  form.append(
    el(
      "p",
      "Enter the license that you choose for this disposable contribution. The prototype does not choose contribution terms.",
    ),
  );
  const label = el("label", "Read circled numbers as place markers");
  const structured = el("input");
  structured.type = "checkbox";
  structured.checked = draft.structured ?? false;
  structured.onchange = () => {
    draft.structured = structured.checked;
    void store.put("drafts", "current", { ...draft }).catch(report);
  };
  label.append(structured);
  form.append(
    label,
    el(
      "p",
      "Leave this control off to preserve circled numbers as literal text.",
    ),
  );
  const preview = el("section");
  preview.setAttribute("aria-label", "Draft preview");
  form.append(
    button("Preview", () => {
      try {
        const body = draftBody(draft, structured.checked);
        preview.replaceChildren(
          el("h2", "Preview"),
          richText(body.text, body.language),
        );
        for (const place of body.frame?.places ?? [])
          preview.append(
            el(
              "p",
              `Place ${place.index}: ${descriptionsText(place.description)}`,
            ),
          );
      } catch (error) {
        report(error);
      }
    }),
    button("Export draft", () =>
      download("jbovlacku-draft.json", JSON.stringify(draft, null, 2)),
    ),
    el("button", "Sign and save to outbox"),
  );
  form.onsubmit = (event) => {
    event.preventDefault();
    void run(async () => {
      if (!workingKey)
        throw new Error("Create or unlock your identity before signing.");
      const body = draftBody(draft, structured.checked);
      await queue(
        {
          kind: "definition.publish",
          word: wordId(body.word),
          language: body.language,
          parents: [],
          origin: "native",
        },
        body,
      );
    })();
  };
  main.append(signingMode(), form, preview);
  if (!workingKey)
    main.append(link("Create or unlock your identity", "/identity"));
  main.append(
    el(
      "p",
      "AI assistance and automatic word builders are unavailable in this prototype.",
    ),
  );
}
function descriptionsText(value: unknown) {
  return Array.isArray(value)
    ? value
        .flat()
        .filter((node) => typeof node === "string")
        .join("")
    : "";
}
async function outboxPage(current: number) {
  heading(
    "Signed outbox",
    "Ready means saved locally. Stored means that this server accepted the event. The receipt describes its effect at last contact.",
  );
  const items = await store.list<OutboxItem>("outbox");
  if (current !== revision) return;
  main.append(
    button("Export signed outbox", () =>
      download(
        "jbovlacku-outbox.jsonl",
        items.map((item) => item.transport).join("\n") + "\n",
      ),
    ),
  );
  if (!items.length) main.append(el("p", "The outbox is empty."));
  for (const item of items) {
    const card = el("article");
    card.append(
      link(item.id, `/definition/${encodeURIComponent(item.id)}`),
      el("p", `Delivery: ${item.state}`),
    );
    if (item.error) card.append(el("p", item.error, "warning"));
    if (item.receipt) {
      card.append(
        el(
          "p",
          `Admission: ${item.receipt.admission}. Interpretation: ${item.receipt.interpretation}. Body: ${item.receipt.body_status}.`,
        ),
        el("p", `Receipt position: ${item.receipt.cursor ?? "unavailable"}.`),
      );
      if (item.receipt.reasons.length)
        card.append(el("p", `Reasons: ${item.receipt.reasons.join(", ")}`));
    }
    if (item.state !== "stored")
      card.append(
        button(
          item.state === "unknown"
            ? "Check receipt and retry"
            : "Send to this test server",
          run(async () => {
            await sendItem(store, item);
            await render();
          }),
        ),
      );
    main.append(card);
  }
}
interface SearchHit {
  word: { language: string; spelling: string };
  word_id: string;
  definitions: string[];
  match: string;
  preview?: {
    event: string;
    word_kind: string;
    plain_text: string;
    status: string;
  };
}
const searchKinds = [
  "headword",
  "gloss",
  "headword-prefix",
  "gloss-prefix",
  "token",
];
const searchPageSize = 50;
const searchResultLimit = 1000;
interface SearchState {
  query: string;
  language: string;
  source: "local" | "server";
  snapshot: string;
  view: string | null;
  hits: SearchHit[];
  next: string | null;
  cursors: string[];
  pages: number;
}
async function searchPage(current: number, focusHeading = false) {
  heading(
    "A dictionary shaped by its readers",
    "Search words and meanings. Each definition keeps its own author and history.",
  );
  const params = new URL(location.href).searchParams;
  const query = params.get("q") ?? "";
  document.title = `${query ? `Search: ${query}` : "Search"} · jbovlacku`;
  const language = params.get("lang") ?? params.get("language") ?? "en";
  const form = el("form");
  form.className = "search-form";
  const input = field(form, "Search words and meanings", "q", query);
  input.type = "search";
  input.autofocus = !focusHeading;
  const lang = field(form, "Definition language", "language", language);
  form.append(el("button", "Search"));
  form.onsubmit = (event) => {
    event.preventDefault();
    navigate(
      `/search?q=${encodeURIComponent(input.value)}&lang=${encodeURIComponent(lang.value)}`,
    );
  };
  main.append(form);
  let cached = storageAvailable
    ? await store
        .get<{
          snapshot: string;
          entries: PackageEntry[];
        }>("packages", language)
        .catch(() => undefined)
    : undefined;
  if (current !== revision) return;
  if (cached) {
    try {
      validateCachedPackage(cached, language);
    } catch (error) {
      cached = undefined;
      report(error);
    }
  }
  const meta = el(
    "p",
    cached
      ? "Search uses the downloaded package. Queries stay on this device. This index contains retained publications. It does not evaluate the current view or definition status."
      : "Search uses this server and its selected view.",
    "muted",
  );
  const packageDownload = button(
    "Download search package",
    run(async () => {
      const pkg = await downloadPackage(language);
      await store.put("packages", language, pkg);
      await render();
      status.textContent = "The search package is saved in this browser.";
    }),
  );
  packageDownload.disabled = !storageAvailable;
  main.append(meta, packageDownload);
  if (cached)
    main.append(
      el(
        "p",
        "Local results can include unselected or deprecated definitions. Their current status is unavailable in this index.",
        "warning",
      ),
    );
  else
    main.append(
      el(
        "p",
        "Search previews come from this server. They are not independently verified.",
        "muted",
      ),
    );
  main.append(
    el(
      "p",
      "A preview follows the strongest text match. Open the word to inspect definition layers.",
      "muted",
    ),
  );
  if (!query) return;
  let snapshot = cached?.snapshot ?? "";
  let view: string | null = null;
  const source = el("details");
  source.append(el("summary", "Search source and snapshot"));
  const sourceInfo = el("div");
  source.append(sourceInfo);
  main.append(source);
  const results = el("section");
  results.setAttribute("aria-label", "Search results");
  const progress = el("p", "", "muted");
  const displayed: SearchHit[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let next: string | null = null;
  let pages = 0;
  let stopped = false;
  const saved = history.state?.dictionarySearch as SearchState | undefined;
  const canRestore =
    saved?.query === query &&
    saved.language === language &&
    saved.source === (cached ? "local" : "server") &&
    Array.isArray(saved.hits) &&
    saved.hits.length <= searchResultLimit;
  let localHits: SearchHit[] = [];
  if (cached) {
    const q = query.toLocaleLowerCase("en");
    const grouped = new Map<string, SearchHit>();
    for (const entry of cached.entries) {
      const spelling = entry.word.spelling.toLocaleLowerCase("en");
      const glosses = entry.glosses.map((gloss) =>
        gloss.text.toLocaleLowerCase("en"),
      );
      const match =
        spelling === q
          ? "headword"
          : glosses.includes(q)
            ? "gloss"
            : spelling.startsWith(q)
              ? "headword-prefix"
              : glosses.some((gloss) => gloss.startsWith(q))
                ? "gloss-prefix"
                : entry.plain_text.toLocaleLowerCase("en").includes(q)
                  ? "token"
                  : null;
      if (!match) continue;
      const id = wordId({ language: "jbo", spelling: entry.word.spelling });
      const preview = {
        event: entry.event,
        word_kind: entry.classification.kind,
        plain_text: Array.from(entry.plain_text).slice(0, 240).join(""),
        status: "unavailable",
      };
      const old = grouped.get(id);
      if (old) {
        old.definitions.push(entry.event);
        if (
          searchKinds.indexOf(match) < searchKinds.indexOf(old.match) ||
          (match === old.match && entry.event < old.preview!.event)
        ) {
          old.match = match;
          old.preview = preview;
        }
      } else
        grouped.set(id, {
          word: entry.word,
          word_id: id,
          definitions: [entry.event],
          match,
          preview,
        });
    }
    localHits = [...grouped.values()].sort(
      (a, b) =>
        searchKinds.indexOf(a.match) - searchKinds.indexOf(b.match) ||
        a.word_id.localeCompare(b.word_id, "en"),
    );
  }
  const remember = () => {
    if (current !== revision) return;
    const state: SearchState = {
      query,
      language,
      source: cached ? "local" : "server",
      snapshot,
      view,
      hits: displayed,
      next,
      cursors: [...cursors],
      pages,
    };
    history.replaceState(
      { ...history.state, dictionarySearch: state },
      "",
      location.href,
    );
  };
  const appendHits = (hits: SearchHit[]) => {
    for (const hit of hits) {
      seen.add(hit.word_id);
      displayed.push(hit);
      const card = el("article");
      const headword = link(
        hit.word.spelling,
        `/word/${encodeURIComponent(hit.word_id)}`,
      );
      headword.lang = hit.word.language;
      card.append(headword);
      if (hit.preview) {
        const preview = el("p", hit.preview.plain_text);
        preview.lang = language;
        card.append(el("p", hit.preview.word_kind, "muted"), preview);
      } else card.append(el("p", "Preview unavailable.", "muted"));
      card.append(
        el(
          "p",
          `${hit.definitions.length} definition${hit.definitions.length === 1 ? "" : "s"} · ${hit.match.replaceAll("-", " ")}`,
          "muted",
        ),
        el(
          "p",
          cached
            ? "Definition status: unavailable in this local index."
            : "Server status: active.",
          "muted",
        ),
      );
      results.append(card);
    }
  };
  const invalid = (message: string): never => {
    stopped = true;
    throw new Error(message);
  };
  const validCursor = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 512;
  const validateHits = (hits: unknown): hits is SearchHit[] =>
    Array.isArray(hits) &&
    hits.every(
      (hit) =>
        hit &&
        typeof hit.word_id === "string" &&
        /^jvw1:[0-9a-f]{64}$/.test(hit.word_id) &&
        hit.word?.language === "jbo" &&
        typeof hit.word.spelling === "string" &&
        searchKinds.includes(hit.match) &&
        Array.isArray(hit.definitions) &&
        hit.definitions.every(
          (id: unknown) =>
            typeof id === "string" && /^jve1:[0-9a-f]{64}$/.test(id),
        ) &&
        (!hit.preview ||
          (typeof hit.preview.event === "string" &&
            hit.definitions.includes(hit.preview.event) &&
            typeof hit.preview.word_kind === "string" &&
            typeof hit.preview.plain_text === "string" &&
            Array.from(hit.preview.plain_text).length <= 240 &&
            hit.preview.status === "active")),
    );
  const refreshControls = () => {
    sourceInfo.replaceChildren(el("p", `Snapshot: ${snapshot}`, "fingerprint"));
    if (view) sourceInfo.append(el("p", `View: ${view}`, "fingerprint"));
    progress.textContent = `${displayed.length} result${displayed.length === 1 ? "" : "s"} shown.`;
    const more = cached ? displayed.length < localHits.length : next !== null;
    loadMore.hidden = !more;
    loadMore.disabled =
      stopped || displayed.length >= searchResultLimit || pages >= 20;
    if (more && loadMore.disabled && !stopped)
      progress.textContent +=
        " The browser limit is reached. Refine your search.";
  };
  const loadNext = async () => {
    try {
      if (cached)
        appendHits(
          localHits.slice(
            displayed.length,
            Math.min(displayed.length + searchPageSize, searchResultLimit),
          ),
        );
      else {
        const result = await api<any>(
          `/search?q=${encodeURIComponent(query)}&language=${encodeURIComponent(language)}&limit=${searchPageSize}${snapshot ? `&snapshot=${encodeURIComponent(snapshot)}&view=${encodeURIComponent(view!)}` : ""}${next ? `&after=${encodeURIComponent(next)}` : ""}`,
        );
        if (current !== revision) return;
        if (
          !result ||
          typeof result.snapshot !== "string" ||
          !/^sha256:[0-9a-f]{64}$/.test(result.snapshot) ||
          typeof result.view !== "string" ||
          !/^jve1:[0-9a-f]{64}$/.test(result.view) ||
          (snapshot &&
            (result.snapshot !== snapshot || result.view !== view)) ||
          !validateHits(result.hits) ||
          result.hits.length > searchPageSize ||
          !(result.next === null || validCursor(result.next))
        )
          invalid(
            "The server returned an invalid search page. Start a new search to retry.",
          );
        if (
          (result.next !== null &&
            (cursors.has(result.next) || !result.hits.length)) ||
          result.hits.some(
            (hit: SearchHit, index: number) =>
              seen.has(hit.word_id) ||
              result.hits
                .slice(0, index)
                .some((prior: SearchHit) => prior.word_id === hit.word_id),
          )
        )
          invalid(
            "Search pagination repeated a cursor or result. Start a new search to retry.",
          );
        snapshot = result.snapshot;
        view = result.view;
        next = result.next;
        if (next) cursors.add(next);
        appendHits(result.hits);
      }
      pages++;
      remember();
    } finally {
      if (current === revision) refreshControls();
    }
  };
  const loadMore = button(
    "Load more",
    run(async () => {
      loadMore.disabled = true;
      await loadNext();
    }),
  );
  main.append(results, progress, loadMore);
  if (canRestore && saved) {
    if (cached && saved.snapshot === cached.snapshot) {
      appendHits(localHits.slice(0, saved.hits.length));
      pages = saved.pages;
    } else if (
      !cached &&
      /^sha256:[0-9a-f]{64}$/.test(saved.snapshot) &&
      typeof saved.view === "string" &&
      /^jve1:[0-9a-f]{64}$/.test(saved.view) &&
      validateHits(saved.hits) &&
      Array.isArray(saved.cursors) &&
      saved.cursors.every(validCursor) &&
      saved.cursors.length <= 20 &&
      (saved.next === null || validCursor(saved.next)) &&
      Number.isInteger(saved.pages) &&
      saved.pages <= 20
    ) {
      snapshot = saved.snapshot;
      view = saved.view;
      next = saved.next;
      pages = saved.pages;
      for (const cursor of saved.cursors) cursors.add(cursor);
      appendHits(saved.hits);
    }
  }
  if (!displayed.length) await loadNext();
  else refreshControls();
  if (current !== revision) return;
  if (!displayed.length)
    results.append(el("p", "No matching definitions in this search source."));
}
async function loadDefinition(id: string, snapshot?: string) {
  const envelope = await getEnvelope<any>(
    `/events/${encodeURIComponent(id)}${snapshot ? `?snapshot=${encodeURIComponent(snapshot)}` : ""}`,
  );
  if (envelope.id !== id)
    throw new Error("The returned event does not match this link.");
  let body: any = null;
  let bodyError: string | undefined;
  if (envelope.header.content) {
    try {
      body = await getBody(
        `/bodies/${encodeURIComponent(envelope.header.content.hash)}${snapshot ? `?snapshot=${encodeURIComponent(snapshot)}` : ""}`,
        envelope.header.content.hash,
        envelope.header.content.bytes,
      );
      const inspected = inspectBody(
        utf8(JSON.stringify(envelope)),
        utf8(canonicalize(utf8(JSON.stringify(body)))),
      );
      if (inspected.availability !== "valid")
        throw new Error(
          "This signed body does not satisfy the definition format. Its content is unavailable.",
        );
    } catch (error) {
      bodyError =
        error instanceof Error ? error.message : "The body is unavailable.";
      body = null;
    }
  }
  return { envelope, body, bodyError };
}
function definitionCard(
  id: string,
  record: Awaited<ReturnType<typeof loadDefinition>>,
  state?: string,
) {
  const { envelope, body, bodyError } = record;
  const card = el("article");
  const headword = link(
    body?.word?.spelling ?? "Signed event",
    `/definition/${encodeURIComponent(id)}`,
  );
  if (body?.word) headword.lang = body.word.language;
  card.append(
    headword,
    el("p", "Signed by:"),
    fingerprint(envelope.header.issuer),
  );
  if (state) card.append(el("p", `Status: ${state}`));
  if (body) {
    if (body.legacy) {
      const legacy = body.legacy;
      card.append(
        el(
          "p",
          `Imported from ${legacy.source}. Source record: ${legacy.record?.kind} ${legacy.record?.id}.`,
        ),
        el(
          "p",
          `Source author: ${typeof legacy.attribution?.author === "string" ? legacy.attribution.author : "unknown"}.`,
        ),
        el("p", `Source position: ${legacy.locator}`),
        el("p", `Source snapshot: ${legacy.snapshot}`, "fingerprint"),
      );
      if (typeof legacy.attribution?.editor === "string")
        card.append(el("p", `Source editor: ${legacy.attribution.editor}.`));
      const account = legacy.attribution?.author_account;
      if (
        account &&
        typeof account.origin === "string" &&
        Number.isSafeInteger(account.account)
      )
        card.append(
          el(
            "p",
            `Source account: ${account.origin}, account ${account.account}. Evidence: ${account.evidence?.kind ?? "unavailable"}.`,
          ),
        );
      const evidence = el("details");
      evidence.append(
        el("summary", "Original source author, account, and import evidence"),
        el("pre", visibleJson(legacy)),
      );
      card.append(evidence);
    }
    card.append(richText(body.text, body.language));
    if (body.glosses?.length) {
      const glosses = el("p", "Glosses: ");
      for (const [index, gloss] of body.glosses.entries()) {
        if (index) glosses.append(", ");
        const text = el("span", gloss.text);
        text.lang = gloss.language;
        glosses.append(text);
      }
      card.append(glosses);
    }
    if (body.frame?.places?.length) {
      const places = el("section");
      places.append(el("h2", "Places"));
      for (const place of body.frame.places) {
        const row = el("div");
        row.id = `place-${place.index}`;
        row.append(
          el("h3", `Place ${place.index}`),
          richText(place.description, body.language),
        );
        places.append(row);
      }
      card.append(places);
    }
    if (body.notes?.length) {
      card.append(el("h2", "Notes"), richText(body.notes, body.language));
    }
    if (body.etymology?.text?.length)
      card.append(
        el("h2", "Etymology"),
        richText(body.etymology.text, body.language),
      );
    if (body.license)
      card.append(
        el(
          "p",
          `License: ${body.license.expression ?? "unknown"}. Attribution: ${body.license.attribution ?? "unavailable"}.`,
        ),
      );
    if (body.examples?.length) {
      card.append(el("h2", "Examples"));
      for (const example of body.examples) {
        const text = el("p", example.text);
        text.lang = example.language;
        card.append(
          text,
          richText(example.translation, body.language),
          richText(example.notes, body.language),
        );
      }
    }
    if (body.sources?.length) {
      card.append(el("h2", "Sources"));
      for (const source of body.sources) {
        const row = el("p", source.label);
        if (source.url)
          row.append(richText([[{ url: source.url, label: "Source link" }]]));
        if (source.event)
          row.append(
            link(
              "Referenced event",
              `/definition/${encodeURIComponent(source.event)}`,
            ),
          );
        if (source.locator) row.append(el("bdi", source.locator));
        card.append(row);
      }
    }
  } else
    card.append(el("p", bodyError ?? "This event has no body.", "warning"));
  if (envelope.header.action.kind === "definition.publish") {
    const controls = el("div", undefined, "actions");
    for (const value of ["bless", "curse", "clear"])
      controls.append(
        button(
          value === "clear"
            ? "Clear judgment"
            : value === "bless"
              ? "Bless"
              : "Curse",
          run(async () =>
            queue({ kind: "judgment.set", target: id, value }, null),
          ),
        ),
      );
    card.append(
      controls,
      el(
        "p",
        "Bless supports this definition. Curse opposes it. Each action first enters your local outbox.",
        "muted",
      ),
    );
    const trust = el("div", undefined, "actions");
    for (const value of ["heed", "shun", "clear"])
      trust.append(
        button(
          value === "clear"
            ? "Clear scoped trust"
            : value === "heed"
              ? "Heed signer here"
              : "Shun signer here",
          run(async () =>
            queue(
              {
                kind: "trust.set",
                subject: envelope.header.issuer,
                scope: {
                  kind: "definition",
                  word: envelope.header.action.word,
                  language: envelope.header.action.language,
                },
                value,
              },
              null,
            ),
          ),
        ),
      );
    card.append(
      trust,
      el(
        "p",
        "These trust actions apply to this word and language. Heed gives the signer influence. Shun blocks their influence here.",
        "muted",
      ),
    );
  }
  if (envelope.header.action.parents?.length) {
    const parents = el("p", "Parent revisions: ");
    for (const parent of envelope.header.action.parents)
      parents.append(
        link(parent, `/definition/${encodeURIComponent(parent)}`),
        " ",
      );
    card.append(parents);
  }
  const source = el("details");
  source.append(
    el("summary", "Signed record and structured body"),
    el("pre", visibleJson({ envelope, body })),
  );
  card.append(source);
  if (!storageAvailable)
    for (const control of card.querySelectorAll("button"))
      control.disabled = true;
  return card;
}
async function wordPage(id: string, current: number) {
  heading("Word");
  main.append(signingMode());
  const word = await api<any>(`/words/${encodeURIComponent(id)}`);
  if (current !== revision) return;
  const wordHeading = main.querySelector("h1")!;
  wordHeading.textContent = word.word?.spelling ?? "Word unavailable";
  if (word.word) wordHeading.lang = word.word.language;
  document.title = `${wordHeading.textContent} · jbovlacku`;
  main.append(
    el("p", `Snapshot: ${word.snapshot}`, "fingerprint"),
    el(
      "p",
      "Ranking and status come from this server. The browser checks signatures and body hashes.",
    ),
  );
  if (word.calculation === null)
    main.append(
      el(
        "p",
        "Ranking is unavailable. No numeric score is assumed.",
        "warning",
      ),
    );
  const definitions = new Set<string>(word.definitions);
  const shown = new Set<string>();
  const appendDefinition = async (
    definition: string,
    parent: HTMLElement,
    ranked: boolean,
  ) => {
    const state = word.statuses.find((s: any) => s.event === definition)?.state;
    const record = await loadDefinition(definition, word.snapshot);
    if (current !== revision) return;
    const card = definitionCard(definition, record, state);
    const score =
      ranked && !word.unavailable_scores.includes(definition)
        ? word.scores.find((s: any) => s.target === definition)
        : undefined;
    if (score)
      card.append(
        el(
          "p",
          `Server net interval: ${score.net.map((n: any) => `${n.numerator}/${n.denominator}`).join(" to ")}.`,
        ),
      );
    else
      card.append(
        el("p", "Score unavailable. No numeric score is assumed.", "muted"),
      );
    if (state === "deprecated")
      card.append(
        el(
          "p",
          "This definition is deprecated in this snapshot. Its judgments are inactive.",
          "muted",
        ),
      );
    parent.append(card);
  };
  if (
    word.definitions.length &&
    word.definitions.every(
      (id: string) =>
        word.statuses.find((s: any) => s.event === id)?.state === "deprecated",
    )
  )
    main.append(el("p", "No active definitions in this snapshot."));
  for (const [index, layer] of (word.calculation === null
    ? []
    : word.layers
  ).entries()) {
    const ids = layer.filter(
      (id: string) => definitions.has(id) && !shown.has(id),
    );
    if (!ids.length) continue;
    const section = el("section");
    section.setAttribute("aria-label", `Definition layer ${index + 1}`);
    section.append(el("h2", `Definition layer ${index + 1}`));
    if (ids.length > 1)
      section.append(
        el(
          "p",
          `${ids.length} alternatives. Order tied or unresolved within this layer.`,
          "warning",
        ),
      );
    main.append(section);
    for (const id of ids) {
      shown.add(id);
      await appendDefinition(id, section, true);
      if (current !== revision) return;
    }
  }
  const unavailable = word.definitions.filter((id: string) => !shown.has(id));
  if (unavailable.length) {
    const section = el("section");
    section.setAttribute(
      "aria-label",
      "Definitions without an available ranking",
    );
    section.append(
      el("h2", "Ranking unavailable"),
      el(
        "p",
        "These definitions have no available position in the server layers.",
        "muted",
      ),
    );
    main.append(section);
    for (const id of unavailable) {
      await appendDefinition(id, section, false);
      if (current !== revision) return;
    }
  }
  if (!word.definitions.length)
    main.append(el("p", "No available definitions in this view."));
}
async function definitionPage(id: string, current: number) {
  heading("Definition");
  main.append(signingMode());
  const record = await loadDefinition(id);
  if (current !== revision) return;
  main.append(definitionCard(id, record));
  if (record.body?.word)
    document.title = `Definition: ${record.body.word.spelling} · jbovlacku`;
  try {
    const receipt = await api<any>(`/receipts/${encodeURIComponent(id)}`);
    if (current !== revision) return;
    main.append(
      el(
        "p",
        `Stored: ${receipt.admission}. Interpretation: ${receipt.interpretation}. Body: ${receipt.body_status}.`,
      ),
    );
  } catch (error) {
    if (current === revision)
      main.append(
        el(
          "p",
          error instanceof Error ? error.message : "Receipt unavailable.",
        ),
      );
  }
}
async function render(focusHeading = false) {
  const current = ++revision;
  status.textContent = "";
  try {
    const path = location.pathname;
    main.className =
      path.startsWith("/words/") ||
      path.startsWith("/definitions/") ||
      path.startsWith("/word/") ||
      path.startsWith("/definition/")
        ? "wide"
        : "";
    if (
      !storageAvailable &&
      ["/identity", "/draft", "/new", "/outbox"].includes(path)
    ) {
      heading(
        "Browser storage unavailable",
        "Restore browser storage access and reload before using drafts, keys, or the outbox.",
      );
      return;
    }
    if (path === "/identity") await identityPage(current);
    else if (path === "/draft" || path === "/new") await draftPage(current);
    else if (path === "/outbox") await outboxPage(current);
    else if (path.startsWith("/word/"))
      await wordPage(decodeURIComponent(path.slice(6)), current);
    else if (path.startsWith("/definition/"))
      await definitionPage(decodeURIComponent(path.slice(12)), current);
    else if (path.startsWith("/words/"))
      await wordPage(decodeURIComponent(path.slice(7)), current);
    else if (path.startsWith("/definitions/"))
      await definitionPage(decodeURIComponent(path.slice(13)), current);
    else if (path === "/" || path === "/search")
      await searchPage(current, focusHeading);
    else
      heading(
        "Page unavailable",
        "Use the navigation to return to the dictionary.",
      );
  } catch (error) {
    if (current === revision) report(error);
  } finally {
    if (current === revision && focusHeading) main.querySelector("h1")?.focus();
  }
}
void (async () => {
  try {
    await initializeCore();
    backup = await store.get<KeyBackup>("keys", "selected").catch(() => {
      storageAvailable = false;
      storageWarning.hidden = false;
      return undefined;
    });
    await render();
  } catch (error) {
    heading(
      "Browser storage or core unavailable",
      "Drafts cannot be saved until the browser opens its local storage and shared core.",
    );
    report(error);
  }
})();
