import { button, disclosure, el, link, p, text } from "../lib/dom.ts";
import { declaredPlaceCount, type Draft } from "../model/draft.ts";

const ordinary =
  "A place stays in the meaning even when nobody says it. Only zi'o removes it. That is why a container with no lid is not a botpi, whose x4 is the lid. Keep the places that the idea cannot do without, and add other details when needed with a tag such as sepi'o (\"using tool\").";
const firmer =
  "Few good definitions have more than five places, because a word with that many is hard to use. A place stays in the meaning even when nobody says it, and only zi'o removes it. Keep the places that the idea cannot do without, and add other details when needed with a tag such as sepi'o (\"using tool\").";

/** Shows advice without changing publication validation or signed content. */
export function placeCountNote(
  draft: Draft,
  onHide: () => void,
): HTMLElement | null {
  const count = declaredPlaceCount(draft);
  if (count <= 3 || draft.placeCountNoteHidden) return null;
  return el(
    "section",
    {
      class: "notice",
      role: "note",
      "aria-labelledby": "place-count-note-heading",
      style: "margin-top:16px",
    },
    el("h3", {
      id: "place-count-note-heading",
      style: "font-size:16px;margin:0 0 8px",
      text:
        count > 5
          ? `Are all ${count} places needed?`
          : "Does every place belong?",
    }),
    p(count > 5 ? firmer : ordinary),
    disclosure("More about places", () => [
      el(
        "p",
        {},
        text(
          "An omitted place is zo'e, the value that the speaker means. Under ",
        ),
        link("CLL 7.7", "https://lojban.github.io/cll/7/7/", {
          class: "touch-link",
        }),
        text(", zbasu still has a maker. zi'o makes a different relation."),
      ),
      el(
        "p",
        {},
        text(
          "A modal adds a place to any bridi without changing the numbered ones, under ",
        ),
        link("CLL 9.5", "https://lojban.github.io/cll/9/5/", {
          class: "touch-link",
        }),
        text(
          ". Use BAI tags such as sepi'o, ma'e, and bau, or fi'o with any selbri.",
        ),
      ),
      p("A good four-place example is bamri: x1 buys x2 from x3 for price x4."),
    ]),
    button("Hide for this draft", onHide, { class: "btn btn-quiet" }),
  );
}
