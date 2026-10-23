import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteCoordinator } from "../../../apps/server/src/storage.ts";
import { FileCheckpointStore } from "../../../apps/server/src/checkpoint.ts";
import { DictionaryService } from "../src/service.ts";
import {
  initializeCore,
  createEvent,
  identityFromSeed,
  wordId,
  utf8,
} from "../../core/src/index.ts";

before(async () =>
  initializeCore(
    await readFile(
      new URL("../../core/generated/jvc_runtime_bg.wasm", import.meta.url),
    ),
  ),
);
const seed = new Uint8Array(32).fill(62);
const word = { language: "jbo" as const, spelling: "klama" };
const request = (path: string) => new Request("http://localhost/api/v1" + path);
async function read(service: DictionaryService, path: string): Promise<any> {
  const response = await service.fetch(request(path));
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function settle(service: DictionaryService) {
  const internal = service as any;
  while (internal.background) await internal.background;
  if (internal.backgroundError) throw internal.backgroundError;
}
function stopTimer(service: DictionaryService) {
  const internal = service as any;
  clearTimeout(internal.checkpointTimer);
  internal.checkpointTimer = undefined;
  internal.pendingCheckpoint = undefined;
}
async function fixture(
  retention = 16,
  missingDefinitionBody = false,
  limits = { events: 200000, traversal: 1000000, claim_depth: 1024 },
) {
  const root = process.env.JVC_TEST_ROOT ?? tmpdir();
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "older-checkpoint-"));
  const path = join(directory, "coordinator.sqlite");
  let coordinator = new SqliteCoordinator(path, retention);
  const bytes = new Map<string, Uint8Array>();
  const reads: string[] = [];
  const objects = {
    async get(hash: string) {
      reads.push(hash);
      return bytes.get(hash)?.slice() ?? null;
    },
    async put(hash: string, value: Uint8Array) {
      bytes.set(hash, value.slice());
    },
  };
  const definition = createEvent(
    seed,
    [],
    "1".repeat(32),
    {
      kind: "definition.publish",
      word: wordId(word),
      language: "en",
      parents: [],
      origin: "native",
    },
    {
      word,
      language: "en",
      text: [["go"]],
      frame: null,
      operands: [],
      notes: [],
      etymology: { text: [], formation: null, compound: null },
      examples: [],
      classification: { kind: "gismu", selmaho: [] },
      labels: [],
      sources: [],
      legacy: null,
      glosses: [{ language: "en", text: "go", sense: null }],
      license: {
        expression: "CC0-1.0",
        url: "https://creativecommons.org/publicdomain/zero/1.0/",
        attribution: "",
      },
    },
  );
  const view = createEvent(
    seed,
    [],
    "2".repeat(32),
    { kind: "view.publish", parents: [] },
    {
      name: "Older checkpoint",
      description: [],
      roots: [
        {
          identity: identityFromSeed(seed),
          q: { numerator: 1, denominator: 1 },
        },
      ],
      rafsi_threshold: { numerator: 1, denominator: 1 },
      H: { numerator: 3, denominator: 1 },
      alpha: { numerator: 1, denominator: 2 },
      excluded: [],
      calculation: "simple-routes-bounds-v1",
      work: 1000,
      import_sets: [],
      account_witnesses: [],
      account_authority: false,
      notes: [],
    },
  );
  const profile = createEvent(
    seed,
    [],
    "3".repeat(32),
    { kind: "identity.profile" },
    { name: "Author", bio: [], links: [] },
  );
  const store = () =>
    new FileCheckpointStore(join(directory, "evaluation-cache"), coordinator);
  const options = {
    serverId: "older-test",
    policyUrl: "https://example.invalid",
    asyncMaterialization: true,
    coreVersion: "synthetic-loaded-artifact:1",
    selectedView: view.envelope.id,
    checkpointIntervalMs: 60000,
    stateLimits: limits,
  };
  let service = new DictionaryService(objects, coordinator, {
    ...options,
    checkpoints: store(),
  });
  await service.admitMany(
    [
      missingDefinitionBody ? { ...definition, body: null } : definition,
      view,
      profile,
    ].map((record) => utf8(JSON.stringify(record))),
  );
  await service.flushMaterialization();
  const base = (await coordinator.loadMetadata()).snapshot!;
  const pin = coordinator.checkpointPin()!;
  async function write(
    n: number,
    previous = profile.envelope.id,
    value = "bless",
  ) {
    const record = createEvent(
      seed,
      [previous],
      n.toString(16).padStart(32, "0"),
      { kind: "judgment.set", target: definition.envelope.id, value },
      null,
    );
    await service.admitMany([utf8(JSON.stringify(record))]);
    await settle(service);
    assert.deepEqual(coordinator.checkpointPin(), pin);
    return record;
  }
  function restart(overrides: Record<string, unknown> = {}) {
    stopTimer(service);
    coordinator.close();
    coordinator = new SqliteCoordinator(path, retention);
    reads.length = 0;
    service = new DictionaryService(objects, coordinator, {
      ...options,
      checkpoints: store(),
      ...overrides,
    });
    return service;
  }
  return {
    directory,
    path,
    objects,
    reads,
    options,
    definition,
    view,
    profile,
    base,
    pin,
    write,
    restart,
    get coordinator() {
      return coordinator;
    },
    get service() {
      return service;
    },
    async close() {
      await settle(service);
      stopTimer(service);
      if ((service as any).checkpointJob) await (service as any).checkpointJob;
      coordinator.close();
      await rm(directory, { recursive: true });
    },
  };
}

