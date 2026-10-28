import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

// Run explicitly with a local dataset. Ordinary browser suites skip this measurement.
test("measure real package routes and browser main-thread CPU", async ({
  page,
}) => {
  test.skip(
    !process.env.JVC_SEARCH_MEASURE_DATA,
    "Set JVC_SEARCH_MEASURE_DATA to a local search-entry JSON file.",
  );
  test.setTimeout(180_000);
  const bytes = await readFile(process.env.JVC_SEARCH_MEASURE_DATA!);
  const entries = JSON.parse(bytes.toString());
  let corrected = 0;
  for (const entry of entries)
    if (entry.classification.kind === "fuivla") {
      entry.classification.kind = "fuhivla";
      corrected++;
    }
  const identity = {
    head:
      process.env.JVC_SEARCH_MEASURE_REVISION ??
      execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    entries: entries.length,
    input_sha256: createHash("sha256").update(bytes).digest("hex"),
    corrected_classifications: corrected,
  };
  console.log(JSON.stringify({ kind: "browser dataset", ...identity }));
  await page.goto("/");
  await page.evaluate(async (entries) => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    await new LocalStore().put("packages", "en", {
      snapshot: "sha256:" + "d".repeat(64),
      entries,
    });
  }, entries);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
  const cpu = async () =>
    (await cdp.send("Performance.getMetrics")).metrics.find(
      (metric) => metric.name === "TaskDuration",
    )!.value;
  const navigate = (path: string) =>
    page.evaluate(async (path) => {
      const { navigate } = await import(String("/src/app/router.ts"));
      navigate(path);
    }, path);
  for (const [label, path, selector] of [
    ["cold stored package route", "/search?q=klama&lang=en", "article.hit .hw"],
    ["second query route", "/search?q=book&lang=en", "article.hit .hw"],
    [
      "wizard nearby route",
      "/new/meaning?meaning=book%20travel%20movement&lang=en",
      ".similar-item",
    ],
  ]) {
    const start = await cpu();
    await navigate(path);
    await expect(page.locator(selector).first()).toBeVisible({
      timeout: 120_000,
    });
    const elapsed = 1000 * ((await cpu()) - start);
    console.log(JSON.stringify({ label, main_thread_cpu_ms: elapsed }));
    expect(elapsed, label).toBeLessThan(400);
    const stats = await page.evaluate(async () => {
      const { packageSearchStats } = await import(
        String("/src/data/package-search.ts")
      );
      return packageSearchStats();
    });
    console.log(JSON.stringify({ label, main_thread_cpu_ms: elapsed, stats }));
    if (label === "second query route") {
      const start = await cpu();
      const stats = await page.evaluate(async () => {
        const { LocalStore } = await import(String("/src/data/store.ts"));
        const { searchPackage } = await import(
          String("/src/data/package-search.ts")
        );
        const pkg = await new LocalStore().get("packages", "en");
        const result = await searchPackage(pkg, "en", ["klama"]);
        return { prepared: result.prepared, metrics: result.metrics };
      });
      console.log(
        JSON.stringify({
          label: "fresh LocalStore connection lookup",
          main_thread_cpu_ms: 1000 * ((await cpu()) - start),
          stats,
        }),
      );
      expect(stats.prepared).toBe(false);
    }
  }
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const pkg = await store.get("packages", "en");
    pkg.entries[0].plain_text = "replacementmarker";
    pkg.entries[0].classification.kind = "other";
    await store.put("packages", "en", pkg);
  });
  const start = await cpu();
  await navigate("/search?q=replacementmarker&lang=en");
  await expect(page.locator("article.hit .hw")).toHaveCount(1, {
    timeout: 120_000,
  });
  console.log(
    JSON.stringify({
      label: "same snapshot text and metadata replacement",
      main_thread_cpu_ms: 1000 * ((await cpu()) - start),
      stats: await page.evaluate(async () =>
        (
          await import(String("/src/data/package-search.ts"))
        ).packageSearchStats(),
      ),
    }),
  );
  await page.evaluate(async () => {
    const { LocalStore } = await import(String("/src/data/store.ts"));
    const store = new LocalStore();
    const pkg = await store.get("packages", "en");
    pkg.snapshot = "sha256:" + "e".repeat(64);
    await store.put("packages", "en", pkg);
  });
  const snapshotStart = await cpu();
  await navigate("/search?q=klama&lang=en");
  await expect(page.locator("article.hit .hw").first()).toBeVisible({
    timeout: 120_000,
  });
  console.log(
    JSON.stringify({
      label: "changed snapshot route",
      main_thread_cpu_ms: 1000 * ((await cpu()) - snapshotStart),
      stats: await page.evaluate(async () =>
        (
          await import(String("/src/data/package-search.ts"))
        ).packageSearchStats(),
      ),
    }),
  );
});
