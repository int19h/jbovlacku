import assert from "node:assert/strict";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const application = process.argv[2];
assert(
  application === "web" || application === "server",
  "Choose the web or server build output.",
);
const destination = join(root, "apps", application, "dist", "notices");
const sources = [
  ["docs/dependencies.md", "dependencies.md"],
  ["docs/third-party-notices.md", "third-party-notices.md"],
  ["crates/jvc-morphology/THIRD-PARTY-NOTICES.md", "morphology-notices.md"],
  [
    "packages/core/generated/rust-standard-library-notices.html",
    "rust-standard-library-notices.html",
  ],
  ["apps/web/public/fonts/NOTICE.txt", "font-notices.txt"],
  ["apps/web/public/fonts/OFL.txt", "font-license.txt"],
];
await mkdir(destination, { recursive: true });
await Promise.all(
  sources.map(([source, name]) =>
    copyFile(join(root, source), join(destination, name)),
  ),
);
await writeFile(
  join(destination, "index.html"),
  `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dependency notices</title>
<body>
<h1>Dependency notices</h1>
<p>These files preserve the licenses and attribution for libraries and fonts in this package.</p>
<ul>
<li><a href="dependencies.md">Dependency guide</a></li>
<li><a href="third-party-notices.md">Full dependency notices</a></li>
<li><a href="morphology-notices.md">Morphology notices</a></li>
<li><a href="rust-standard-library-notices.html">Rust standard library notices</a></li>
<li><a href="font-notices.txt">Font attribution</a></li>
<li><a href="font-license.txt">Font license</a></li>
</ul>
<p>These notices apply to their own components. They do not assign a license to dictionary content.</p>
</body>
</html>
`,
);
console.log(`Dependency notices copied to ${destination}.`);