test("crash restart restores an older pinned checkpoint and reads only later records", async () => {
  const f = await fixture();
  try {
    const record = await f.write(4);
    const expected = await read(f.service, "/words/" + wordId(word));
    const service = f.restart();
    await service.initialize();
    await settle(service);
    assert.equal(
      f.reads.includes(f.definition.envelope.header.content!.hash),
      false,
      "a baseline definition body must come from the verified checkpoint",
    );
    assert.equal(
      f.reads.includes(f.profile.envelope.header.content!.hash),
      false,
    );
    assert.ok(
      f.reads.includes(
        (await f.coordinator.load()).events[record.envelope.id].envelope_hash,
      ),
    );
    assert.deepEqual(await read(service, "/words/" + wordId(word)), expected);
    const reference = new DictionaryService(f.objects, f.coordinator, {
      ...f.options,
      asyncMaterialization: false,
    });
    assert.deepEqual(
      await read(service, "/receipts/" + record.envelope.id),
      await read(reference, "/receipts/" + record.envelope.id),
    );
    assert.deepEqual(
      await read(service, "/words/" + wordId(word)),
      await read(reference, "/words/" + wordId(word)),
    );
  } finally {
    await f.close();
  }
});

test("the single private checkpoint base survives public snapshot expiry", async () => {
  const f = await fixture(2);
  try {
    let previous = f.profile.envelope.id;
    for (let n = 4; n < 10; n++)
      previous = (await f.write(n, previous, n % 2 ? "curse" : "bless"))
        .envelope.id;
    assert.equal(await f.coordinator.getSnapshot(f.base), null);
    const service = f.restart();
    await service.initialize();
    await settle(service);
    assert.equal(
      f.reads.includes(f.definition.envelope.header.content!.hash),
      false,
    );
    assert.equal(
      (
        await service.fetch(
          request("/words/" + wordId(word) + "?snapshot=" + f.base),
        )
      ).status,
      410,
    );
    assert.equal(
      (await read(service, "/manifest")).snapshot,
      (await f.coordinator.loadMetadata()).snapshot,
    );
  } finally {
    await f.close();
  }
});

test("equivalent limits with reordered keys still restore the older checkpoint", async () => {
  const f = await fixture();
  try {
    await f.write(4);
    const service = f.restart({
      stateLimits: { claim_depth: 1024, traversal: 1000000, events: 200000 },
    });
    await service.initialize();
    await settle(service);
    assert.equal(
      f.reads.includes(f.definition.envelope.header.content!.hash),
      false,
    );
  } finally {
    await f.close();
  }
});

test("older checkpoint recovery rejects incompatible context and damaged or absent cache bytes", async (t) => {
  for (const failure of [
    "core",
    "view",
    "limits",
    "damaged",
    "missing",
    "malformed pin",
  ] as const) {
    await t.test(failure, async () => {
      const f = await fixture();
      try {
        await f.write(4);
        let overrides: Record<string, unknown> = {};
        if (failure === "core")
          overrides = { coreVersion: "another-loaded-artifact" };
        if (failure === "view")
          overrides = { selectedView: "jve1:" + "0".repeat(64) };
        if (failure === "limits")
          overrides = {
            stateLimits: { ...f.options.stateLimits, traversal: 999999 },
          };
        const cache = join(f.directory, "evaluation-cache", f.pin.file);
        if (failure === "damaged")
          await writeFile(cache, Uint8Array.of(1, 2, 3));
        if (failure === "missing") await rm(cache);
        if (failure === "malformed pin") {
          const database = new DatabaseSync(f.path);
          try {
            database
              .prepare(
                "UPDATE evaluation_checkpoint_pin SET binding=? WHERE id=1",
              )
              .run('[1,"file-derived-context"]');
          } finally {
            database.close();
          }
        }
        const service = f.restart(overrides);
        await service.initialize();
        await settle(service);
        assert.equal(
          f.reads.includes(f.definition.envelope.header.content!.hash),
          true,
          failure,
        );
      } finally {
        await f.close();
      }
    });
  }
});

