import { navigate, rememberState, type RenderContext } from "../app/router.ts";
import { RequestError } from "../data/api.ts";
import { button, describe, p } from "../lib/dom.ts";

const stateKey = "jvcReadRetry";
const currentTarget = () => location.pathname + location.search + location.hash;

/** Consume the retry marker once, so success and later visits start fresh. */
export function takeReadRetryAttempt(): number {
  const state = history.state;
  if (!state || typeof state !== "object" || !(stateKey in state)) return 0;
  const retry = state[stateKey];
  if (!retry) return 0;
  rememberState({ [stateKey]: null });
  return retry?.target === currentTarget() &&
    Number.isSafeInteger(retry.attempt) &&
    retry.attempt > 0
    ? retry.attempt
    : 0;
}

/** Retry a temporary read failure with the same route and preferences. */
export function appendReadRetry(
  container: HTMLElement,
  error: unknown,
  context: RenderContext,
  announce: (message: string) => void,
): boolean {
  const attempt = context.readRetryAttempt ?? 0;
  if (attempt > 0) {
    const message = `Still unavailable after retry ${attempt}.`;
    container.append(p(message, "notice"));
    announce(`${message} ${describe(error)}`);
  }
  if (!(error instanceof RequestError) || error.status !== 503) return false;
  const target = currentTarget();
  container.append(
    button("Retry reading", () => {
      if (context.live() && !context.signal.aborted)
        navigate(target, {
          replace: true,
          state: {
            ...history.state,
            [stateKey]: {
              target,
              attempt: Math.min(attempt + 1, Number.MAX_SAFE_INTEGER),
            },
          },
        });
    }),
  );
  return true;
}
