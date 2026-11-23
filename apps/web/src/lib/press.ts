/**
 * A press in progress. A background update that moves, hides
 * or rebuilds content waits for its release, so the layout under the pointer
 * does not change before the click completes. A primary press can start a
 * click, and a middle press can open a link in a new tab, so both count. A
 * press can also end without a release on the page: a context menu, or a
 * switch to another window or tab. Each of those ends the press too. Only
 * the pointer that started the press ends it by a release or cancel.
 */
export function pressTracker(signal: AbortSignal) {
  // The pointer that started the press. A release or cancel of another
  // pointer, such as a touch during a mouse press, does not end it.
  let pointer: number | null = null;
  let released: (() => void)[] = [];
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (pointer === null && (event.button === 0 || event.button === 1))
        pointer = event.pointerId;
    },
    { capture: true, signal },
  );
  const endPress = () => {
    if (pointer === null) return;
    pointer = null;
    const waiting = released;
    released = [];
    // After the click that this release completes.
    setTimeout(() => waiting.forEach((resolve) => resolve()), 0);
  };
  for (const type of ["pointerup", "pointercancel"])
    window.addEventListener(
      type,
      (event) => {
        if ((event as PointerEvent).pointerId === pointer) endPress();
      },
      { capture: true, signal },
    );
  window.addEventListener("contextmenu", endPress, { capture: true, signal });
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
      return pointer !== null;
    },
    /** Resolves after the press in progress ends, or at once without one. */
    finished: () =>
      pointer !== null
        ? new Promise<void>((resolve) => released.push(resolve))
        : Promise.resolve(),
  };
}
