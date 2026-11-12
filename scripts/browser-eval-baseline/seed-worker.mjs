import { LocalStore } from "../../apps/web/src/data/store.ts";
import { initializeCore } from "../../packages/core/src/browser.ts";
import { seedProductStream } from "./seed.mjs";

self.onmessage = async (event) => {
  try {
    await initializeCore();
    const store = new LocalStore(event.data.database);
    const inventory = await seedProductStream(
      store,
      event.data.fixture,
      event.data.records,
    );
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
