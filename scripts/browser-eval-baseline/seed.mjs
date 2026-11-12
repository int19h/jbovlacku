import {
  canonicalize,
  contentHash,
  projectRecord,
  projectionBuildIdentity,
  utf8,
} from "../../packages/core/src/browser.ts";
import { PROJECTION_PRODUCER_KEY } from "../../apps/web/src/data/projection-meta.ts";

const hashJson = (value) =>
  contentHash(utf8(canonicalize(utf8(JSON.stringify(value)))));
export const productInventory = (value) => {
  const events = value.events.map((envelope) => JSON.parse(envelope).id);
  const bodies = [
    ...new Set(
      value.events
        .map((envelope) => JSON.parse(envelope).header.content?.hash)
        .filter(Boolean),
    ),
  ].sort();
  const selections = Object.keys(value.import_selections).sort();
  const manifest = {
    events: {
      count: events.length,
      hash: contentHash(utf8(value.events.join("\n") + "\n")),
    },
    bodies: { count: bodies.length, hash: hashJson(bodies) },
    import_selections: { count: selections.length, hash: hashJson(selections) },
  };
  return {
    snapshot: hashJson(manifest),
    logical_inventory: hashJson({
      events,
      bodies,
      import_selections: selections,
    }),
    events_digest: manifest.events.hash,
    view: value.selected_view,
    events,
    bodies,
    unretained_bodies: [
      ...new Set(
        value.events
          .map((envelope) => JSON.parse(envelope).header.content?.hash)
          .filter((hash) => hash && !bodies.includes(hash)),
      ),
    ].sort(),
    selections,
  };
};
const writeBatch = async (database, name, rows) => {
  for (let start = 0; start < rows.length; start += 256) {
    const batch = rows.slice(start, start + 256);
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(name, "readwrite");
      const store = transaction.objectStore(name);
      for (const [id, value] of batch) store.put(value, id);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => {};
    });
  }
};
const writeProjectedBatch = async (database, records) => {
  for (let start = 0; start < records.length; start += 256) {
    const batch = records.slice(start, start + 256);
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(
        ["records", "projections", "meta"],
        "readwrite",
      );
      const meta = transaction.objectStore("meta");
      const producer = meta.get(PROJECTION_PRODUCER_KEY);
      producer.onsuccess = () => {
        const current = producer.result;
        const next =
          current === undefined || current === projectionBuildIdentity()
            ? projectionBuildIdentity()
            : "mixed";
        meta.put(next, PROJECTION_PRODUCER_KEY);
        for (const { record, row } of batch) {
          transaction.objectStore("records").put(record, record.id);
          transaction.objectStore("projections").put(row, record.id);
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => {};
    });
  }
};
const projectedRecord = (record) => {
  const projected = projectRecord(
    utf8(record.envelope),
    record.body === null ? undefined : utf8(record.body),
  );
  return {
    record: { ...record, bodyStatus: projected.bodyStatus },
    row: projected.row,
  };
};
export const seedProduct = async (store, value) => {
  const database = await store.database;
  for (let start = 0; start < value.events.length; start += 256) {
    const records = value.events.slice(start, start + 256).map((envelope) => {
      const { id, header } = JSON.parse(envelope);
      const body = value.bodies[id];
      return projectedRecord({
        id,
        envelope,
        body: body ?? null,
        bodyStatus: "none",
        bodyHash: header.content?.hash ?? null,
      });
    });
    await writeProjectedBatch(database, records);
  }
  await writeBatch(
    database,
    "selections",
    Object.entries(value.import_selections).map(([hash, selection]) => [
      hash,
      JSON.stringify(selection),
    ]),
  );
  const inventory = productInventory(value);
  await store.commitInventory(inventory);
  return inventory;
};

export const seedProductStream = async (store, fixtureUrl, recordsUrl) => {
  const fixture = await (await fetch(fixtureUrl)).json();
  const response = await fetch(recordsUrl);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const database = await store.database;
  let text = "";
  let rows = [];
  const flush = async () => {
    if (rows.length === 0) return;
    await writeProjectedBatch(database, rows.map(projectedRecord));
    rows = [];
  };
  for (;;) {
    const { done, value } = await reader.read();
    text += decoder.decode(value, { stream: !done });
    let end;
    while ((end = text.indexOf("\n")) >= 0) {
      const line = text.slice(0, end);
      text = text.slice(end + 1);
      if (!line) continue;
      const row = JSON.parse(line);
      rows.push(row);
      if (rows.length === 256) await flush();
    }
    if (done) break;
  }
  if (text) rows.push(JSON.parse(text));
  await flush();
  await writeBatch(
    database,
    "selections",
    Object.entries(fixture.import_selections).map(([hash, selection]) => [
      hash,
      JSON.stringify(selection),
    ]),
  );
  await store.commitInventory(fixture.inventory);
  return fixture.inventory;
};
