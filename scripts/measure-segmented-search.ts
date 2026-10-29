/** Run with /usr/bin/time -v to record CPU time and peak resident memory. */
import { selectMatches, searchMetrics } from "../packages/search/src/index.ts";
const count = Number(process.argv[2] ?? 30_000);
if (!Number.isSafeInteger(count) || count < 1 || count > 200_000)
  throw new Error("Entry count must be 1 through 200000.");
const query = [...Array(99).fill("mi"), "bo"].join(" ");
const cases = {
  contiguous: (index: number) => "mi".repeat(20 + (index % 11)) + "bo",
  subsequence: () => "mi".repeat(50) + "ta" + "mi".repeat(49) + "bo",
  mismatch: () => "mi".repeat(100) + "ta",
};
for (const [scenario, spelling] of Object.entries(cases)) {
  const entries = Array.from({ length: count }, (_, index) => ({
    word: { spelling: spelling(index) },
    glosses: [],
    plain_text: "A synthetic compound definition.",
  }));
  for (const temperature of ["cold", "warm"]) {
    const metrics = searchMetrics();
    const start = process.cpuUsage();
    const result = selectMatches(entries, query, metrics);
    const cpu = process.cpuUsage(start);
    console.log(
      JSON.stringify({
        scenario,
        temperature,
        entries: count,
        hits: result.rows.length,
        segmentation: result.segmentation,
        metrics,
        cpu_us: cpu,
        rss_bytes: process.memoryUsage().rss,
      }),
    );
  }
}
