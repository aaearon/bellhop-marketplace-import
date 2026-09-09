#!/usr/bin/env node
// Bellhop - fails the release if a git tag disagrees with either
// extension/manifest.json or package.json's version, or the tag itself
// isn't a valid version.
//
// A release adds a third source of truth (the git tag) to the two
// check:version already keeps in sync. Publishing a release from a tag that
// names the wrong version would ship a mislabelled artifact with no error
// anywhere else in the pipeline, so this check runs as its own release step.
//
// Imports the compiled check from extension/lib/ (built by `npm run build`
// from src/version.ts), the same way check-version.mjs does — see CLAUDE.md
// "Conventions".

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function usageError(message) {
  console.error(`check:tag: FAILED - ${message}`);
  console.error(
    "  usage: node tools/check-tag.mjs <tag> (or set the TAG or GITHUB_REF_NAME env var)"
  );
  process.exit(1);
}

async function main() {
  const tagRef = process.argv[2] || process.env.TAG || process.env.GITHUB_REF_NAME;
  if (!tagRef) {
    usageError("no tag given");
    return;
  }

  const [manifestRaw, packageRaw] = await Promise.all([
    readFile(path.join(root, "extension/manifest.json"), "utf8"),
    readFile(path.join(root, "package.json"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestRaw);
  const pkg = JSON.parse(packageRaw);

  const compiledPath = path.join(root, "extension/lib/version.js");
  let checkTagVersionSync;
  try {
    ({ checkTagVersionSync } = await import(pathToFileURL(compiledPath).href));
  } catch (err) {
    console.error(
      "check:tag: FAILED - could not load extension/lib/version.js. Run `npm run build` first."
    );
    console.error(`  ${err && err.message ? err.message : err}`);
    process.exit(1);
    return;
  }

  const result = checkTagVersionSync(tagRef, manifest.version, pkg.version);

  if (result.ok) {
    console.log(`check:tag: OK - tag "${tagRef}" agrees with manifest and package.json at ${result.normalizedVersion}`);
    process.exit(0);
    return;
  }

  console.error("check:tag: FAILED");
  console.error(`  tag:                   ${JSON.stringify(tagRef)}`);
  console.error(`  normalized version:    ${JSON.stringify(result.normalizedVersion)}`);
  console.error(`  manifest.json version: ${JSON.stringify(manifest.version)}`);
  console.error(`  package.json version:  ${JSON.stringify(pkg.version)}`);
  for (const e of result.errors) {
    console.error(`  - ${e}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error("check:tag: unexpected error");
  console.error(err);
  process.exit(1);
});
