import { LocalStore } from "../../apps/web/src/data/store.ts";
import { seedProduct } from "./seed.mjs";

self.onmessage = async (event) => {
  try {
    const store = new LocalStore(event.data.database);
    const input = await (
      await fetch(event.data.input, { cache: "no-store" })
    ).json();
    const inventory = await seedProduct(store, input);
    (await store.database).close();
    self.postMessage({ inventory });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    self.close();
  }
};
