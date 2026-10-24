import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

async function* sources(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.[cm]?[jt]sx?$/.test(path)) yield path;
  }
}
test("browser sources import only the public core facade and never call host storage ports", async () => {
  const forbidden =
    /^(addHostVerifiedRecord|extractHostVerifiedRecord|checkHostVerifiedRecord|inspectHostStoredBody|restoreHostEvaluationSession|add_host_verified_record|extract_host_verified_record|check_host_verified_record|inspect_host_stored_body|restore_host_result_checkpoint)$/;
  for await (const path of sources("apps/web/src")) {
    const text = await readFile(path, "utf8");
    assert.doesNotMatch(
      text,
      /(?:core\/src\/(?:index|host)\.ts|generated\/jvc_runtime)/,
      path,
    );
    const source = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) || ts.isStringLiteral(node))
        assert.equal(forbidden.test(node.text), false, path + ": " + node.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});
