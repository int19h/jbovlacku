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
  packageCause,
  reportPackageError,
  type CachedPackage,
  type PackageProgress,
} from "../data/search.ts";
import { getCapabilities, getManifest, selfPeer } from "../data/api.ts";
import {
  INVALID_PACKAGE_MESSAGE,
  PackageValidationError,
  savedPackage,
  savedRow,
  savedSpellingChecks,
} from "../data/saved-package.ts";
import type { Preferences } from "../data/store.ts";

/** The outcome of one render of the Settings package list. */
interface RenderResult {
  /** The number of the render, in the order that renders started. */
  render: number;
  /** True if the render replaced the shown list. */
  published: boolean;
  /** The element that had focus just before a published render replaced the list. */
  focusedAtPublish: Element | null;
}

export async function preferencesPage(
  _route: Route,
  context: RenderContext,
  app: App,
) {
  const { main } = context;
  context.title("Settings");
  main.className = "";
  main.append(el("h1", { class: "page", text: "Settings" }));
  // A pending note while the first requests wait. It is removed when the
  // page finishes or fails, so a slow load never shows only the heading and
  // a failed load never keeps an untrue loading state.
  const loading = p("Loading…", "meta");
  main.append(loading);
  try {
    await preferencesBody(context, app);
  } finally {
    loading.remove();
  }
}

