import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function verifyReleaseTag(tagName, pkgVersion) {
  if (typeof pkgVersion !== "string" || !SEMVER_REGEX.test(pkgVersion)) {
    throw new Error(`Invalid package.json version "${String(pkgVersion)}"`);
  }
  const expected = `v${pkgVersion}`;
  if (tagName !== expected) {
    throw new Error(`Release tag "${String(tagName)}" must equal ${expected} (from package.json)`);
  }
}

function isExecutedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  }
}

if (isExecutedDirectly()) {
  const tagName = process.argv[2] ?? "";
  const pkgPath = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  verifyReleaseTag(tagName, pkg.version);
  console.log(`Release tag ${tagName} matches package.json version ${pkg.version}.`);
}
