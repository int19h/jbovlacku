import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { contentHash, initializeCore } from "../../core/src/index.ts";
import { canonical } from "../src/index.ts";
import { importSqlSnapshot, type SqlManifest } from "../src/sql.ts";

const directories: string[] = [];
let fixture: Buffer;
let fixtureManifest: SqlManifest;
before(async () => {
  await initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  );
  fixture = await readFile(
    new URL("../fixtures/lensisku-sql-sample.sql", import.meta.url),
  );
  fixtureManifest = JSON.parse(
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
async function setup() {
  const base = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "sql-size-check-r4-"));
  directories.push(directory);
  return {
    directory,
    sourcePath: "",
    manifestPath: join(directory, "manifest.json"),
    output: join(directory, "proposal"),
    seed: new Uint8Array(32).fill(43),
    roots: [],
  };
}
async function updateSource(
  input: Awaited<ReturnType<typeof setup>>,
  bytes: Buffer,
) {
  input.sourcePath = join(
    input.directory,
    `${contentHash(bytes).slice(7)}.sql`,
  );
  await writeFile(input.sourcePath, bytes);
  await writeFile(
    input.manifestPath,
    canonical({
      ...fixtureManifest,
      sha256: contentHash(bytes),
      bytes: bytes.length,
    }),
  );
}
function mutate(transform: (fields: string[]) => void) {
  let definitions = false;
  return Buffer.from(
    fixture
      .toString()
      .split("\r\n")
      .map((line) => {
        if (line.startsWith("COPY "))
          definitions = line.startsWith("COPY public.definitions ");
        if (line === "\\.") definitions = false;
        if (!definitions || line.startsWith("COPY ")) return line;
        const fields = line.split("\t");
        transform(fields);
        return fields.join("\t");
      })
      .join("\r\n"),
  );
}
function versionCount(output: string) {
  const db = new DatabaseSync(join(output, "journal.sqlite"), {
    readOnly: true,
  });
  try {
    return Number(
      db.prepare("SELECT COUNT(*) AS count FROM versions").get()!.count,
    );
  } finally {
    db.close();
  }
}

test("r4 N5 the staged count agrees with new, revised, reused, reverted, and unresolved publications", async () => {
  const input = await setup();
  const retained = new Map<string, string>();
  const revised = mutate((fields) => {
    if (fields[3] === "4") fields[4] += " changed text";
  });
  const provenance = mutate((fields) => {
    if (fields[3] === "4") fields[15] = "Changed display name";
  });
  const unresolved = mutate((fields) => {
    if (fields[3] === "4") fields[4] = "x".repeat(260 * 1024);
  });
  for (const [bytes, expected] of [
    [fixture, 4],
    [revised, 1],
    [fixture, 0],
    [provenance, 0],
    [unresolved, 0],
  ] as const) {
    await updateSource(input, bytes);
    let beforeSigning = -1;
    const result = await importSqlSnapshot({
      ...input,
      estimate: (estimate) => {
        beforeSigning = versionCount(input.output);
        assert.equal(estimate.new_publication_count, expected);
        assert.equal(estimate.definition_rows, 4);
      },
    });
    assert.equal(versionCount(input.output) - beforeSigning, expected);
    assert.equal(result.report.added + result.report.revised, expected);
    const db = new DatabaseSync(join(input.output, "journal.sqlite"), {
      readOnly: true,
    });
    try {
      for (const row of db
        .prepare("SELECT event,carrier FROM versions")
        .all()) {
        const event = row.event as string;
        const carrier = row.carrier as string;
        if (retained.has(event)) assert.equal(carrier, retained.get(event));
        retained.set(event, carrier);
      }
    } finally {
      db.close();
    }
  }
});

for (const conflicting of [false, true]) {
  test(`r4 N5 ${conflicting ? "conflicting" : "identical"} duplicate rows keep observation growth separate from new publications`, async () => {
    const input = await setup();
    const duplicate = mutate((fields) => {
      if (fields[3] !== "4") return;
      const extra = [...fields];
      if (conflicting) extra[4] += " conflicting text";
      fields[fields.length - 1] += `\r\n${extra.join("\t")}`;
    });
    await updateSource(input, duplicate);
    const expected = conflicting ? 3 : 4;
    const result = await importSqlSnapshot({
      ...input,
      estimate: (estimate) => {
        assert.equal(versionCount(input.output), 0);
        assert.equal(estimate.definition_rows, 5);
        assert.equal(estimate.new_publication_count, expected);
      },
    });
    assert.equal(result.report.added, expected);
    assert.equal(versionCount(input.output), expected);
  });
}

test("r4 R3-2 a check refuses retained output before any journal migration or write", async () => {
  const input = await setup();
  await updateSource(input, fixture);
  await importSqlSnapshot(input);
  const db = new DatabaseSync(join(input.output, "journal.sqlite"));
  db.exec("DROP INDEX observations_record");
  db.close();
  const before = await readFile(join(input.output, "journal.sqlite"));
  const carriers = await readFile(join(input.output, "carriers.jsonl"));
  await assert.rejects(
    importSqlSnapshot({ ...input, checkExisting: true }),
    /check requires a scratch output directory/i,
  );
  assert.deepEqual(
    await readFile(join(input.output, "journal.sqlite")),
    before,
  );
  assert.deepEqual(
    await readFile(join(input.output, "carriers.jsonl")),
    carriers,
  );
});

for (const [marker, kind] of [
  ["carriers.jsonl", "file"],
  ["source-archive", "file"],
  ["source-archive", "directory"],
  ["carriers.jsonl", "symlink"],
  ["source-archive", "symlink"],
] as const) {
  test(`r4 R3-2 a check refuses an output containing only the ${marker} ${kind} marker`, async () => {
    const input = await setup();
    await updateSource(input, fixture);
    await importSqlSnapshot(input);
    const output = join(input.directory, "check");
    await mkdir(output);
    await copyFile(
      join(input.output, "journal.sqlite"),
      join(output, "journal.sqlite"),
    );
    if (kind === "directory") await mkdir(join(output, marker));
    else if (kind === "symlink")
      await symlink(join(input.directory, "missing"), join(output, marker));
    else await writeFile(join(output, marker), "retained proposal marker");
    const before = await readFile(join(output, "journal.sqlite"));
    await assert.rejects(
      importSqlSnapshot({ ...input, output, checkExisting: true }),
      /check requires a scratch output directory/i,
    );
    assert.deepEqual(await readFile(join(output, "journal.sqlite")), before);
  });
}
