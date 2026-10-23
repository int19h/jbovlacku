import { createHash, randomUUID } from "node:crypto";
import { link, open, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import type {
  CheckpointBinding,
  CheckpointStore,
  ServiceCheckpoint,
} from "../../../packages/service/src/checkpoint.ts";
import {
  durableDirectory,
  syncDirectory,
  type CheckpointPin,
} from "./storage.ts";

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const ownedFile = /^evaluation-[a-f0-9]{64}\.json\.gz$/;
const pendingFile = /^\.evaluation-pending-[a-f0-9-]{36}$/;
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const bindingBytes = (binding: CheckpointBinding) =>
  JSON.stringify([
    binding.schema,
    binding.snapshot,
    binding.logical_inventory,
    binding.position,
    binding.view,
    binding.core_version,
    binding.limits
      ? [
          binding.limits.events,
          binding.limits.traversal,
          binding.limits.claim_depth,
        ]
      : null,
  ]);

export interface CheckpointPins {
  checkpointPin(): CheckpointPin | null;
  pinCheckpoint(binding: CheckpointBinding, pin: CheckpointPin): boolean;
}

/** SQLite pins private cache bytes independently of the file contents. */
export class FileCheckpointStore implements CheckpointStore {
  private pending: Promise<void> = Promise.resolve();
  private initialized?: Promise<void>;
  constructor(
    private directory: string,
    private pins: CheckpointPins,
  ) {}
  private async initialize(): Promise<void> {
    this.initialized ??= (async () => {
      await durableDirectory(this.directory);
      await this.clean();
    })();
    return this.initialized;
  }
  private async clean(): Promise<void> {
    const retained = this.pins.checkpointPin()?.file;
    for (const name of await readdir(this.directory)) {
      if (name !== retained && (ownedFile.test(name) || pendingFile.test(name)))
        await unlink(join(this.directory, name));
    }
  }
  async load(binding: CheckpointBinding): Promise<ServiceCheckpoint | null> {
    try {
      await this.initialize();
      const pin = this.pins.checkpointPin();
      const expected = bindingBytes(binding);
      if (
        !pin ||
        pin.binding !== expected ||
        !ownedFile.test(pin.file) ||
        !/^[a-f0-9]{64}$/.test(pin.hash)
      )
        return null;
      const bytes = await readFile(join(this.directory, pin.file));
      if (hash(bytes) !== pin.hash) return null;
      const text = await decompress(bytes, {
        maxOutputLength: 768 * 1024 * 1024,
      });
      const value = JSON.parse(text.toString("utf8"));
      if (value.binding !== expected || typeof value.payload?.core !== "string")
        return null;
      const payload = value.payload;
      if (
        !Array.isArray(payload.package_records) ||
        !Array.isArray(payload.envelopes) ||
        !Array.isArray(payload.packages?.entries) ||
        !payload.packages.packages ||
        !payload.packages.packages2
      )
        return null;
      const core = Buffer.from(payload.core, "base64");
      if (core.toString("base64") !== payload.core) return null;
      return { ...payload, core: new Uint8Array(core) } as ServiceCheckpoint;
    } catch {
      // A missing, damaged, or stale cache always returns to ordinary evaluation.
      return null;
    }
  }
  save(binding: CheckpointBinding, payload: ServiceCheckpoint): Promise<void> {
    const operation = this.pending.then(() => this.write(binding, payload));
    this.pending = operation.catch(() => {});
    return operation;
  }
  private async write(
    binding: CheckpointBinding,
    payload: ServiceCheckpoint,
  ): Promise<void> {
    await this.initialize();
    const expected = bindingBytes(binding);
    const bytes = await compress(
      JSON.stringify({
        binding: expected,
        payload: {
          ...payload,
          core: Buffer.from(payload.core).toString("base64"),
        },
      }),
      { level: 1 },
    );
    const digest = hash(bytes);
    const name = `evaluation-${digest}.json.gz`;
    const target = join(this.directory, name);
    const temporary = join(
      this.directory,
      `.evaluation-pending-${randomUUID()}`,
    );
    let created = false;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, target);
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (hash(await readFile(target)) !== digest)
          throw new Error("Checkpoint cache collision.");
      }
      await unlink(temporary);
      await syncDirectory(this.directory);
      const committed = this.pins.pinCheckpoint(binding, {
        binding: expected,
        hash: digest,
        file: name,
      });
      if (!committed) {
        if (created && this.pins.checkpointPin()?.file !== name)
          await unlink(target);
        return;
      }
      await this.clean();
      await syncDirectory(this.directory);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      // A failed file write or pin transaction preserves the last pinned file.
      if (created && this.pins.checkpointPin()?.file !== name)
        await unlink(target).catch(() => {});
      throw error;
    }
  }
}
