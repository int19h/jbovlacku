import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { initializeCore } from "../../../packages/core/src/index.ts";
import type { EmbeddingRoute } from "../../../packages/service/src/inference.ts";
import {
  createQwenProfile,
  profileId,
  qwenRequestRoute,
} from "../../../packages/service/src/semantic/profile.ts";
import type { SemanticOptions } from "../../../packages/service/src/semantic/search.ts";

before(async () => {
  await initializeCore(
    await readFile(
      new URL(
        "../../../packages/core/generated/jvc_runtime_bg.wasm",
        import.meta.url,
      ),
    ),
  );
});

let sequence = 0;
async function startHost(
  storedRoute: EmbeddingRoute,
  requested?: string,
  withProfile = true,
) {
  const profile = createQwenProfile("ab".repeat(16), storedRoute);
  const state: {
    env: Record<string, string>;
    profile: typeof profile;
    semantic?: SemanticOptions;
    listening: boolean;
    released: boolean;
    vectorsClosed: boolean;
    lookups: string[];
  } = {
    env: {
      ...(withProfile ? { JVC_SEMANTIC_PROFILE: profileId(profile) } : {}),
      ...(requested === undefined ? {} : { JVC_SEMANTIC_ROUTE: requested }),
    },
    profile,
    listening: false,
    released: false,
    vectorsClosed: false,
    lookups: [],
  };
  const key = `__semanticHostConfig${sequence++}`;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[key] = state;
  const source = await readFile(
    new URL("../src/main.ts", import.meta.url),
    "utf8",
  );
  // Bundle the shipped entry point. Replace only host boundaries, never route logic.
  const output = await build({
    stdin: {
      contents: source,
      resolveDir: fileURLToPath(new URL("../src", import.meta.url)),
      sourcefile: "main.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    define: {
      process: `globalThis.${key}.process`,
      "import.meta.url": JSON.stringify(
        new URL("../src/main.ts", import.meta.url).href,
      ),
    },
    plugins: [
      {
        name: "mock-host-boundaries",
        setup(builder) {
          builder.onResolve({ filter: /./ }, (args) => {
            if (
              args.path.endsWith("/inference.ts") ||
              args.path.endsWith("/semantic/profile.ts")
            )
              return {
                path: new URL(args.path, new URL("../src/", import.meta.url))
                  .href,
                external: true,
              };
            if (["node:crypto", "node:path", "node:stream"].includes(args.path))
              return { path: args.path, external: true };
            return { path: "host-mocks", namespace: "mock" };
          });
          builder.onLoad({ filter: /./, namespace: "mock" }, () => ({
            contents: `
const state = globalThis[${JSON.stringify(key)}];
state.process = { env: state.env, once() {} };
export const BROWSER_HEADERS = {};
export const initializeCore = async () => {};
export const coreCheckpointVersion = () => "mock";
export const readFile = async () => new Uint8Array();
export const stat = async () => {};
export const trustedProxyAddresses = () => [];
export const nodeAssistance = () => ({});
export const durableDirectory = async () => {};
export const lockDataDirectory = async () => async () => { state.released = true; };
export const readLoadedView = async () => undefined;
export const checkLoadedView = async () => {};
export const stateTraversalLimit = () => undefined;
export const shutdownHost = async () => {};
export const sendResponseBody = async () => {};
class Resource { close() {} }
export class SqliteIndexStore extends Resource {}
export class SqliteCoordinator extends Resource {
  async discardAbandonedVerifiedRecordStages() {}
}
export class SqliteAssistanceBudgetStore extends Resource {}
export class NodeEvaluationRuntime extends Resource {}
export class NodePatternScanner extends Resource {}
export class NodeVectorScanner extends Resource {}
export class FileObjectStore extends Resource {}
export class FileCheckpointStore extends Resource {}
export class SqliteVectorStore extends Resource {
  queryCache = {};
  async storedProfile(id) { state.lookups.push(id); return state.profile; }
  close() { state.vectorsClosed = true; }
}
export class DictionaryService {
  constructor(objects, coordinator, options) { state.semantic = options.semantic; }
  async initialize() {}
}
export const createServer = () => ({
  once() {},
  listen() { state.listening = true; },
});`,
            loader: "js",
          }));
        },
      },
    ],
  });
  let error: unknown;
  try {
    await import(
      `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`
    );
  } catch (failure) {
    error = failure;
  } finally {
    delete globals[key];
  }
  return { ...state, error };
}

for (const stored of ["nebius", "siliconflow/fp8", "deepinfra/us"] as const) {
  for (const requested of [
    undefined,
    "nebius",
    "siliconflow/fp8",
    "deepinfra/us",
  ] as const) {
    test(`Node host configures ${requested ?? "default"} for ${stored}`, async () => {
      const result = await startHost(stored, requested);
      const shared = stored !== "deepinfra/us";
      const expected =
        requested === undefined
          ? shared
            ? "siliconflow/fp8"
            : "deepinfra/us"
          : (requested === "deepinfra/us") !== !shared
            ? null
            : requested;
      if (expected === null) {
        assert.match(
          String(result.error),
          /JVC_SEMANTIC_ROUTE is incompatible with JVC_SEMANTIC_PROFILE/,
        );
        assert.equal(result.listening, false);
        assert.equal(result.vectorsClosed, true);
        assert.equal(result.released, true);
      } else {
        assert.equal(result.error, undefined);
        assert.equal(result.listening, true);
        assert.equal(result.semantic?.route, requested);
        assert.equal(result.semantic?.profile, profileId(result.profile));
        assert.equal(
          qwenRequestRoute(result.profile, result.semantic?.route),
          expected,
        );
      }
      assert.deepEqual(
        result.lookups,
        requested === undefined ? [] : [profileId(result.profile)],
      );
    });
  }
}

for (const route of ["unknown", "", "Nebius", "nebius "]) {
  test(`Node host rejects invalid route ${JSON.stringify(route)}`, async () => {
    const result = await startHost("nebius", route);
    assert.match(
      String(result.error),
      /JVC_SEMANTIC_ROUTE must be nebius, siliconflow\/fp8, or deepinfra\/us/,
    );
    assert.equal(result.listening, false);
    assert.equal(result.released, true);
    assert.deepEqual(result.lookups, []);
  });
}

test("Node host requires a profile for an explicit route", async () => {
  const result = await startHost("nebius", "nebius", false);
  assert.match(
    String(result.error),
    /JVC_SEMANTIC_ROUTE requires JVC_SEMANTIC_PROFILE/,
  );
  assert.equal(result.listening, false);
  assert.equal(result.released, true);
});

test("Node host keeps semantic search disabled without a profile or route", async () => {
  const result = await startHost("nebius", undefined, false);
  assert.equal(result.error, undefined);
  assert.equal(result.listening, true);
  assert.equal(result.semantic, undefined);
  assert.deepEqual(result.lookups, []);
});
