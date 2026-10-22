import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  initializeCore,
  identityFromSeed,
  createEvent,
  prepareSelection,
  utf8,
  wordId,
} from "../../core/src/index.ts";
import {
  canonical,
  importCapture,
  type CaptureManifest,
} from "../src/index.ts";
import { publishProposal } from "../src/storage.ts";
import { admitImportProposal, loadImportProposal } from "../src/load.ts";
import {
  checkLoadedView,
  readLoadedView,
  stateTraversalLimit,
} from "../src/load-config.ts";
import { lockDataDirectory } from "../src/load-lock.ts";
import {
  FileObjectStore,
  SqliteCoordinator,
} from "../../../apps/server/src/storage.ts";
import { DictionaryService } from "../../service/src/service.ts";

const seed = new Uint8Array(32).fill(42);
const directories: string[] = [];
let source: Buffer;
let manifest: CaptureManifest;
before(async () => {
  await initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  );
  source = await readFile(
    new URL("../fixtures/lensisku-sample.json", import.meta.url),
  );
  manifest = JSON.parse(
    await readFile(
      new URL("../fixtures/lensisku-sample.manifest.json", import.meta.url),
      "utf8",
    ),
  );
});
after(async () => {
  for (const directory of directories)
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "jvc-import-load-"));
  directories.push(root);
  const proposal = join(root, "proposal");
  const directory = join(root, "data");
  const imported = importCapture({
    sourceBytes: source,
    manifest,
    seed,
    roots: [],
  });
  await publishProposal(proposal, source, manifest, imported);
  return { root, proposal, directory, imported };
}
function stores(directory: string) {
  return {
    coordinator: new SqliteCoordinator(join(directory, "coordinator.sqlite")),
    objects: new FileObjectStore(join(directory, "objects")),
  };
}

test("offline load accepts any carrier order and preserves receipts on rerun", async () => {
  const f = await fixture();
  await writeFile(
    join(f.proposal, "carriers.jsonl"),
    f.imported.carriers.toReversed().map(canonical).join("\n"),
  );
  const loaded = await loadImportProposal({
    ...f,
    stateTraversalLimit: 2_000_000,
  });
  assert.equal(loaded.accepted, f.imported.carriers.length);
  assert.equal(loaded.selected, f.imported.selection.ids.length);
  const first = stores(f.directory);
  const before = await first.coordinator.load();
  const service = new DictionaryService(first.objects, first.coordinator, {
    serverId: "loader-test",
    selectedView: loaded.view,
    policyUrl: "https://example.invalid/policy",
  });
  const response = await service.fetch(
    new Request(
      "http://localhost/api/v1/words/" +
        wordId({ language: "jbo", spelling: "bajra" }) +
        "?language=en",
    ),
  );
  assert.equal(response.status, 200);
  const word: any = await response.json();
  assert.equal(word.view, loaded.view);
  assert.ok(JSON.stringify(word).includes("bajra"));
  assert.equal(
    (await service.fetch(new Request("http://localhost/api/v1/packages/en")))
      .status,
    200,
  );
  const bounded = new DictionaryService(first.objects, first.coordinator, {
    serverId: "loader-test",
    selectedView: loaded.view,
    policyUrl: "https://example.invalid/policy",
    stateLimits: { events: 200_000, traversal: 1, claim_depth: 1024 },
  });
  assert.equal(
    (
      await bounded.fetch(
        new Request(
          "http://localhost/api/v1/words/" +
            wordId({ language: "jbo", spelling: "bajra" }),
        ),
      )
    ).status,
    503,
  );
  const after = await first.coordinator.load();
  assert.ok(after.snapshot);
  first.coordinator.close();
  const rerun = await loadImportProposal(f);
  assert.equal(rerun.accepted, 0);
  const second = stores(f.directory);
  try {
    const state = await second.coordinator.load();
    assert.equal(state.position, before.position);
    assert.deepEqual(state.journal, before.journal);
    assert.equal(state.snapshot, after.snapshot);
    assert.equal(
      (await readLoadedView(f.directory))?.state_traversal_limit,
      2_000_000,
    );
    await checkLoadedView(
      (await readLoadedView(f.directory))!,
      second.coordinator,
      second.objects,
    );
  } finally {
    second.coordinator.close();
  }
});

