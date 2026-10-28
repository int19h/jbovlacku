import { test, expect } from "@playwright/test";
import {
  createIdentity,
  PASSPHRASE,
  corePath,
  fingerprintText,
} from "./helpers.ts";

test("browser keys use the backup profile and restore in another browser context", async ({
  page,
  browser,
}) => {
  const backup = await createIdentity(page);
  expect(Object.keys(backup).sort()).toEqual([
    "format",
    "identity",
    "jwe",
    "version",
  ]);
  const header = JSON.parse(
    Buffer.from(backup.jwe.split(".")[0], "base64url").toString(),
  );
  expect(header.alg).toBe("PBES2-HS256+A128KW");
  expect(header.enc).toBe("A256GCM");
  expect(header.p2c).toBe(600000);
  expect(Object.keys(header).sort()).toEqual(["alg", "enc", "p2c", "p2s"]);
  await expect(
    page.getByText(fingerprintText(backup.identity), { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Backup test" })).toContainText(
    "Test your backup.",
  );
  const context = await browser.newContext();
  const restored = await context.newPage();
  await restored.goto("/identity");
  await restored.getByLabel("Backup file").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await restored.getByLabel("Backup passphrase").fill("wrong");
  await restored.getByRole("button", { name: "Open backup locally" }).click();
  await expect(restored.getByRole("status")).toHaveText(
    "This file did not unlock with that passphrase.",
  );
  await expect(
    restored.getByLabel("New passphrase", { exact: true }),
  ).toBeVisible();
  await restored.getByLabel("Backup passphrase").fill(PASSPHRASE);
  await restored.getByRole("button", { name: "Open backup locally" }).click();
  await expect(
    restored.getByText(fingerprintText(backup.identity), { exact: true }),
  ).toBeVisible();
  await expect(restored.getByText("Unlocked", { exact: true })).toBeVisible();
  // A restore counts as a successful backup test in that browser.
  await expect(
    restored.getByRole("region", { name: "Backup test" }),
  ).toHaveCount(0);
  const invalid = await restored.evaluate(async (backup) => {
    const { unlockKey } = await import(String("/src/data/keys.ts"));
    const bad = { ...backup, identity: "ed25519:" + "0".repeat(64) };
    try {
      await unlockKey(bad, "test passphrase with spaces");
      return "accepted";
    } catch (error) {
      return String(error);
    }
  }, backup);
  expect(invalid).toContain("This file did not unlock");
  await context.close();
});

test("the backup test decrypts the file and clears the reminder only on an identity match", async ({
  page,
}) => {
  const backup = await createIdentity(page);
  await page.getByRole("button", { name: "Test the backup" }).click();
  const other = await page.evaluate(async () => {
    const { createKey } = await import(String("/src/data/keys.ts"));
    return (await createKey("other passphrase")).backup;
  });
  await page
    .getByRole("form", { name: "Test the backup" })
    .getByLabel("Backup file")
    .setInputFiles({
      name: "other.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(other)),
    });
  await page
    .getByRole("form", { name: "Test the backup" })
    .getByLabel("Backup passphrase")
    .fill("other passphrase");
  await page.getByRole("button", { name: "Run the test" }).click();
  await expect(page.getByRole("status")).toContainText(
    "belongs to another identity",
  );
  await expect(page.getByRole("region", { name: "Backup test" })).toBeVisible();
  await page
    .getByRole("form", { name: "Test the backup" })
    .getByLabel("Backup file")
    .setInputFiles({
      name: "backup.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(backup)),
    });
  await page
    .getByRole("form", { name: "Test the backup" })
    .getByLabel("Backup passphrase")
    .fill("wrong passphrase");
  await page.getByRole("button", { name: "Run the test" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "This file did not unlock with that passphrase.",
  );
  await expect(page.getByRole("region", { name: "Backup test" })).toBeVisible();
  await page
    .getByRole("form", { name: "Test the backup" })
    .getByLabel("Backup passphrase")
    .fill(PASSPHRASE);
  await page.getByRole("button", { name: "Run the test" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "The backup unlocked and matches this identity.",
  );
  await expect(page.getByRole("region", { name: "Backup test" })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Your backup test passed in this browser."),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole("region", { name: "Backup test" })).toHaveCount(
    0,
  );
});

test("lock, unlock, and stay unlocked follow the key page controls", async ({
  page,
}) => {
  await createIdentity(page);
  await expect(page.getByRole("link", { name: /key unlocked/ })).toBeVisible();
  await page.getByRole("button", { name: "Lock", exact: true }).click();
  await expect(page.getByText("Locked", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /key locked/ })).toBeVisible();
  await page.getByLabel("Passphrase", { exact: true }).fill("wrong");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(
    "This file did not unlock with that passphrase.",
  );
  await page.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByText("Unlocked", { exact: true })).toBeVisible();
  const toggle = page.getByRole("switch", {
    name: "Stay unlocked this session",
  });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByText("Stays unlocked until you lock it or close the tab."),
  ).toBeVisible();
});

for (const action of ["create", "import"] as const) {
  test(`a stale tab cannot ${action} another identity over the original encrypted backup`, async ({
    page,
    context,
  }) => {
    const other = await context.newPage();
    await Promise.all([page.goto("/identity"), other.goto("/identity")]);
    await expect(
      other.getByLabel("New passphrase", { exact: true }),
    ).toBeVisible();
    const passphrase = "original two-tab passphrase";
    await page.getByLabel("New passphrase", { exact: true }).fill(passphrase);
    await page.getByLabel("Repeat passphrase").fill(passphrase);
    await page.getByRole("button", { name: "Create a key" }).click();
    await expect(page.getByText("Unlocked", { exact: true })).toBeVisible();
    const original = await page.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      return new LocalStore().get("keys", "selected");
    });
    let refusedIdentity: string | undefined;
    if (action === "create") {
      await other
        .getByLabel("New passphrase", { exact: true })
        .fill("another passphrase");
      await other.getByLabel("Repeat passphrase").fill("another passphrase");
      await other.getByRole("button", { name: "Create a key" }).click();
    } else {
      const candidate = await other.evaluate(async () => {
        const { createKey } = await import(String("/src/data/keys.ts"));
        return (await createKey("another passphrase")).backup;
      });
      refusedIdentity = candidate.identity;
      await other.getByLabel("Backup file").setInputFiles({
        name: "other.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(candidate)),
      });
      await other.getByLabel("Backup passphrase").fill("another passphrase");
      await other.getByRole("button", { name: "Open backup locally" }).click();
    }
    await expect(other.getByRole("status")).toHaveText(
      "Another tab selected an identity. This browser kept its existing key. Unlock that identity or keep your backup file.",
    );
    await expect(
      other.getByText(fingerprintText(original.identity), { exact: true }),
    ).toBeVisible();
    await expect(other.getByText("Locked", { exact: true })).toBeVisible();
    await expect(
      other.getByLabel("New passphrase", { exact: true }),
    ).toHaveCount(0);
    const preserved = await other.evaluate(
      async ({ passphrase, refusedIdentity }) => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const { unlockKey } = await import(String("/src/data/keys.ts"));
        const store = new LocalStore();
        const backup = await store.get("keys", "selected");
        const key = await unlockKey(backup, passphrase);
        const publicKey = await crypto.subtle.importKey(
          "raw",
          Uint8Array.from(
            backup.identity.slice(8).match(/../g),
            (hex: string) => parseInt(hex, 16),
          ),
          { name: "Ed25519" },
          false,
          ["verify"],
        );
        const message = new TextEncoder().encode("original key still works");
        const signature = await crypto.subtle.sign("Ed25519", key, message);
        return {
          backup,
          extractable: key.extractable,
          signatureValid: await crypto.subtle.verify(
            "Ed25519",
            publicKey,
            signature,
            message,
          ),
          refusedTested: refusedIdentity
            ? await store.get("keys", `tested:${refusedIdentity}`)
            : undefined,
        };
      },
      { passphrase, refusedIdentity },
    );
    expect(preserved.backup).toEqual(original);
    expect(preserved.extractable).toBe(false);
    expect(preserved.signatureValid).toBe(true);
    expect(preserved.refusedTested).toBeUndefined();
    await other.getByRole("button", { name: "Import", exact: true }).click();
    await other
      .getByRole("form", { name: "Import an encrypted backup" })
      .getByLabel("Backup file")
      .setInputFiles({
        name: "original.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(original)),
      });
    await other
      .getByRole("form", { name: "Import an encrypted backup" })
      .getByLabel("Backup passphrase")
      .fill(passphrase);
    await other
      .getByRole("form", { name: "Import an encrypted backup" })
      .getByRole("button", { name: "Open backup locally" })
      .click();
    await expect(other.getByRole("status")).toHaveText(
      "The backup opened locally. Keep the file in a safe place.",
    );
    const restored = await other.evaluate(async () => {
      const { LocalStore } = await import(String("/src/data/store.ts"));
      const store = new LocalStore();
      const backup = await store.get("keys", "selected");
      return {
        backup,
        tested: await store.get("keys", `tested:${backup.identity}`),
      };
    });
    expect(restored).toEqual({ backup: original, tested: true });
    await other.close();
  });
}

