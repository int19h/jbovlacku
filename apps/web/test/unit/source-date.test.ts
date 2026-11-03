import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceDate } from "../../src/lib/source-date.ts";

const date = (dates: Record<string, string>) =>
  sourceDate({ legacy: { attribution: { dates } } } as never);

test("SQL source time takes precedence over a later database date", () => {
  assert.equal(
    date({ time: "1046655416", created_at: "2026-01-01T00:00:00Z" }),
    "Mar 2003",
  );
  assert.equal(date({ time: "0" }), "Jan 1970");
  assert.equal(date({ created_at: "2024-09-20T10:00:00Z" }), "Sep 2024");
});

test("unavailable or invalid source dates never become the current date", () => {
  assert.equal(date({}), null);
  assert.equal(
    date({ time: "not a timestamp", created_at: "not a date" }),
    null,
  );
  assert.equal(
    date({ time: "9007199254740992", created_at: "2024-09-01" }),
    "Sep 2024",
  );
});