test("an invalid later signature leaves receipt state and selected view unchanged", async () => {
  const f = await fixture();
  await loadImportProposal(f);
  const previous = await readFile(join(f.directory, "loaded-view.json"));
  const old = stores(f.directory);
  const state = await old.coordinator.load();
  old.coordinator.close();
  const broken = structuredClone(f.imported.carriers[0]);
  broken.envelope.signature = "invalid";
  await writeFile(
    join(f.proposal, "carriers.jsonl"),
    canonical(f.imported.carriers[1]) + "\n" + canonical(broken) + "\n",
  );
  await assert.rejects(loadImportProposal(f));
  assert.deepEqual(
    await readFile(join(f.directory, "loaded-view.json")),
    previous,
  );
  const reopened = stores(f.directory);
  try {
    assert.deepEqual(await reopened.coordinator.load(), state);
  } finally {
    reopened.coordinator.close();
  }
});

test("source and direct importer must match the selected view", async () => {
  for (const field of ["source", "importer"]) {
    const f = await fixture();
    const body = structuredClone(f.imported.view.body);
    body.import_sets[0][field] =
      field === "source"
        ? "https://example.invalid/other"
        : identityFromSeed(new Uint8Array(32).fill(43));
    const view = createEvent(
      seed,
      [f.imported.view.envelope.id],
      "d".repeat(32),
      { kind: "view.publish", parents: [f.imported.view.envelope.id] },
      body,
    );
    await writeFile(join(f.proposal, "selected-view.json"), canonical(view));
    await assert.rejects(loadImportProposal(f), /source and importer/);
    const state = stores(f.directory);
    try {
      assert.equal((await state.coordinator.load()).position, 0);
    } finally {
      state.coordinator.close();
    }
  }
});

test("selected view checks retained selection bytes after ordinary writes", async () => {
  const f = await fixture();
  await loadImportProposal(f);
  const state = stores(f.directory);
  const loaded = (await readLoadedView(f.directory))!;
  try {
    const service = new DictionaryService(state.objects, state.coordinator, {
      serverId: "loader-test",
      selectedView: loaded.view,
      policyUrl: "https://example.invalid/policy",
    });
    const head = f.imported.view.envelope.id;
    const extra = createEvent(
      seed,
      [head],
      "f".repeat(32),
      { kind: "identity.merge" },
      null,
    );
    assert.equal((await service.admit(utf8(canonical(extra)))).status, 201);
    await checkLoadedView(loaded, state.coordinator, state.objects);
    const missing = {
      ...state.objects,
      get: async (hash: string) =>
        hash === loaded.selection ? null : state.objects.get(hash),
    };
    await assert.rejects(
      checkLoadedView(loaded, state.coordinator, {
        get: missing.get,
        put: state.objects.put.bind(state.objects),
      }),
      /selection bytes/,
    );
  } finally {
    state.coordinator.close();
  }
});

test("selection rejects missing publications", async () => {
  const f = await fixture();
  const missing = prepareSelection(
    utf8(JSON.stringify(["jve1:" + "1".repeat(64)])),
  );
  const body = structuredClone(f.imported.view.body);
  body.import_sets[0].selection = missing.hash;
  const view = createEvent(
    seed,
    [f.imported.view.envelope.id],
    "e".repeat(32),
    { kind: "view.publish", parents: [f.imported.view.envelope.id] },
    body,
  );
  await writeFile(join(f.proposal, "selected-view.json"), canonical(view));
  await writeFile(join(f.proposal, "import-selection.json"), missing.canonical);
  await assert.rejects(
    loadImportProposal(f),
    /unavailable imported publication/,
  );
});

test("selection rejects several definitions for one source record", async () => {
  const f = await fixture();
  const first = f.imported.carriers.find(
    (carrier) => carrier.envelope.header.action.kind === "definition.publish",
  )!;
  const revised = createEvent(
    seed,
    [f.imported.view.envelope.id],
    "9".repeat(32),
    first.envelope.header.action,
    first.body,
  );
  const selection = prepareSelection(
    utf8(
      JSON.stringify([...f.imported.selection.ids, revised.envelope.id].sort()),
    ),
  );
  const body = structuredClone(f.imported.view.body);
  body.import_sets[0].selection = selection.hash;
  const view = createEvent(
    seed,
    [revised.envelope.id],
    "8".repeat(32),
    { kind: "view.publish", parents: [f.imported.view.envelope.id] },
    body,
  );
  await writeFile(join(f.proposal, "selected-view.json"), canonical(view));
  await writeFile(
    join(f.proposal, "import-selection.json"),
    selection.canonical,
  );
  await writeFile(
    join(f.proposal, "carriers.jsonl"),
    f.imported.carriers.map(canonical).join("\n") +
      "\n" +
      canonical(revised) +
      "\n",
  );
  await assert.rejects(loadImportProposal(f), /several definitions/);
});