test("backup validation rejects extra headers and large files before password work", async ({
  page,
}) => {
  await page.goto("/");
  const results = await page.evaluate(async (corePath) => {
    const core = await import(corePath);
    await core.initializeCore();
    const { createKey, parseBackup } = await import(
      String("/src/data/keys.ts")
    );
    const created = await createKey("test");
    const parts = created.backup.jwe.split(".");
    const header = JSON.parse(
      atob(parts[0].replaceAll("-", "+").replaceAll("_", "/")),
    );
    header.jku = "https://example.invalid/keys";
    parts[0] = btoa(JSON.stringify(header))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    const messages = [];
    for (const value of [
      JSON.stringify({ ...created.backup, jwe: parts.join(".") }),
      " ".repeat(16385),
    ]) {
      try {
        parseBackup(value);
        messages.push("accepted");
      } catch (error) {
        messages.push(String(error));
      }
    }
    if (created.key.extractable)
      throw new Error("The working key is exportable.");
    return messages;
  }, corePath);
  expect(results[0]).toContain("not supported");
  expect(results[1]).toContain("exceeds 16 KiB");
});

test("stay unlocked ends on reload and lock changes update the key page", async ({
  page,
}) => {
  await createIdentity(page);
  await page
    .getByRole("switch", { name: "Stay unlocked this session" })
    .click();
  await page.reload();
  await expect(
    page.getByRole("switch", { name: "Stay unlocked this session" }),
  ).toHaveAttribute("aria-checked", "false");
  await page.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.clock.install();
  await page.clock.fastForward(15 * 60 * 1000 + 100);
  await expect(page.getByText("Locked", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /key locked/ })).toBeVisible();
});

