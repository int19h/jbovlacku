import { prepareAdmissionRecords } from "../../service/src/admission-records.ts";
import {
  retainSemanticRecords,
  type StoredSemanticRecord,
} from "../../service/src/semantic/storage.ts";
import { randomUUID } from "node:crypto";
import {
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

/** Optional operator quotas. Absent means no logical cap. */
export interface ImportLoadQuotas {
  maxAdmittedEvents?: number;
  maxCarrierRecords?: number;
}

function quota(value: number | undefined, name: string) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

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

/**
 * Admit once without per-record snapshots, receipts, or full evaluation.
 * Carriers stream in one at a time. Only events this proposal changes are
 * held in memory; retained events are read from the loaded state and are
 * never deep-cloned. Verified and semantic records stage in batches of
 * 256 inside the coordinator, and one final transaction promotes them.
 */
export async function admitImportProposal(
  proposal: string,
  coordinator: Coordinator,
  objects: ObjectStore,
  quotas: ImportLoadQuotas = {},
) {
  const maxAdmittedEvents = quota(
    quotas.maxAdmittedEvents,
    "maxAdmittedEvents",
  );
  const maxCarrierRecords = quota(
    quotas.maxCarrierRecords,
    "maxCarrierRecords",
  );
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
  const selectedIds = new Set(selection.ids);
  const sourceEvidence = new Map<
    string,
    { source: string; record: { kind: string; id: number } }
  >();
  // Only events this proposal changes live here. Retained events stay in
  // the loaded state and are never cloned or indexed up front.
  const pending = new Map<string, StoredEvent>();
  const journal: { position: number; id: string }[] = [];
  let position = state.position;
  const suppliedBodies = new Map<string, string>();
  const bodyAvailability = new Map<string, boolean>();
  const waiting = new Map<string, string[]>();
  const key = (hash: string, bytes: number) => `${hash}/${bytes}`;
  const changedIds = new Set<string>();
  let changed = false;
  let accepted = 0;
  let duplicate = 0;
  let records = 0;
  const add = async (p: PreparedAdmission) => {
    records++;
    if (maxCarrierRecords !== undefined && records > maxCarrierRecords)
      throw new Error(
        `The import proposal exceeds the configured limit of ${maxCarrierRecords} carrier records.`,
      );
    const old = pending.get(p.id) ?? state.events[p.id];
    if (
      old &&
      canonicalize(utf8(JSON.stringify(old.header))) !==
        canonicalize(utf8(JSON.stringify(p.header)))
    )
      throw new Error(`The event ID names different headers: ${p.id}`);
    if (!old && maxAdmittedEvents !== undefined && position >= maxAdmittedEvents)
      throw new Error(
        `The data directory exceeds the configured limit of ${maxAdmittedEvents} admitted events.`,
      );
    await objects.put(p.envelope_hash, utf8(p.envelope));
    const descriptor = p.header.content;
    const token = descriptor ? key(descriptor.hash, descriptor.bytes) : null;
    if (p.body !== null) {
      await objects.put(descriptor!.hash, utf8(p.body));
      suppliedBodies.set(token!, descriptor!.hash);
      bodyAvailability.set(token!, true);
      for (const id of waiting.get(token!) ?? []) {
        const event = pending.get(id);
        if (event && !event.body_hash) {
          event.body_hash = descriptor!.hash;
          changedIds.add(id);
          changed = true;
        }
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
    let available = token ? bodyAvailability.get(token) : undefined;
    if (p.body === null && token && available === undefined && !old?.body_hash) {
      // A retained body for this content is already in the object store.
      // Cache the answer per content token seen in this proposal only.
      available = (await objects.get(descriptor!.hash)) !== null;
      bodyAvailability.set(token, available);
    }
    const body =
      p.body !== null || (token && available)
        ? descriptor!.hash
        : (old?.body_hash ?? null);
    const preferred =
      !old || preferredSignature(p.signature_bytes, old.signature);
    if (old) duplicate++;
    else {
      accepted++;
      position++;
      journal.push({ position, id: p.id });
    }
    if (!old || preferred || old.body_hash !== body) {
      changed = true;
      changedIds.add(p.id);
      const event: StoredEvent = {
        envelope_hash: preferred ? p.envelope_hash : old.envelope_hash,
        body_hash: body,
        header: p.header,
        signature: preferred ? p.signature_bytes : old.signature,
        position: old?.position ?? position,
      };
      pending.set(p.id, event);
      if (token && !body) {
        const list = waiting.get(token) ?? [];
        list.push(p.id);
        waiting.set(token, list);
      }
    }
  };
  for await (const bytes of carriers(join(proposal, "carriers.jsonl")))
    await add(validCarrier(bytes));
  await add(view);
  // Fill retained events whose body this proposal supplied. One scan at
  // the end replaces a whole-dictionary waiting map built up front.
  if (suppliedBodies.size) {
    for (const [id, event] of Object.entries(state.events)) {
      if (pending.has(id) || event.body_hash) continue;
      const descriptor = event.header.content;
      if (!descriptor) continue;
      const hash = suppliedBodies.get(key(descriptor.hash, descriptor.bytes));
      if (!hash) continue;
      pending.set(id, { ...event, body_hash: hash });
      changedIds.add(id);
      changed = true;
    }
  }
  const sourceRecords = new Map<string, string>();
  const eventFor = (id: string) => pending.get(id) ?? state.events[id];
  const evidenceFor = async (id: string) => {
    const event = eventFor(id);
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
      if (!state.selections.includes(set.selection))
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
      const retained = eventFor(id);
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
  const selections = [...state.selections];
  if (!selections.includes(selection.hash)) {
    selections.push(selection.hash);
    selections.sort();
    changed = true;
  }
  if (changed) {
    // Assemble the next state once, at commit. Retained event objects are
    // shared with the loaded state; only changed events are new objects.
    const next = {
      ...state,
      revision: state.revision + 1,
      position,
      // The first service read publishes one wrapper for the complete inventory.
      snapshot: null,
      events: { ...state.events, ...Object.fromEntries(pending) },
      journal: [...state.journal, ...journal],
      selections,
    };
    // Projections stay bounded even when a full proposal changes every event.
    // Staged rows stay private until the final admission transaction promotes them.
    const canStage =
      coordinator.stageVerifiedRecords &&
      coordinator.discardVerifiedRecordStage;
    const stage = canStage ? randomUUID() : undefined;
    let verified: StoredVerifiedRecord[] = [];
    let semantic: StoredSemanticRecord[] = [];
    try {
      if (stage) {
        let batch: string[] = [];
        for (const id of changedIds) {
          batch.push(id);
          if (batch.length === 256) {
            const records = await prepareAdmissionRecords(
              objects,
              next.events,
              batch,
            );
            await coordinator.stageVerifiedRecords!(
              stage,
              records.verifiedRecords,
              records.semanticRecords,
            );
            batch = [];
          }
        }
        if (batch.length) {
          const records = await prepareAdmissionRecords(
            objects,
            next.events,
            batch,
          );
          await coordinator.stageVerifiedRecords!(
            stage,
            records.verifiedRecords,
            records.semanticRecords,
          );
        }
      } else {
        const records = await prepareAdmissionRecords(
          objects,
          next.events,
          changedIds,
        );
        verified = records.verifiedRecords;
        semantic = records.semanticRecords;
      }
      if (
        !(await coordinator.compareAndSwap(
          state.revision,
          next,
          undefined,
          [...changedIds],
          verified,
          stage,
          semantic,
        ))
      )
        throw new Error(
          "The data directory changed during the load. Stop other writers and rerun the loader.",
        );
      if (!coordinator.saveVerifiedRecords)
        await retainVerifiedRecords(coordinator, verified);
      if (!coordinator.saveSemanticRecords)
        await retainSemanticRecords(coordinator, semantic);
    } finally {
      if (stage) await coordinator.discardVerifiedRecordStage!(stage);
    }
  }
  return {
    view: view.id,
    selection: selection.hash,
    accepted,
    duplicate,
    selected: selection.count,
    position,
  };
}

export async function loadImportProposal(options: {
  proposal: string;
  directory: string;
  stateTraversalLimit?: number;
  maxAdmittedEvents?: number;
  maxCarrierRecords?: number;
}) {
  const traversal = stateTraversalLimit(options.stateTraversalLimit);
  const release = await lockDataDirectory(options.directory, "import-loader");
  let coordinator: SqliteCoordinator | undefined;
  try {
    const previousConfiguration = await readLoadedView(options.directory);
    coordinator = new SqliteCoordinator(
      join(options.directory, "coordinator.sqlite"),
    );
    await coordinator.discardAbandonedVerifiedRecordStages();
    const objects = new FileObjectStore(join(options.directory, "objects"));
    const result = await admitImportProposal(
      options.proposal,
      coordinator,
      objects,
      {
        maxAdmittedEvents: options.maxAdmittedEvents,
        maxCarrierRecords: options.maxCarrierRecords,
      },
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
