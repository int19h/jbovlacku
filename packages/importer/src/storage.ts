import {
  access,
  link,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { canonicalize, contentHash, utf8 } from "../../core/src/index.ts";
import {
  canonical,
  type CaptureManifest,
  type ImportResult,
  type Journal,
} from "./index.ts";

/** Protocol-owned JSON crosses the same strict parser as signed records. */
export function parseProtocolJson<T>(bytes: Uint8Array): T {
  return JSON.parse(canonicalize(bytes)) as T;
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function durableDirectory(path: string): Promise<void> {
  const firstCreated = await mkdir(path, { recursive: true });
  if (firstCreated === undefined) return;
  let current = path;
  while (true) {
    await syncDirectory(dirname(current));
    if (current === firstCreated) break;
    current = dirname(current);
  }
}

async function immutableFile(path: string, bytes: Uint8Array): Promise<void> {
  try {
    const existing = await readFile(path);
    if (!existing.equals(Buffer.from(bytes)))
      throw new Error(
        "The existing source archive bytes differ from the pinned artifact.",
      );
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${randomUUID()}.next`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", flush: true });
    // A hard link installs the complete file and refuses an existing hash path.
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await readFile(path)).equals(Buffer.from(bytes)))
        throw new Error(
          "The concurrent source archive bytes differ from the pinned artifact.",
        );
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

async function derivedFile(path: string, text: string): Promise<void> {
  const temporary = `${path}.next`;
  await writeFile(temporary, text);
  await rename(temporary, path);
}

export async function readJournal(
  output: string,
): Promise<Journal | undefined> {
  try {
    return parseProtocolJson<Journal>(
      await readFile(join(output, "journal.json")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    for (const name of [
      "carriers.jsonl",
      "selected-view.json",
      "proposal.json",
      "journal.json.next",
      "import-selection.json",
      "source-archive",
    ]) {
      let exists = false;
      try {
        await access(join(output, name));
        exists = true;
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing;
      }
      if (exists)
        throw new Error(
          "The import journal is missing. Rebuild it from retained envelopes before another import.",
        );
    }
    return undefined;
  }
}

export type PublicationCheckpoint =
  | "source-durable"
  | "journal-durable"
  | "carriers-written";

/** Save source evidence, commit the journal, then replace rebuildable output files. */
export async function publishProposal(
  output: string,
  sourceBytes: Uint8Array,
  manifest: CaptureManifest,
  result: ImportResult,
  checkpoint?: (stage: PublicationCheckpoint) => Promise<void>,
): Promise<void> {
  if (contentHash(sourceBytes) !== manifest.sha256)
    throw new Error("The archived source bytes do not match the manifest.");
  await durableDirectory(output);
  await syncDirectory(dirname(output));
  const archive = join(output, "source-archive");
  await durableDirectory(archive);
  await syncDirectory(output);
  await immutableFile(
    join(archive, `${manifest.sha256.slice(7)}.json`),
    sourceBytes,
  );
  const manifestBytes = utf8(canonical(manifest));
  await immutableFile(
    join(
      archive,
      `${manifest.sha256.slice(7)}.${contentHash(manifestBytes).slice(7)}.manifest.json`,
    ),
    manifestBytes,
  );
  await syncDirectory(archive);
  await checkpoint?.("source-durable");

  // The directory flush makes the committed name durable before dependent output appears.
  await writeFile(
    join(output, "journal.json.next"),
    canonical(result.journal),
    { flush: true },
  );
  await rename(join(output, "journal.json.next"), join(output, "journal.json"));
  await syncDirectory(output);
  await checkpoint?.("journal-durable");

  await derivedFile(
    join(output, "carriers.jsonl"),
    result.carriers.map((carrier) => canonical(carrier) + "\n").join(""),
  );
  await checkpoint?.("carriers-written");
  await derivedFile(
    join(output, "import-selection.json"),
    result.selection.canonical,
  );
  await derivedFile(join(output, "selected-view.json"), canonical(result.view));
  await derivedFile(
    join(output, "proposal.json"),
    canonical({
      source: manifest.source,
      importer: result.journal.importer,
      selected_view: result.view.envelope.id,
      import_selection: result.selection.hash,
      report: result.report,
    }),
  );
}