async function preferencesBody(context: RenderContext, app: App) {
  const { main } = context;
  const { session } = app;
  const prefs = session.preferences;
  // Only the latest failed choice restores a control. Success keeps newer input.
  // A key stays in the map while its latest save runs.
  const saves = new Map<keyof Preferences, symbol>();
  /**
   * Saves one choice. A failure of the latest choice restores the control
   * and stays in the control's note until a later save of it succeeds. The
   * shell status announces the failure too.
   */
  const save = async (
    key: keyof Preferences,
    patch: Partial<Preferences>,
    restore: () => void,
    note: HTMLElement,
  ) => {
    const request = Symbol();
    saves.set(key, request);
    try {
      await session.setPreferences(patch, (error) => {
        if (context.live() && saves.get(key) === request) {
          note.textContent = `Not saved: ${describe(error)}`;
          note.hidden = false;
        }
        return false;
      });
      if (context.live() && saves.get(key) === request) note.hidden = true;
    } catch {
      if (context.live() && saves.get(key) === request) restore();
    } finally {
      if (saves.get(key) === request) saves.delete(key);
    }
  };
  // Another tab can change the saved settings. The session reads them
  // again when that tab reports the change, and each control here then
  // shows the saved value, unless a save of its own is still running.
  const syncs: (() => void)[] = [];
  const syncControls = () => {
    if (!context.live()) return;
    for (const sync of syncs) sync();
  };
  const unsubscribe = session.subscribe(syncControls);
  context.signal.addEventListener("abort", () => unsubscribe(), {
    once: true,
  });
  /**
   * Adds the sync of one control and runs it at once. The page builds its
   * controls after requests that can wait, and a change from another tab
   * can arrive during such a request. The first run gives the control the
   * current saved value instead of the value that the page read first.
   */
  const track = (sync: () => void) => {
    syncs.push(sync);
    sync();
  };
  /**
   * Keeps a select control on the saved value of its key. When the control
   * takes a new saved value, an earlier failed save of it no longer
   * describes what the control shows, so its note is hidden.
   */
  const syncSelect = (
    key: keyof Preferences,
    input: HTMLSelectElement,
    note: HTMLElement,
  ) =>
    track(() => {
      if (saves.has(key)) return;
      const value = String(session.preferences[key]);
      if (input.value === value) return;
      if (![...input.options].some((option) => option.value === value))
        input.append(
          el("option", {
            value,
            text: key === "definitionLanguage" ? languageName(value) : value,
          }),
        );
      input.value = value;
      note.hidden = true;
    });
  /** A note in place under one control. It is empty and hidden until used. */
  const controlNote = () => {
    const note = el("p", { class: "notice" });
    note.hidden = true;
    return note;
  };
  // Languages.
  const languages = new Set<string>(["en", prefs.definitionLanguage]);
  let manifestLanguages: string[] = [];
  let packagesAvailable = true;
  // Why the server's package list could not be read, or null after a read.
  let manifestError: string | null = null;
  try {
    const manifest = await getManifest({ signal: context.signal });
    manifestLanguages = manifest.packages
      .map((pkg) => pkg.language)
      .filter(listedLanguage);
    packagesAvailable = manifest.packages_available !== false;
    for (const tag of manifestLanguages) languages.add(tag);
  } catch (error) {
    if (!context.live()) return;
    manifestError = describe(error);
    // Packages saved in this browser still work without the server, so
    // their languages stay available.
    if (session.storageAvailable)
      try {
        for (const tag of await app.store.keys("packages")) languages.add(tag);
      } catch {}
  }
  if (!context.live()) return;
  if (manifestError !== null)
    main.append(
      p(
        // Only the server list is reported here. Each saved package row
        // shows the state of that package.
        `The server's languages and search packages did not load: ${manifestError} Open Settings again to retry.`,
        "notice",
      ),
    );
  const languageField = field("Definition language", {
    options: [...languages]
      .filter((tag) => tag === prefs.definitionLanguage || listedLanguage(tag))
      .sort()
      .map((tag) => ({ value: tag, label: languageName(tag) })),
    value: prefs.definitionLanguage,
    hint: "Definitions shown by default. The interface language is English in this prototype.",
  });
  const languageNote = controlNote();
  syncSelect("definitionLanguage", languageField.input, languageNote);
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
        languageNote,
      ),
  );
  main.append(
    el("h2", { class: "section", text: "Languages" }),
    languageField.wrapper,
    languageNote,
  );
  main.append(el("h2", { class: "section", text: "Assistance" }));
  try {
    const capabilities = await getCapabilities({ signal: context.signal });
    if (!context.live()) return;
    // Why the meaning search profiles did not load, or null after a read.
    let profilesError = null as string | null;
    const meaningAvailable =
      capabilities.features.semantic_search &&
      (
        await embeddingProfiles(null, prefs.definitionLanguage, {
          signal: context.signal,
        }).catch((error: unknown) => {
          profilesError = describe(error);
          return [];
        })
      ).some((profile) => profile.query_available);
    if (!context.live()) return;
    const assistanceShown =
      assistanceProfiles(capabilities).length || meaningAvailable;
    if (!assistanceShown && profilesError !== null)
      // The server offers meaning search, and only its profiles tell
      // whether assistance applies. A failed request has not said that.
      main.append(
        p(
          `Assistance settings did not load: the meaning search profiles did not load. ${profilesError} Open Settings again to retry.`,
          "small",
        ),
      );
    else if (assistanceShown) {
      const saved = el("p", {
        id: "assistance-save-status",
        class: "small",
        role: "status",
      });
      let saving = false;
      let pendingValue = session.preferences.useAiAssistance !== false;
      const choice = checkbox(
        "Use AI assistance",
        session.preferences.useAiAssistance !== false,
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
      track(() => {
        if (saving) return;
        const value = session.preferences.useAiAssistance !== false;
        if (input.checked === value) return;
        input.checked = value;
        // An earlier outcome described another value.
        saved.textContent = "";
      });
      input.setAttribute("aria-describedby", saved.id);
      input.setAttribute("aria-disabled", "false");
      input.addEventListener("click", (event) => {
        if (saving) event.preventDefault();
      });
      main.append(choice, saved);
    } else main.append(p("Not available on this server.", "small"));
  } catch (error) {
    // A server that did not answer has not said that it lacks assistance.
    if (context.live())
      main.append(
        p(`Assistance settings did not load: ${describe(error)}`, "small"),
      );
  }
  // Search mode.
  main.append(el("h2", { class: "section", text: "Search" }));
  const modeField = field("Search mode", {
    // Short option labels fit a phone. The hint explains each mode.
    options: [
      { value: "local", label: "Local" },
      { value: "remote", label: "Remote" },
    ],
    value: prefs.searchMode,
    hint: `Local uses downloaded packages for word and definition searches. If no usable package is available for a language, local mode asks the server. Remote sends each query to ${selfPeer.label}. Meaning search sends queries to the server and provider after consent.`,
  });
  // The remote search disclosure stays in place under the control.
  const modeDisclosure = p("", "small");
  modeDisclosure.hidden = true;
  const modeNote = controlNote();
  syncSelect("searchMode", modeField.input, modeNote);
  modeField.input.addEventListener("change", async () => {
    const mode = modeField.input.value as "local" | "remote";
    if (mode === "remote" && !session.preferences.remoteSearchDisclosed) {
      modeDisclosure.textContent = `Remote search sends each query to ${selfPeer.label}. Earlier local queries are not uploaded.`;
      modeDisclosure.hidden = false;
      app.announce(modeDisclosure.textContent);
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
      modeNote,
    );
  });
  main.append(modeField.wrapper, modeDisclosure, modeNote);
  const packages = el("div", { class: "stack" });
  // One line per language with the progress or the last outcome of its
  // download, refresh or remove. A line stays until the next run of that
  // language replaces it, so a reader who looks away still finds it next to
  // the list. A render of the list keeps these lines.
  const packageNotes = el("div", { class: "stack", "data-package-notes": "" });
  main.append(
    el("h3", {
      class: "small",
      style: "font-weight:640",
      text: "Downloaded search packages",
    }),
    packages,
    packageNotes,
  );
  const noteLines = new Map<string, HTMLElement>();
  // Whether the line of a language says that its package is saved in this
  // browser or that it is not. A line with no entry makes no such claim.
  const noteClaims = new Map<string, "saved" | "absent">();
  /**
   * Shows a line for a language. A quiet line, such as progress or a
   * remove that the list already shows, is not announced. An outcome or an
   * error is announced too, even after the reader left this page. A claim
   * records whether the line says that the package is saved.
   */
  const packageNote = (
    language: string,
    message: string,
    kind: "quiet" | "outcome" | "error",
    claim?: "saved" | "absent",
  ) => {
    if (kind !== "quiet") app.announce(message);
    if (!context.live()) return;
    let line = noteLines.get(language);
    if (!line) {
      line = el("p", { "data-package-note": language });
      noteLines.set(language, line);
      packageNotes.append(line);
    }
    line.className = kind === "error" ? "notice" : "small";
    line.textContent = message;
    if (claim) noteClaims.set(language, claim);
    else noteClaims.delete(language);
  };
  /**
   * Another tab can save or remove a package. When a shown list reads a
   * state that a line contradicts, the line takes the state of the list.
   */
  const reconcileNotes = (keys: string[]) => {
    for (const [language, claim] of noteClaims) {
      const stored = keys.includes(language);
      if (claim === "saved" && !stored)
        packageNote(
          language,
          `The ${languageName(language)} package is no longer saved in this browser.`,
          "quiet",
          "absent",
        );
      else if (claim === "absent" && stored)
        packageNote(
          language,
          `The ${languageName(language)} package is saved in this browser.`,
          "quiet",
          "saved",
        );
    }
  };
  const mebibytes = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`;
  /** The progress line of one running download or refresh. */
  const progressText = (
    verb: "Downloading" | "Refreshing",
    language: string,
    progress: PackageProgress | null,
  ) =>
    progress === null
      ? `${verb} the ${languageName(language)} package: reading its index.`
      : `${verb} the ${languageName(language)} package: ${mebibytes(progress.bytes)} of ${mebibytes(progress.totalBytes)}, part ${progress.parts} of ${progress.totalParts}.`;
  // Languages with a package download or refresh running on this page,
  // each with the token of the run that set the mark. A run clears the
  // mark only while it still holds its own token, so an older run cannot
  // clear the mark of a newer run of the same language. Refresh buttons
  // of a marked language are disabled, and Download is disabled while the
  // picked language is marked. Every change of a mark updates the shown
  // buttons at once, so they always match the marks.
  const runningPackages = new Map<string, symbol>();
  const startRun = (language: string) => {
    const token = Symbol(language);
    runningPackages.set(language, token);
    syncPackageButtons();
    return token;
  };
  const endRun = (language: string, token: symbol) => {
    if (runningPackages.get(language) !== token) return;
    runningPackages.delete(language);
    syncPackageButtons();
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
  /** Sets every shown Refresh button and Download from the running marks. */
  const syncPackageButtons = () => {
    for (const refresh of packages.querySelectorAll<HTMLButtonElement>(
      '[data-package-control="refresh"]',
    ))
      refresh.disabled = runningPackages.has(
        refresh.dataset.packageLanguage ?? "",
      );
    syncDownloadButton();
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
   * again. `endRun` has already updated the shown buttons in place. Focus
   * moves only under the rule of `focusIsFree`, and never to a disabled
   * button.
   */
  const endFailedRun = (
    own: HTMLButtonElement,
    language: string,
    kinds: [string, string?][],
    hadFocus: boolean,
  ) => {
    const mayFocus = hadFocus && focusIsFree(own);
    syncPackageButtons();
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
   * The row checks of a published list run in one task after the list is
   * shown. A dropped list runs none. Returns the number of this render
   * and, for a published list, the element that had focus just before the
   * replacement.
   */
  const renderPackages = async (): Promise<RenderResult> => {
    const render = ++renderCount;
    const list = document.createDocumentFragment();
    const checks: (() => void)[] = [];
    const keys = await buildPackages(list, checks);
    if (render !== renderCount || !context.live())
      return { render, published: false, focusedAtPublish: null };
    const focusedAtPublish = document.activeElement;
    const focused = controlKey(focusedAtPublish);
    const livePicker = findControl<HTMLSelectElement>("picker");
    if (livePicker) pickedPackage = livePicker.value;
    const newPicker = findControl<HTMLSelectElement>("picker", "", list);
    if (
      newPicker &&
      [...newPicker.options].some((option) => option.value === pickedPackage)
    )
      newPicker.value = pickedPackage;
    packages.replaceChildren(list);
    if (keys) reconcileNotes(keys);
    // A run may have started or ended while the list was built, so every
    // button takes the running marks as they are now.
    syncPackageButtons();
    if (checks.length)
      setTimeout(() => {
        for (const check of checks)
          try {
            check();
          } catch (error) {
            // One failed check does not stop the checks of later rows.
            reportError(error);
          }
      });
    if (focused) {
      const [kind, language] = focused.split(":");
      const copy = findControl<HTMLButtonElement | HTMLSelectElement>(
        kind,
        language,
      );
      if (copy && !copy.disabled) copy.focus({ preventScroll: true });
    }
    return { render, published: true, focusedAtPublish };
  };
  /**
   * Ends a run that rendered the list. The handler may move focus only if
   * its render published and is still the newest, and the focus that the
   * publish step saw was the handler's own button or no control. If the
   * reader had moved focus to another control that the new list lacks,
   * focus stays on the page. Then `refocusPackageButton` applies its own
   * rule.
   */
  const endRenderedRun = (
    result: RenderResult,
    own: HTMLButtonElement,
    mayFocus: boolean,
    kinds: [string, string?][],
  ) => {
    const seen = result.focusedAtPublish;
    const free = seen === null || seen === document.body || seen === own;
    refocusPackageButton(
      mayFocus && result.published && result.render === renderCount && free,
      kinds,
    );
  };
  /** Builds the list and returns the saved languages that it read. */
  const buildPackages = async (
    list: DocumentFragment,
    checks: (() => void)[],
  ): Promise<string[] | null> => {
    if (!session.storageAvailable) {
      list.append(
        p(
          "Browser storage is unavailable. Packages cannot be saved.",
          "notice",
        ),
      );
      return null;
    }
    const keys = await app.store.keys("packages");
    for (const key of keys) {
      // An unusable package keeps its row and Remove control, with the
      // invalid-package message in place of its definition count.
      let cached: CachedPackage | null = null;
      let invalid = false;
      try {
        cached = savedPackage(await app.store.get("packages", key));
      } catch (error) {
        if (!(error instanceof PackageValidationError)) throw error;
        invalid = true;
      }
      const detail = el("small", {
        text: invalid
          ? INVALID_PACKAGE_MESSAGE
          : cached
            ? "Checking saved package…"
            : "unreadable",
      });
      const row = el("div", { class: "row" });
      row.append(
        el("span", { class: "t" }, text(languageName(key)), detail),
        button(
          "Remove",
          async () => {
            // The delete writes a new package revision, so a download or
            // refresh that is still running cannot save over this remove.
            await app.store.delete("packages", key);
            packageNote(
              key,
              `The ${languageName(key)} package is removed from this browser.`,
              "quiet",
              "absent",
            );
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
      // Show the Remove control first. Give the count after the row checks pass.
      const pkg = cached;
      if (pkg)
        checks.push(() => {
          try {
            const spellings = savedSpellingChecks();
            for (const entry of pkg.entries)
              spellings.add(savedRow(entry, pkg.version, key).word.spelling);
            spellings.finish();
            detail.textContent = `${plural(pkg.entries.length, "definition")} · snapshot ${pkg.snapshot.slice(7, 19)}… · version ${pkg.version ?? 1}${
              pkg.downgrade
                ? `. Version 1 was saved instead of version 2: ${packageCause(pkg.downgrade)}`
                : ""
            }`;
          } catch (error) {
            if (!(error instanceof PackageValidationError)) throw error;
            detail.textContent = INVALID_PACKAGE_MESSAGE;
          }
        });
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
          // Read focus before the mark disables the button.
          const hadFocus = document.activeElement === go;
          const token = startRun(language);
          let rendered = false;
          // Set when the outcome line is written. A later error, such as a
          // failed list read, must not replace that true line.
          let reported = false;
          try {
            packageNote(
              language,
              progressText("Downloading", language, null),
              "quiet",
            );
            const expected = await app.store.packageRevisionOf(language);
            const pkg = await downloadPackage(language, {
              onProgress: (progress) =>
                packageNote(
                  language,
                  progressText("Downloading", language, progress),
                  "quiet",
                ),
            });
            packageNote(
              language,
              `Saving the ${languageName(language)} package in this browser.`,
              "quiet",
            );
            // A remove or another save of this package that committed
            // while the download ran wins; this save then does nothing.
            const saved = await app.store.put(
              "packages",
              language,
              pkg,
              expected ?? null,
            );
            packageNote(
              language,
              !saved
                ? `The ${languageName(language)} search package was not saved. It changed in this browser while the download ran.`
                : pkg.downgrade
                  ? // The row names the current version. This line names
                    // only what this download saved, so it stays true after
                    // another tab refreshes the package.
                    `The ${languageName(language)} search package is saved in this browser. This download saved version 1 because version 2 failed: ${pkg.downgrade}`
                  : `The ${languageName(language)} search package is saved in this browser.`,
              saved ? "outcome" : "error",
              saved ? "saved" : undefined,
            );
            reported = true;
            // Clear the running mark before the render, so the new
            // buttons for this language render enabled.
            endRun(language, token);
            const mayFocus = hadFocus && focusIsFree(go);
            const render = await renderPackages();
            rendered = true;
            endRenderedRun(render, go, mayFocus, [
              ["download"],
              ["refresh", language],
            ]);
          } catch (error) {
            // A full store reports its own message instead of a raw quota error.
            if (reported) {
              app.announce(describe(reportPackageError(error)));
              return;
            }
            // The line stays after the state changes, so it names the
            // package and the attempt in the past tense before the cause.
            packageNote(
              language,
              `The ${languageName(language)} package was not downloaded: ${describe(reportPackageError(error))}`,
              "error",
            );
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
    } else if (manifestError !== null)
      list.append(
        p(
          keys.length
            ? "The packages that the server offers are listed when it answers."
            : "No package is saved in this browser. The packages that the server offers are listed when it answers.",
          "small",
        ),
      );
    else if (!keys.length && packagesAvailable)
      list.append(p("This server offers no search package yet.", "small"));
    for (const key of keys)
      if (manifestLanguages.includes(key)) {
        const refresh = button(
          `Refresh ${languageName(key)}`,
          async () => {
            if (runningPackages.has(key)) return;
            // Read focus before the mark disables the button.
            const hadFocus = document.activeElement === refresh;
            const token = startRun(key);
            refresh.disabled = true;
            let rendered = false;
            // Set when the outcome line is written. A later error, such as
            // a failed list read, must not replace that true line.
            let reported = false;
            packageNote(key, progressText("Refreshing", key, null), "quiet");
            try {
              const expected = await app.store.packageRevisionOf(key);
              const stored = await app.store.keys("packages");
              if (!stored.includes(key)) {
                // This row is stale: the package was removed, in this
                // tab or another one. Refresh updates a saved package,
                // so it does not bring one back. Download adds it again.
                packageNote(
                  key,
                  `The ${languageName(key)} package is no longer saved in this browser.`,
                  "outcome",
                  "absent",
                );
                reported = true;
                endRun(key, token);
                const mayFocus = hadFocus && focusIsFree(refresh);
                const render = await renderPackages();
                rendered = true;
                endRenderedRun(render, refresh, mayFocus, [["download"]]);
                return;
              }
              const pkg = await downloadPackage(key, {
                onProgress: (progress) =>
                  packageNote(
                    key,
                    progressText("Refreshing", key, progress),
                    "quiet",
                  ),
              });
              packageNote(
                key,
                `Saving the ${languageName(key)} package in this browser.`,
                "quiet",
              );
              // A remove or another save of this package that committed
              // while the refresh ran wins; this save then does nothing.
              const saved = await app.store.put(
                "packages",
                key,
                pkg,
                expected ?? null,
              );
              packageNote(
                key,
                saved
                  ? `The ${languageName(key)} package is refreshed.`
                  : `The ${languageName(key)} package was not saved. It changed in this browser while the refresh ran.`,
                saved ? "outcome" : "error",
                saved ? "saved" : undefined,
              );
              reported = true;
              endRun(key, token);
              const mayFocus = hadFocus && focusIsFree(refresh);
              const render = await renderPackages();
              rendered = true;
              endRenderedRun(render, refresh, mayFocus, [
                ["refresh", key],
                ["download"],
              ]);
            } catch (error) {
              // A full store reports its own message instead of a raw quota error.
              if (reported) {
                app.announce(describe(reportPackageError(error)));
                return;
              }
              // The line names only what this refresh did. The reader or
              // another tab can remove the package while it runs, so the
              // line claims nothing about a saved package. It gives the
              // cause without the recovery instruction of a failed download.
              packageNote(
                key,
                `The ${languageName(key)} package was not refreshed. This refresh changed nothing in this browser: ${packageCause(describe(reportPackageError(error)))}`,
                "error",
              );
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
    return keys;
  };
  await renderPackages();
  if (!context.live()) return;
  // Delivery peers.
  main.append(el("h2", { class: "section", text: "Delivery" }));
  let serverId: string | null = null;
  try {
    serverId = (await getCapabilities({ signal: context.signal })).server_id;
  } catch {}
  if (!context.live()) return;
  main.append(
    p(
      serverId === null
        ? `Publications go to one server at ${selfPeer.label}. Its server name did not load. Sending a signed record to a server publishes it there.`
        : `Publications go to one server: ${serverId} at ${selfPeer.label}. Sending a signed record to a server publishes it there.`,
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
  // The outcome of the request stays in place under the button.
  const persistNote = p("", "small");
  persistNote.hidden = true;
  const persistOutcome = (message: string, error: boolean) => {
    app.announce(message);
    if (!context.live()) return;
    persistNote.className = error ? "notice" : "small";
    persistNote.textContent = message;
    persistNote.hidden = false;
  };
  main.append(
    el(
      "div",
      { class: "actions" },
      button(
        "Request persistent storage",
        async () => {
          try {
            const granted = await navigator.storage?.persist?.();
            persistOutcome(
              granted
                ? "Persistent storage granted."
                : "The browser did not grant persistent storage.",
              false,
            );
          } catch (error) {
            persistOutcome(
              `The request for persistent storage failed: ${describe(error)}`,
              true,
            );
          }
          await describeStorage();
        },
        { class: "btn" },
      ),
    ),
    persistNote,
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
  const themeNote = controlNote();
  syncSelect("theme", theme.input, themeNote);
  theme.input.addEventListener("change", async () => {
    const value = theme.input.value as "system" | "light" | "dark";
    await save(
      "theme",
      { theme: value },
      () => {
        theme.input.value = session.preferences.theme;
      },
      themeNote,
    );
  });
  main.append(theme.wrapper, themeNote);
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
  const orthographyNote = controlNote();
  syncSelect("orthography", orthography.input, orthographyNote);
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
        orthographyNote,
      ),
  );
  main.append(orthography.wrapper, orthographyNote);
  const judgmentsNote = controlNote();
  const judgments = checkbox(
    "Show my judgments first on word pages",
    prefs.myJudgmentsFirst,
    async (value) => {
      await save(
        "myJudgmentsFirst",
        { myJudgmentsFirst: value },
        () => {
          judgmentsInput.checked = session.preferences.myJudgmentsFirst;
        },
        judgmentsNote,
      );
    },
  );
  const judgmentsInput = judgments.querySelector("input")!;
  track(() => {
    if (saves.has("myJudgmentsFirst")) return;
    const value = session.preferences.myJudgmentsFirst;
    if (judgmentsInput.checked === value) return;
    judgmentsInput.checked = value;
    judgmentsNote.hidden = true;
  });
  // The order uses the judgments that your key signed, so it needs a key.
  const judgmentsHint = el("p", {
    class: "hint",
    id: "judgments-first-hint",
    text: "Uses the judgments that your key signed. Without a key, the order does not change.",
  });
  judgmentsInput.setAttribute("aria-describedby", judgmentsHint.id);
  main.append(judgments, judgmentsHint, judgmentsNote);
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
