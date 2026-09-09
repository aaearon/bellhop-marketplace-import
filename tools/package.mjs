#!/usr/bin/env node
// Bellhop - builds a Chrome/Edge Web Store upload zip.
//
// Rebuilds extension/lib/ first (it's gitignored — see CLAUDE.md
// "Conventions" on why a naive zip from a fresh clone silently ships a
// non-existent lib/), refuses to package on a version mismatch (Task 1's
// check:version), zips only the files the extension needs at runtime, and
// verifies the result the way the Chrome Web Store would reject it if wrong:
// manifest.json must sit at the archive root, and every compiled src/ output
// must actually be in the zip's lib/.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { deriveRuntimeFileList, assertManifestAtRoot, assertLibCoversSrc } from "./package-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const extensionDir = path.join(root, "extension");
const libDir = path.join(extensionDir, "lib");
const srcDir = path.join(root, "src");
const distDir = path.join(root, "dist");

function fail(message) {
  console.error(`package: FAILED - ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) {
    fail(`could not run \`${command} ${args.join(" ")}\`: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`\`${command} ${args.join(" ")}\` exited with status ${result.status}`);
  }
}

function main() {
  // 1. Rebuild extension/lib/ unconditionally, so packaging can never ship a
  // stale or missing compile of src/.
  console.log("package: running npm run build...");
  run("npm", ["run", "build"]);

  if (!existsSync(libDir) || readdirSync(libDir).length === 0) {
    fail("extension/lib/ is missing or empty after `npm run build` — cannot package.");
  }

  // 2. Refuse to package on a manifest/package.json version mismatch or an
  // invalid manifest version.
  console.log("package: checking version sync...");
  run("npm", ["run", "check:version"]);

  // 3. Derive the runtime file list: fixed top-level files, the icon files
  // the manifest actually references, and the filtered contents of lib/.
  const manifest = JSON.parse(readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
  const libFiles = readdirSync(libDir);
  const runtimeFiles = deriveRuntimeFileList({ manifest, libFiles });

  for (const rel of runtimeFiles) {
    const abs = path.join(extensionDir, rel);
    if (!existsSync(abs)) {
      fail(`derived runtime file is missing on disk: extension/${rel}`);
    }
  }

  // 4. Verify every compiled src/*.js output made it into the derived list
  // (catches src/ files that build.ts's `include` reached but this script's
  // filtering did not, before we even shell out to zip).
  const srcTsFiles = readdirSync(srcDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
  const preZipCheck = assertLibCoversSrc(srcTsFiles, runtimeFiles);
  if (!preZipCheck.ok) {
    fail(
      `src/ file(s) with no compiled counterpart in the derived file list: ${preZipCheck.missing.join(", ")}`
    );
  }

  // 5. Resolve the output path from the (now version-verified) manifest.
  const version = manifest.version;
  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
  }
  const zipPath = path.join(distDir, `bellhop-${version}.zip`);
  if (existsSync(zipPath)) {
    rmSync(zipPath);
  }

  // 6. Zip exactly the derived file list, run from inside extension/ so
  // paths inside the archive have no "extension/" prefix — that prefix is
  // exactly what would put manifest.json one directory below the archive
  // root, which the Chrome Web Store silently rejects.
  const zipBinary = spawnSync("which", ["zip"], { encoding: "utf8" }).stdout.trim();
  if (!zipBinary) {
    fail(
      "the `zip` command is not installed. Install it (e.g. `apt-get install zip` / `brew install zip`) and re-run `npm run package`."
    );
  }

  console.log(`package: writing ${runtimeFiles.length} files to ${path.relative(root, zipPath)}...`);
  const zipResult = spawnSync("zip", ["-X", "-q", zipPath, ...runtimeFiles], {
    cwd: extensionDir,
    stdio: "inherit",
  });
  if (zipResult.error || zipResult.status !== 0) {
    fail(`\`zip\` failed: ${zipResult.error ? zipResult.error.message : `exit ${zipResult.status}`}`);
  }

  // 7. Verify the produced archive, not just the intended file list: read
  // back its actual entries with zipinfo.
  let zipEntries;
  try {
    const listing = execFileSync("zipinfo", ["-1", zipPath], { encoding: "utf8" });
    zipEntries = listing.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    fail(`could not list zip contents with \`zipinfo\`: ${err.message}`);
  }

  const rootCheck = assertManifestAtRoot(zipEntries);
  if (!rootCheck.ok) {
    rmSync(zipPath);
    fail(rootCheck.reason);
  }

  const libCheck = assertLibCoversSrc(srcTsFiles, zipEntries);
  if (!libCheck.ok) {
    rmSync(zipPath);
    fail(`src/ file(s) missing their compiled counterpart in the zip's lib/: ${libCheck.missing.join(", ")}`);
  }

  // 8. Summary.
  const bytes = statSync(zipPath).size;
  console.log("package: OK");
  console.log(`  output: ${path.relative(root, zipPath)}`);
  console.log(`  size:   ${bytes} bytes`);
  console.log(`  files:  ${zipEntries.length}`);
}

main();
