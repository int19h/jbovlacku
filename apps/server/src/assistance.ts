import { readFile } from "node:fs/promises";
import { providerConfig } from "../../../packages/service/src/inference.ts";

export function nodeAssistance(env: Record<string, string | undefined>) {
  if (env.JVC_AI_ENABLED !== "enabled") return {};
  if (!env.JVC_AI_KEY_FILE)
    throw new Error(
      "JVC_AI_KEY_FILE is required when AI assistance is enabled.",
    );
  const path = env.JVC_AI_KEY_FILE;
  return {
    provider: providerConfig(env, async () => {
      try {
        return await readFile(path, "utf8");
      } catch {
        throw new Error("The configured AI key file is unavailable.");
      }
    }),
  };
}
