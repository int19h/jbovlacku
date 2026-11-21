import { embeddingProfiles } from "../data/semantic-search.ts";
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
import { listedLanguage, languageName, plural } from "../lib/format.ts";
import type { RenderContext, Route } from "../app/router.ts";
import type { App } from "../app/context.ts";
import {
  downloadPackage,
  reportPackageError,
  type CachedPackage,
} from "../data/search.ts";
import { getCapabilities, getManifest, selfPeer } from "../data/api.ts";
import type { Preferences } from "../data/store.ts";

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
  // Only the latest failed choice restores a control. Success keeps newer input.
  const saves = new Map<keyof Preferences, symbol>();
  const save = async (
    key: keyof Preferences,
    patch: Partial<Preferences>,
    restore: () => void,
  ) => {
    const request = Symbol();
    saves.set(key, request);
    try {
      await session.setPreferences(patch);
    } catch {
      if (context.live() && saves.get(key) === request) restore();
    }
  };
  // Languages.
  const languages = new Set<string>(["en", prefs.definitionLanguage]);
  let manifestLanguages: string[] = [];
  let packagesAvailable = true;
  try {
    const manifest = await getManifest({ signal: context.signal });
    manifestLanguages = manifest.packages
      .map((pkg) => pkg.language)
      .filter(listedLanguage);
    packagesAvailable = manifest.packages_available !== false;
    for (const tag of manifestLanguages) languages.add(tag);
  } catch {}
  if (!context.live()) return;
  const languageField = field("Definition language", {
    options: [...languages]
      .filter((tag) => tag === prefs.definitionLanguage || listedLanguage(tag))
      .sort()
      .map((tag) => ({ value: tag, label: languageName(tag) })),
    value: prefs.definitionLanguage,
    hint: "Definitions shown by default. The interface language is English in this prototype.",
  });
  languageField.input.addEventListener(
    "change",
    () =>
      void save(
        "definitionLanguage",
        {
          definitionLanguage: languageField.input.value,
        },
        () => {
          languageField.input.value = session.preferences.definitionLanguage;
        },
      ),
  );
  main.append(
    el("h2", { class: "section", text: "Languages" }),
    languageField.wrapper,
  );
  main.append(el("h2", { class: "section", text: "Assistance" }));
  try {
    const capabilities = await getCapabilities({ signal: context.signal });
    if (!context.live()) return;
    const meaningAvailable =
      capabilities.features.semantic_search &&
      (
        await embeddingProfiles(null, prefs.definitionLanguage, {
          signal: context.signal,
        }).catch(() => [])
      ).some((profile) => profile.query_available);
    if (assistanceProfiles(capabilities).length || meaningAvailable) {
      const saved = el("p", {
        id: "assistance-save-status",
        class: "small",
        role: "status",
      });
      let saving = false;
      let pendingValue = prefs.useAiAssistance !== false;
      const choice = checkbox(
        "Use AI assistance",
        prefs.useAiAssistance !== false,
        async (value) => {
          if (saving) {
            input.checked = pendingValue;
            return;
          }
          saving = true;
          pendingValue = value;
          input.setAttribute("aria-disabled", "true");
          saved.textContent = "Saving assistance setting.";
          try {
            await session.setPreferences(
              { useAiAssistance: value },
              (error) => {
                if (!context.live()) return false;
                input.checked = session.preferences.useAiAssistance !== false;
                saved.textContent = `Not saved: ${describe(error)}`;
                return true;
              },
            );
            if (context.live())
              saved.textContent = "Assistance setting saved in this browser.";
          } catch {
            // The live inline status or the session reports the failure.
          } finally {
            saving = false;
            if (context.live()) input.setAttribute("aria-disabled", "false");
          }
        },
      );
      const input = choice.querySelector("input")!;
      input.setAttribute("aria-describedby", saved.id);
      input.setAttribute("aria-disabled", "false");
      input.addEventListener("click", (event) => {
        if (saving) event.preventDefault();
      });
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
        label:
          "Local: use downloaded packages for word and definition searches",
      },
      {
        value: "remote",
        label: `Remote: send each query to ${selfPeer.label}`,
      },
    ],
    value: prefs.searchMode,
    hint: "Without a downloaded package for a language, local mode asks the server. Meaning search sends queries to the server and provider after consent.",
  });
  modeField.input.addEventListener("change", async () => {
    const mode = modeField.input.value as "local" | "remote";
    if (mode === "remote" && !prefs.remoteSearchDisclosed) {
      app.announce(
        `Remote search sends each query to ${selfPeer.label}. Earlier local queries are not uploaded.`,
      );
    }
    await save(
      "searchMode",
      {
        searchMode: mode,
        ...(mode === "remote" ? { remoteSearchDisclosed: true } : {}),
      },
      () => {
        modeField.input.value = session.preferences.searchMode;
      },
    );
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
  // Languages with a package download or refresh running on this page,
  // each with the token of the run that set the mark. A run clears the
  // mark only while it still holds its own token, so an older run cannot
  // clear the mark of a newer run of the same language. Refresh buttons
  // of a marked language render disabled, and Download is disabled while
  // the picked language is marked.
  const runningPackages = new Map<string, symbol>();
  const startRun = (language: string) => {
    const token = Symbol(language);
    runningPackages.set(language, token);
    return token;
  };
  const endRun = (language: string, token: symbol) => {
    if (runningPackages.get(language) === token)
      runningPackages.delete(language);
  };
  // The language picked for a download. A render that publishes its list
  // reads it from the live picker first, so the new picker shows it.
  let pickedPackage = "";
  // Each list control carries its kind ("picker", "download", "refresh" or
  // "remove") and, for a row control, its language. Only one list is ever
  // shown, so a kind and a language name at most one live control. A
  // render uses them to find the new copy of the control that had focus.
  const controlKey = (node: Element | null) => {
    const control = node?.closest<HTMLElement>("[data-package-control]");
    if (!control || !packages.contains(control)) return null;
    return `${control.dataset.packageControl}:${control.dataset.packageLanguage ?? ""}`;
  };
  const findControl = <T extends HTMLElement>(
    kind: string,
    language = "",
    root: ParentNode = packages,
  ) =>
    [...root.querySelectorAll<T>("[data-package-control]")].find(
      (node) =>
        node.dataset.packageControl === kind &&
        (node.dataset.packageLanguage ?? "") === language,
    ) ?? null;
  /** Sets the Download button from the running state of the picked language. */
  const syncDownloadButton = () => {
    const picker = findControl<HTMLSelectElement>("picker");
    const download = findControl<HTMLButtonElement>("download");
    if (picker && download)
      download.disabled = runningPackages.has(picker.value);
  };
  /** Sets the Refresh button of a language, if it is listed, from its running state. */
  const syncRefreshButton = (language: string) => {
    const refresh = findControl<HTMLButtonElement>("refresh", language);
    if (refresh) refresh.disabled = runningPackages.has(language);
  };
  /**
   * Tells whether the end of a run may move focus. It may only when focus
   * is still on the handler's own button, or on no control: the page body
   * or nothing, as after a render removed the focused control and found no
   * new copy of it. Focus on any other control stays there.
   */
  const focusIsFree = (own?: HTMLButtonElement) => {
    const active = document.activeElement;
    return active === null || active === document.body || active === own;
  };
  /**
   * Focuses the first enabled list button of these kinds, in order, when
   * the handler's button had focus and focus is still free. Kinds are
   * [kind, language] pairs, so focus can fall back to a later kind when
   * the first is missing or disabled. The focus does not scroll the page.
   */
  const refocusPackageButton = (
    hadFocus: boolean,
    kinds: [string, string?][],
  ) => {
    if (!hadFocus || !context.live() || !focusIsFree()) return;
    for (const [kind, language] of kinds) {
      const candidate = findControl<HTMLButtonElement>(kind, language);
      if (candidate && !candidate.disabled) {
        candidate.focus({ preventScroll: true });
        return;
      }
    }
  };
  /**
   * Ends a failed run. Storage did not change, so the list does not render
   * again. The current controls are updated in place: the Refresh button
   * of the language, and Download for the picked language. Focus moves
   * only under the rule of `focusIsFree`, and never to a disabled button.
   */
  const endFailedRun = (
    own: HTMLButtonElement,
    language: string,
    kinds: [string, string?][],
    hadFocus: boolean,
  ) => {
    const mayFocus = hadFocus && focusIsFree(own);
    syncRefreshButton(language);
    syncDownloadButton();
    refocusPackageButton(mayFocus, kinds);
  };
  // Counts the renders that started. Only the newest render publishes its
  // list, and a handler moves focus after its render only while that
  // render is still the newest.
  let renderCount = 0;
  /**
   * Builds the package list into a detached fragment. When the build ends,
   * it replaces the live list only if no newer render has started; an
   * older render's list is dropped. So the page shows one list, never
   * rows from two renders. At the replacement, the new picker takes the
   * live picker's language while that language is still offered, and
   * focus moves to the new copy of the list control that had focus, if
   * that copy exists and is enabled. The focus does not scroll the page.
   * Returns the number of this render.
   */
  const renderPackages = async () => {
    const render = ++renderCount;
    const list = document.createDocumentFragment();
    await buildPackages(list);
    if (render !== renderCount || !context.live()) return render;
    const focused = controlKey(document.activeElement);
    const livePicker = findControl<HTMLSelectElement>("picker");
    if (livePicker) pickedPackage = livePicker.value;
    const newPicker = findControl<HTMLSelectElement>("picker", "", list);
    if (
      newPicker &&
      [...newPicker.options].some((option) => option.value === pickedPackage)
    )
      newPicker.value = pickedPackage;
    packages.replaceChildren(list);
    syncDownloadButton();
    if (focused) {
      const [kind, language] = focused.split(":");
      const copy = findControl<HTMLButtonElement | HTMLSelectElement>(
        kind,
        language,
      );
      if (copy && !copy.disabled) copy.focus({ preventScroll: true });
    }
    return render;
  };
  /** True while the render with this number is the newest one that started. */
  const isNewestRender = (render: number) => render === renderCount;
  const buildPackages = async (list: DocumentFragment) => {
    if (!session.storageAvailable) {
      list.append(
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
            // The delete writes a new package revision, so a download or
            // refresh that is still running cannot save over this remove.
            await app.store.delete("packages", key);
            await renderPackages();
          },
          {
            class: "btn btn-quiet",
            "data-package-control": "remove",
            "data-package-language": key,
          },
        ),
      );
      list.append(row);
    }
    if (!packagesAvailable)
      list.append(
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
        value: available.includes(pickedPackage) ? pickedPackage : undefined,
      });
      pick.input.dataset.packageControl = "picker";
      const go = button(
        "Download",
        async () => {
          const language = pick.input.value;
          if (runningPackages.has(language)) return;
          pickedPackage = language;
          const token = startRun(language);
          const hadFocus = document.activeElement === go;
          syncDownloadButton();
          let rendered = false;
          try {
            const expected = await app.store.packageRevisionOf(language);
            const pkg = await downloadPackage(language);
            // A remove or another save of this package that committed
            // while the download ran wins; this save then does nothing.
            const saved = await app.store.put(
              "packages",
              language,
              pkg,
              expected ?? null,
            );
            app.announce(
              !saved
                ? `The ${languageName(language)} search package was not saved. It changed in this browser while the download ran.`
                : pkg.downgrade
                  ? `The ${languageName(language)} search package is saved in this browser as version 1. ${pkg.downgrade}`
                  : `The ${languageName(language)} search package is saved in this browser.`,
            );
            // Clear the running mark before the render, so the new
            // buttons for this language render enabled.
            endRun(language, token);
            const mayFocus = hadFocus && focusIsFree(go);
            const render = await renderPackages();
            rendered = true;
            refocusPackageButton(mayFocus && isNewestRender(render), [
              ["download"],
              ["refresh", language],
            ]);
          } catch (error) {
            // A full store reports its own message instead of a raw quota error.
            app.announce(describe(reportPackageError(error)));
          } finally {
            endRun(language, token);
            // A failure changed no storage, so the list stays as it is,
            // with its picker value and focus. Only the current buttons
            // are updated.
            if (!rendered)
              endFailedRun(
                go,
                language,
                [["download"], ["refresh", language]],
                hadFocus,
              );
          }
        },
        { class: "btn", "data-package-control": "download" },
      );
      go.disabled = runningPackages.has(pick.input.value);
      pick.input.addEventListener("change", () => {
        pickedPackage = pick.input.value;
        syncDownloadButton();
      });
      list.append(
        el(
          "div",
          { style: "display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap" },
          pick.wrapper,
          go,
        ),
      );
    } else if (!keys.length && packagesAvailable)
      list.append(p("This server offers no search package yet.", "small"));
    for (const key of keys)
      if (manifestLanguages.includes(key)) {
        const refresh = button(
          `Refresh ${languageName(key)}`,
          async () => {
            if (runningPackages.has(key)) return;
            const token = startRun(key);
            const hadFocus = document.activeElement === refresh;
            refresh.disabled = true;
            let rendered = false;
            try {
              const expected = await app.store.packageRevisionOf(key);
              const stored = await app.store.keys("packages");
              if (!stored.includes(key)) {
                // This row is stale: the package was removed, in this
                // tab or another one. Refresh updates a saved package,
                // so it does not bring one back. Download adds it again.
                app.announce(
                  `The ${languageName(key)} package is no longer saved in this browser.`,
                );
                endRun(key, token);
                const mayFocus = hadFocus && focusIsFree(refresh);
                const render = await renderPackages();
                rendered = true;
                refocusPackageButton(mayFocus && isNewestRender(render), [
                  ["download"],
                ]);
                return;
              }
              const pkg = await downloadPackage(key);
              // A remove or another save of this package that committed
              // while the refresh ran wins; this save then does nothing.
              const saved = await app.store.put(
                "packages",
                key,
                pkg,
                expected ?? null,
              );
              app.announce(
                saved
                  ? `The ${languageName(key)} package is refreshed.`
                  : `The ${languageName(key)} package was not saved. It changed in this browser while the refresh ran.`,
              );
              endRun(key, token);
              const mayFocus = hadFocus && focusIsFree(refresh);
              const render = await renderPackages();
              rendered = true;
              refocusPackageButton(mayFocus && isNewestRender(render), [
                ["refresh", key],
                ["download"],
              ]);
            } catch (error) {
              // A full store reports its own message instead of a raw quota error.
              app.announce(describe(reportPackageError(error)));
            } finally {
              endRun(key, token);
              // A failure changed no storage, so the list stays as it is.
              // Only the current buttons are updated.
              if (!rendered)
                endFailedRun(
                  refresh,
                  key,
                  [["refresh", key], ["download"]],
                  hadFocus,
                );
            }
          },
          {
            class: "btn btn-quiet",
            "data-package-control": "refresh",
            "data-package-language": key,
          },
        );
        refresh.disabled = runningPackages.has(key);
        list.append(refresh);
      }
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
    await save("theme", { theme: value }, () => {
      theme.input.value = session.preferences.theme;
    });
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
      void save(
        "orthography",
        {
          orthography: orthography.input.value as "latin" | "zbalermorna",
        },
        () => {
          orthography.input.value = session.preferences.orthography;
        },
      ),
  );
  main.append(orthography.wrapper);
  const judgments = checkbox(
    "Show my judgments first on word pages",
    prefs.myJudgmentsFirst,
    async (value) => {
      await save("myJudgmentsFirst", { myJudgmentsFirst: value }, () => {
        judgments.querySelector("input")!.checked =
          session.preferences.myJudgmentsFirst;
      });
    },
  );
  main.append(judgments);
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
