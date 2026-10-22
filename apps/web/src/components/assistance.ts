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
import { navigate, type RenderContext } from "../app/router.ts";
import { getCapabilities, selfPeer, readBounded } from "../data/api.ts";
import {
  currentDraft,
  draftFingerprint,
  applyProposals,
  validateSuggestion,
  undoPatches,
  restorePatches,
  mappingKind,
  hintLabel,
  type AssistanceRecord,
  type Current,
  type Operation,
  type Suggestion,
} from "../model/assistance.ts";
import { richTextToText, renderRichText } from "../model/richtext.ts";
import type { Draft } from "../model/draft.ts";
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
    showDialog(dialog);
    accept.focus();
  });
}
const json = (value: unknown) => JSON.stringify(value, null, 2);
function logMarkdown(
  log: Record<string, unknown>,
  record: AssistanceRecord,
): string {
  const rows = [
    `# ${record.label}`,
    "",
    `Model: ${String(log.model ?? "")}. Reasoning level: ${String(log.reasoning_effort ?? "")}. Provider: ${String(log.provider ?? "")}.`,
    `Prompt version: ${String(log.prompt_version ?? "")}.`,
    `Started: ${String(log.started_at ?? "")}. Duration: ${String(log.duration_ms ?? "")} ms.`,
    `Answers: ${String(log.answers ?? "")}. Corrections: ${String(log.corrections ?? "")}.`,
    `Input tokens: ${String(log.input_tokens ?? "unknown")}. Output tokens: ${String(log.output_tokens ?? "unknown")}. Cost: ${String(log.cost_usd ?? "unknown")} USD.`,
    "",
    "The provider does not make the assistant’s private reasoning available. This log holds the shared reasoning summary and everything that the assistant wrote.",
  ];
  for (const exchange of (Array.isArray(log.exchanges)
    ? log.exchanges
    : []) as Record<string, unknown>[]) {
    rows.push(
      "",
      `## ${String(exchange.task)}`,
      "",
      "### System prompt",
      "",
      String(exchange.system_prompt ?? ""),
      "",
      "### App request",
      "",
      "```json",
      json(exchange.request),
      "```",
    );
    for (const attempt of (Array.isArray(exchange.attempts)
      ? exchange.attempts
      : []) as Record<string, unknown>[])
      rows.push(
        "",
        `### Answer ${String(attempt.attempt)}`,
        "",
        String(
          attempt.reasoning_summary ||
            "No reasoning summary was shared for this answer.",
        ),
        "",
        String(attempt.text ?? ""),
        "",
        "Tool call:",
        "",
        "```json",
        json(attempt.tool_calls),
        "```",
        "",
        `Usage: ${json(attempt.usage)}. Cost: ${String(attempt.cost_usd ?? "unknown")} USD.`,
        "",
        "App check:",
        "",
        "```json",
        json(attempt.check),
        "```",
      );
  }
  return rows.join("\n");
}
export function inferenceLog(record: AssistanceRecord) {
  const log = record.log ?? record.result?.log ?? {};
  const dialog = el("dialog", {
    class: "sheet ai-log",
    "aria-labelledby": "ai-log-title",
  });
  dialog.append(
    el("h2", { id: "ai-log-title", text: "How the assistant decided" }),
    p(
      `${record.label}. Model: ${String(log.model ?? record.result?.provenance.model ?? "unavailable")}. Reasoning level: ${String(log.reasoning_effort ?? "unavailable")}. Provider: ${String(log.provider ?? record.result?.provenance.provider ?? "unavailable")}.`,
    ),
    p(
      `Prompt version: ${String(log.prompt_version ?? record.result?.provenance.recipe ?? "unavailable")}.`,
    ),
  );
  for (const file of (Array.isArray(log.prompt_files)
    ? log.prompt_files
    : []) as unknown[]) {
    if (
      typeof file === "string" &&
      /^[a-zA-Z0-9_./-]+$/.test(file) &&
      !file.includes("..")
    )
      dialog.append(
        link(
          file,
          file.startsWith("/api/v1/assist/prompts/")
            ? file
            : `https://github.com/int19h/jbovlacku/blob/main/${file.startsWith("prompts/") ? "" : "prompts/"}${file}`,
          { target: "_blank", rel: "noopener noreferrer" },
        ),
        text(" "),
      );
  }
  dialog.append(
    p(
      `Time: ${String(log.started_at ?? "unavailable")}. Duration: ${String(log.duration_ms ?? "unavailable")} ms. Answers: ${String(log.answers ?? 0)}. Corrections: ${String(log.corrections ?? 0)}.`,
    ),
    p(
      `Input tokens: ${String(log.input_tokens ?? "unknown")}. Output tokens: ${String(log.output_tokens ?? "unknown")}. Cost: ${String(log.cost_usd ?? "unknown")} USD.${Number(log.unknown_cost_attempts) > 0 ? " Some answer costs are unknown." : ""}`,
    ),
    p(
      "The provider does not make the assistant’s private reasoning available. This log holds the shared reasoning summary and everything that the assistant wrote.",
      "small",
    ),
    p(
      "This log stays in this browser with the draft. It is never published.",
      "meta",
    ),
  );
  if (record.error) dialog.append(p(record.error, "notice"));
  for (const exchange of (Array.isArray(log.exchanges)
    ? log.exchanges
    : []) as Record<string, unknown>[]) {
    const system = el(
      "details",
      {},
      el("summary", { text: `System prompt: ${String(exchange.task)}` }),
      el("pre", { text: String(exchange.system_prompt ?? "") }),
    );
    dialog.append(
      system,
      el("h3", { text: "App request" }),
      el("pre", {
        text:
          typeof exchange.request === "string"
            ? exchange.request
            : json(exchange.request),
      }),
    );
    for (const attempt of (Array.isArray(exchange.attempts)
      ? exchange.attempts
      : []) as Record<string, unknown>[]) {
      dialog.append(
        el("h3", { text: `Answer ${String(attempt.attempt)}` }),
        p(
          String(
            attempt.reasoning_summary ||
              "No reasoning summary was shared for this answer.",
          ),
        ),
        el("div", {
          class: "ai-written",
          text: typeof attempt.text === "string" ? attempt.text : "",
        }),
        el("h4", { text: "Tool call" }),
        el("pre", { text: json(attempt.tool_calls) }),
        p(
          `Tokens: ${json(attempt.usage)}. Cost: ${String(attempt.cost_usd ?? "unknown")} USD.`,
        ),
        el("h4", { text: "App check" }),
        el("pre", { text: json(attempt.check) }),
      );
    }
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
            logMarkdown(log, record),
            "text/markdown",
          ),
        { class: "btn" },
      ),
      button(
        "Export raw JSON",
        () =>
          download(
            `jbovlacku-ai-${record.id}.json`,
            json(log),
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
}
function snapshot(draft: Draft): Partial<Draft> {
  const { ai, revision, updatedAt, ...rest } = draft;
  void ai;
  void revision;
  void updatedAt;
  return structuredClone(rest);
}
const runners = new WeakMap<HTMLElement, () => Promise<void>>();
export async function runAssistance(control: HTMLElement) {
  await runners.get(control)?.();
}
export function assistanceAction(
  app: App,
  draft: Draft,
  saver: DraftSaver,
  context: RenderContext,
  options: ActionOptions,
): HTMLElement {
  const box = el("div", { class: "ai-action", "data-ai-action": options.key });
  let profile: ConsentProfile | undefined;
  interface Run {
    controller: AbortController;
    job: string | null;
    csrf: string;
    signal: AbortSignal;
  }
  let active: Run | null = null;
  let working = false;
  let progress = "The assistant is working.";
  let record = (draft.ai?.records ?? []).findLast((r) => r.key === options.key);
  const visibility = assistanceVisibility(app, context);
  const enabled = () => visibility.enabled && !!profile;
  const save = () => {
    saver.touch();
    box.dispatchEvent(new CustomEvent("assist-change", { bubbles: true }));
  };
  const refreshPage = async () => {
    if (await saver.flush())
      navigate(`${location.pathname}${location.search}`, { replace: true });
  };
  const logButton = (r: AssistanceRecord) =>
    button("How the assistant decided", () => inferenceLog(r), {
      class: "btn btn-quiet small",
    });
  const storeRecord = (r: AssistanceRecord) => {
    draft.ai ??= { records: [] };
    draft.ai.records.push(r);
    record = r;
    save();
  };
  const apply = (target: Draft, result: Suggestion) => {
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
    if (!run) return;
    active = null;
    working = false;
    run.controller.abort();
    if (context.live()) render();
    await acknowledge(run);
  };
  context.signal.addEventListener("abort", () => void cancel(), { once: true });
  box.addEventListener("assist-cancel", () => void cancel());

  function mappingControl(
    index: number,
    derivation: NonNullable<
      Current["frame"]
    >["places"][number]["derivation"][number],
  ): HTMLElement {
    const key = `${options.key}:mapping:${index}:${derivation.word.spelling}:${derivation.place}`;
    const prior = draft.ai?.records.findLast(
      (r) => r.key === key && r.state === "accepted",
    );
    if (prior)
      return button(
        "Undo mapping",
        async () => {
          restorePatches(draft, prior);
          prior.state = "undone";
          save();
          await saver.flush();
          render();
        },
        {
          class: "btn btn-quiet",
          "aria-label": `Undo mapping ${derivation.word.spelling} ${derivation.place} to place ${index}`,
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
        if (!target || !record?.result) return;
        const before = snapshot(draft);
        target.derivations.push({
          word: derivation.word.spelling,
          definition: derivation.definition,
          place: derivation.place,
          explanation: structuredClone(derivation.explanation),
        });
        const after = snapshot(draft);
        draft.ai ??= { records: [] };
        draft.ai.records.push({
          ...record,
          id: crypto.randomUUID(),
          key,
          label: `Add ${derivation.word.spelling} ${derivation.place} to place ${index}`,
          state: "accepted",
          patches: undoPatches(before, after),
        });
        save();
        await refreshPage();
      },
      {
        class: "btn btn-quiet",
        "aria-label": `Add ${derivation.word.spelling} ${derivation.place} to place ${index}`,
        disabled: !target,
      },
    );
  }
  function renderProposal(result: Suggestion) {
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
                    mappingControl(place.index, d),
                  ),
                ),
              ),
            ),
          );
        section.append(el("div", { class: "table-scroll" }, table));
      } else if (proposal.path === "/formation/sources") {
        for (const source of proposal.value as NonNullable<
          Current["formation"]
        >["sources"])
          section.append(
            p(
              `${source.language}: ${source.word || "No single source word"}. Letters: ${source.input?.text || "unknown"}.`,
            ),
            renderRichText(source.notes, { placeHref: null }),
          );
      } else if (proposal.path === "/glosses")
        for (const g of proposal.value as Current["glosses"])
          section.append(p(`${g.text}${g.sense ? ` (${g.sense})` : ""}`));
      else
        section.append(
          el("pre", {
            text:
              typeof proposal.value === "string"
                ? proposal.value
                : json(proposal.value),
          }),
        );
    }
    return section;
  }
  function render() {
    box.replaceChildren();
    box.hidden = !enabled();
    if (!enabled()) return;
    if (working) {
      box.append(
        el(
          "div",
          { role: "status", "aria-live": "polite", class: "ai-working" },
          el("span", { class: "ai-spinner", "aria-hidden": "true" }),
          text(progress),
          button("Cancel", () => void cancel(), { class: "btn btn-quiet" }),
        ),
      );
      return;
    }
    const idle = () =>
      box.append(
        button(
          el("span", {}, text("AI", "ai-tag"), text(` ${options.label}`)),
          () => void start(),
          { class: "btn btn-quiet", "aria-label": options.label },
        ),
      );
    if (!record || record.state === "dismissed" || record.state === "undone") {
      idle();
      return;
    }
    if (record.state === "accepted") {
      const r = record;
      box.append(
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
              record = undefined;
              render();
            },
            { class: "btn btn-quiet" },
          ),
        ),
      );
      return;
    }
    if (record.state === "failed") {
      box.append(
        p(
          record.error ||
            "No usable answer. Try again or fill the fields in by hand.",
          "notice",
        ),
        button("Try again", () => void start(), { class: "btn btn-quiet" }),
        logButton(record),
      );
      return;
    }
    const result = record.result;
    if (!result) {
      idle();
      return;
    }
    const r = record;
    const panel = el(
      "section",
      {
        class: "card ai-suggestion",
        "aria-label": `${options.label} suggestion`,
      },
      el("div", {}, text("AI", "ai-tag"), text(` ${options.label}`)),
      p(result.explanation),
      p(
        `${result.provenance.model} · ${result.provenance.provider} · prompt ${result.provenance.recipe}`,
        "meta",
      ),
    );
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
    let invalid = "";
    try {
      apply(structuredClone(draft), result);
    } catch (error) {
      invalid = describe(error);
    }
    if (invalid) panel.append(el("pre", { text: json(result.proposals) }));
    else panel.append(renderProposal(result));
    const accept = button(
      "Use this",
      async () => {
        if (!reviewed) return;
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
          apply(candidate, result);
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
    accept.disabled = !reviewed || !!invalid;
    if (stale)
      panel.append(
        checkbox(
          "I reviewed the newer fields and want to replace them",
          false,
          (value) => {
            reviewed = value;
            reviewedFingerprint = draftFingerprint(draft);
            accept.disabled = !reviewed || !!invalid;
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
    panel.append(
      el(
        "div",
        { class: "actions" },
        invalid ? null : accept,
        button(
          "Dismiss",
          async () => {
            r.state = "dismissed";
            save();
            await saver.flush();
            render();
          },
          { class: "btn btn-quiet" },
        ),
        logButton(r),
      ),
    );
    box.append(panel);
  }
  async function request(run: Run, path: string, init: RequestInit = {}) {
    const signal = AbortSignal.any([run.signal, AbortSignal.timeout(30000)]);
    const response = await fetch(`${selfPeer.base}${path}`, {
      ...init,
      credentials: "same-origin",
      signal,
    });
    // A complete private attempt log can be larger than an ordinary API result.
    // Each response is limited to 16 MiB and 30 seconds. Each action expires in 15 minutes.
    const bytes = await readBounded(response, 16 * 1024 * 1024, signal);
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!response.ok)
      throw Object.assign(
        new Error(value.message || `Request failed (${response.status}).`),
        { log: value.log },
      );
    return { response, value };
  }
  async function start() {
    if (!visibility.ready || !enabled() || active || !context.live()) return;
    if (!draft.meaning.trim()) {
      app.announce("Write the meaning before asking for a suggestion.");
      return;
    }
    const controller = new AbortController();
    const run: Run = {
      controller,
      job: null,
      csrf: "",
      signal: AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(15 * 60 * 1000),
      ]),
    };
    active = run;
    working = true;
    const revision = crypto.randomUUID();
    let requested: Current | undefined;
    let fingerprint = "";
    let received = false;
    try {
      await visibility.refresh();
      if (!enabled()) return;
      if (
        !(await consent(app, profile!, run.signal)) ||
        !enabled() ||
        !context.live() ||
        active !== run
      )
        return;
      progress = "The assistant is working.";
      render();
      requested = options.current?.() ?? currentDraft(draft);
      fingerprint = draftFingerprint(draft);
      run.csrf = (await request(run, "/session")).value.csrf;
      const answer = await request(run, "/assist", {
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
              ...draft.parents,
            ]),
          ].slice(0, 32),
          profile: options.profile ?? "default",
        }),
      });
      let result: unknown;
      if (answer.response.status === 202) {
        if (typeof answer.value.job !== "string")
          throw new Error("The server returned an invalid job.");
        run.job = answer.value.job;
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
          const status = (
            await request(run, `/jobs/${encodeURIComponent(run.job!)}`)
          ).value;
          if (active !== run || !context.live()) return;
          if (status.progress?.attempt > 1) {
            progress = `The first answer had errors, so the assistant is trying again (${status.progress.attempt} of ${status.progress.max_attempts || 3}).`;
            render();
          }
          if (status.state === "completed") {
            result = status.result;
            break;
          }
          if (status.state === "failed")
            throw Object.assign(
              new Error(
                status.error?.message ||
                  "No usable answer after 3 tries. Try again or fill the fields in by hand.",
              ),
              { log: status.error?.log ?? status.result?.log },
            );
          if (
            status.state === "canceled" ||
            status.state === "cancel_requested"
          )
            throw new DOMException("Canceled", "AbortError");
        }
      } else result = answer.value;
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
        return;
      storeRecord({
        id: crypto.randomUUID(),
        key: options.key,
        label: options.label,
        operation: options.operation,
        fingerprint,
        requested,
        result: checked,
        log: checked.log,
        error: null,
        state: "done",
      });
      received = await saver.flush();
    } catch (error) {
      if (
        run.controller.signal.aborted ||
        !context.live() ||
        !enabled() ||
        active !== run ||
        !requested
      )
        return;
      storeRecord({
        id: crypto.randomUUID(),
        key: options.key,
        label: options.label,
        operation: options.operation,
        fingerprint,
        requested,
        result: null,
        log: (error as { log?: Record<string, unknown> }).log ?? null,
        error: `${describe(error)} Try again or fill the fields in by hand.`,
        state: "failed",
      });
      received = await saver.flush();
    } finally {
      if (run.job && received) await acknowledge(run);
      if (active === run) {
        active = null;
        working = false;
        if (context.live()) {
          render();
          if (!record) box.querySelector<HTMLButtonElement>("button")?.focus();
        }
      }
    }
  }
  const unsubscribe = visibility.subscribe(() => {
    profile = visibility.profiles.find(
      (p) =>
        p.id === (options.profile ?? "default") &&
        p.operations.includes(options.operation),
    );
    if (!enabled()) void cancel();
    render();
  });
  context.signal.addEventListener("abort", unsubscribe, { once: true });
  runners.set(box, start);
  return box;
}
