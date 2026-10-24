import {
  prepareVerifiedRecords,
  projectVerifiedRecord,
  verifiedRecordKey,
  retainVerifiedRecords,
  type StoredVerifiedRecord,
} from "../../service/src/verified-records.ts";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalize,
  prepareAdmission,
  prepareSelection,
  utf8,
  type PreparedAdmission,
} from "../../core/src/index.ts";
import type {
  Coordinator,
  ObjectStore,
  StoredEvent,
} from "../../service/src/storage.ts";
import {
  FileObjectStore,
  SqliteCoordinator,
} from "../../../apps/server/src/storage.ts";
import { lockDataDirectory } from "./load-lock.ts";
import {
  checkLoadedView,
  readLoadedView,
  stateTraversalLimit,
  writeLoadedView,
  type LoadedView,
} from "./load-config.ts";

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_EVENTS = 200_000;

async function boundedFile(path: string, limit: number) {
  const file = await open(path, "r");
  try {
    if ((await file.stat()).size > limit)
      throw new Error(`The file exceeds its byte limit: ${path}`);
    const bytes = await file.readFile();
    if (bytes.length > limit)
      throw new Error(`The file exceeds its byte limit: ${path}`);
    return bytes;
  } finally {
    await file.close();
  }
}

/** Bound each line before decoding it, including a file with no newline. */
async function* carriers(path: string) {
  let pending = Buffer.alloc(0);
  for await (const chunk of createReadStream(path, { highWaterMark: 65536 })) {
    const bytes = Buffer.concat([pending, chunk as Buffer]);
    let offset = 0;
    for (;;) {
      const end = bytes.indexOf(10, offset);
      if (end < 0) break;
      if (end - offset > MAX_RECORD_BYTES)
        throw new Error("An import carrier exceeds 1048576 bytes.");
      if (end !== offset) yield bytes.subarray(offset, end);
      offset = end + 1;
    }
    pending = bytes.subarray(offset);
    if (pending.length > MAX_RECORD_BYTES)
      throw new Error("An import carrier exceeds 1048576 bytes.");
  }
  if (pending.length) yield pending;
}

function validCarrier(bytes: Uint8Array) {
  const prepared = prepareAdmission(bytes);
  if (!prepared.action_valid || prepared.body_status === "invalid")
    throw new Error(
      `The import carrier has an invalid action or body: ${prepared.id}`,
    );
  return prepared;
}

function preferredSignature(left: number[], right: number[]) {
  for (let i = 0; i < Math.min(left.length, right.length); i++)
    if (left[i] !== right[i]) return left[i] < right[i];
  return left.length < right.length;
}

