import { kindLabel } from "../model/types.ts";
import { changeTypedWord } from "../model/typed-headword.ts";
/** Optional assistance. Provider data is inert, private, and separate from publication. */
import {
  button,
  checkbox,
  describe,
  download,
  el,
  link,
  p,
  text,
} from "../lib/dom.ts";
import type { App } from "../app/context.ts";
import { navigate, routes, type RenderContext } from "../app/router.ts";
import {
  getCapabilities,
  selfPeer,
  readBounded,
  loadDefinition,
} from "../data/api.ts";
import {
  assistanceLog,
  assistanceLogJson,
  assistanceLogRows,
  assistanceLogMarkdown,
  applyMapping,
  mappingRecordMatches,
  retainAssistance,
  storeAssistanceRecord,
  currentDraft,
  draftFingerprint,
  applyProposals,
  validateSuggestion,
  undoPatches,
  restorePatches,
  mappingKind,
  hintLabel,
  sourceProposal,
  captureSourceTarget,
  sourceTargetMatches,
  type SourceTarget,
  type AssistanceRecord,
  type Current,
  type Operation,
  type Suggestion,
} from "../model/assistance.ts";
import { richTextToText, renderRichText } from "../model/richtext.ts";
import {
  draftFromBody,
  editorToRichText,
  revisionChanges,
  type Draft,
} from "../model/draft.ts";
import {
  setSourceAiNoteGroup,
  sourceNotes,
  type GismuRowState,
} from "../model/builders.ts";
import { confirmKindChange, type DraftSaver } from "../pages/wizard/common.ts";

