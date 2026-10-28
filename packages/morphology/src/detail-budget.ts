import { resource } from "./errors.ts";
import { utf8Length } from "./phonotactics.ts";
const U64_MAX = (1n << 64n) - 1n;
/** Bounds scans and copied details across one complete result. */
export class DetailBudget {
  private counts = [0n, 0n, 0n];
  private limits: bigint[];
  constructor(work = 1_000_000, entries = 20_000, bytes = 4_000_000) {
    this.limits = [work, entries, bytes].map(BigInt);
  }
  private charge(index: number, amount: bigint, measure: string): void {
    this.counts[index] += amount;
    if (this.counts[index] > U64_MAX) this.counts[index] = U64_MAX;
    if (this.counts[index] > this.limits[index]) {
      resource(measure, Number(this.counts[index]), Number(this.limits[index]));
    }
  }
  scan(amount: number): void {
    this.charge(0, BigInt(amount), "conflict detail work");
  }
  detail(fields: readonly string[]): void {
    this.charge(1, 1n, "conflict detail rows");
    this.charge(
      2,
      fields.reduce((sum, field) => sum + BigInt(utf8Length(field)), 0n),
      "conflict detail bytes",
    );
  }
}
