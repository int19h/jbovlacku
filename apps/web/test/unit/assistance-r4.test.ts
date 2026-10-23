import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initializeCore } from "../../../../packages/core/src/index.ts";
import { newDraft, newPlace } from "../../src/model/draft.ts";
import * as assistance from "../../src/model/assistance.ts";
import type { AssistanceRecord } from "../../src/model/assistance.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL(
        "../../../../packages/core/generated/jvc_runtime_bg.wasm",
        import.meta.url,
      ),
    ),
  ),
);
function record(
  id: string,
  state: AssistanceRecord["state"],
): AssistanceRecord {
  return {
    id,
    key: "definition",
    label: "Draft definition",
    operation: "definition",
    fingerprint: "",
    requested: assistance.currentDraft(newDraft()),
    result: null,
    log: { exchanges: [] },
    error: null,
    state,
  };
}
test("retention keeps the latest run and accepted Undo, and stores a result log once", () => {
  const draft = newDraft();
  const accepted = record("accepted", "accepted");
  const latest = record("latest", "dismissed");
  draft.ai = {
    records: [
      record("old", "dismissed"),
      accepted,
      record("failed", "failed"),
      latest,
    ],
  };
  (assistance as any).retainAssistance(draft);
  assert.deepEqual(
    draft.ai.records.map((r) => r.id),
    ["accepted", "latest"],
  );
  const done = record("done", "done");
  done.result = {
    log: { secret: "private log" },
  } as unknown as assistance.Suggestion;
  (assistance as any).storeAssistanceRecord(draft, done);
  assert.equal(done.result!.log, undefined);
  assert.deepEqual(done.log, { secret: "private log" });
  assert.deepEqual(
    draft.ai.records.map((r) => r.id),
    ["accepted", "done"],
  );
});
test("mapping additions use frame and reference checks before changing the draft", () => {
  const draft = newDraft({
    kind: "lujvo",
    spelling: "ckusni",
    text: "A quantity.",
    frameMode: "fixed",
    places: [newPlace(1)],
  });
  const derivation = {
    word: { language: "jbo", spelling: "klama" },
    definition: null,
    place: 2,
    explanation: [[999]],
  };
  const before = structuredClone(draft);
  assert.throws(
    () => (assistance as any).applyMapping(draft, 1, derivation),
    /reference|place|explanation/i,
  );
  assert.deepEqual(draft, before);
});
test("log Markdown uses the displayed rows and fences untrusted content safely", () => {
  const r = record("failure", "failed");
  r.error = "No usable answer. Try again or fill the rows in by hand.";
  r.log = {
    prompt_files: ["type.task.txt"],
    exchanges: [
      {
        task: "type",
        system_prompt: "system\n```\ninjected",
        request: "line one\nline two",
        attempts: [
          { attempt: 1, text: "```\nmodel text", tool_calls: [], check: {} },
        ],
      },
    ],
  };
  const markdown = (assistance as any).assistanceLogMarkdown(r);
  assert.match(markdown, /line one\nline two/);
  assert.doesNotMatch(markdown, /line one\\nline two/);
  assert.match(markdown, /No usable answer/);
  assert.match(markdown, /Duration: unavailable ms/);
  assert.match(markdown, /Answers: 0/);
  assert.match(markdown, /prompts\/type.task.txt/);
  assert.match(markdown, /never published/);
  assert.match(markdown, /````text\nsystem\n```\ninjected\n````/);
});

test("save metadata does not serialize private log exchanges", () => {
  const draft = newDraft();
  const r = record("latest", "done");
  r.log = {
    toJSON: () => {
      throw new Error("Private exchanges were serialized.");
    },
  };
  draft.ai = { records: [r] };
  assert.doesNotThrow(() =>
    JSON.stringify(assistance.assistanceSaveKey(draft.ai)),
  );
  const before = JSON.stringify(assistance.assistanceSaveKey(draft.ai));
  r.state = "dismissed";
  assert.notEqual(
    JSON.stringify(assistance.assistanceSaveKey(draft.ai)),
    before,
  );
});

test("source Undo follows its row ID after an earlier row is removed", () => {
  const row = (id: string, language: string) => ({
    id,
    language,
    name: language,
    word: "before",
    input: "bef",
    weight: null,
  });
  const draft = newDraft({
    gismu: {
      preset: null,
      rows: [row("first", "en"), row("second", "zh")],
      candidates: "source-letters",
      selected: null,
      manual: "",
      acknowledged: [],
      reason: "",
      window: 12,
    },
  });
  const before = structuredClone(draft.gismu);
  draft.gismu!.rows[1].word = "after";
  const after = structuredClone(draft.gismu);
  const r = record("accepted", "accepted");
  r.key = "source-second";
  r.before = { gismu: before };
  r.after = { gismu: after };
  r.patches = assistance.undoPatches(r.before, r.after);
  draft.gismu!.rows.shift();
  assert.equal(assistance.restorePatches(draft, r), 0);
  assert.equal(draft.gismu!.rows[0].word, "before");
});

test("retention drops removed source rows and bounds recent dynamic keys", () => {
  const draft = newDraft();
  draft.ai = {
    records: Array.from({ length: 40 }, (_, i) => ({
      ...record(String(i), "dismissed"),
      key: `action-${i}`,
    })),
  };
  draft.ai.records.push({
    ...record("orphan", "accepted"),
    key: "source-removed",
  });
  assistance.retainAssistance(draft);
  assert.equal(draft.ai.records.length, 32);
  assert.equal(draft.ai.records[0].id, "8");
});

test("legacy mapping Undo resolves its exact definition without colliding with another occurrence", () => {
  const r = record("legacy-mapping", "accepted");
  r.key = "places-glosses:mapping:1:klama:2";
  const mapping = {
    word: { language: "jbo", spelling: "klama" },
    definition: `jve1:${"a".repeat(64)}`,
    place: 2,
    explanation: [],
  } as assistance.Mapping;
  r.patches = [
    {
      path: ["places", "0", "derivations"],
      before: [],
      after: [
        {
          word: "klama",
          definition: mapping.definition,
          place: 2,
          explanation: [],
        },
      ],
    },
  ];
  assert.equal(
    assistance.mappingRecordMatches(
      r,
      `${r.key}:${mapping.definition}`,
      r.key,
      mapping,
    ),
    true,
  );
  assert.equal(
    assistance.mappingRecordMatches(r, `${r.key}:`, r.key, {
      ...mapping,
      definition: null,
    }),
    false,
  );
});

test("legacy partial records share the parent log after loading", () => {
  const draft = newDraft();
  const parent = record("parent", "dismissed");
  parent.key = "places-glosses";
  parent.result = {
    draft_revision: "request-one",
    log: { exchanges: ["large exchange"] },
  } as unknown as assistance.Suggestion;
  parent.log = { exchanges: ["large exchange"] };
  const child = {
    ...structuredClone(parent),
    id: "child",
    key: "places-glosses:mapping:1:klama:2",
    state: "accepted" as const,
  };
  draft.ai = { records: [parent, child] };
  assistance.retainAssistance(draft);
  assert.equal(child.log_id, parent.id);
  assert.equal(child.result, null);
  assert.equal(child.log, null);
  assert.equal(parent.result.log, undefined);
  assert.deepEqual(assistance.assistanceLog(child, draft), parent.log);
});
