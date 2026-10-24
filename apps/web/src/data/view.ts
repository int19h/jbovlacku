/** The signed view in use: the server's selected view, or the one the reader chose. */
import { describe } from "../lib/dom.ts";
import { getManifest, getWord, getPreferredView, loadRecord } from "./api.ts";
import type { ViewBody } from "../model/types.ts";
/** Loads the selected public view event of this server. */
export async function loadSiteView(signal?: AbortSignal): Promise<{
  id: string;
  body: ViewBody | null;
  error: string | null;
  issuer?: string;
}> {
  const manifest = await getManifest({ signal });
  let view = getPreferredView() ?? manifest.view;
  if (view === undefined)
    view = (
      await getWord("jvw1:" + "0".repeat(64), {
        snapshot: manifest.snapshot,
        signal,
      }).catch(() => null)
    )?.view;
  if (!view)
    return {
      id: "",
      body: null,
      error: "The server did not report its selected view.",
    };
  try {
    const record = await loadRecord<ViewBody>(view, manifest.snapshot, {
      signal,
    });
    return {
      id: view,
      body: record.body,
      error: record.bodyError,
      issuer: record.envelope.header.issuer,
    };
  } catch (error) {
    return { id: view, body: null, error: describe(error) };
  }
}
