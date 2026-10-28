import { expect, test } from "@playwright/test";
import { corePath } from "./helpers.ts";

test("R6 an edit beside padded multiline code keeps literal place notation in code", async ({
  page,
}) => {
  await page.goto("/");
  const original = await page.evaluate(async (path) => {
    const core = await import(path);
    await core.initializeCore();
    const { newDraft, newPlace } = await import(String("/src/model/draft.ts"));
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const text = [[{ code: "x\n\n① " }, " ", { code: "\nfirst\n\n①" }]];
    await new LocalStore().put(
      "drafts",
      "current",
      newDraft({
        spelling: "broda",
        kind: "gismu",
        structured: true,
        frameMode: "fixed",
        places: [newPlace(1)],
        numberingApproved: true,
        text,
      }),
    );
    return text;
  }, corePath);
  await page.goto("/new/places");
  const editor = page.getByRole("textbox", {
    name: "Definition text",
    exact: true,
  });
  await expect(editor).toBeVisible();
  const read = () =>
    page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      return (await new LocalStore().get("drafts", "current")).text;
    });
  expect(await read()).toEqual(original);
  await editor.fill((await editor.inputValue()) + " appended");
  await expect
    .poll(read)
    .toEqual([[{ code: "x\n① " }, " ", { code: "\nfirst\n①" }, " appended"]]);
  const problems = await page.evaluate(async () => {
    const { draftToBody } = await import(String("/src/model/draft.ts"));
    const { LocalStore } = await import(String("/src/data/store.ts"));
    return draftToBody(
      await new LocalStore().get("drafts", "current"),
    ).problems.filter((p: any) => p.blocking);
  });
  expect(problems).toEqual([]);
});

for (const [kind, label] of [
  ["place", "Description for place 1"],
  ["tail", "Places 2 and on"],
  ["translation", "Translation of example 1"],
  ["exampleNotes", "Notes for example 1"],
  ["operand", "Operand 1 description"],
  ["derivation", "Explanation of derivation 1 for place 1"],
  ["rationale", "Rationale for rafsi 1"],
] as const) {
  test(`R6 ${kind} uses a multiline control and keeps line breaks after a nearby edit`, async ({
    page,
  }) => {
    await page.goto("/");
    const original = await page.evaluate(
      async ({ path, kind }) => {
        const core = await import(path);
        await core.initializeCore();
        const { newDraft, newPlace } = await import(
          String("/src/model/draft.ts")
        );
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const rich = [
          [
            { code: "left\n\nright" },
            " ",
            { url: "https://example.org/", label: "left\n\nright" },
          ],
        ];
        const place = newPlace(1);
        if (kind === "place") place.description = rich;
        if (kind === "derivation")
          place.derivations = [
            { word: "cukta", definition: null, place: 1, explanation: rich },
          ];
        const draft = newDraft({
          spelling: "broda",
          kind: kind === "operand" ? "cmavo" : "gismu",
          structured: true,
          frameMode: kind === "tail" ? "variadic" : "fixed",
          variadicMinimum: 1,
          places: [place],
          numberingApproved: true,
          text: [["Test definition."]],
          tail:
            kind === "tail"
              ? { description: rich, kind: "unspecified", hint: null }
              : null,
          examples: [
            {
              language: "jbo",
              text: "broda",
              translation: kind === "translation" ? rich : [],
              notes: kind === "exampleNotes" ? rich : [],
            },
          ],
          operands:
            kind === "operand"
              ? [
                  {
                    id: "bridi",
                    category: "bridi",
                    description: rich,
                    minimum: 1,
                    maximum: 1,
                  },
                ]
              : [],
          rafsiClaims:
            kind === "rationale"
              ? [{ rafsi: "rod", rationale: "left\nright" }]
              : [],
        });
        await new LocalStore().put("drafts", "current", draft);
        return kind === "rationale" ? "left\nright" : rich;
      },
      { path: corePath, kind },
    );
    await page.goto("/new/editor");
    const editor = page.getByRole("textbox", { name: label, exact: true });
    await expect(editor).toBeVisible();
    const source =
      kind === "rationale"
        ? "left\nright"
        : "`left\nright` [[https://example.org/|left\nright]]";
    expect(await editor.inputValue()).toBe(source);
    expect(await editor.evaluate((node) => node.tagName)).toBe("TEXTAREA");
    const read = () =>
      page.evaluate(async (kind) => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const draft = await new LocalStore().get("drafts", "current");
        if (kind === "place") return draft.places[0].description;
        if (kind === "tail") return draft.tail.description;
        if (kind === "translation") return draft.examples[0].translation;
        if (kind === "exampleNotes") return draft.examples[0].notes;
        if (kind === "operand") return draft.operands[0].description;
        if (kind === "derivation")
          return draft.places[0].derivations[0].explanation;
        return draft.rafsiClaims[0].rationale;
      }, kind);
    expect(await read()).toEqual(original);
    await editor.fill(source + " appended");
    await expect
      .poll(read)
      .toEqual(
        kind === "rationale"
          ? "left\nright appended"
          : [
              [
                { code: "left\nright" },
                " ",
                { url: "https://example.org/", label: "left\nright" },
                " appended",
              ],
            ],
      );
  });
}
