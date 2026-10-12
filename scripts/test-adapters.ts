import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { initializeCore, createEvent } from "../packages/core/src/index.ts";

const root = resolve(import.meta.dirname, "..");
const testRoot = resolve(
  process.env.JVC_TEST_ROOT ?? join(root, "data", "adapter-tests"),
);
await mkdir(testRoot, { recursive: true });
const directory = await mkdtemp(join(testRoot, "case-"));
await initializeCore(
  await readFile(join(root, "packages/core/generated/jvc_runtime_bg.wasm")),
);
const corpus = process.env.JVC_ADAPTER_CARRIER
  ? await readFile(process.env.JVC_ADAPTER_CARRIER)
  : null;
const seed = new Uint8Array(32).fill(91);
const entry = createEvent(
  seed,
  [],
  "a".repeat(32),
  { kind: "identity.profile" },
  { name: "Adapter fixture", bio: [], links: [] },
);
async function unusedPort() {
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((done) => listener.close(() => done()));
  return port;
}
const ports = [await unusedPort(), await unusedPort()];
const children: ChildProcess[] = [];
const logs: string[] = [];
async function start(index: number) {
  const args =
    index === 0
      ? [join(root, "apps/server/dist/main.js")]
      : [
          join(root, "node_modules/wrangler/bin/wrangler.js"),
          "dev",
          "--config",
          "apps/worker/wrangler.jsonc",
          "--local",
          "--ip",
          "127.0.0.1",
          "--port",
          String(ports[index]),
          "--var",
          "SNAPSHOT_LIMIT:3",
          "--var",
          `PROTOTYPE_BATCH:${corpus ? "enabled" : "disabled"}`,
          "--persist-to",
          join(directory, "worker"),
        ];
  const child = spawn(process.execPath, args, {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      PORT: String(ports[index]),
      HOST: "127.0.0.1",
      JVC_DATA_DIR: join(directory, "node"),
      JVC_LOG_ERRORS: "enabled",
      JVC_SNAPSHOT_LIMIT: "3",
      JVC_PROTOTYPE_BATCH: corpus ? "enabled" : "disabled",
      WRANGLER_SEND_METRICS: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children[index] = child;
  child.stdout!.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr!.on("data", (chunk) => logs.push(String(chunk)));
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    if (child.exitCode !== null)
      throw new Error(`Adapter exited: ${logs.join("")}`);
    try {
      if ((await fetch(`http://127.0.0.1:${ports[index]}/api/health/ready`)).ok)
        return;
    } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Adapter failed readiness: ${logs.join("")}`);
}
async function stop(index: number) {
  const child = children[index];
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  process.kill(-child.pid!, "SIGTERM");
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Adapter did not stop.")),
        10000,
      ).unref(),
    ),
  ]);
}
const api = (index: number, path: string, body?: unknown) =>
  fetch(
    `http://127.0.0.1:${ports[index]}/api/v1${path}`,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: `http://127.0.0.1:${ports[index]}`,
          },
          body: JSON.stringify(body),
        },
  );
