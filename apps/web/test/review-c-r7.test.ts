import { appendRichText, typeRichText } from "./rich-helpers.ts";
import { expect, test } from "@playwright/test";
import { acceptFirstSignature, corePath, createIdentity } from "./helpers.ts";

for (const short of [false, true]) {
  test(`R7 editing beside a ${short ? "short" : "labelled"} stored multiline URL keeps its link and destination`, async ({
    page,
  }) => {
    await page.goto("/");
    const original = await page.evaluate(
      async ({ path, short }) => {
        const core = await import(path);
        await core.initializeCore();
        const { newDraft, newPlace } = await import(
          String("/src/model/draft.ts")
        );
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const urls = [
          "https://example.org/\n\npath",
          "https://example.org/a\n \n①?q=x y\u00a0",
          "https:\n\nexample.org/a①",
        ];
        const text = [
          urls.flatMap((url, i) => [
            ...(i ? [" "] : []),
            { url, label: short ? url : "①" },
          ]),
        ];
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
      },
      { path: corePath, short },
    );
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
    await appendRichText(editor, " appended");
    await expect.poll(read).toEqual([[...original[0], " appended"]]);
    const urls = original[0].filter((node) => typeof node === "object");
    const links = page
      .getByRole("region", { name: "Rendered definition" })
      .locator('a[target="_blank"]');
    for (let i = 0; i < urls.length; i++) {
      const originalUrl = (
        original[0].filter((n) => typeof n === "object")[i] as { url: string }
      ).url;
      await expect(links.nth(i)).toHaveAttribute(
        "href",
        new URL(originalUrl).href,
      );
    }
  });
}

test("R7 the full editor signs separate rafsi rationale paragraphs with literal circled text", async ({
  page,
}) => {
  await createIdentity(page);
  await page.getByRole("link", { name: "Add a word" }).click();
  await page.getByRole("link", { name: "Skip to the full editor" }).click();
  await page.getByLabel("Headword").fill("brodu");
  await page.getByLabel("Type", { exact: true }).selectOption("gismu");
  await page
    .getByRole("textbox", { name: "Definition text", exact: true })
    .fill("A disposable test definition.");
  await page.getByRole("button", { name: "Add a rafsi claim" }).click();
  await page.getByLabel("Rafsi 1", { exact: true }).fill("rod");
  await typeRichText(
    page.getByLabel("Rationale for rafsi 1"),
    " First ① paragraph.\nAnother line.\n\n \t\nSecond paragraph.\n\n  ",
  );
  await page.getByRole("button", { name: "Review" }).click();
  await page
    .locator("aside")
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  await acceptFirstSignature(page);
  await expect(page).toHaveTitle("brodu · jbovlacku");
  const claim = await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const records = await new LocalStore().list("outbox");
    const item = records.find(
      (row: any) =>
        JSON.parse(row.transport).envelope.header.action.kind ===
        "rafsi.publish",
    );
    return { state: item.peers.self.state, signed: JSON.parse(item.transport) };
  });
  expect(claim.state).toBe("accepted");
  expect(claim.signed.envelope.signature.length).toBeGreaterThan(0);
  expect(claim.signed.body.rationale).toEqual([
    [" First ① paragraph.\nAnother line."],
    [" \t\nSecond paragraph."],
    ["  "],
  ]);
});