/** Admit once without per-record snapshots, receipts, or full evaluation. */
export async function admitImportProposal(
  proposal: string,
  coordinator: Coordinator,
  objects: ObjectStore,
) {
  const selection = prepareSelection(
    await boundedFile(
      join(proposal, "import-selection.json"),
      16 * 1024 * 1024,
    ),
  );
  const view = validCarrier(
    await boundedFile(join(proposal, "selected-view.json"), MAX_RECORD_BYTES),
  );
  if (
    view.header.action.kind !== "view.publish" ||
    view.body_status !== "present"
  )
    throw new Error(
      "The selected view must contain a signed view.publish event and its body.",
    );
  const viewBody = JSON.parse(view.body!);
  if (
    !viewBody.import_sets.some(
      (set: { selection: string }) => set.selection === selection.hash,
    )
  )
    throw new Error(
      "The selected view does not select the supplied import selection.",
    );
  const state = await coordinator.load();
  const next = structuredClone(state);
  const selectedIds = new Set(selection.ids);
  const sourceEvidence = new Map<
    string,
    { source: string; record: { kind: string; id: number } }
  >();
  const available = new Set<string>();
  const waiting = new Map<string, [string, StoredEvent][]>();
  const key = (hash: string, bytes: number) => `${hash}/${bytes}`;
  for (const [id, event] of Object.entries(next.events)) {
    const descriptor = event.header.content;
    if (!descriptor) continue;
    const token = key(descriptor.hash, descriptor.bytes);
    if (event.body_hash) available.add(token);
    else {
      const list = waiting.get(token) ?? [];
      list.push([id, event]);
      waiting.set(token, list);
    }
  }
  const changedIds = new Set<string>();
  const projections = new Map<string, StoredVerifiedRecord>();
  let changed = false;
  let accepted = 0;
  let duplicate = 0;
  let records = 0;
  const add = async (p: PreparedAdmission) => {
    records++;
    if (records > MAX_EVENTS * 2)
      throw new Error("The import proposal exceeds 400000 carrier records.");
    const projected = projectVerifiedRecord(
      p.id,
      {
        envelope_hash: p.envelope_hash,
        body_hash: p.body === null ? null : p.header.content!.hash,
      },
      utf8(p.envelope),
      p.body === null ? undefined : utf8(p.body),
    );
    projections.set(verifiedRecordKey(projected), projected);
    const old = next.events[p.id];
    if (
      old &&
      canonicalize(utf8(JSON.stringify(old.header))) !==
        canonicalize(utf8(JSON.stringify(p.header)))
    )
      throw new Error(`The event ID names different headers: ${p.id}`);
    if (!old && next.position >= MAX_EVENTS)
      throw new Error("The data directory exceeds 200000 admitted events.");
    await objects.put(p.envelope_hash, utf8(p.envelope));
    const descriptor = p.header.content;
    const token = descriptor ? key(descriptor.hash, descriptor.bytes) : null;
    if (p.body !== null) {
      await objects.put(descriptor!.hash, utf8(p.body));
      available.add(token!);
      for (const [id, event] of waiting.get(token!) ?? []) {
        event.body_hash = descriptor!.hash;
        changedIds.add(id);
        changed = true;
      }
      waiting.delete(token!);
      if (selectedIds.has(p.id)) {
        const body = JSON.parse(p.body);
        sourceEvidence.set(p.id, {
          source: body.legacy?.source,
          record: body.legacy?.record,
        });
      }
    }
    const body =
      p.body !== null || (token && available.has(token))
        ? descriptor!.hash
        : (old?.body_hash ?? null);
    const preferred =
      !old || preferredSignature(p.signature_bytes, old.signature);
    if (old) duplicate++;
    else {
      accepted++;
      next.position++;
      next.journal.push({ position: next.position, id: p.id });
    }
    if (!old || preferred || old.body_hash !== body) {
      changed = true;
      changedIds.add(p.id);
      const event = (next.events[p.id] = {
        envelope_hash: preferred ? p.envelope_hash : old.envelope_hash,
        body_hash: body,
        header: p.header,
        signature: preferred ? p.signature_bytes : old.signature,
        position: old?.position ?? next.position,
      });
      if (token && !body) {
        const list = waiting.get(token) ?? [];
        list.push([p.id, event]);
        waiting.set(token, list);
      }
    }
  };
  for await (const bytes of carriers(join(proposal, "carriers.jsonl")))
    await add(validCarrier(bytes));
  await add(view);
  const sourceRecords = new Map<string, string>();
  const evidenceFor = async (id: string) => {
    const event = next.events[id];
    if (
      !event?.body_hash ||
      event.header.action.origin !== "import" ||
      !["definition.publish", "rafsi.publish"].includes(
        String(event.header.action.kind),
      )
    )
      throw new Error(
        `The selection names an unavailable imported publication: ${id}`,
      );
    let evidence = sourceEvidence.get(id);
    if (!evidence) {
      const bytes = await objects.get(event.body_hash);
      if (!bytes)
        throw new Error(`The selected publication body is unavailable: ${id}`);
      const body = JSON.parse(new TextDecoder().decode(bytes));
      evidence = { source: body.legacy?.source, record: body.legacy?.record };
      sourceEvidence.set(id, evidence);
    }
    if (
      typeof evidence.source !== "string" ||
      !evidence.record ||
      !Number.isSafeInteger(evidence.record.id) ||
      evidence.record.id < 1
    )
      throw new Error(
        `The selected publication source metadata is unavailable: ${id}`,
      );
    return { event, evidence };
  };
  for (const id of selection.ids) {
    const { event, evidence } = await evidenceFor(id);
    if (
      !viewBody.import_sets.some(
        (set: { selection: string; source: string; importer: string }) =>
          set.selection === selection.hash &&
          set.source === evidence.source &&
          set.importer === event.header.issuer,
      )
    )
      throw new Error(
        `The selected publication does not match its source and importer: ${id}`,
      );
  }
  for (const set of viewBody.import_sets as {
    selection: string;
    source: string;
    importer: string;
  }[]) {
    let ids = selection.ids;
    if (set.selection !== selection.hash) {
      if (!next.selections.includes(set.selection))
        throw new Error(
          "The selected view requires another import selection that is not retained.",
        );
      const bytes = await objects.get(set.selection);
      if (!bytes)
        throw new Error("The retained import selection bytes are unavailable.");
      const retained = prepareSelection(bytes);
      if (retained.hash !== set.selection)
        throw new Error(
          "The retained import selection bytes do not match their hash.",
        );
      ids = retained.ids;
    }
    for (const id of ids) {
      const retained = next.events[id];
      if (
        retained &&
        (retained.header.issuer !== set.importer ||
          retained.header.action.origin !== "import" ||
          !["definition.publish", "rafsi.publish"].includes(
            String(retained.header.action.kind),
          ))
      )
        continue;
      const { event, evidence } = await evidenceFor(id);
      if (set.source !== evidence.source) continue;
      if (event.header.action.kind === "definition.publish") {
        const token = JSON.stringify([
          set.source,
          set.importer,
          evidence.record.id,
        ]);
        if (sourceRecords.has(token) && sourceRecords.get(token) !== id)
          throw new Error(
            "The import selection contains several definitions for one source record.",
          );
        sourceRecords.set(token, id);
      }
    }
  }
  await objects.put(selection.hash, utf8(selection.canonical));
  if (!next.selections.includes(selection.hash)) {
    next.selections.push(selection.hash);
    next.selections.sort();
    changed = true;
  }
  if (changed) {
    next.revision++;
    // The first service read publishes one wrapper for the complete inventory.
    next.snapshot = null;
    const verified = await prepareVerifiedRecords(
      objects,
      next.events,
      changedIds,
      projections,
    );
    if (
      !(await coordinator.compareAndSwap(
        state.revision,
        next,
        undefined,
        [...changedIds],
        verified,
      ))
    )
      throw new Error(
        "The data directory changed during the load. Stop other writers and rerun the loader.",
      );
    if (!coordinator.saveVerifiedRecords)
      await retainVerifiedRecords(coordinator, verified);
  }
  return {
    view: view.id,
    selection: selection.hash,
    accepted,
    duplicate,
    selected: selection.count,
    position: next.position,
  };
}

export async function loadImportProposal(options: {
  proposal: string;
  directory: string;
  stateTraversalLimit?: number;
}) {
  const traversal = stateTraversalLimit(options.stateTraversalLimit);
  const release = await lockDataDirectory(options.directory, "import-loader");
  let coordinator: SqliteCoordinator | undefined;
  try {
    const previousConfiguration = await readLoadedView(options.directory);
    coordinator = new SqliteCoordinator(
      join(options.directory, "coordinator.sqlite"),
    );
    const objects = new FileObjectStore(join(options.directory, "objects"));
    const result = await admitImportProposal(
      options.proposal,
      coordinator,
      objects,
    );
    const configuration: LoadedView = {
      version: 1,
      view: result.view,
      selection: result.selection,
      ...((traversal ?? previousConfiguration?.state_traversal_limit) ===
      undefined
        ? {}
        : {
            state_traversal_limit:
              traversal ?? previousConfiguration?.state_traversal_limit,
          }),
    };
    await checkLoadedView(configuration, coordinator, objects);
    await writeLoadedView(options.directory, configuration);
    return result;
  } finally {
    coordinator?.close();
    await release();
  }
}
