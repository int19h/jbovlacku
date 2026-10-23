import { createHash, randomUUID } from "node:crypto";
import { link, open, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { serialize, deserialize } from "node:v8";
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
const legacyFile = /^evaluation-[a-f0-9]{64}\.json\.gz$/;
const binaryFile = /^evaluation-v2-[a-f0-9]{64}\.bin\.gz$/;
const ownedFile = (name: string) =>
  legacyFile.test(name) || binaryFile.test(name);
const MAX_COMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 768 * 1024 * 1024;
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
  prepareSnapshotCache?(snapshot: string): Promise<void>;
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
      if (name !== retained && (ownedFile(name) || pendingFile.test(name)))
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
        !ownedFile(pin.file) ||
        !/^[a-f0-9]{64}$/.test(pin.hash)
      )
        return null;
      const bytes = await readFile(join(this.directory, pin.file));
      if (bytes.length > MAX_COMPRESSED_BYTES || hash(bytes) !== pin.hash)
        return null;
      const decoded = await decompress(bytes, {
        maxOutputLength: MAX_PAYLOAD_BYTES,
      });
      const binary = binaryFile.test(pin.file);
      const value = binary
        ? deserialize(decoded)
        : JSON.parse(decoded.toString("utf8"));
      if (value.binding !== expected || (binary && value.cache_schema !== 2))
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
      if (binary)
        return payload.core instanceof Uint8Array
          ? (payload as ServiceCheckpoint)
          : null;
      if (typeof payload.core !== "string") return null;
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
    await this.pins.prepareSnapshotCache?.(binding.snapshot);
    const expected = bindingBytes(binding);
    const encoded = serialize({ cache_schema: 2, binding: expected, payload });
    if (encoded.length > MAX_PAYLOAD_BYTES)
      throw new Error("The checkpoint payload exceeds its local cache limit.");
    const bytes = await compress(encoded, { level: 1 });
    if (bytes.length > MAX_COMPRESSED_BYTES)
      throw new Error(
        "The compressed checkpoint exceeds its local cache limit.",
      );
    const digest = hash(bytes);
    const name = `evaluation-v2-${digest}.bin.gz`;
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
