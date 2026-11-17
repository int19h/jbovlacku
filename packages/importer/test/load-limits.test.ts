import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { once } from "node:events";
import {
  createEvent,
  initializeCore,
} from "../../core/src/index.ts";
import { emptyState, type State } from "../../service/src/storage.ts";
import { canonical, importCapture, type CaptureManifest } from "../src/index.ts";
import { admitImportProposal } from "../src/load.ts";
import { publishProposal } from "../src/storage.ts";

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

test("loader accepts more than 200000 admitted events and 400000 carrier records with no quota", async () => {
  const root = await mkdtemp(join(tmpdir(), "jvc-import-load-limits-"));
  directories.push(root);
  const proposal = join(root, "proposal");
  const imported = importCapture({
    sourceBytes: source,
    manifest,
    seed,
    roots: [],
  });
  await publishProposal(proposal, source, manifest, imported);
  const stream = createWriteStream(join(proposal, "carriers.jsonl"));
  const write = async (text: string) => {
    if (!stream.write(text)) await once(stream, "drain");
  };
  for (const carrier of imported.carriers) await write(canonical(carrier) + "\n");
  const synthetic = createEvent(
    seed,
    [],
    "a".repeat(32),
    { kind: "identity.merge" },
    null,
  );
  const line = canonical(synthetic) + "\n";
  // Duplicate records count as carrier records without adding events.
  const repeats = 400_001;
  const chunk = line.repeat(1000);
  for (let written = 0; written < repeats; written += 1000)
    await write(chunk.slice(0, line.length * Math.min(1000, repeats - written)));
  stream.end();
  await once(stream, "finish");
  let state: State = emptyState();
  const objects = new Map<string, Uint8Array>();
  const batchSizes: number[] = [];
  const coordinator = {
    load: async () => state,
    getSnapshot: async () => null,
    getSnapshotRevision: async () => null,
    stageVerifiedRecords: async (_stage: string, records: unknown[]) => {
      batchSizes.push(records.length);
    },
    discardVerifiedRecordStage: async () => {},
    compareAndSwap: async (revision: number, next: State) => {
      if (revision !== state.revision) return false;
      state = next;
      return true;
    },
  };
  const store = {
    get: async (hash: string) => objects.get(hash) ?? null,
    put: async (hash: string, bytes: Uint8Array) => {
      objects.set(hash, bytes);
    },
  };
  const recordsResult = await admitImportProposal(
    proposal,
    coordinator as never,
    store,
  );
  assert.ok(recordsResult.accepted >= imported.carriers.length);
  assert.ok(batchSizes.every((size) => size <= 256));

  // A second proposal adds distinct events above the old admitted cap.
  // Copy the published proposal instead of publishing again: a second
  // publication of the same capture would move the shared ledger.
  const eventsProposal = join(root, "events-proposal");
  await cp(proposal, eventsProposal, { recursive: true });
  const eventsStream = createWriteStream(join(eventsProposal, "carriers.jsonl"));
  const writeEvent = async (text: string) => {
    if (!eventsStream.write(text)) await once(eventsStream, "drain");
  };
  for (const carrier of imported.carriers)
    await writeEvent(canonical(carrier) + "\n");
  const total = 200_001;
  for (let index = 0; index < total; index++) {
    const event = createEvent(
      seed,
      [],
      (index + 1).toString(16).padStart(32, "0"),
      { kind: "identity.merge" },
      null,
    );
    await writeEvent(canonical(event) + "\n");
  }
  eventsStream.end();
  await once(eventsStream, "finish");
  let eventState: State = emptyState();
  const eventObjects = new Map<string, Uint8Array>();
  const eventCoordinator = {
    load: async () => eventState,
    getSnapshot: async () => null,
    getSnapshotRevision: async () => null,
    stageVerifiedRecords: async (_stage: string, records: unknown[]) => {
      assert.ok(records.length <= 256);
    },
    discardVerifiedRecordStage: async () => {},
    compareAndSwap: async (revision: number, next: State) => {
      if (revision !== eventState.revision) return false;
      eventState = next;
      return true;
    },
  };
  const eventStore = {
    get: async (hash: string) => eventObjects.get(hash) ?? null,
    put: async (hash: string, bytes: Uint8Array) => {
      eventObjects.set(hash, bytes);
    },
  };
  const eventsResult = await admitImportProposal(
    eventsProposal,
    eventCoordinator as never,
    eventStore,
  );
  assert.ok(eventsResult.position > 200_000, `position ${eventsResult.position}`);
  assert.equal(Object.keys(eventState.events).length, eventsResult.position);
});
