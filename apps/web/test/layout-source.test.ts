import { test, expect } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  inspectLayoutCss,
  inspectLayoutSource,
  TARGET_SELECTOR,
  PROSE_SELECTOR,
} from "../../../scripts/layout-policy.ts";

async function files(root: string): Promise<string[]> {
  return (
    await Promise.all(
      (await readdir(root, { withFileTypes: true })).map((item) =>
        item.isDirectory()
          ? files(resolve(root, item.name))
          : [resolve(root, item.name)],
      ),
    )
  ).flat();
}
const root = resolve("apps/web/src");
test("R6: every web source file preserves default targets and reasoned exceptions", async () => {
  const errors: string[] = [];
  const styles: string[] = [];
  for (const path of await files(root)) {
    if (path.endsWith(".ts"))
      errors.push(...inspectLayoutSource(await readFile(path, "utf8"), path));
    if (path.endsWith(".css")) styles.push(await readFile(path, "utf8"));
  }
  errors.push(...inspectLayoutCss(styles.join("\n")));
  expect(errors).toEqual([]);
});

test("R6: source guard rejects unsafe future code without an anchor whitelist", async () => {
  for (const [name, source] of Object.entries({
    linkOnly:
      'inlineProse("A stated reason long enough.", link("Source code", "https://x.y"));',
    separateSentence:
      'inlineProse("A stated reason long enough.", text("Read the guide. "), link("go", "/go"), text("."));',
    multipleLinks:
      'inlineProse("A stated reason long enough.", link("Read the guide", "/guide"), text(" "), link("Source code", "https://x.y"), text("."));',
    alias:
      'import { inlineProse as prose } from "./dom.ts"; prose("", link("go", "/go"));',
    namespace:
      'import * as dom from "./dom.ts"; dom.inlineProse("", link("go", "/go"));',
    escapingAlias: 'const prose = inlineProse; prose("", link("go", "/go"));',
    manualMarker:
      'p.classList.add("inline-prose"); p.dataset.inlineProseReason = "because"; p.append(link("go", "/go"));',
    computedMarker: 'p["dataset"]["inlineProseReason"] = "because";',
    computedAttribute: "p.setAttribute(attribute, value);",
    computedStyle: 'a.style["minHeight"] = "0";',
    dynamicStyle: 'a.style.setProperty(name, "0");',
    compoundStyle: 'a.style.cssText += "min-height:0!important";',
    directStyle: 'element.style = "min-height:0!important";',
    directComputedStyle: 'element["style"] = "min-height:0!important";',
    transformStyle: 'a.style.setProperty("transform", "scale(.01)");',
    hiddenTarget: 'link("go", "/go", {class:"sr"});',
    opaqueStyle: "Object.assign(a.style, styles);",
    missingReason:
      'inlineProse("", text("Read the "), link("guide", "/guide"), text(" for details."));',
    hiddenSentence:
      'inlineProse("The guide is part of the instruction.", text("Read the ", "sr"), link("guide", "/guide"), text(" for details."));',
    blockSentence:
      'inlineProse("The guide is part of the instruction.", el("p", {}, text("Read the guide.")), link("go", "/go"));',
    metadata:
      'inlineProse("This link describes the source.", text("Source: "), link("record", "/record"));',
    markerBypass:
      'el("p", {class:"inline-prose", "data-inline-prose-reason":"because"}, link("go", "/go"));',
    inlineInitial: 'link("go", "/new", {style:"display:initial"});',
    inlineRevert: 'link("go", "/new", {style:"DISPLAY:revert"});',
    inlineVariable:
      'link("go", "/new", {style:"display:var(--display,inline)"});',
    assignedReason: 'Object.assign(p.dataset, {inlineProseReason:"because"});',
    templateHidden:
      'link("go", "/go", {class:`s${condition ? "r" : "mall"}`});',
    extraClassToken:
      'p.classList.add("safe", "inline-prose"); Object.assign(p.dataset, {inlineProseReason:"because"});',
    extraHiddenToken: 'p.classList.add("safe", "sr");',
    conditionalHidden: 'link("go", "/go", {class:condition ? "sr" : "small"});',
    opaqueClasses: 'link("go", "/go", {class:classes});',
    inlineOptOut: 'link("go", "/new", {style:"min-height:1px !important"});',
    inlineDisplay: 'el("a", {href:"/new", style:"display:inline"}, "go");',
    inlineTableCell: 'link("go", "/new", {style:"display:table-cell"});',
    inlineTableRow: 'link("go", "/new", {style:"display:table-row"});',
    styleAssignment: 'anchor.style.minHeight = "0";',
    styleProperty: 'anchor.style.setProperty("min-height", "0", "important");',
    rawAnchor: 'document.createElement("a");',
    markup: 'box.innerHTML = "<a href=/new>go</a>";',
    detachedProxy:
      'const input = el("input", {type:"checkbox"}); main.append(input);',
  }))
    expect(inspectLayoutSource(source, `/new/${name}.ts`), name).not.toEqual(
      [],
    );
  expect(
    inspectLayoutSource('link("go", "/new"); el("a", {href:"/new"}, "go");'),
  ).toEqual([]);
  expect(
    inspectLayoutSource(
      'const input = el("input", {type:"checkbox", id:"ordinary"}); el("label", {for:"ordinary"}, text("x"));',
    ),
  ).toEqual([]);

  expect(
    inspectLayoutSource(
      'el("p", {class:"inline-prose", "data-inline-prose-reason":"This is a claimed reason."}, link("go", "/go"));',
      "/new/other/lib/dom.ts",
    ),
  ).not.toEqual([]);
  expect(
    inspectLayoutSource(
      'inlineProse("This guide is part of the sentence.", text("For example: read the "), link("guide", "/guide"), text(" for details."));',
    ),
  ).toEqual([]);

  expect(
    inspectLayoutSource(
      'inlineProse("The guide is part of this instruction sentence.", text("Read the "), link("guide", "/guide"), text(" for details."));',
    ),
  ).toEqual([]);
});

