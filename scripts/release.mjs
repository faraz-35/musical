// One-command release for the Firefox extension in this repo.
//
//   npm run release              # bump patch (default) + release
//   npm run release -- minor     # bump minor (0.1.3 -> 0.2.0)
//   npm run release -- major     # bump major (0.1.3 -> 1.0.0)
//   npm run release -- 1.2.0     # release a specific version
//
// Bumps `version` in extension/manifest.json + package.json automatically,
// signs via AMO (unlisted), publishes the signed XPI to a GitHub Release, and
// rewrites updates.json so installed copies auto-update.
//
// Flow:
//   1. bump version (default: patch) in manifest.json + package.json
//   2. web-ext sign --channel unlisted  ->  web-ext-artifacts/<name>-<ver>.xpi
//   3. sha256 the XPI
//   4. add/replace this version's entry in updates.json
//   5. commit manifest + package.json + updates.json, push to origin
//   6. gh release create v<version> with the XPI attached
//
// Prereqs:
//   - AMO API creds in .env: WEB_EXT_API_KEY / WEB_EXT_API_SECRET
//   - origin remote on a GitHub repo

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT_DIR = join(ROOT, "extension");
const ARTIFACTS = join(ROOT, "web-ext-artifacts");
const MANIFEST = join(EXT_DIR, "manifest.json");
const PKG = join(ROOT, "package.json");
const UPDATES = join(ROOT, "updates.json");
const WEB_EXT_BIN = join(ROOT, "node_modules", "web-ext", "bin", "web-ext.js");

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT, env: process.env, ...opts });
const out = (cmd, args) =>
  execFileSync(cmd, args, { cwd: ROOT, env: process.env }).toString().trim();

// --- 1. bump version ------------------------------------------------------
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const id = manifest.browser_specific_settings.gecko.id;
const prevVersion = manifest.version;
const nextVersion = bumpVersion(prevVersion, process.argv[2] || "patch");

bumpVersionInFile(MANIFEST, prevVersion, nextVersion);
const pkg = JSON.parse(readFileSync(PKG, "utf8"));
bumpVersionInFile(PKG, pkg.version, nextVersion); // keep package.json in sync
console.log(`\n▶ Version: ${prevVersion} → ${nextVersion}`);

const version = nextVersion;
const tag = `v${version}`;

const remote = out("git", ["remote", "get-url", "origin"]);
const m = remote.match(/github\.com[:/]([^/]+)\/([^./\s]+)/);
if (!m) throw new Error(`origin is not a GitHub remote: ${remote}`);
const [, owner, repo] = m;

if (out("git", ["tag", "-l", tag])) {
  console.error(`✗ Tag ${tag} already exists. Pass a higher version: npm run release -- <x.y.z>`);
  process.exit(1);
}

// --- 2. sign via AMO ------------------------------------------------------
console.log(`▶ Signing ${id} ${tag} (unlisted) via AMO…`);
run(process.execPath, [
  WEB_EXT_BIN, "sign",
  "--source-dir", EXT_DIR,
  "--channel", "unlisted",
  "--artifacts-dir", ARTIFACTS,
  // No-op where the file is absent (yt-journal); excludes musical's icon generator.
  "--ignore-files", "make_icons.py",
]);

// Pick the signed XPI for this version (newest matching .xpi).
const xpi = readdirSync(ARTIFACTS)
  .filter((f) => f.endsWith(".xpi") && f.includes(version))
  .map((f) => ({ f, t: statSync(join(ARTIFACTS, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0];
if (!xpi) throw new Error(`No signed .xpi for ${version} in ${ARTIFACTS}`);
const xpiPath = join(ARTIFACTS, xpi.f);

// --- 3. integrity hash ----------------------------------------------------
const hash =
  "sha256:" + createHash("sha256").update(readFileSync(xpiPath)).digest("hex");

// --- 4. updates.json ------------------------------------------------------
const assetUrl = `https://github.com/${owner}/${repo}/releases/download/${tag}/${xpi.f}`;
const entry = { version, update_link: assetUrl, update_hash: hash };

const upd = JSON.parse(readFileSync(UPDATES, "utf8"));
upd.addons ||= {};
upd.addons[id] ||= { updates: [] };
const updates = upd.addons[id].updates;
const without = updates.filter((u) => u.version !== version); // dedupe
without.push(entry);
without.sort(cmpVer); // ascending; Firefox picks the highest
upd.addons[id].updates = without;
writeFileSync(UPDATES, JSON.stringify(upd, null, 2) + "\n");

// --- 5. commit + push -----------------------------------------------------
console.log("▶ Committing version bump + updates.json…");
run("git", ["add", "extension/manifest.json", "package.json", "updates.json"]);
run("git", ["commit", "-m", `release ${tag}`]);
run("git", ["push"]);

// --- 6. GitHub release + XPI upload ---------------------------------------
console.log(`▶ Creating GitHub release ${tag}…`);
const notes =
  `Signed XPI for ${tag}.\n\n` +
  `Auto-update manifest: https://raw.githubusercontent.com/${owner}/${repo}/main/updates.json`;
run("gh", [
  "release", "create", tag, xpiPath,
  "--target", "main",
  "--title", tag,
  "--notes", notes,
]);

console.log(`\n✓ Released ${tag}.`);
console.log(`  XPI:        ${assetUrl}`);
console.log(`  Manifest:   https://raw.githubusercontent.com/${owner}/${repo}/main/updates.json`);

// --- helpers --------------------------------------------------------------

// spec: "patch" | "minor" | "major" | "<x.y.z>"
function bumpVersion(v, spec) {
  if (/^\d+\.\d+\.\d+$/.test(spec)) return spec; // explicit version
  const parts = v.split(".").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) {
    throw new Error(
      `Current version "${v}" isn't x.y.z. Pass an explicit version: npm run release -- <x.y.z>`
    );
  }
  const [maj, min, pat] = parts;
  switch (spec) {
    case "major": return `${maj + 1}.0.0`;
    case "minor": return `${maj}.${min + 1}.0`;
    case "patch": return `${maj}.${min}.${pat + 1}`;
    default:
      throw new Error(`Unknown version spec "${spec}". Use patch | minor | major | x.y.z`);
  }
}

// Surgical replace of "version": "<cur>" -> "<next>", preserving file formatting.
function bumpVersionInFile(filePath, cur, next) {
  if (cur === next) return;
  const text = readFileSync(filePath, "utf8");
  const updated = text.replace(`"version": "${cur}"`, `"version": "${next}"`);
  if (updated === text) {
    throw new Error(`Couldn't find "version": "${cur}" in ${filePath}`);
  }
  writeFileSync(filePath, updated);
}

// Tiny version comparator: "0.10.0" > "0.9.0". Numeric per segment, lenient.
function cmpVer(a, b) {
  const pa = a.version.split(".").map(Number);
  const pb = b.version.split(".").map(Number);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
