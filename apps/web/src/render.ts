export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function link(text: string, href: string): HTMLAnchorElement {
  const node = el("a", text);
  node.href = href;
  return node;
}
export function button(text: string, action: () => unknown): HTMLButtonElement {
  const node = el("button", text);
  node.type = "button";
  node.onclick = () => {
    void action();
  };
  return node;
}
export function richText(value: unknown, language?: string): HTMLElement {
  const container = el("div");
  if (language) container.lang = language;
  if (!Array.isArray(value)) return container;
  for (const paragraph of value) {
    if (!Array.isArray(paragraph)) continue;
    const row = el("p");
    for (const item of paragraph) {
      if (typeof item === "string") {
        const text = el("bdi", item);
        if (/[\u202a-\u202e\u2066-\u2069]/u.test(item)) {
          text.className = "direction-warning";
          text.title = "This text contains invisible direction controls.";
        }
        row.append(text);
      } else if (Number.isInteger(item) && item > 0) {
        const marker = link(
          item <= 20 ? String.fromCodePoint(0x245f + item) : String(item),
          `#place-${item}`,
        );
        marker.className = "place-marker";
        marker.setAttribute("aria-label", `place ${item}`);
        row.append(marker);
      } else if (item && typeof item === "object") {
        if (typeof item.code === "string") row.append(el("code", item.code));
        else if (typeof item.operand === "string")
          row.append(el("bdi", `[${item.operand}]`));
        else if (
          item.word?.language === "jbo" &&
          typeof item.word.spelling === "string"
        ) {
          const text = el("bdi", String(item.label ?? item.word.spelling));
          if (item.label === undefined || item.label === item.word.spelling)
            text.lang = item.word.language;
          row.append(text);
        } else if (typeof item.url === "string") {
          try {
            const url = new URL(item.url);
            if (url.protocol === "https:") {
              const anchor = link(
                `${String(item.label ?? url.href)} (${url.href})`,
                url.href,
              );
              anchor.rel = "noopener noreferrer";
              row.append(anchor);
            } else row.append(el("bdi", String(item.label ?? item.url)));
          } catch {
            row.append(el("bdi", String(item.label ?? item.url)));
          }
        }
      }
    }
    container.append(row);
  }
  return container;
}
export function visibleJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
    (c) =>
      c === "\n" ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
export function download(filename: string, text: string): void {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json;charset=utf-8" }),
  );
  const a = link("", url);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