test("R6: CSS guard rejects removal and unauthorized target opt-outs", async () => {
  const source = await readFile(resolve(root, "styles/components.css"), "utf8");
  expect(
    inspectLayoutCss(
      source.replace(
        /:where\(\s*a,\s*button,[\s\S]*?\)\s*\{/,
        ".only-a-known-state {",
      ),
    ),
  ).not.toEqual([]);
  expect(
    inspectLayoutCss(
      source.replace(
        /(min-height: max\([^;]+;)/,
        "$1\n min-height: 0 !important;",
      ),
    ),
  ).not.toEqual([]);
  expect(
    inspectLayoutCss(
      source.replace(
        /(min-height: max\([^;]+;)/,
        "$1\n min-inline-size: 0 !important;",
      ),
    ),
  ).not.toEqual([]);
  expect(inspectLayoutCss(`@media (max-width:1px) {${source}}`)).not.toEqual(
    [],
  );
  for (const rule of [
    "a.new-state { min-height: 1px !important; }",
    "a.new-state { MIN-HEIGHT: 1px !important; }",
    "a.new-state { display: initial; }",
    "a.new-state { display: inherit; }",
    "a.new-state { display: unset; }",
    "a.new-state { display: revert; }",
    "a.new-state { display: revert-layer; }",
    "a.new-state { display: var(--bad,inline); }",
    "a.new-state { clip-path: inset(45%); }",
    "a.new-state { display: inline; }",
    "a.new-state { display: table-cell; }",
    "a.new-state { display: table-row; }",
    "a.new-state { transform: scale(.5); }",
    "a.new-state { all: unset; }",
    "a.new-state { --target-min-height: 1px; }",
    `${PROSE_SELECTOR} { width: 1px; }`,
  ])
    expect(inspectLayoutCss(`${source}\n${rule}`), rule).not.toEqual([]);
});

test("R7: source prose follows abbreviations and inspects direct competitor lists", () => {
  for (const copy of ["Compare cf. ", "See e.g. "])
    expect(
      inspectLayoutSource(
        `inlineProse("The word belongs to this comparison sentence.", text(${JSON.stringify(copy)}), link("papri", "/word/papri"), text("."));`,
      ),
      copy,
    ).toEqual([]);
  const list =
    '...claim.competitors.flatMap((competitor, index) => [text(index ? ", " : ""), link(competitor.spelling, routes.word(competitor.spelling))])';
  expect(
    inspectLayoutSource(
      `inlineProse("The competitors belong to this claim sentence.", text("cku is also claimed by "), ${list}, text(". Readers judge each pair separately."));`,
    ),
  ).toEqual([]);
  for (const prefix of ["", "Read the guide. ", "Source: "])
    expect(
      inspectLayoutSource(
        `inlineProse("The competitors belong to this claim sentence.", text(${JSON.stringify(prefix)}), ${list}, text("."));`,
      ),
      prefix,
    ).not.toEqual([]);
  expect(
    inspectLayoutSource(
      'inlineProse("The competitors belong to this claim sentence.", text("cku is also claimed by "), ...getCompetitorLinks(), text("."));',
    ),
  ).not.toEqual([]);
});

for (const display of [
  "table-row",
  "table-cell",
  "table-row-group",
  "table-column",
  "table-column-group",
  "table-header-group",
  "table-footer-group",
  "contents",
  "inline",
]) {
  test(`R7: ${display} cannot bypass minimum sizes in CSS or inline source`, async () => {
    const source = await readFile(
      resolve(root, "styles/components.css"),
      "utf8",
    );
    expect
      .soft(inspectLayoutCss(`${source}\na.new { display:${display}; }`))
      .not.toEqual([]);
    expect
      .soft(
        inspectLayoutSource(
          `link("go", "/new", {style:"display:${display}"});`,
        ),
      )
      .not.toEqual([]);
  });
}

test("R7: direct style assignment cannot bypass target rules", () => {
  for (const source of [
    'element.style = "min-height:0!important";',
    'element["style"] = "min-height:0!important";',
  ])
    expect.soft(inspectLayoutSource(source), source).not.toEqual([]);
});
