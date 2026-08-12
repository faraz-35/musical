// One-command release for the musical Firefox extension.
//
//   npm run release
//
// Signs the extension via AMO (unlisted), publishes the signed XPI to a GitHub
// Release, and rewrites updates.json so installed copies auto-update.
//
// Flow:
//   1. read version + add-on id from extension/manifest.json
//   2. web-ext sign --channel unlisted  ->  web-ext-artifacts/<name>-<ver>.xpi
//   3. sha256 the XPI
//   4. add/replace this version's entry in updates.json
//      (update_link = the GitHub Release asset URL)
//   5. commit manifest + updates.json, push to origin
//   6. gh release create v<version> with the XPI attached
//
// Prereqs:
//   - AMO API creds in .env: WEB_EXT_API_KEY / WEB_EXT_API_SECRET
//   - origin remote on a GitHub repo
//
// AMO won't re-sign a version it has already signed, so bump
// extension/manifest.json "version" before each release. The script refuses to
// run if tag v<version> already exists.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT_DIR = join(ROOT, "extension");
const ARTIFACTS = join(ROOT, "web-ext-artifacts");
const MANIFEST = join(EXT_DIR, "manifest.json");
const UPDATES = join(ROOT, "updates.json");
const WEB_EXT_BIN = join(ROOT, "node_modules", "web-ext", "bin", "web-ext.js");

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, {
    stdio: "inherit",
    cwd: ROOT,
    env: process.env,
    ...opts,
  });

const out = (cmd, args) =>
  execFileSync(cmd, args, { cwd: ROOT, env: process.env }).toString().trim();

// --- 1. version, id, repo -------------------------------------------------
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const { version } = manifest;
const id = manifest.browser_specific_settings.gecko.id;
const tag = `v${version}`;

const remote = out("git", ["remote", "get-url", "origin"]);
const m = remote.match(/github\.com[:/]([^/]+)\/([^./\s]+)/);
if (!m) throw new Error(`origin is not a GitHub remote: ${remote}`);
const [, owner, repo] = m;

if (out("git", ["tag", "-l", tag])) {
  console.error(
    `✗ Tag ${tag} already exists. Bump "version" in extension/manifest.json first — AMO rejects duplicate versions.`
  );
  process.exit(1);
}

// --- 2. sign via AMO ------------------------------------------------------
console.log(`\n▶ Signing ${id} ${tag} (unlisted) via AMO…`);
run(process.execPath, [
  WEB_EXT_BIN, "sign",
  "--source-dir", EXT_DIR,
  "--channel", "unlisted",
  "--artifacts-dir", ARTIFACTS,
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
// Keep entries in ascending version order (cosmetic; Firefox picks the highest).
without.sort(cmpVer);
upd.addons[id].updates = without;
writeFileSync(UPDATES, JSON.stringify(upd, null, 2) + "\n");

// --- 5. commit + push -----------------------------------------------------
console.log("\n▶ Committing updates.json…");
run("git", ["add", "extension/manifest.json", "updates.json"]);
run("git", ["commit", "-m", `release ${tag}`]);
run("git", ["push"]);

// --- 6. GitHub release + XPI upload ---------------------------------------
console.log(`\n▶ Creating GitHub release ${tag}…`);
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
console.log(
  `\nFirst-time install only: about:addons → gear → Install Add-on From File →\n  ${xpiPath}\n` +
  `After that, Firefox auto-updates on its own (checks roughly once a day).`
);

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