test("late bodies after a private pin use changed-record recovery and preserve the closed baseline version", async () => {
  const f = await fixture(2, true);
  try {
    await f.service.admitMany([utf8(JSON.stringify(f.definition))]);
    await settle(f.service);
    let previous = f.profile.envelope.id;
    for (let n = 4; n < 9; n++)
      previous = (await f.write(n, previous)).envelope.id;
    assert.equal(await f.coordinator.getSnapshot(f.base), null);
    const privateBase = await f.coordinator.getCheckpointSnapshot(f.base);
    assert.equal(privateBase!.events[f.definition.envelope.id].body_hash, null);
    const expected = await read(f.service, "/words/" + wordId(word));
    const service = f.restart();
    await service.initialize();
    await settle(service);
    assert.ok(
      f.reads.includes(f.definition.envelope.header.content!.hash),
      "the new body must pass ordinary record authentication",
    );
    assert.equal(
      f.reads.includes(f.profile.envelope.header.content!.hash),
      false,
    );
    assert.deepEqual(await read(service, "/words/" + wordId(word)), expected);
    await service.flushMaterialization();
    assert.equal(await f.coordinator.getCheckpointSnapshot(f.base), null);
    const database = new DatabaseSync(f.path);
    try {
      assert.equal(
        database.prepare("SELECT COUNT(*) AS n FROM checkpoint_snapshot").get()!
          .n,
        1,
      );
      assert.equal(
        database
          .prepare(
            "SELECT COUNT(*) AS n FROM snapshot_event_versions WHERE event=?",
          )
          .get(f.definition.envelope.id)!.n,
        1,
      );
    } finally {
      database.close();
    }
  } finally {
    await f.close();
  }
});

test("a checkpoint captured with reordered limit keys restores without baseline reads", async () => {
  const f = await fixture(16, false, {
    claim_depth: 1024,
    traversal: 1000000,
    events: 200000,
  });
  try {
    await f.write(4);
    for (const stateLimits of [
      f.options.stateLimits,
      { events: 200000, traversal: 1000000, claim_depth: 1024 },
    ]) {
      const service = f.restart({ stateLimits });
      await service.initialize();
      await settle(service);
      assert.equal(
        f.reads.includes(f.definition.envelope.header.content!.hash),
        false,
      );
    }
  } finally {
    await f.close();
  }
});

test("existing pins migrate a still-public base and missing expired bases fall back safely", async () => {
  const f = await fixture(2);
  const removePrivate = () => {
    const database = new DatabaseSync(f.path);
    try {
      database.exec(
        "DELETE FROM checkpoint_snapshot_chunks; DELETE FROM checkpoint_snapshot",
      );
    } finally {
      database.close();
    }
  };
  try {
    removePrivate();
    let service = f.restart();
    await service.initialize();
    assert.ok(await f.coordinator.getCheckpointSnapshot(f.base));
    let previous = f.profile.envelope.id;
    for (let n = 4; n < 8; n++)
      previous = (await f.write(n, previous)).envelope.id;
    assert.equal(await f.coordinator.getSnapshot(f.base), null);
    removePrivate();
    service = f.restart();
    await service.initialize();
    await settle(service);
    assert.equal(
      f.reads.includes(f.definition.envelope.header.content!.hash),
      true,
    );
    assert.equal(
      (
        await service.fetch(
          request("/words/" + wordId(word) + "?snapshot=" + f.base),
        )
      ).status,
      410,
    );
  } finally {
    await f.close();
  }
});

test("a failed new pin transaction preserves the prior private base and closed event version", async () => {
  const f = await fixture(2, true);
  try {
    await f.service.admitMany([utf8(JSON.stringify(f.definition))]);
    await settle(f.service);
    let previous = f.profile.envelope.id;
    for (let n = 4; n < 8; n++)
      previous = (await f.write(n, previous)).envelope.id;
    const database = new DatabaseSync(f.path);
    try {
      database.exec(
        "CREATE TRIGGER reject_checkpoint_pin BEFORE UPDATE ON evaluation_checkpoint_pin BEGIN SELECT RAISE(ABORT,'injected pin transaction failure'); END",
      );
      const errors: unknown[] = [];
      f.service.options.reportError = (error) => errors.push(error);
      await f.service.flushMaterialization();
      assert.ok(
        errors.some((error) =>
          String(error).includes("injected pin transaction failure"),
        ),
      );
      assert.deepEqual(f.coordinator.checkpointPin(), f.pin);
      assert.equal(
        (await f.coordinator.getCheckpointSnapshot(f.base))!.events[
          f.definition.envelope.id
        ].body_hash,
        null,
      );
      assert.equal(await f.coordinator.getSnapshot(f.base), null);
      assert.equal(
        database.prepare("SELECT COUNT(*) AS n FROM checkpoint_snapshot").get()!
          .n,
        1,
      );
      database.exec("DROP TRIGGER reject_checkpoint_pin");
    } finally {
      database.close();
    }
  } finally {
    await f.close();
  }
});
