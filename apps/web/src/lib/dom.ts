/** Small DOM helpers. Every page builds elements through these functions. */
export type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (name === "class") node.className = String(value);
    else if (name === "text") node.textContent = String(value);
    else if (name === "html") throw new Error("Raw HTML is not permitted.");
    else if (value === true) node.setAttribute(name, "");
    else node.setAttribute(name, String(value));
  }
  append(node, ...children);
  return node;
}
export function append(parent: Node, ...children: Child[]) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(
      typeof child === "string" ? document.createTextNode(child) : child,
    );
  }
  return parent;
}
export function text(value: string, className?: string): HTMLSpanElement {
  return el("span", { class: className, text: value });
}
export function p(value: string, className?: string): HTMLParagraphElement {
  return el("p", { class: className, text: value });
}
export function link(
  label: Child,
  href: string,
  attributes: Record<string, string | undefined> = {},
): HTMLAnchorElement {
  const node = el("a", { href, ...attributes });
  append(node, label);
  return node;
}
export function button(
  label: Child,
  action: (event: MouseEvent) => unknown,
  attributes: Record<string, string | boolean | undefined> = {},
): HTMLButtonElement {
  const node = el("button", { type: "button", class: "btn", ...attributes });
  append(node, label);
  node.addEventListener("click", (event) => {
    void action(event);
  });
  return node;
}
export function sr(value: string): HTMLSpanElement {
  return text(value, "sr");
}
let fieldCounter = 0;
export function fieldId(prefix = "f") {
  return `${prefix}-${++fieldCounter}`;
}
export interface FieldOptions {
  hint?: string;
  value?: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  autocomplete?: string;
  multiline?: boolean;
  rows?: number;
  options?: { value: string; label: string }[];
  labelClass?: string;
  wrapperClass?: string;
  spellcheck?: boolean;
  lang?: string;
}
export interface Field<T extends HTMLElement> {
  wrapper: HTMLDivElement;
  input: T;
  label: HTMLLabelElement;
}
/** A labeled input, select, or textarea. The label is always visible unless labelClass hides it. */
export function field(
  label: string,
  options: FieldOptions & { options: { value: string; label: string }[] },
): Field<HTMLSelectElement>;
export function field(
  label: string,
  options: FieldOptions & { multiline: true },
): Field<HTMLTextAreaElement>;
export function field(
  label: string,
  options?: FieldOptions,
): Field<HTMLInputElement>;
export function field(
  label: string,
  options: FieldOptions = {},
): Field<HTMLElement> {
  const id = fieldId();
  const labelNode = el("label", {
    for: id,
    class: options.labelClass ?? "field-label",
    text: label,
  });
  let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  if (options.options) {
    input = el("select", { id, class: "field" });
    for (const option of options.options)
      input.append(
        el("option", {
          value: option.value,
          text: option.label,
          selected: option.value === options.value,
        }),
      );
  } else if (options.multiline) {
    input = el("textarea", { id, class: "field", rows: options.rows ?? 4 });
    input.value = options.value ?? "";
  } else {
    input = el("input", { id, class: "field", type: options.type ?? "text" });
    input.value = options.value ?? "";
  }
  if (options.required) input.required = true;
  if (options.placeholder && "placeholder" in input)
    input.placeholder = options.placeholder;
  if (options.autocomplete)
    input.setAttribute("autocomplete", options.autocomplete);
  if (options.spellcheck === false) input.spellcheck = false;
  if (options.lang) input.lang = options.lang;
  const wrapper = el(
    "div",
    { class: options.wrapperClass ?? "field-group" },
    labelNode,
    input,
    options.hint ? el("p", { class: "hint", text: options.hint }) : null,
  );
  return { wrapper, input, label: labelNode };
}
export function checkbox(
  label: string,
  checked: boolean,
  onChange: (checked: boolean) => unknown,
): HTMLLabelElement {
  const input = el("input", { type: "checkbox" });
  input.checked = checked;
  input.addEventListener("change", () => void onChange(input.checked));
  return el("label", { class: "check" }, input, text(label));
}
export function switchControl(
  label: string,
  checked: boolean,
  onChange: (checked: boolean) => unknown,
): HTMLButtonElement {
  const node = el(
    "button",
    {
      type: "button",
      role: "switch",
      class: "switch",
      "aria-checked": String(checked),
      "aria-label": label,
    },
    el("span", { class: "track", "aria-hidden": "true" }),
    text(checked ? "On" : "Off", "small state"),
  );
  node.addEventListener("click", () => {
    const next = node.getAttribute("aria-checked") !== "true";
    node.setAttribute("aria-checked", String(next));
    node.querySelector(".state")!.textContent = next ? "On" : "Off";
    void onChange(next);
  });
  return node;
}
/** A named disclosure with a chevron and a 44px summary. */
export function disclosure(
  label: Child,
  body: () => Child | Child[] | Promise<Child | Child[]>,
  attributes: Record<string, string | undefined> = {},
): HTMLDetailsElement {
  const details = el("details", { class: "disclosure", ...attributes });
  const summary = el("summary", {}, icon("chevron", "chev"), label);
  const container = el("div", { class: "body" });
  details.append(summary, container);
  let loaded = false;
  details.addEventListener("toggle", async () => {
    if (!details.open || (loaded && container.childElementCount)) return;
    loaded = true;
    try {
      const result = await body();
      container.replaceChildren();
      append(container, ...(Array.isArray(result) ? result : [result]));
    } catch (error) {
      container.replaceChildren(
        p(error instanceof Error ? error.message : String(error), "notice"),
      );
      loaded = false;
    }
  });
  return details;
}
const icons: Record<string, string> = {
  search:
    '<circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path>',
  close: '<path d="M18 6 6 18M6 6l12 12"></path>',
  plus: '<path d="M12 5v14M5 12h14"></path>',
  warn: '<path d="M12 3 2 21h20L12 3z"></path><path d="M12 10v5"></path><path d="M12 18h.01"></path>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path>',
  unlock:
    '<rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 7.6-1.7"></path>',
  up: '<path d="m6 14 6-6 6 6"></path>',
  down: '<path d="m6 10 6 6 6-6"></path>',
  chevron: '<path d="m9 6 6 6-6 6"></path>',
  check: '<path d="m5 12 5 5L20 7"></path>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a1 1 0 0 1 1-1h10"></path>',
};
export function icon(name: keyof typeof icons, className = "", size = 18) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);
  // The icon paths are fixed strings from this module, not dictionary content.
  svg.innerHTML = icons[name];
  return svg;
}
export function download(
  filename: string,
  content: string,
  type = "application/json;charset=utf-8",
) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
