/**
 * A primary-button press in progress. A background update that moves, hides
 * or rebuilds content waits for its release, so the layout under the pointer
 * does not change before the click completes. Only a primary press can start
 * a click. A press can also end without a release on the page: a context
 * menu, or a switch to another window or tab. Each of those ends the press
 * too.
 */
export function pressTracker(signal: AbortSignal) {
  let pressed = false;
  let released: (() => void)[] = [];
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button === 0) pressed = true;
    },
    { capture: true, signal },
  );
  const endPress = () => {
    if (!pressed) return;
    pressed = false;
    const waiting = released;
    released = [];
    // After the click that this release completes.
    setTimeout(() => waiting.forEach((resolve) => resolve()), 0);
  };
  for (const type of ["pointerup", "pointercancel", "contextmenu"])
    window.addEventListener(type, endPress, { capture: true, signal });
  // Only the window's own blur. A blur of an element inside the page is a
  // focus move, and a press moves focus.
  window.addEventListener(
    "blur",
    (event) => {
      if (event.target === window) endPress();
    },
    { signal },
  );
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden) endPress();
    },
    { signal },
  );
  return {
    get pressed() {
      return pressed;
    },
    /** Resolves after the press in progress ends, or at once without one. */
    finished: () =>
      pressed
        ? new Promise<void>((resolve) => released.push(resolve))
        : Promise.resolve(),
  };
}
