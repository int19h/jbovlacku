import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contentHash, initializeCore } from "../../core/src/index.ts";
import { readCopyRows } from "../src/sql-copy.ts";
import { importSqlSnapshot } from "../src/sql.ts";

const directories: string[] = [];
let fixture: Buffer;
let manifest: Record<string, any>;
before(async () => {
  await initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  );
  fixture = await readFile(
    new URL("../fixtures/lensisku-sql-sample.sql", import.meta.url),
  );
  manifest = JSON.parse(
    await readFile(
      new URL("../fixtures/lensisku-sql-sample.manifest.json", import.meta.url),
      "utf8",
    ),
  );
});
after(async () => {
  for (const directory of directories)
    await rm(directory, { recursive: true, force: true });
});
async function source(bytes: Buffer) {
  const base = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "sql-copy-r3-"));
  directories.push(directory);
  const path = join(directory, "source.sql");
  await writeFile(path, bytes);
  return { directory, path };
}
function independentHistoryRows(): Buffer {
  let inside = false;
  let position = 0;
  return Buffer.from(
    fixture
      .toString()
      .split("\r\n")
      .flatMap((line) => {
        if (line.startsWith("COPY "))
          inside = line.startsWith("COPY public.definition_versions ");
        if (line === "\\.") inside = false;
        if (inside && !line.startsWith("COPY ") && position++ === 0) {
          const head = line.split("\t").slice(0, 12);
          const other = [
            "999999",
            "4",
            "2",
            "4",
            "independent definition text",
            "independent notes",
          ];
          return [head.join("\t"), other.join("\t")];
        }
        return [line];
      })
      .join("\r\n"),
  );
}

test("r3 N1 separate short history rows retain both structurally valid owner prefixes", async () => {
  const input = await source(independentHistoryRows());
  const rows = [];
  for await (const row of readCopyRows(
    input.path,
    new Set(["definition_versions"]),
  ))
    rows.push(row);
  assert.equal(rows.length, 6);
  assert.deepEqual(
    rows.slice(0, 2).map((row) => row.values[1]),
    ["74481", "4"],
  );
  assert.ok(
    rows.slice(0, 2).every((row) => row.error && row.fragments === undefined),
  );
});

test("r3 N1 independent malformed history owners both stay unpublished", async () => {
  const bytes = independentHistoryRows();
  const input = await source(bytes);
  const manifestPath = join(input.directory, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      ...manifest,
      bytes: bytes.length,
      sha256: contentHash(bytes),
      expected_rows: { ...manifest.expected_rows, definition_versions: 6 },
    }),
  );
  const output = join(input.directory, "proposal");
  const result = await importSqlSnapshot({
    sourcePath: input.path,
    manifestPath,
    output,
    seed: new Uint8Array(32).fill(44),
    roots: [],
  });
  assert.equal(result.report.added, 2);
  assert.ok(result.report.unresolved.some((issue) => issue.record === 74481));
  assert.ok(result.report.unresolved.some((issue) => issue.record === 4));
  const carriers = (await readFile(join(output, "carriers.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    carriers
      .filter((carrier) => carrier.body.legacy)
      .map((carrier) => carrier.body.legacy.record.id)
      .sort((a, b) => a - b),
    [36101, 53191],
  );
});

test("r3 N1 history note continuations still retain one malformed head owner", async () => {
  const lines = fixture.toString().split("\r\n");
  const header = lines.findIndex((line) =>
    line.startsWith("COPY public.definition_versions "),
  );
  const fields = lines[header + 2].split("\t");
  fields[5] += "\r\ncontinuation without an identifier prefix";
  lines[header + 2] = fields.join("\t");
  const input = await source(Buffer.from(lines.join("\r\n")));
  const rows = [];
  for await (const row of readCopyRows(
    input.path,
    new Set(["definition_versions"]),
  ))
    rows.push(row);
  assert.equal(rows.length, 5);
  assert.equal(rows[1].values[1], "74481");
  assert.equal(rows[1].fragments?.length, 2);
  assert.ok(rows[1].error);
});

test("r3 N1 the real definition fragment shape still associates the 19-field head and 9-field tail", async () => {
  const head = ["318", "731", "62020", "62020", ...new Array(15).fill("text")];
  const tail = [
    "French continuation",
    "minra",
    "mir minr",
    "1",
    "1",
    "",
    "\\N",
    "\\N",
    "\\N",
  ];
  const columns = [
    "langid",
    "valsiid",
    "definitionnum",
    "definitionid",
    "definition",
    ...new Array(22).fill("text"),
  ];
  const input = await source(
    Buffer.from(
      `COPY public.definitions (${columns.join(", ")}) FROM stdin;\r\n${head.join("\t")}\r\n${tail.join("\t")}\r\n\\.\r\n`,
    ),
  );
  const rows = [];
  for await (const row of readCopyRows(input.path, new Set(["definitions"])))
    rows.push(row);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].values[3], "62020");
  assert.equal(rows[0].fragments?.length, 2);
  assert.ok(rows[0].error);
});
