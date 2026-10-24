import {
  compactRecord,
  readVerifiedRecord,
} from "../../service/src/verified-records.ts";
import { open, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { prepareSelection } from "../../core/src/index.ts";
import type { Coordinator, ObjectStore } from "../../service/src/storage.ts";
import { parseProtocolJson, syncDirectory } from "./storage.ts";

export interface LoadedView {
  version: 1;
  view: string;
  selection: string;
  state_traversal_limit?: number;
}

export function stateTraversalLimit(value: string | number | undefined) {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(String(value)))
    throw new Error("The state traversal limit must be a positive integer.");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > 1_000_000_000)
    throw new Error("The state traversal limit must not exceed 1000000000.");
  return number;
}

/** Check retained signed evidence rather than a snapshot that later writes replace. */
export async function checkLoadedView(
  value: LoadedView,
  coordinator: Coordinator,
  objects: ObjectStore,
) {
  if (
    value.version !== 1 ||
    (value.state_traversal_limit !== undefined &&
      typeof value.state_traversal_limit !== "number") ||
    !/^jve1:[a-f0-9]{64}$/.test(value.view) ||
    !/^sha256:[a-f0-9]{64}$/.test(value.selection) ||
    Object.keys(value).some(
      (key) =>
        !["version", "view", "selection", "state_traversal_limit"].includes(
          key,
        ),
    )
  )
    throw new Error("The loaded view configuration is invalid.");
  stateTraversalLimit(value.state_traversal_limit);
  const state = await coordinator.load();
  const event = state.events[value.view];
  if (!event?.body_hash || !state.selections.includes(value.selection))
    throw new Error(
      "The loaded view or its selection is not retained. Rerun the loader.",
    );
  const retained = compactRecord(
    await readVerifiedRecord(coordinator, objects, value.view, event),
  );
  const body = await objects.get(event.body_hash);
  if (!body)
    throw new Error("The loaded view bytes are unavailable. Rerun the loader.");
  const viewBody = JSON.parse(new TextDecoder().decode(body));
  if (
    retained.id !== value.view ||
    event.header.action.kind !== "view.publish" ||
    !retained.action_valid ||
    retained.body_status !== "present" ||
    !viewBody.import_sets.some(
      (set: { selection: string }) => set.selection === value.selection,
    ) ||
    viewBody.import_sets.some(
      (set: { selection: string }) => !state.selections.includes(set.selection),
    )
  )
    throw new Error(
      "The loaded view does not select the retained import selection.",
    );
  for (const set of viewBody.import_sets) {
    const bytes = await objects.get(set.selection);
    if (!bytes || prepareSelection(bytes).hash !== set.selection)
      throw new Error(
        "The loaded import selection bytes are unavailable or invalid. Rerun the loader.",
      );
  }
}

export async function readLoadedView(
  directory: string,
): Promise<LoadedView | undefined> {
  let handle;
  try {
    handle = await open(join(directory, "loaded-view.json"), "r");
    if ((await handle.stat()).size > 4096)
      throw new Error("The loaded view configuration exceeds 4096 bytes.");
    return parseProtocolJson<LoadedView>(await handle.readFile());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function writeLoadedView(directory: string, value: LoadedView) {
  const temporary = join(directory, `.loaded-view-${randomUUID()}.next`);
  try {
    await writeFile(temporary, JSON.stringify(value), {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    await rename(temporary, join(directory, "loaded-view.json"));
    await syncDirectory(directory);
  } finally {
    await unlink(temporary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}
