#!/usr/bin/env node
// Bellhop - fails the build if extension/manifest.json and package.json
// disagree on version, or the manifest version breaks Chrome's grammar.
//
// Imports the compiled check from extension/lib/ (built by `npm run build`
// from src/version.ts), the same way extension/background.js imports its
// other pure-function modules from extension/lib/ — see CLAUDE.md
// "Conventions".

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

async function main() {
  const [manifestRaw, packageRaw] = await Promise.all([
    readFile(path.join(root, "extension/manifest.json"), "utf8"),
    readFile(path.join(root, "package.json"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestRaw);
  const pkg = JSON.parse(packageRaw);

  const compiledPath = path.join(root, "extension/lib/version.js");
  let checkVersionSync;
  try {
    ({ checkVersionSync } = await import(pathToFileURL(compiledPath).href));
  } catch (err) {
    console.error(
      "check:version: FAILED - could not load extension/lib/version.js. Run `npm run build` first."
    );
    console.error(`  ${err && err.message ? err.message : err}`);
    process.exit(1);
    return;
  }

  const result = checkVersionSync(manifest.version, pkg.version);

  if (result.valid && result.match) {
    console.log(`check:version: OK - manifest and package.json both at ${manifest.version}`);
    process.exit(0);
    return;
  }

  console.error("check:version: FAILED");
  console.error(`  manifest.json version: ${JSON.stringify(manifest.version)}`);
  console.error(`  package.json version:  ${JSON.stringify(pkg.version)}`);
  for (const e of result.errors) {
    console.error(`  - ${e}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error("check:version: unexpected error");
  console.error(err);
  process.exit(1);
});
