import type { BuilderFailure } from "./types.ts";
export class BuilderError extends Error {
  constructor(public failure: BuilderFailure) {
    super(
      failure.kind === "resource-limit"
        ? `${failure.measure} is ${failure.value}, above the limit of ${failure.limit}.${failure.measure === "build recognition work" ? " Lock a component form." : ""}`
        : (failure.message ?? "The builder request failed."),
    );
  }
}
export function resource(measure: string, value: number, limit: number): never {
  throw new BuilderError({ kind: "resource-limit", measure, value, limit });
}
export function requireLimit(
  measure: string,
  value: number,
  limit: number,
): void {
  if (value > limit) resource(measure, value, limit);
}
export function invalid(message: string): never {
  throw new BuilderError({ kind: "invalid", message });
}
