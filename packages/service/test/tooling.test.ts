import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
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

test("both build outputs carry the exact morphology notice and an index link", async () => {
  const notice = await readFile(
    join(root, "crates/jvc-morphology/THIRD-PARTY-NOTICES.md"),
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
