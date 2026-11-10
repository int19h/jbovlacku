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
export const seedProduct = async (store, value) => {
  for (const envelope of value.events) {
    const { id, header } = JSON.parse(envelope);
    const body = value.bodies[id];
    await store.put("records", id, {
      id,
      envelope,
      body: body ?? null,
      bodyStatus:
        body !== undefined ? "present" : header.content ? "missing" : "none",
      bodyHash: header.content?.hash ?? null,
    });
  }
  for (const [hash, selection] of Object.entries(value.import_selections))
    await store.put("selections", hash, JSON.stringify(selection));
  const inventory = productInventory(value);
  await store.put("inventory", inventory.snapshot, inventory);
  await store.put("inventory", "latest", inventory);
  return inventory;
};