try {
  const receipts: any[] = [];
  const indexes =
    process.env.JVC_ADAPTER_ONLY === "worker"
      ? [1]
      : process.env.JVC_ADAPTER_ONLY === "node"
        ? [0]
        : [0, 1];
  for (const index of indexes) {
    await start(index);
    if (process.env.JVC_ADAPTER_CORPUS_ONLY !== "enabled") {
      const missing = await api(index, "/events", { ...entry, body: null });
      assert.equal(missing.status, 201);
      const original: any = await missing.json();
      const complete = await api(index, "/events", entry);
      assert.equal(complete.status, 200);
      const receipt: any = await complete.json();
      assert.equal(receipt.cursor, original.cursor);
      assert.notEqual(receipt.snapshot, original.snapshot);
      assert.equal(
        (
          await api(
            index,
            `/bodies/${entry.envelope.header.content!.hash}?snapshot=${original.snapshot}`,
          )
        ).status,
        404,
      );
      receipts[index] = receipt;
      await stop(index);
      await start(index);
      const retry = await api(index, "/events", entry);
      assert.equal(retry.status, 200);
      assert.deepEqual(await retry.json(), receipt);
      const changes: any = await (await api(index, "/changes")).json();
      assert.equal(changes.items.length, 1);
      assert.equal(changes.items[0].id, entry.envelope.id);
      assert.equal(
        (await api(index, `/events/${entry.envelope.id}`)).status,
        200,
      );
      // The newer read routes answer on both adapters with the same shapes.
      const manifest: any = await (await api(index, "/manifest")).json();
      assert.ok(Array.isArray(manifest.package_versions));
      const records: any = await (
        await api(index, "/records?limit=200")
      ).json();
      const record = records.items.find((i: any) => i.id === entry.envelope.id);
      assert.ok(record, "records route lists the fixture event");
      assert.equal(record.body_status, "present");
      assert.equal(record.body.name, "Adapter fixture");
      assert.equal(records.snapshot, manifest.snapshot);
      // Identity reads need a retained view. The fixture key publishes one.
      const view = createEvent(
        seed,
        [],
        "f".repeat(32),
        { kind: "view.publish", parents: [] },
        {
          name: "Adapter view",
          description: [],
          roots: [
            {
              identity: entry.envelope.header.issuer,
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
      const viewResponse = await api(index, "/events", view);
      assert.equal(viewResponse.status, 201, await viewResponse.clone().text());
      const identity = encodeURIComponent(entry.envelope.header.issuer);
      const withView = `view=${encodeURIComponent(view.envelope.id)}`;
      const personResponse = await api(
        index,
        `/identities/${identity}?${withView}`,
      );
      assert.equal(
        personResponse.status,
        200,
        await personResponse.clone().text(),
      );
      const person: any = await personResponse.json();
      assert.equal(person.profile.state, "known");
      assert.equal(person.profile.claims_complete, true);
      assert.equal(person.profile.claims[0].body_status, "present");
      assert.equal(person.profile.claims[0].body.name, "Adapter fixture");
      const activity: any = await (
        await api(index, `/identities/${identity}/activity?limit=5&${withView}`)
      ).json();
      assert.ok(activity.items.some((i: any) => i.id === entry.envelope.id));
      assert.equal(
        (await api(index, `/identities/${identity}/activity/extra`)).status,
        404,
      );
      assert.equal(
        (await api(index, `/records?snapshot=sha256:${"0".repeat(64)}`)).status,
        410,
      );
      const invalid = await fetch(
        `http://127.0.0.1:${ports[index]}/api/v1/events`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"envelope":{},"body":null,"body":null}',
        },
      );
      assert.equal(invalid.status, 400);
      const forbidden = await fetch(
        `http://127.0.0.1:${ports[index]}/api/v1/events`,
        {
          method: "POST",
          headers: {
            origin: "https://attacker.example",
            "content-type": "application/json",
          },
          body: JSON.stringify(entry),
        },
      );
      assert.equal(forbidden.status, 403);
      let latest: any;
      for (const nonce of ["b", "c", "d", "e"]) {
        const extra = createEvent(
          seed,
          [],
          nonce.repeat(32),
          { kind: "identity.merge" },
          null,
        );
        const response = await api(index, "/events", extra);
        assert.equal(response.status, 201);
        latest = await response.json();
      }
      assert.equal(
        (
          await api(
            index,
            `/inventory?kind=events&snapshot=${original.snapshot}`,
          )
        ).status,
        410,
      );
      if (index === 0) {
        const asset = await fetch(`http://127.0.0.1:${ports[index]}/`);
        assert.equal(asset.headers.get("x-frame-options"), "DENY");
        assert(
          asset.headers
            .get("content-security-policy")
            ?.includes("'wasm-unsafe-eval'"),
        );
      }
      await stop(index);
      await start(index);
      assert.equal(
        (
          await api(
            index,
            `/inventory?kind=events&snapshot=${original.snapshot}`,
          )
        ).status,
        410,
      );
      const finalRetry: any = await (await api(index, "/events", entry)).json();
      assert.equal(finalRetry.cursor, receipt.cursor);
      assert.equal(finalRetry.snapshot, latest.snapshot);
      receipts[index].retained_snapshot = latest.snapshot;
    } else {
      receipts[index] = {};
    }
    if (corpus) {
      const batch = await fetch(
        `http://127.0.0.1:${ports[index]}/api/v1/prototype/batch`,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-ndjson",
            origin: `http://127.0.0.1:${ports[index]}`,
          },
          body: corpus,
        },
      );
      assert.equal(batch.status, 201, await batch.clone().text());
      const result: any = await batch.json();
      assert.equal(
        result.receipts.length,
        corpus.toString().trim().split("\n").length,
      );
      if (process.env.JVC_ADAPTER_SELECTION) {
        const selection = await fetch(
          `http://127.0.0.1:${ports[index]}/api/v1/import-selections`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: `http://127.0.0.1:${ports[index]}`,
            },
            body: await readFile(process.env.JVC_ADAPTER_SELECTION),
          },
        );
        assert.equal(selection.status, 201, await selection.clone().text());
      }
      if (process.env.JVC_ADAPTER_VIEW) {
        const search = await api(
          index,
          `/search?q=klama&language=en&view=${process.env.JVC_ADAPTER_VIEW}`,
        );
        assert.equal(search.status, 200, await search.clone().text());
        assert(((await search.json()) as any).hits.length > 0);
      }
      const manifest: any = await (await api(index, "/manifest")).json();
      receipts[index].corpus_snapshot = manifest.snapshot;
      await stop(index);
      await start(index);
      assert.equal(
        ((await (await api(index, "/manifest")).json()) as any).snapshot,
        manifest.snapshot,
      );
    }
    await stop(index);
  }
  if (indexes.length === 2) {
    assert.equal(receipts[0].snapshot, receipts[1].snapshot);
    assert.equal(receipts[0].logical_inventory, receipts[1].logical_inventory);
    assert.equal(receipts[0].retained_snapshot, receipts[1].retained_snapshot);
    assert.equal(receipts[0].corpus_snapshot, receipts[1].corpus_snapshot);
  }
  console.log(
    JSON.stringify({
      status: "passed",
      adapters: indexes.map((index) => (index === 0 ? "node" : "worker")),
      checks:
        "Node/Workers admission, late body, exact old snapshot, duplicate retry, process restart, strict JSON, shared snapshot, same-origin writes, bounded snapshot expiry and restart, package_versions, records, identities and activity reads, 404 suffix, 410 snapshot",
      directory,
    }),
  );
} finally {
  await Promise.allSettled(children.map((_, index) => stop(index)));
  await writeFile(join(directory, "adapters.log"), logs.join(""));
}
