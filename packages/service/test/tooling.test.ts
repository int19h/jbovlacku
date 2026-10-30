import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");

function assertBrowserDiscovery(stdout: string, stderr = "") {
  const output = stripVTControlCharacters(stdout).replace(
    /^  \[[^\]\r\n]+\] › /gmu,
    "  ",
  );
  const lines = output.trim().split(/\r?\n/u);
  assert.equal(lines[0], "Listing tests:");
  assert.match(lines.at(-1)!, /^Total: \d+ tests in \d+ files$/u);
  assert.ok(
    lines
      .slice(1, -1)
      .every((line) => /^  .*\.test\.ts:\d+:\d+ › /u.test(line)),
    "Discovery must print only browser case locations, without Node unit output.",
  );
  assert.match(output, /(?:^|\n)  (?:.*[\\/])?search\.test\.ts:\d+:\d+ › /u);
  assert.match(
    output,
    /(?:^|\n)  (?:.*[\\/])?materialization-retry\.test\.ts:\d+:\d+ › /u,
  );
  assert.doesNotMatch(output, /(?:^  |[\\/])unit[\\/]/mu);
  assert.doesNotMatch(
    stripVTControlCharacters(stdout + stderr),
    /(?:^|\n)\s*(?:[✔✖]|TAP version \d+|# Subtest:|(?:ok|not ok) \d+ -)/u,
  );
}

test("discovery checks accept project markers and reject Node unit listings", () => {
  const listing = (prefix: string, path: string, extra = "") =>
    `Listing tests:\n  ${prefix}${path}search.test.ts:1:1 › search\n  ${prefix}${path}materialization-retry.test.ts:2:1 › retry\n${extra}Total: 2 tests in 2 files\n`;
  for (const prefix of ["", "[chromium] › ", "[firefox-editor] › "]) {
    for (const path of ["", "apps/web/test/", "apps\\web\\test\\"]) {
      assertBrowserDiscovery(listing(prefix, path));
    }
    for (const path of [
      "unit/",
      "unit\\",
      "apps/web/test/unit/",
      "apps\\web\\test\\unit\\",
    ]) {
      assert.throws(() =>
        assertBrowserDiscovery(
          listing(prefix, "", `  ${prefix}${path}hidden.test.ts:3:1 › unit\n`),
        ),
      );
    }
  }
  const valid = listing("[chromium] › ", "");
  for (const text of [
    "TAP version 13",
    "# Subtest: unit",
    "ok 1 - unit",
    "not ok 1 - unit",
    "✔ unit",
    "✖ unit",
  ]) {
    assert.throws(() => assertBrowserDiscovery(valid, `\n${text}\n`));
  }
  for (const file of ["search.test.ts", "materialization-retry.test.ts"]) {
    assert.throws(() =>
      assertBrowserDiscovery(valid.replace(file, "unrelated.test.ts")),
    );
  }
});

test("Playwright runs isolate data and workers reuse only their run directory", async () => {
  const parent = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "config-case-"));
  try {
    await mkdir(join(directory, "browser-run"));
    const sentinel = join(directory, "browser-run", "keep.txt");
    await writeFile(sentinel, "another run");
    const env: NodeJS.ProcessEnv = { ...process.env, JVC_TEST_ROOT: directory };
    delete env.TEST_WORKER_INDEX;
    delete env.JVC_PLAYWRIGHT_RUN_ROOT;
    const script = `import config from './apps/web/playwright.config.ts'; console.log(JSON.stringify({fixture: process.env.JVC_FIXTURE_FILE, run: process.env.JVC_PLAYWRIGHT_RUN_ROOT, output: config.outputDir, data: config.webServer[0].env.JVC_DATA_DIR}));`;
    const load = async (environment: NodeJS.ProcessEnv) =>
      JSON.parse(
        (
          await exec(
            process.execPath,
            ["--import", "tsx", "--input-type=module", "-e", script],
            { cwd: root, env: environment },
          )
        ).stdout,
      );
    const [first, second] = await Promise.all([load(env), load(env)]);
    assert.notEqual(first.fixture, second.fixture);
    assert.notEqual(first.data, second.data);
    assert.equal(await readFile(sentinel, "utf8"), "another run");
    await writeFile(first.fixture, "live fixture");
    const worker = await load({
      ...env,
      TEST_WORKER_INDEX: "0",
      JVC_PLAYWRIGHT_RUN_ROOT: first.run,
    });
    assert.deepEqual(worker, first);
    assert.equal(await readFile(first.fixture, "utf8"), "live fixture");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Playwright discovery excludes Node unit execution and keeps browser cases", async () => {
  const parent = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "discovery-case-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, JVC_TEST_ROOT: directory };
    delete env.TEST_WORKER_INDEX;
    delete env.JVC_PLAYWRIGHT_RUN_ROOT;
    delete env.NODE_TEST_CONTEXT;
    const { stdout, stderr } = await exec(
      process.execPath,
      [
        join(root, "node_modules/playwright/cli.js"),
        "test",
        "--config",
        "apps/web/playwright.config.ts",
        "--list",
      ],
      { cwd: root, env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
    );
    assertBrowserDiscovery(stdout, stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("both build outputs carry the exact morphology notice and an index link", async () => {
  const notice = await readFile(
    join(root, "packages/morphology/THIRD-PARTY-NOTICES.md"),
  );
  const parent = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(parent, { recursive: true });
  const output = await mkdtemp(join(parent, "notice-case-"));
  try {
    for (const application of ["web", "server"]) {
      const build = join(output, application);
      await exec(
        process.execPath,
        ["scripts/copy-notices.mjs", application, build],
        {
          cwd: root,
        },
      );
      const directory = join(build, "notices");
      assert.deepEqual(
        await readFile(join(directory, "morphology-notices.md")),
        notice,
      );
      assert.match(
        await readFile(join(directory, "index.html"), "utf8"),
        /href="morphology-notices\.md"/,
      );
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
