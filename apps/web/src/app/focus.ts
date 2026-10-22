/**
 * The reader's own focus choices while a page renders. The page renderer
 * moves the focus to the new heading when the page finishes, unless the
 * reader chose another element during the load. Only an element that the
 * reader chose keeps the focus:
 *
 * - an element that the reader edits: input, or a key or pointer action on
 *   an editable element, such as typing, caret movement, or selection in a
 *   field that already has the focus;
 * - an element outside the changing page content that receives the focus,
 *   also without key or pointer events, as a screen reader can move it;
 * - an element inside the page content that receives the focus in the same
 *   task as a reader key, pointer, or mouse event, such as Tab, a click, or
 *   a touch tap.
 *
 * A focus move to the element that had the focus when the render started is
 * not a new choice. A key that only scrolls changes no focus, so the heading
 * still receives it. A focus inside an open dialog is not a reader choice
 * here; the renderer keeps it with its own dialog guard. A page's own focus
 * inside the content is not a reader choice either.
 */
const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "reset",
  "submit",
]);
/** True for an element that the reader can type into or select in. */
export function isEditable(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  return (
    target instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(target.type)
  );
}
export interface ReaderFocus {
  /** Ends the observation. The abort signal also ends it. */
  stop(): void;
  /** True when the active element is one that the reader chose during the render. */
  keeps(): boolean;
}
/**
 * Starts to observe the reader's focus choices for one render of `main`.
 * Call it when the render starts, before the old content is removed.
 */
export function watchReaderFocus(
  main: HTMLElement,
  signal: AbortSignal,
): ReaderFocus {
  const start = document.activeElement;
  const chosen = new Set<Element>();
  // True from a reader key, pointer, or mouse event until the end of its
  // task. A focus move by Tab, by a click, or by the mousedown of a touch tap
  // happens in that same task.
  let readerEvent = false;
  let clearReaderEvent: ReturnType<typeof setTimeout> | undefined;
  const onReader = (event: Event) => {
    if (event.type !== "input") {
      readerEvent = true;
      clearTimeout(clearReaderEvent);
      clearReaderEvent = setTimeout(() => (readerEvent = false), 0);
    }
    if (
      (event.type === "input" || isEditable(event.target)) &&
      event.target instanceof Element
    )
      chosen.add(event.target);
  };
  const onFocus = (event: FocusEvent) => {
    const target = event.target;
    if (
      !(target instanceof Element) ||
      target === start ||
      target.closest("dialog[open]")
    )
      return;
    if (!main.contains(target) || readerEvent) chosen.add(target);
  };
  // A touch tap sends pointerdown when the touch starts, but the emulated
  // mousedown and its focus move come later, in another task. The mousedown
  // therefore opens the reader-event window too. It moves no focus by itself.
  const readerTypes = ["keydown", "pointerdown", "mousedown", "input"];
  for (const type of readerTypes)
    document.addEventListener(type, onReader, { capture: true, signal });
  document.addEventListener("focusin", onFocus, { capture: true, signal });
  return {
    stop() {
      for (const type of readerTypes)
        document.removeEventListener(type, onReader, { capture: true });
      document.removeEventListener("focusin", onFocus, { capture: true });
      clearTimeout(clearReaderEvent);
    },
    keeps() {
      const active = document.activeElement;
      return (
        active instanceof HTMLElement &&
        active !== document.body &&
        active.isConnected &&
        chosen.has(active)
      );
    },
  };
}
