import { LocalStore } from "../../apps/web/src/data/store.ts";
import { seedProductStream } from "./seed.mjs";

self.onmessage = async (event) => {
  try {
    const store = new LocalStore(event.data.database);
    const inventory = await seedProductStream(
      store,
      event.data.fixture,
      event.data.records,
    );
    console.error("seed worker: records committed");
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
