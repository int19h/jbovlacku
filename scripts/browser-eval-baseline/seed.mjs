import {
  canonicalize,
  contentHash,
  utf8,
} from "../../packages/core/src/browser.ts";

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
export const seedProduct = async (store, value) => {
  const database = await store.database;
  for (let start = 0; start < value.events.length; start += 256) {
    const records = value.events.slice(start, start + 256).map((envelope) => {
      const { id, header } = JSON.parse(envelope);
      const body = value.bodies[id];
      return [
        id,
        {
          id,
          envelope,
          body: body ?? null,
          bodyStatus:
            body !== undefined
              ? "present"
              : header.content
                ? "missing"
                : "none",
          bodyHash: header.content?.hash ?? null,
        },
      ];
    });
    await writeBatch(database, "records", records);
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
  await store.put("inventory", inventory.snapshot, inventory);
  await store.put("inventory", "latest", inventory);
  return inventory;
};
