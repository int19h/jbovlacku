/** The signed view in use: the server's selected view, or the one the reader chose. */
import { describe } from "../lib/dom.ts";
import { getManifest, getWord, loadRecord } from "./api.ts";
import type { ViewBody } from "../model/types.ts";
/** Loads the selected public view event of this server. */
export async function loadSiteView(
  signal?: AbortSignal,
): Promise<{ id: string; body: ViewBody | null; error: string | null }> {
  // The view ID is reported with every word response. A manifest alone does not name it,
  // so the client reads a search or word response. A zero-word request is cheapest.
  const manifest = await getManifest({ signal });
  const probe = await getWord("jvw1:" + "0".repeat(64), {
    snapshot: manifest.snapshot,
    signal,
  }).catch(() => null);
  if (!probe)
    return {
      id: "",
      body: null,
      error: "The server did not report its selected view.",
    };
  try {
    const record = await loadRecord<ViewBody>(probe.view, manifest.snapshot, {
      signal,
    });
    return { id: probe.view, body: record.body, error: record.bodyError };
  } catch (error) {
    return { id: probe.view, body: null, error: describe(error) };
  }
}
