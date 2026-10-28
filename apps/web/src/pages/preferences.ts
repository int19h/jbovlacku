import { assistanceProfiles } from "../components/assistance.ts";
/** Settings: languages, search mode, delivery peers, storage, export, and appearance. */
import {
  el,
  p,
  text,
  button,
  field,
  describe,
  download,
  checkbox,
} from "../lib/dom.ts";
import { languageName, plural } from "../lib/format.ts";
import type { RenderContext, Route } from "../app/router.ts";
import type { App } from "../app/context.ts";
import { downloadPackage, type CachedPackage } from "../data/search.ts";
import { getCapabilities, getManifest, selfPeer } from "../data/api.ts";
import { applyTheme } from "../app/theme.ts";

export async function preferencesPage(
  _route: Route,
  context: RenderContext,
  app: App,
) {
  const { main } = context;
  const { session } = app;
  context.title("Settings");
  main.className = "";
  main.append(el("h1", { class: "page", text: "Settings" }));
  const prefs = session.preferences;
  // Languages.
  const languages = new Set<string>(["en", prefs.definitionLanguage]);
  let manifestLanguages: string[] = [];
  let packagesAvailable = true;
  try {
    const manifest = await getManifest({ signal: context.signal });
    manifestLanguages = manifest.packages.map((pkg) => pkg.language);
    packagesAvailable = manifest.packages_available !== false;
    for (const tag of manifestLanguages) languages.add(tag);
  } catch {}
  if (!context.live()) return;
  const languageField = field("Definition language", {
    options: [...languages]
      .sort()
      .map((tag) => ({ value: tag, label: languageName(tag) })),
    value: prefs.definitionLanguage,
    hint: "Definitions shown by default. The interface language is English in this prototype.",
  });
  languageField.input.addEventListener(
    "change",
    () =>
      void session.setPreferences({
        definitionLanguage: languageField.input.value,
      }),
  );
  main.append(
    el("h2", { class: "section", text: "Languages" }),
    languageField.wrapper,
  );
  main.append(el("h2", { class: "section", text: "Assistance" }));
  try {
    const capabilities = await getCapabilities({ signal: context.signal });
    if (!context.live()) return;
    if (assistanceProfiles(capabilities).length) {
      const saved = el("p", { class: "small", role: "status", hidden: true });
      const choice = checkbox(
        "Use AI assistance",
        prefs.useAiAssistance !== false,
        async (value) => {
          input.disabled = true;
          saved.hidden = false;
          saved.textContent = "Saving assistance setting.";
          try {
            await session.setPreferences({ useAiAssistance: value });
            saved.textContent = "Assistance setting saved in this browser.";
          } catch (error) {
            input.checked = session.preferences.useAiAssistance !== false;
            saved.textContent = `Not saved: ${describe(error)}`;
          } finally {
            input.disabled = false;
          }
        },
      );
      const input = choice.querySelector("input")!;
      main.append(choice, saved);
    } else main.append(p("Not available on this server.", "small"));
  } catch {
    if (context.live())
      main.append(p("Not available on this server.", "small"));
  }
  // Search mode.
  main.append(el("h2", { class: "section", text: "Search" }));
  const modeField = field("Search mode", {
    options: [
      {
        value: "local",
        label: "Local: use downloaded packages, queries stay in this browser",
      },
      {
        value: "remote",
        label: `Remote: send each query to ${selfPeer.label}`,
      },
    ],
    value: prefs.searchMode,
    hint: "Without a downloaded package for a language, local mode still asks the server for that language.",
  });
  modeField.input.addEventListener("change", async () => {
    const mode = modeField.input.value as "local" | "remote";
    if (mode === "remote" && !prefs.remoteSearchDisclosed) {
      app.announce(
        `Remote search sends each query to ${selfPeer.label}. Earlier local queries are not uploaded.`,
      );
      await session.setPreferences({ remoteSearchDisclosed: true });
    }
    await session.setPreferences({ searchMode: mode });
  });
  main.append(modeField.wrapper);
  const packages = el("div", { class: "stack" });
  main.append(
    el("h3", {
      class: "small",
      style: "font-weight:640",
      text: "Downloaded search packages",
    }),
    packages,
  );
  const renderPackages = async () => {
    packages.replaceChildren();
    if (!session.storageAvailable) {
      packages.append(
        p(
          "Browser storage is unavailable. Packages cannot be saved.",
          "notice",
        ),
      );
      return;
    }
    const keys = await app.store.keys("packages");
    for (const key of keys) {
      const cached = await app.store.get<CachedPackage>("packages", key);
      const row = el("div", { class: "row" });
      row.append(
        el(
          "span",
          { class: "t" },
          text(languageName(key)),
          el("small", {
            text: cached
              ? `${plural(cached.entries.length, "definition")} · snapshot ${cached.snapshot.slice(7, 19)}… · version ${cached.version ?? 1}${
                  cached.downgrade
                    ? `. Version 1 was saved instead of version 2: ${cached.downgrade}`
                    : ""
                }`
              : "unreadable",
          }),
        ),
        button(
          "Remove",
          async () => {
            await app.store.delete("packages", key);
            await renderPackages();
          },
          { class: "btn btn-quiet" },
        ),
      );
      packages.append(row);
    }
    if (!packagesAvailable)
      packages.append(
        p(
          "Search packages are temporarily unavailable. The service cannot evaluate publication receipts.",
          "notice",
        ),
      );
    const available = manifestLanguages.filter((tag) => !keys.includes(tag));
    if (available.length) {
      const pick = field("Download a package", {
        options: available.map((tag) => ({
          value: tag,
          label: languageName(tag),
        })),
      });
      const go = button(
        "Download",
        async () => {
          go.disabled = true;
          try {
            const pkg = await downloadPackage(pick.input.value);
            await app.store.put("packages", pick.input.value, pkg);
            app.announce(
              pkg.downgrade
                ? `The ${languageName(pick.input.value)} search package is saved in this browser as version 1. ${pkg.downgrade}`
                : `The ${languageName(pick.input.value)} search package is saved in this browser.`,
            );
            await renderPackages();
          } catch (error) {
            app.announce(describe(error));
          } finally {
            go.disabled = false;
          }
        },
        { class: "btn" },
      );
      packages.append(
        el(
          "div",
          { style: "display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap" },
          pick.wrapper,
          go,
        ),
      );
    } else if (!keys.length && packagesAvailable)
      packages.append(p("This server offers no search package yet.", "small"));
    for (const key of keys)
      if (manifestLanguages.includes(key))
        packages.append(
          button(
            `Refresh ${languageName(key)}`,
            async () => {
              try {
                const pkg = await downloadPackage(key);
                await app.store.put("packages", key, pkg);
                app.announce(`The ${languageName(key)} package is refreshed.`);
                await renderPackages();
              } catch (error) {
                app.announce(describe(error));
              }
            },
            { class: "btn btn-quiet" },
          ),
        );
  };
  await renderPackages();
  if (!context.live()) return;
  // Delivery peers.
  main.append(el("h2", { class: "section", text: "Delivery" }));
  let serverId = selfPeer.label;
  try {
    serverId = (await getCapabilities({ signal: context.signal })).server_id;
  } catch {}
  if (!context.live()) return;
  main.append(
    p(
      `Publications go to one server: ${serverId} at ${selfPeer.label}. Sending a signed record to a server publishes it there.`,
      "small",
    ),
    p(
      "Additional peers are an operator setting in this prototype. Changing peers never republishes old records by itself.",
      "meta",
    ),
  );
  // Storage.
  main.append(el("h2", { class: "section", text: "Storage" }));
  const storageLine = el("p", { class: "small" });
  main.append(storageLine);
  const describeStorage = async () => {
    try {
      const persisted = await navigator.storage?.persisted?.();
      const estimate = await navigator.storage?.estimate?.();
      storageLine.textContent = `${persisted ? "The browser granted persistent storage." : "Persistent storage is not granted. Browser clearing or eviction can destroy local work."}${estimate?.usage !== undefined ? ` About ${Math.round(estimate.usage / 1024)} KiB in use.` : ""}`;
    } catch {
      storageLine.textContent =
        "Storage information is unavailable in this browser.";
    }
  };
  await describeStorage();
  main.append(
    el(
      "div",
      { class: "actions" },
      button(
        "Request persistent storage",
        async () => {
          try {
            const granted = await navigator.storage?.persist?.();
            app.announce(
              granted
                ? "Persistent storage granted."
                : "The browser did not grant persistent storage.",
            );
          } catch (error) {
            app.announce(describe(error));
          }
          await describeStorage();
        },
        { class: "btn" },
      ),
    ),
  );
  // Export.
  main.append(el("h2", { class: "section", text: "Export" }));
  main.append(
    el(
      "div",
      { class: "actions" },
      button(
        "Export drafts",
        async () => {
          const drafts = (
            await app.store.list<{ kind?: string }>("drafts")
          ).filter((row) => row?.kind !== "saved-drafts");
          download(
            `jbovlacku-drafts-${Date.now()}.json`,
            JSON.stringify(drafts, null, 2),
          );
        },
        { class: "btn" },
      ),
      button(
        "Export signed records",
        async () =>
          download(
            `jbovlacku-records-${Date.now()}.jsonl`,
            await app.delivery.exportLines(await app.delivery.items()),
            "application/x-ndjson",
          ),
        { class: "btn" },
      ),
      button(
        "Export private trust preferences",
        async () =>
          download(
            `jbovlacku-overlay-${Date.now()}.json`,
            JSON.stringify(await app.store.overlay(), null, 2),
          ),
        { class: "btn" },
      ),
    ),
    p(
      "The key backup is a separate download on Your key. Exports contain no passphrase or private key.",
      "meta",
    ),
  );
  // Appearance.
  main.append(el("h2", { class: "section", text: "Appearance" }));
  const theme = field("Theme", {
    options: [
      { value: "system", label: "Follow the system" },
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
    ],
    value: prefs.theme,
  });
  theme.input.addEventListener("change", async () => {
    const value = theme.input.value as "system" | "light" | "dark";
    await session.setPreferences({ theme: value });
    applyTheme(value);
  });
  main.append(theme.wrapper);
  const orthography = field("Lojban orthography beside headwords", {
    options: [
      { value: "latin", label: "Latin only" },
      {
        value: "zbalermorna",
        label: "Show zbalermorna beside the Latin headword",
      },
    ],
    value: prefs.orthography,
    hint: "Display only. Signed spellings and copied text stay Latin unless you choose otherwise.",
  });
  orthography.input.addEventListener(
    "change",
    () =>
      void session.setPreferences({
        orthography: orthography.input.value as "latin" | "zbalermorna",
      }),
  );
  main.append(orthography.wrapper);
  main.append(
    checkbox(
      "Show my judgments first on word pages",
      prefs.myJudgmentsFirst,
      (value) => void session.setPreferences({ myJudgmentsFirst: value }),
    ),
  );
  // Optional services.
  main.append(el("h2", { class: "section", text: "Optional services" }));
  try {
    const capabilities = await getCapabilities({ signal: context.signal });
    if (!context.live()) return;
    const f = capabilities.features;
    main.append(
      p(
        `Semantic search: ${f.semantic_search ? "available" : "not configured on this server"}. AI assistance: ${f.assistance ? "available" : "not configured on this server"}. Account witness: ${f.account_observation ? "available" : "not configured"}. Lensisku bridge: ${f.lensisku_bridge ? "available" : "not configured"}.`,
        "small",
      ),
      p(
        "Manual authoring and local search work without these services.",
        "meta",
      ),
    );
  } catch {
    if (context.live())
      main.append(p("Server capabilities are unavailable right now.", "small"));
  }
}