test("server and loader exclude each other, and startup restores the loaded view", async () => {
  const f = await fixture();
  await loadImportProposal(f);
  const release = await lockDataDirectory(f.directory, "test");
  await assert.rejects(loadImportProposal(f), /data directory is locked/);
  await release();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JVC_DATA_DIR: f.directory,
    HOST: "127.0.0.1",
    PORT: "0",
  };
  delete env.JVC_VIEW;
  delete env.JVC_STATE_TRAVERSAL_LIMIT;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/server/src/main.ts"],
    {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    const line = await new Promise<string>((resolve, reject) => {
      let text = "";
      child.stdout.on("data", (chunk) => {
        text += chunk;
        if (text.includes("\n")) resolve(text.split("\n")[0]);
      });
      child.once("exit", (code) =>
        reject(new Error(`Server exited ${code}: ${stderr}`)),
      );
      setTimeout(
        () => reject(new Error(`Server startup timed out: ${stderr}`)),
        15000,
      ).unref();
    });
    const info = JSON.parse(line);
    await assert.rejects(loadImportProposal(f), /data directory is locked/);
    const response = await fetch(
      `http://127.0.0.1:${info.address.port}/api/v1/search?q=klama&language=en`,
    );
    assert.equal(response.status, 200);
    const data: any = await response.json();
    assert.equal(data.view, f.imported.view.envelope.id);
    assert.ok(JSON.stringify(data).includes("klama"));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  }
  const again = await loadImportProposal(f);
  assert.equal(again.accepted, 0);
});

test("operator traversal limit is explicit and bounded", () => {
  assert.equal(stateTraversalLimit(undefined), undefined);
  assert.equal(stateTraversalLimit("1000000000"), 1_000_000_000);
  for (const value of ["0", "-1", "1.1", "01", "1e6", "1000000001", " "])
    assert.throws(() => stateTraversalLimit(value));
});

test("later inline bodies fill earlier carriers without extra receipts", async () => {
  const f = await fixture();
  const first = f.imported.carriers.find(
    (carrier) => carrier.envelope.header.action.kind === "definition.publish",
  )!;
  await writeFile(
    join(f.proposal, "carriers.jsonl"),
    [
      canonical({ envelope: first.envelope, body: null }),
      ...f.imported.carriers
        .filter((carrier) => carrier !== first)
        .map(canonical),
      canonical(first),
    ].join("\n"),
  );
  const loaded = await loadImportProposal(f);
  assert.equal(loaded.accepted, f.imported.carriers.length);
  const state = stores(f.directory);
  try {
    const retained = await state.coordinator.load();
    assert.equal(
      retained.events[first.envelope.id].body_hash,
      first.envelope.header.content!.hash,
    );
    assert.equal(retained.position, f.imported.carriers.length);
  } finally {
    state.coordinator.close();
  }
});

test("a concurrent coordinator change refuses the load before pointer publication", async () => {
  const f = await fixture();
  const release = await lockDataDirectory(f.directory, "test");
  const state = stores(f.directory);
  try {
    await assert.rejects(
      admitImportProposal(
        f.proposal,
        {
          load: () => state.coordinator.load(),
          getSnapshot: (id) => state.coordinator.getSnapshot(id),
          compareAndSwap: async () => false,
        },
        state.objects,
      ),
      /changed during the load/,
    );
    assert.equal((await state.coordinator.load()).position, 0);
    assert.equal(await readLoadedView(f.directory), undefined);
  } finally {
    state.coordinator.close();
    await release();
  }
});

test("carrier line bounds apply before an unterminated line can grow", async () => {
  const f = await fixture();
  await writeFile(
    join(f.proposal, "carriers.jsonl"),
    " ".repeat(1024 * 1024 + 1),
  );
  await assert.rejects(loadImportProposal(f), /carrier exceeds 1048576 bytes/);
  const state = stores(f.directory);
  try {
    assert.equal((await state.coordinator.load()).position, 0);
  } finally {
    state.coordinator.close();
  }
});
