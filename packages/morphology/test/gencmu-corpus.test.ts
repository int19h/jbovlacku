import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { segmentText } from "../src/index.ts";

type Word = {
  text: string;
  kind: string;
  start: number;
  end: number;
  classEvidence?: string[];
  cgvWarning: boolean;
};
type Expected = {
  words: Word[];
  foreign: { text: string; start: number; end: number }[];
};
type Case = {
  id: string;
  file: string;
  line: number;
  text: string;
  features: string[];
  withoutFeatures: string[];
  expected: Expected;
  unresolved: null | { reason: string; operations: unknown[] };
  reference: Expected;
  ordinaryForms: Expected;
  replacements: null | {
    reason: string;
    tokens: {
      text: string;
      source: [number, number];
      tags: string[];
      reason: string;
    }[];
    originalExpectation: Expected;
    resolution?: string;
  };
  referenceSource: string;
  recordedWords?: string[];
};
const fixture = JSON.parse(
  readFileSync(
    new URL("../evidence/gencmu-corpus.json", import.meta.url),
    "utf8",
  ),
) as {
  source: {
    revision: string;
    caseCount: number;
    recordedWordsCount: number;
    sourceFiles: Record<string, string>;
    sourceDigest: string;
    referenceLedgerSha256: string;
  };
  cases: Case[];
};
const projection = (expected: Expected) => ({
  words: expected.words.map(({ classEvidence, ...word }) => word),
  foreign: expected.foreign,
});

test("the pinned corpus retains every experimental case and its oracle source", () => {
  assert.equal(
    fixture.source.revision,
    "0b3da7d2ec2f727a6730d77c775f88214a7ffc89",
  );
  assert.equal(fixture.source.caseCount, 3745);
  assert.equal(fixture.cases.length, 3745);
  assert.equal(
    new Set(fixture.cases.map((row) => `${row.file}:${row.line}`)).size,
    3745,
  );
  assert.equal(
    fixture.cases.filter((row) => row.referenceSource.startsWith("recorded"))
      .length,
    3544,
  );
  assert.equal(
    fixture.cases.filter((row) => row.referenceSource === "direct-forms")
      .length,
    201,
  );
  assert.equal(fixture.cases.filter((row) => row.replacements).length, 1266);
  assert.equal(
    fixture.cases.filter((row) => row.replacements?.resolution).length,
    508,
  );
  assert.equal(
    fixture.source.sourceDigest,
    createHash("sha256")
      .update(JSON.stringify(fixture.source.sourceFiles))
      .digest("hex"),
  );
  assert.match(fixture.source.referenceLedgerSha256, /^[a-f0-9]{64}$/);
  for (const row of fixture.cases) {
    assert.ok(row.id && row.file && row.line > 0);
    assert.match(
      fixture.source.sourceFiles[row.file],
      /^[a-f0-9]{64}$/,
      row.file,
    );
    if (row.referenceSource.startsWith("recorded"))
      assert.ok(Array.isArray(row.recordedWords), row.id);
    assert.equal(row.unresolved, null, row.id);
    if (row.replacements) {
      assert.ok(row.replacements.reason, row.id);
      assert.ok(row.replacements.tokens.length > 0, row.id);
      for (const token of row.replacements.tokens) {
        assert.ok(token.text && token.reason && token.tags.length > 0, row.id);
        assert.ok(
          token.source[0] >= 0 && token.source[1] > token.source[0],
          row.id,
        );
      }
      assert.deepEqual(
        row.replacements.originalExpectation,
        row.reference,
        row.id,
      );
      if (row.id !== "i212.r8.ieho.quote-gap")
        assert.deepEqual(row.expected, row.ordinaryForms, row.id);
    } else {
      assert.deepEqual(row.expected, row.reference, row.id);
    }
  }
});

for (const row of fixture.cases) {
  test(`experimental corpus: ${row.id}`, () => {
    const result = segmentText(row.text, {
      features: row.features,
      withoutFeatures: row.withoutFeatures,
    });
    const actual = {
      words: result.words.map((word) => ({
        text: word.text.toLowerCase(),
        kind: ["gismu", "lujvo", "fuhivla"].includes(word.kind)
          ? "brivla"
          : word.kind,
        start: word.start,
        end: word.end,
        cgvWarning: word.diagnostics.includes(
          "This form is not valid under the current BPFK morphology.",
        ),
      })),
      foreign: result.foreign,
    };
    assert.deepEqual(
      actual,
      projection(row.expected),
      `${row.file}:${row.line}`,
    );
  });
}
