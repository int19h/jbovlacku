import { navigate, type RenderContext } from "../app/router.ts";
import { RequestError } from "../data/api.ts";
import { button } from "../lib/dom.ts";

/** Retry a temporary read failure with the same route and preferences. */
export function appendReadRetry(
  container: HTMLElement,
  error: unknown,
  context: RenderContext,
): boolean {
  if (!(error instanceof RequestError) || error.status !== 503) return false;
  const target = location.pathname + location.search + location.hash;
  container.append(
    button("Retry reading", () => {
      if (context.live() && !context.signal.aborted)
        navigate(target, { replace: true });
    }),
  );
  return true;
}