test("a page hide clears the key and updates the shown lock state", async ({
  page,
}) => {
  await createIdentity(page);
  const toggle = page.getByRole("switch", {
    name: "Stay unlocked this session",
  });
  await toggle.click();
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle.locator(".state")).toHaveText("Off");
  await expect(page.getByRole("link", { name: /key locked/ })).toBeVisible();
  await expect(page.getByText("Locked", { exact: true })).toBeVisible();
});

test("another identity backup in this tab keeps the selected key unlocked", async ({
  page,
}) => {
  const original = await createIdentity(page);
  const candidate = await page.evaluate(async () => {
    const { createKey } = await import(String("/src/data/keys.ts"));
    return (await createKey("another passphrase")).backup;
  });
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const form = page.getByRole("form", { name: "Import an encrypted backup" });
  await form.getByLabel("Backup file").setInputFiles({
    name: "other.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(candidate)),
  });
  await form.getByLabel("Backup passphrase").fill("another passphrase");
  await form.getByRole("button", { name: "Open backup locally" }).click();
  await expect(page.getByRole("status")).toContainText(
    "This backup belongs to another identity. This browser keeps its selected key.",
  );
  await expect(page.getByRole("link", { name: /key unlocked/ })).toBeVisible();
  await expect(
    page.getByText(fingerprintText(original.identity), { exact: true }),
  ).toBeVisible();
});