export interface AssistanceProfile {
  id: string;
  label: string;
  provider: string;
  model: string;
  operations: Operation[];
  disclosure: string;
}
interface ConsentProfile extends Omit<AssistanceProfile, "disclosure"> {
  disclosure: {
    server: string;
    provider: string;
    tasks: string[];
    data_scope: string[];
    scope: string;
    statement: string;
  };
}
const sentFields = [
  "original meaning",
  "definition language",
  "word type and classification",
  "chosen spelling",
  "current definition and places",
  "glosses",
  "source words and weights",
  "components and rafsi constraints",
  "selected exact definitions",
];
export function assistanceProfiles(
  capabilities: Awaited<ReturnType<typeof getCapabilities>>,
): ConsentProfile[] {
  if (!capabilities.features.assistance) return [];
  const profiles = capabilities.assistance_profiles.filter(
    (p): p is AssistanceProfile => {
      const v = p as AssistanceProfile;
      return (
        !!v &&
        typeof v.id === "string" &&
        typeof v.label === "string" &&
        typeof v.provider === "string" &&
        typeof v.model === "string" &&
        typeof v.disclosure === "string" &&
        Array.isArray(v.operations) &&
        v.operations.every((o) =>
          [
            "type",
            "lujvo",
            "gismu-sources",
            "cmavo-class",
            "definition",
            "places-glosses",
          ].includes(o),
        )
      );
    },
  );
  return profiles.map((p) => ({
    ...p,
    disclosure: {
      server: capabilities.server_id,
      provider: p.provider,
      tasks: [
        ...new Set(
          profiles
            .filter((other) => other.provider === p.provider)
            .flatMap((other) => other.operations),
        ),
      ],
      data_scope: sentFields,
      statement: p.disclosure,
      scope: JSON.stringify({
        server: capabilities.server_id,
        model: p.model,
        disclosure: p.disclosure,
      }),
    },
  }));
}
/** One capability read controls every AI decoration on the current page. */
class AssistanceVisibility {
  profiles: ConsentProfile[] = [];
  ready = false;
  private pending: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  constructor(
    private app: App,
    private context: RenderContext,
  ) {
    const unsubscribe = app.session.subscribe(() => this.changed());
    context.signal.addEventListener(
      "abort",
      () => {
        unsubscribe();
        this.listeners.clear();
      },
      { once: true },
    );
    void this.refresh();
  }
  get enabled() {
    return (
      this.ready &&
      this.profiles.length > 0 &&
      this.app.session.preferences.useAiAssistance !== false
    );
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    listener();
    return () => this.listeners.delete(listener);
  }
  bind(node: HTMLElement) {
    node.hidden = true;
    return this.subscribe(() => {
      node.hidden = !this.enabled;
    });
  }
  private changed() {
    if (this.context.live()) for (const listener of this.listeners) listener();
  }
  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = getCapabilities({ signal: this.context.signal })
      .then((capabilities) => {
        this.profiles = assistanceProfiles(capabilities);
        this.ready = true;
        this.changed();
      })
      .catch(() => {
        if (this.context.signal.aborted) return;
        this.profiles = [];
        this.ready = true;
        this.changed();
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
}
const visibilityByContext = new WeakMap<RenderContext, AssistanceVisibility>();
export function assistanceVisibility(app: App, context: RenderContext) {
  let visibility = visibilityByContext.get(context);
  if (!visibility) {
    visibility = new AssistanceVisibility(app, context);
    visibilityByContext.set(context, visibility);
  }
  return visibility;
}
function showDialog(
  dialog: HTMLDialogElement,
  opener = document.activeElement as HTMLElement | null,
) {
  dialog.addEventListener(
    "close",
    () => {
      dialog.remove();
      if (opener?.isConnected) opener.focus();
    },
    { once: true },
  );
  document.body.append(dialog);
  dialog.showModal();
}
async function consent(
  app: App,
  profile: ConsentProfile,
  signal: AbortSignal,
  opener: HTMLElement | null,
): Promise<boolean> {
  const d = profile.disclosure;
  const prior = app.session.preferences.aiConsents ?? [];
  if (
    prior.some(
      (c) =>
        c.provider === d.provider &&
        c.scope === d.scope &&
        d.tasks.every((t) => c.tasks.includes(t)) &&
        d.data_scope.every((s) => c.dataScope.includes(s)),
    )
  )
    return true;
  return new Promise((resolve) => {
    const dialog = el("dialog", {
      class: "sheet",
      "aria-labelledby": "ai-consent-title",
    });
    const accept = button(
      "Allow these tasks",
      async () => {
        try {
          await app.session.setPreferences({
            aiConsents: [
              ...prior,
              {
                provider: d.provider,
                scope: d.scope,
                tasks: [...d.tasks],
                dataScope: [...d.data_scope],
              },
            ],
          });
          dialog.close("allowed");
        } catch (error) {
          status.textContent = describe(error);
        }
      },
      { class: "btn btn-primary" },
    );
    const status = p("", "notice");
    dialog.append(
      el("h2", { id: "ai-consent-title", text: "Before using AI assistance" }),
      p(`Server: ${d.server}. Provider: ${d.provider}.`),
      p(`Declared tasks: ${d.tasks.join(", ")}.`),
      p(`Fields sent: ${d.data_scope.join(", ")}.`),
      p(
        `Scope: ${d.statement}. Your draft leaves this browser only when you choose an AI action.`,
      ),
      p(
        "Type suggestions can also send public dictionary definitions that the server finds for your meaning.",
      ),
      p(
        "Suggestions and their logs stay with this private draft. Selected content is published only when you publish it.",
        "small",
      ),
      status,
      el(
        "div",
        { class: "actions" },
        accept,
        button("Not now", () => dialog.close("cancel"), {
          class: "btn btn-quiet",
        }),
      ),
    );
    const abort = () => dialog.close("cancel");
    signal.addEventListener("abort", abort, { once: true });
    dialog.addEventListener(
      "close",
      () => {
        signal.removeEventListener("abort", abort);
        resolve(dialog.returnValue === "allowed");
      },
      { once: true },
    );
    showDialog(dialog, opener);
    accept.focus();
  });
}
const json = (value: unknown) => JSON.stringify(value, null, 2);
function failureMessage(
  message = "No usable answer.",
  operation?: Operation,
  serviceCode?: string,
) {
  if (
    /(?:Try again or|You can) fill the (?:fields|rows) in by hand\.$/.test(
      message.trimEnd(),
    )
  )
    return message;
  const target = operation === "gismu-sources" ? "rows" : "fields";
  const guidance = serviceCode ? "You can" : "Try again or";
  return `${message}${/[.!?]$/.test(message) ? "" : "."} ${guidance} fill the ${target} in by hand.`;
}
export function inferenceLog(record: AssistanceRecord, draft?: Draft) {
  const log = assistanceLog(record, draft);
  const dialog = el("dialog", {
    class: "sheet ai-log",
    "aria-labelledby": "ai-log-title",
  });
  dialog.append(
    el("h2", { id: "ai-log-title", text: "How the assistant decided" }),
  );
  let section: HTMLElement = dialog;
  for (const row of assistanceLogRows(record, log)) {
    if (row.kind === "heading") {
      section = dialog;
      if (row.collapsed) {
        section = el("details", {}, el("summary", { text: row.text }));
        dialog.append(section);
      } else
        dialog.append(el(`h${row.level ?? 3}` as "h3", { text: row.text }));
    } else if (row.kind === "code")
      section.append(el("pre", { text: row.text }));
    else if (row.kind === "link")
      section.append(
        link(row.text, row.href!, {
          target: "_blank",
          rel: "noopener noreferrer",
        }),
      );
    else section.append(p(row.text));
  }
  const close = button("Close", () => dialog.close(), { class: "btn" });
  dialog.append(
    el(
      "div",
      { class: "actions" },
      button(
        "Export as Markdown",
        () =>
          download(
            `jbovlacku-ai-${record.id}.md`,
            assistanceLogMarkdown(record, log),
            "text/markdown",
          ),
        { class: "btn" },
      ),
      button(
        "Export raw JSON",
        () =>
          download(
            `jbovlacku-ai-${record.id}.json`,
            assistanceLogJson(record, draft),
            "application/json",
          ),
        { class: "btn" },
      ),
      close,
    ),
  );
  showDialog(dialog);
  close.focus();
}
interface ActionOptions {
  key: string;
  label: string;
  operation: Operation;
  profile?: string;
  current?: () => Current;
  apply?: (draft: Draft, result: Suggestion) => void;
  sourceRow?: () => GismuRowState | undefined;
}
function snapshot(draft: Draft): Partial<Draft> {
  const { ai, revision, updatedAt, ...rest } = draft;
  void ai;
  void revision;
  void updatedAt;
  return structuredClone(rest);
}
const runners = new WeakMap<HTMLElement, () => Promise<boolean>>();
export async function runAssistance(control: HTMLElement) {
  return (await runners.get(control)?.()) ?? false;
}
export function assistanceAction(
  app: App,
  draft: Draft,
  saver: DraftSaver,
  context: RenderContext,
  options: ActionOptions,
): HTMLElement {
  const box = el("div", { class: "ai-action", "data-ai-action": options.key });
  const status = el("span", {
    class: "sr",
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true",
  });
  const content = el("div");
  box.append(status, content);
  const focusControl = () =>
    (
      content.querySelector<HTMLElement>(
        ".ai-suggestion .btn-primary:not([disabled])",
      ) ??
      content.querySelector<HTMLElement>(
        '.ai-suggestion input[type="checkbox"]',
      ) ??
      content.querySelector<HTMLElement>(".ai-suggestion") ??
      content.querySelector<HTMLElement>("[data-ai-focus]:not([disabled])")
    )?.focus();
  let workingLine: HTMLElement | null = null;
  let workingText: HTMLElement | null = null;
  let showIdle = false;
  let disposed = false;
  let profile: ConsentProfile | undefined;
  interface Run {
    controller: AbortController;
    job: string | null;
    csrf: string;
    signal: AbortSignal;
    resultStored: boolean;
  }
  let active: Run | null = null;
  let working = false;
  let progress = "The assistant is working.";
  let record = (draft.ai?.records ?? []).findLast((r) => r.key === options.key);
  const visibility = assistanceVisibility(app, context);
  const enabled = () => !disposed && visibility.enabled && !!profile;
  const save = () => {
    if (draft.ai) draft.ai.changes = (draft.ai.changes ?? 0) + 1;
    retainAssistance(draft);
    saver.touch();
    box.dispatchEvent(new CustomEvent("assist-change", { bubbles: true }));
  };
  const refreshPage = async () => {
    if (await saver.flush())
      navigate(`${location.pathname}${location.search}`, { replace: true });
  };
  const logButton = (r: AssistanceRecord) =>
    button("How the assistant decided", () => inferenceLog(r, draft), {
      class: "btn btn-quiet small",
    });
  const storeRecord = (r: AssistanceRecord) => {
    storeAssistanceRecord(draft, r);
    record = r;
    save();
  };
  const apply = (
    target: Draft,
    result: Suggestion,
    sourceTarget?: SourceTarget,
  ) => {
    if (
      result.operation === "gismu-sources" &&
      (!sourceTarget || !sourceTargetMatches(target, sourceTarget))
    )
      throw new Error("This source row changed. Request a new suggestion.");
    if (options.apply) options.apply(target, result);
    else applyProposals(target, result);
  };
  async function acknowledge(run: Run) {
    if (!run.job) return;
    try {
      await fetch(`${selfPeer.base}/jobs/${encodeURIComponent(run.job!)}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "X-CSRF-Token": run.csrf },
        signal: AbortSignal.timeout(10000),
      });
    } catch {}
  }
  const cancel = async () => {
    const run = active;
    if (!run || run.resultStored) return;
    active = null;
    working = false;
    run.controller.abort();
    if (context.live()) {
      status.textContent = "Canceled.";
      render();
    }
    await acknowledge(run);
  };
  const abortRun = () => void cancel();
  context.signal.addEventListener("abort", abortRun, { once: true });
  box.addEventListener("assist-cancel", () => void cancel());

  function mappingControl(
    index: number,
    canApply: () => boolean,
    derivation: NonNullable<
      Current["frame"]
    >["places"][number]["derivation"][number],
  ): HTMLElement {
    const legacyKey = `${options.key}:mapping:${index}:${derivation.word.spelling}:${derivation.place}`;
    const key = `${legacyKey}:${derivation.definition ?? ""}`;
    const definitionLabel = derivation.definition
      ? ` from ${derivation.definition}`
      : "";
    const prior = draft.ai?.records.findLast(
      (r) =>
        mappingRecordMatches(r, key, legacyKey, derivation) &&
        r.state === "accepted",
    );
    if (prior)
      return button(
        "Undo mapping",
        async () => {
          restorePatches(draft, prior);
          prior.state = "undone";
          save();
          await saver.flush();
          await refreshPage();
        },
        {
          class: "btn btn-quiet",
          "aria-label": `Undo mapping ${derivation.word.spelling} ${derivation.place} to place ${index}${definitionLabel}`,
        },
      );
    const target = draft.places.find((p) => p.index === index);
    if (
      target?.derivations.some(
        (d) =>
          d.word === derivation.word.spelling &&
          d.place === derivation.place &&
          d.definition === derivation.definition,
      )
    )
      return text("In this row", "meta");
    return button(
      "Add",
      async () => {
        if (!canApply() || !record?.result) return;
        const before = snapshot(draft);
        try {
          applyMapping(draft, index, derivation);
        } catch (error) {
          app.announce(describe(error));
          return;
        }
        const after = snapshot(draft);
        storeAssistanceRecord(draft, {
          ...record,
          id: crypto.randomUUID(),
          key,
          label: `Add ${derivation.word.spelling} ${derivation.place} to place ${index}${definitionLabel}`,
          state: "accepted",
          result: null,
          log: null,
          log_json: undefined,
          log_id: record.log_id ?? record.id,
          patches: undoPatches(before, after),
          before,
          after,
        });
        save();
        await refreshPage();
      },
      {
        class: "btn btn-quiet",
        "aria-label": `Add ${derivation.word.spelling} ${derivation.place} to place ${index}${definitionLabel}`,
        disabled: !target || !canApply(),
      },
    );
  }
  function renderProposal(result: Suggestion, canApply: () => boolean) {
    const section = el("div", { class: "ai-proposals" });
    for (const proposal of result.proposals) {
      const title = proposal.path.replace(/^\//, "").replaceAll("/", " · ");
      section.append(el("h3", { class: "small", text: title }));
      if (proposal.path === "/text")
        section.append(renderRichText(proposal.value, { placeHref: null }));
      else if (proposal.path === "/frame" && proposal.value) {
        const frame = proposal.value as NonNullable<Current["frame"]>;
        const table = el(
          "table",
          { class: "small" },
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              ...["Place", "Description", "Gloss", "Kind of thing", "From"].map(
                (t) => el("th", { scope: "col", text: t }),
              ),
            ),
          ),
        );
        for (const place of frame.places ?? [])
          table.append(
            el(
              "tr",
              {},
              el("td", { text: String(place.index) }),
              el(
                "td",
                {},
                renderRichText(place.description, { placeHref: null }),
              ),
              el("td", {
                text: (place.glosses ?? [])
                  .map((g) => `${g.text}${g.sense ? ` (${g.sense})` : ""}`)
                  .join(", "),
              }),
              el(
                "td",
                {},
                ...((place.type_hints ?? []).length
                  ? (place.type_hints ?? []).map((h) =>
                      el(
                        "div",
                        {},
                        p(
                          h.alternatives
                            .map((a) => a.tags.join(" and "))
                            .join(" or ") || "unspecified",
                        ),
                        renderRichText(h.note, { placeHref: null }),
                      ),
                    )
                  : [text("unspecified")]),
              ),
              el(
                "td",
                {},
                ...(place.derivation ?? []).map((d) =>
                  el(
                    "div",
                    {},
                    p(
                      `${d.word.spelling} ${d.place}${mappingKind(d.explanation) ? ` · ${mappingKind(d.explanation)}` : ""}`,
                    ),
                    renderRichText(d.explanation, { placeHref: null }),
                    mappingControl(place.index, canApply, d),
                  ),
                ),
              ),
            ),
          );
        section.append(el("div", { class: "table-scroll" }, table));
      } else if (proposal.path === "/formation/sources") {
        const source = sourceProposal(result);
        const row = options.sourceRow?.();
        if (!row) continue;
        section.append(
          p(
            `${row.language}: ${(source.word ?? row.word) || "No single source word"}.`,
          ),
        );
        const table = el("table", { class: "small ai-source-preview" });
        table.append(
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              ...["Field", "Before", "After acceptance"].map((label) =>
                el("th", { scope: "col", text: label }),
              ),
            ),
          ),
        );
        const values: [string, string, unknown][] = [
          ["Word", "word", row.word],
          ["Said", "word_ipa", row.word_ipa],
          ["Stem (private)", "stem", row.stem],
          ["Stem said (private)", "ipa", row.ipa],
          [
            "Letters",
            "input",
            row.inputOriginal ??
              (row.input ? { format: "lojbanized", text: row.input } : null),
          ],
        ];
        const show = (value: unknown) =>
          value == null || value === ""
            ? "empty"
            : typeof value === "string"
              ? value
              : json(value);
        for (const [label, key, before] of values) {
          const proposed = Object.hasOwn(source, key);
          const after = proposed ? source[key as keyof typeof source] : before;
          table.append(
            el(
              "tr",
              {},
              el("th", { scope: "row", text: label }),
              el("td", { text: show(before) }),
              el("td", {
                text: `${show(after)}${proposed ? " (proposed)" : " (retained)"}`,
              }),
            ),
          );
        }
        section.append(el("div", { class: "table-scroll" }, table));
        const beforeNotes = sourceNotes(row);
        const groupIndexes = new Set(
          row.aiNoteGroup?.map((entry) => entry.index) ?? [],
        );
        section.append(
          el("h4", { class: "small", text: "New AI notes" }),
          source.notes.length
            ? renderRichText(source.notes, { placeHref: null })
            : p(
                "No new AI notes. The earlier AI group will be removed.",
                "meta",
              ),
        );
        section.append(
          el("h4", { class: "small", text: "Authored notes retained" }),
          renderRichText(
            beforeNotes.filter((_, index) => !groupIndexes.has(index)),
            { placeHref: null },
          ),
        );
        if (row.aiNoteGroup?.length)
          section.append(
            el("h4", { class: "small", text: "Earlier AI notes replaced" }),
            renderRichText(
              row.aiNoteGroup.map((entry) => entry.paragraph),
              { placeHref: null },
            ),
          );
      } else if (proposal.path === "/glosses")
        for (const g of proposal.value as Current["glosses"])
          section.append(p(`${g.text}${g.sense ? ` (${g.sense})` : ""}`));
      else
        section.append(
          el("pre", {
            text:
              typeof proposal.value === "string"
                ? proposal.path === "/word_type"
                  ? kindLabel(proposal.value)
                  : proposal.value
                : json(proposal.value),
          }),
        );
    }
    return section;
  }
  function existingWordBlock(r: AssistanceRecord): HTMLElement | null {
    const result = r.result;
    if (result?.operation !== "type" || !result.existing) return null;
    const existing = result.existing;
    const block = el(
      "section",
      { class: "ai-existing", "aria-label": "Existing word" },
      p("Existing word: "),
      link(existing.word, routes.word(existing.word, draft.language), {
        lang: "jbo",
        class: "hw",
      }),
    );
    const converted = existing.conversion
      ? `${existing.conversion} ${existing.word}`
      : null;
    if (converted) block.append(p(converted));
    const startExistingDraft = async (revise: boolean) => {
      try {
        if (!(await saver.flush()) || !context.live()) return;
        const publication = await loadDefinition(existing.event);
        if (!context.live()) return;
        if (
          !publication.body ||
          publication.body.word.spelling !== existing.word
        )
          throw new Error("The existing definition is unavailable.");
        const origin =
          publication.envelope.header.action.origin === "import"
            ? "import"
            : "native";
        const replacement = revise
          ? draftFromBody(
              publication.body,
              existing.event,
              origin,
              publication.rawBody,
            )
          : structuredClone(draft);
        if (revise)
          replacement.revisionNotice = revisionChanges(
            publication.body,
            origin,
          );
        else changeTypedWord(replacement, existing.word);
        if (revise) {
          const proposed: Suggestion = {
            ...result,
            operation: "definition",
            existing: undefined,
            proposals: [
              {
                path: "/text",
                value: editorToRichText(
                  existing.revised_definition!,
                  replacement.structured,
                ),
              },
            ],
            explanation:
              "Review the proposed definition. Use this applies it with undo.",
          };
          storeAssistanceRecord(replacement, {
            ...r,
            id: crypto.randomUUID(),
            key: "definition",
            label: "Rewrite definition",
            operation: "definition",
            fingerprint: draftFingerprint(replacement),
            requested: currentDraft(replacement),
            result: proposed,
            state: "done",
            patches: undefined,
            before: undefined,
            after: undefined,
          });
        }
        await app.store.switchDraft(draft.revision, replacement);
        saver.detach();
        navigate(revise ? "/new/editor" : "/new/type");
      } catch (error) {
        app.announce(describe(error));
      }
    };
    if (converted)
      block.append(
        button(
          `Use ${converted}`,
          async () => {
            if (await saver.flush())
              navigate(
                `${routes.word(existing.word, draft.language)}&conversion=${existing.conversion}`,
              );
          },
          { class: "btn" },
        ),
      );
    else if (existing.revised_definition === null)
      block.append(
        button("Add a definition", () => void startExistingDraft(false), {
          class: "btn",
        }),
      );
    if (existing.revised_definition !== null)
      block.append(
        p(existing.revised_definition),
        button("Revise this one", () => void startExistingDraft(true), {
          class: "btn",
        }),
      );
    return block;
  }
  function renderAccepted(r: AssistanceRecord) {
    content.append(
      el(
        "div",
        { class: "ai-accepted" },
        text("AI", "ai-tag"),
        text(` ${options.label} accepted. `),
        button(
          "Undo",
          async () => {
            const newer = restorePatches(draft, r);
            if (newer)
              app.announce(
                "Kept newer author edits while undoing the AI suggestion.",
              );
            r.state = "undone";
            save();
            await refreshPage();
          },
          { class: "btn btn-quiet", "aria-label": `Undo ${options.label}` },
        ),
        logButton(r),
        button(
          "Suggest again",
          () => {
            showIdle = true;
            render();
            const idle = content.lastElementChild;
            if (idle instanceof HTMLButtonElement) idle.focus();
          },
          { class: "btn btn-quiet", "data-ai-focus": "" },
        ),
      ),
    );
    const block = existingWordBlock(r);
    if (block) content.append(block);
  }
  function renderOtherMappingUndos(result?: Suggestion) {
    const frame = result
      ? (result.proposals.find((p) => p.path === "/frame")
          ?.value as Current["frame"])
      : null;
    for (const prior of draft.ai?.records ?? []) {
      if (
        prior.state !== "accepted" ||
        !prior.key.startsWith(`${options.key}:mapping:`)
      )
        continue;
      const rendered = frame?.places.some((place) =>
        place.derivation.some((mapping) => {
          const legacy = `${options.key}:mapping:${place.index}:${mapping.word.spelling}:${mapping.place}`;
          return mappingRecordMatches(
            prior,
            `${legacy}:${mapping.definition ?? ""}`,
            legacy,
            mapping,
          );
        }),
      );
      if (rendered) continue;
      content.append(
        el(
          "div",
          { class: "ai-accepted" },
          text(`${prior.label} accepted. `),
          button(
            "Undo mapping",
            async () => {
              restorePatches(draft, prior);
              prior.state = "undone";
              save();
              await refreshPage();
            },
            {
              class: "btn btn-quiet",
              "aria-label": `Undo mapping ${prior.label.replace(/^Add /, "")}`,
            },
          ),
          logButton(prior),
        ),
      );
    }
  }
  function render() {
    const focused =
      document.activeElement instanceof HTMLElement &&
      content.contains(document.activeElement);
    const replace = () => {
      if (focused) focusControl();
    };
    box.hidden = !enabled();
    if (!enabled()) return;
    if (working && workingLine?.isConnected) {
      workingText!.textContent = progress;
      return;
    }
    content.replaceChildren();
    workingLine = null;
    if (working) {
      workingText = text(progress);
      workingLine = el(
        "div",
        { class: "ai-working" },
        el("span", { class: "ai-spinner", "aria-hidden": "true" }),
        workingText,
        button("Cancel", () => void cancel(), {
          class: "btn btn-quiet",
          "data-ai-focus": "",
        }),
      );
      content.append(workingLine);
      replace();
      return;
    }
    if (record?.state !== "done" || showIdle) renderOtherMappingUndos();
    const accepted = draft.ai?.records.findLast(
      (r) => r.key === options.key && r.state === "accepted",
    );
    if (accepted && (showIdle || accepted !== record)) renderAccepted(accepted);
    const idle = () =>
      content.append(
        button(
          el("span", {}, text("AI", "ai-tag"), text(` ${options.label}`)),
          () => void start(),
          {
            class: "btn btn-quiet",
            "aria-label": options.label,
            "data-ai-focus": "",
          },
        ),
      );
    if (
      showIdle ||
      !record ||
      record.state === "dismissed" ||
      record.state === "undone"
    ) {
      idle();
      replace();
      return;
    }
    if (record.state === "accepted") {
      renderAccepted(record);
      replace();
      return;
    }
    if (record.state === "failed") {
      content.append(
        p(
          failureMessage(record.error || undefined, options.operation),
          "notice",
        ),
        button("Try again", () => void start(), {
          class: "btn btn-quiet",
          "data-ai-focus": "",
        }),
        logButton(record),
      );
      replace();
      return;
    }
    const result = record.result;
    if (!result) {
      idle();
      return;
    }
    const r = record;
    const hasProposal = result.proposals.length > 0;
    const panel = el(
      "section",
      {
        class: "card ai-suggestion",
        "aria-label": `${options.label} suggestion`,
        tabindex: "-1",
      },
      el("div", {}, text("AI", "ai-tag"), text(` ${options.label}`)),
      ...result.explanation.split(/\n\n/u).map((paragraph) => p(paragraph)),
      p(
        `${result.provenance.model} · ${result.provenance.provider} · prompt ${result.provenance.recipe}`,
        "meta",
      ),
    );
    const existingBlock = existingWordBlock(r);
    if (existingBlock) panel.append(existingBlock);
    const stale = draftFingerprint(draft) !== r.fingerprint;
    let reviewed = !stale;
    let reviewedFingerprint = draftFingerprint(draft);
    if (stale) {
      panel.append(
        p(
          "The draft changed while this suggestion was made. Compare the current fields with the suggestion before replacing them.",
          "notice",
        ),
        el(
          "details",
          {},
          el("summary", { text: "Current draft fields" }),
          el("pre", { text: json(options.current?.() ?? currentDraft(draft)) }),
        ),
      );
    }
    const sourceRow = options.sourceRow?.();
    const needsNoteChoice =
      result.operation === "gismu-sources" &&
      sourceRow &&
      !Object.hasOwn(sourceRow, "aiNoteGroup");
    if (needsNoteChoice) {
      const chosen = new Set<number>();
      panel.append(
        p(
          "Identify the earlier AI notes before accepting this source. Edited and authored notes stay with the row.",
          "notice",
        ),
      );
      sourceNotes(sourceRow).forEach((paragraph, index) =>
        panel.append(
          checkbox(
            `Earlier AI paragraph ${index + 1}: ${richTextToText([paragraph])}`,
            false,
            (checked) => (checked ? chosen.add(index) : chosen.delete(index)),
          ),
        ),
      );
      const establish = (indexes: number[]) => {
        const current = options.sourceRow?.();
        if (!current) return;
        setSourceAiNoteGroup(current, indexes);
        save();
        render();
      };
      panel.append(
        button(
          "Use the selected earlier AI notes",
          () => establish([...chosen]),
          { class: "btn btn-quiet" },
        ),
        button("No earlier AI notes", () => establish([]), {
          class: "btn btn-quiet",
        }),
      );
    }
    let invalid = "";
    try {
      if (!needsNoteChoice && hasProposal)
        apply(structuredClone(draft), result, r.sourceTarget);
    } catch (error) {
      invalid = describe(error);
    }
    renderOtherMappingUndos(invalid ? undefined : result);
    if (invalid) panel.append(el("pre", { text: json(result.proposals) }));
    const canApply = () => {
      if (!reviewed) return false;
      if (draftFingerprint(draft) !== reviewedFingerprint) {
        queueMicrotask(render);
        return false;
      }
      return true;
    };
    if (!invalid) panel.append(renderProposal(result, canApply));
    const accept = button(
      "Use this",
      async () => {
        if (!reviewed || needsNoteChoice) return;
        // Recheck at the time of the click. A late edit cannot bypass the stale comparison.
        if (draftFingerprint(draft) !== reviewedFingerprint) {
          render();
          return;
        }
        const before = snapshot(draft);
        const candidate = structuredClone(draft);
        if (result.operation === "type") {
          const kind = result.proposals.find((p) => p.path === "/word_type")
            ?.value as Draft["kind"];
          if (!confirmKindChange(candidate, kind)) return;
          if (before.kind !== kind) candidate.selmaho = [];
        }
        try {
          apply(candidate, result, r.sourceTarget);
        } catch (error) {
          app.announce(describe(error));
          return;
        }
        const after = snapshot(candidate);
        const keys = Object.keys(after).filter(
          (k) =>
            json((before as Record<string, unknown>)[k]) !==
            json((after as Record<string, unknown>)[k]),
        );
        r.patches = undoPatches(before, after);
        r.before = Object.fromEntries(
          keys.map((k) => [k, (before as Record<string, unknown>)[k]]),
        );
        r.after = Object.fromEntries(
          keys.map((k) => [k, (after as Record<string, unknown>)[k]]),
        );
        Object.assign(draft, r.after);
        r.state = "accepted";
        save();
        await refreshPage();
      },
      { class: "btn btn-primary" },
    );
    accept.disabled = !reviewed || !!invalid || !!needsNoteChoice;
    if (stale)
      panel.append(
        checkbox(
          "I reviewed the newer fields and want to replace them",
          false,
          (value) => {
            reviewed = value;
            reviewedFingerprint = draftFingerprint(draft);
            accept.disabled = !reviewed || !!invalid || !!needsNoteChoice;
            for (const add of panel.querySelectorAll<HTMLButtonElement>(
              'button[aria-label^="Add "]',
            ))
              add.disabled = !reviewed;
          },
        ),
      );
    if (invalid)
      panel.append(
        p(
          `This suggestion cannot be applied: ${invalid} You can copy its text and edit the fields by hand.`,
          "notice",
        ),
      );
    if (invalid && result.operation === "gismu-sources")
      panel.append(
        button("Request a new source suggestion", () => void start(), {
          class: "btn btn-quiet",
        }),
      );
    panel.append(
      el(
        "div",
        { class: "actions" },
        invalid || !hasProposal ? null : accept,
        !hasProposal
          ? button("Try again", () => void start(), {
              class: "btn btn-quiet",
              "data-ai-focus": "",
            })
          : null,
        button(
          "Dismiss",
          async () => {
            r.state = "dismissed";
            status.textContent = "";
            save();
            await saver.flush();
            render();
          },
          { class: "btn btn-quiet" },
        ),
        logButton(r),
      ),
    );
    content.append(panel);
    replace();
  }
  async function request(
    run: Run,
    path: string,
    init: RequestInit = {},
    retainCreateResponse = false,
  ) {
    const deadline = AbortSignal.timeout(30000);
    // Finish a bounded create response after Cancel so its exact job can be canceled.
    const signal = retainCreateResponse
      ? deadline
      : AbortSignal.any([run.signal, deadline]);
    const response = await fetch(`${selfPeer.base}${path}`, {
      ...init,
      credentials: "same-origin",
      signal,
    });
    // A complete private attempt log can be larger than an ordinary API result.
    // Job reads include the complete private log. Other responses keep the smaller bound.
    // Each response expires after 30 seconds. Each action expires after 15 minutes.
    const limit =
      path.startsWith("/jobs/") && (!init.method || init.method === "GET")
        ? 96 * 1024 * 1024
        : 16 * 1024 * 1024;
    const bytes = await readBounded(response, limit, signal);
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!response.ok)
      throw Object.assign(
        new Error(value.message || `Request failed (${response.status}).`),
        { code: value.code, log: value.log },
      );
    return { response, value };
  }
  async function start(): Promise<boolean> {
    const opener = document.activeElement as HTMLElement | null;
    if (!visibility.ready || active || !context.live()) return false;
    try {
      await app.session.refreshPreferences();
    } catch (error) {
      app.announce(describe(error));
      return false;
    }
    if (!enabled() || active || !context.live()) return false;
    if (!draft.meaning.trim()) {
      app.announce("Write the meaning before asking for a suggestion.");
      return false;
    }
    const controller = new AbortController();
    const run: Run = {
      controller,
      job: null,
      csrf: "",
      resultStored: false,
      signal: AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(15 * 60 * 1000),
      ]),
    };
    const isCurrent = () =>
      active === run && context.live() && enabled() && !run.signal.aborted;
    active = run;
    const revision = crypto.randomUUID();
    let requested: Current | undefined;
    let sourceTarget: SourceTarget | undefined;
    let fingerprint = "";
    let received = false;
    try {
      await visibility.refresh();
      if (!isCurrent()) return false;
      if (!(await consent(app, profile!, run.signal, opener)) || !isCurrent())
        return false;
      working = true;
      showIdle = false;
      progress = "The assistant is working.";
      status.textContent = progress;
      render();
      requested = options.current?.() ?? currentDraft(draft);
      const sourceRow = options.sourceRow?.();
      if (sourceRow) sourceTarget = captureSourceTarget(draft, sourceRow.id!);
      fingerprint = draftFingerprint(draft);
      run.csrf = (await request(run, "/session")).value.csrf;
      if (!isCurrent()) return false;
      const answer = await request(
        run,
        "/assist",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": run.csrf,
          },
          body: json({
            operation: options.operation,
            draft_revision: revision,
            language: draft.language,
            meaning: draft.meaning,
            current: requested,
            context: [
              ...new Set([
                ...(draft.lujvo?.components.flatMap((c) =>
                  c.definition ? [c.definition] : [],
                ) ?? []),
                ...(requested?.compound?.components.flatMap((c) =>
                  c.definition ? [c.definition] : [],
                ) ?? []),
                ...draft.parents,
              ]),
            ].slice(0, 32),
            profile: options.profile ?? "default",
          }),
        },
        true,
      );
      let result: unknown;
      if (answer.response.status === 202) {
        if (typeof answer.value.job !== "string")
          throw new Error("The server returned an invalid job.");
        run.job = answer.value.job;
        if (!isCurrent()) {
          await acknowledge(run);
          return false;
        }
        const polling = Math.max(
          100,
          Math.min(60000, Number(answer.value.poll_after_ms) || 100),
        );
        for (;;) {
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              clearTimeout(timer);
              reject(run.signal.reason);
            };
            const timer = setTimeout(() => {
              run.signal.removeEventListener("abort", abort);
              resolve();
            }, polling);
            run.signal.addEventListener("abort", abort, { once: true });
            if (run.signal.aborted) abort();
          });
          const jobStatus = (
            await request(run, `/jobs/${encodeURIComponent(run.job!)}`)
          ).value;
          if (!isCurrent()) return false;
          if (jobStatus.progress?.attempt > 1) {
            const nextProgress = `The first answer had errors, so the assistant is trying again (${jobStatus.progress.attempt} of ${jobStatus.progress.max_attempts || 3}).`;
            if (progress !== nextProgress) {
              progress = nextProgress;
              status.textContent = progress;
              render();
            }
          }
          if (jobStatus.state === "completed") {
            result = jobStatus.result;
            break;
          }
          if (jobStatus.state === "failed")
            throw Object.assign(
              new Error(
                jobStatus.error?.message ||
                  "No usable answer after 3 tries. Try again or fill the fields in by hand.",
              ),
              {
                code: jobStatus.error?.code,
                log: jobStatus.error?.log ?? jobStatus.result?.log,
              },
            );
          if (
            jobStatus.state === "canceled" ||
            jobStatus.state === "cancel_requested"
          )
            throw new DOMException("Canceled", "AbortError");
        }
      } else {
        if (!isCurrent()) return false;
        result = answer.value;
      }
      let checked: Suggestion;
      try {
        checked = validateSuggestion(result, options.operation, revision);
      } catch (error) {
        throw Object.assign(error as Error, {
          log: (result as Suggestion)?.log,
        });
      }
      if (
        !context.live() ||
        run.controller.signal.aborted ||
        !enabled() ||
        active !== run
      )
        return false;
      storeRecord({
        id: crypto.randomUUID(),
        key: options.key,
        label: options.label,
        operation: options.operation,
        fingerprint,
        requested,
        sourceTarget,
        result: checked,
        log: null,
        log_json: checked.log_json,
        error: null,
        state: "done",
      });
      run.resultStored = true;
      status.textContent = "Suggestion ready.";
      received = await saver.flush();
    } catch (error) {
      if (
        run.controller.signal.aborted ||
        !context.live() ||
        !enabled() ||
        active !== run ||
        !requested
      )
        return false;
      storeRecord({
        id: crypto.randomUUID(),
        key: options.key,
        label: options.label,
        operation: options.operation,
        fingerprint,
        requested,
        sourceTarget,
        result: null,
        log: (error as { log?: Record<string, unknown> }).log ?? null,
        error: failureMessage(
          describe(error),
          options.operation,
          (error as { code?: string }).code,
        ),
        state: "failed",
      });
      run.resultStored = true;
      status.textContent = record!.error;
      received = await saver.flush();
    } finally {
      if (run.job && received) await acknowledge(run);
      if (active === run) {
        active = null;
        working = false;
        if (context.live()) {
          const restore =
            document.activeElement === opener ||
            content.contains(document.activeElement) ||
            document.activeElement === document.body;
          render();
          if (restore && document.activeElement === document.body) {
            if (opener?.isConnected) opener.focus();
            else if (enabled()) focusControl();
          }
        }
      }
    }
    return received && record?.state === "done";
  }
  const unsubscribe = visibility.subscribe(() => {
    profile = visibility.profiles.find(
      (p) =>
        p.id === (options.profile ?? "default") &&
        p.operations.includes(options.operation),
    );
    if (!enabled()) void cancel();
    if (!active || working || !enabled()) render();
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    runners.delete(box);
    void cancel();
    record = undefined;
    workingLine = null;
    workingText = null;
    content.replaceChildren();
    status.textContent = "";
    context.signal.removeEventListener("abort", abortRun);
    context.signal.removeEventListener("abort", dispose);
  };
  box.addEventListener("assist-dispose", dispose, { once: true });
  context.signal.addEventListener("abort", dispose, { once: true });
  runners.set(box, start);
  return box;
}
