import { test, expect, type Page } from "@playwright/test";
import { corePath } from "./helpers.ts";

async function harness(page: Page) {
  await page.route("**/authority-harness", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Authority test</title>",
    }),
  );
  await page.goto("/authority-harness");
}

for (const cancel of ["dialog", "lock", "pagehide", "replacement"] as const) {
  test(`${cancel} invalidates an unlock while real decryption finishes`, async ({
    page,
  }) => {
    await harness(page);
    const result = await page.evaluate(
      async ({ corePath, cancel }) => {
        const core = await import(corePath);
        await core.initializeCore();
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const { Session } = await import(String("/src/app/session.ts"));
        const { createKey } = await import(String("/src/data/keys.ts"));
        const created = await createKey("cancel unlock passphrase");
        const replacement =
          cancel === "replacement"
            ? await createKey("successor passphrase")
            : null;
        const store = new LocalStore(`cancel-unlock-${crypto.randomUUID()}`);
        await store.installIdentity(created.backup, "restore");
        const session = new Session(store);
        await session.load();
        let actions = 0;
        let finished!: () => void;
        const decrypted = new Promise<void>((resolve) => {
          finished = resolve;
        });
        const unlock = session.unlock.bind(session);
        session.unlock = async (passphrase: string, signal?: AbortSignal) => {
          try {
            await unlock(passphrase, signal);
          } finally {
            finished();
          }
        };
        const completed = session.requireUnlocked(
          "Cancellation test",
          async () => {
            actions++;
          },
        );
        const dialog = document.querySelector("dialog")!;
        (
          dialog.querySelector("input[type=password]") as HTMLInputElement
        ).value = "cancel unlock passphrase";
        dialog
          .querySelector("form")!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          );
        if (cancel === "dialog")
          [...dialog.querySelectorAll("button")]
            .find((button) => button.textContent === "Cancel")!
            .click();
        if (cancel === "lock") session.lock();
        if (cancel === "pagehide") window.dispatchEvent(new Event("pagehide"));
        if (replacement)
          session.adoptSuccessor(replacement.backup, replacement.key);
        await decrypted;
        await completed;
        const outcome = {
          actions,
          unlocked: session.unlocked,
          keyPreserved: session.workingKey === replacement?.key,
          identity: session.identity,
          expectedIdentity: (replacement ?? created).backup.identity,
          dialogPresent: document.contains(dialog),
        };
        session.lock();
        return outcome;
      },
      { corePath, cancel },
    );
    expect(result.actions).toBe(0);
    expect(result.unlocked).toBe(cancel === "replacement");
    if (cancel === "replacement") expect(result.keyPreserved).toBe(true);
    expect(result.identity).toBe(result.expectedIdentity);
    expect(result.dialogPresent).toBe(false);
  });
}
