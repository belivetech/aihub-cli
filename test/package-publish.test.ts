import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verifyReleaseTag } from "../scripts/verify-release-tag.mjs";
import { runCli } from "../src/cli.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function listFilesRecursive(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

describe("public npm package readiness", () => {
  it("pins unscoped belive-aihub metadata, public registry config, and provenance-compatible repository URL", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.name).toBe("belive-aihub");
    expect(pkg.version).toBe("0.4.0");
    expect(pkg.private).toBeUndefined();
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.bin).toEqual({ aihub: "./dist/cli.js" });
    expect(pkg.engines).toEqual({ node: ">=22.0.0" });
    expect(pkg.publishConfig).toEqual({
      access: "public",
      registry: "https://registry.npmjs.org/",
    });
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/belivetech/aihub-cli.git",
    });
    expect(pkg.homepage).toBe("https://aihub.belive.sg/docs/cli");
    expect(pkg.bugs).toEqual({ url: "https://github.com/belivetech/aihub-cli/issues" });
  });

  it("packs only dist/, README.md, LICENSE, and package.json with executable dist/cli.js and no staging hosts", () => {
    const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const parsed = JSON.parse(raw) as Array<{ files: Array<{ path: string }> }>;
    const files = parsed[0]?.files ?? [];
    const paths = files.map((f) => f.path);
    expect(paths).toContain("dist/cli.js");
    expect(paths).toContain("README.md");
    expect(paths).toContain("LICENSE");
    expect(paths.some((p) => p.startsWith("src/") || p.startsWith("test/") || p.startsWith(".github/"))).toBe(false);
    const cliHead = fs.readFileSync(new URL("../dist/cli.js", import.meta.url), "utf8").split("\n")[0];
    expect(cliHead).toBe("#!/usr/bin/env node");

    const forbiddenStagingRe = new RegExp("stg-" + "tokenhub", "i");
    for (const dir of ["src", "dist", "test"]) {
      const targetDir = path.join(repoRoot, dir);
      if (!fs.existsSync(targetDir)) continue;
      for (const file of listFilesRecursive(targetDir)) {
        const content = fs.readFileSync(file, "utf8");
        expect(content, `unexpected staging host in ${file}`).not.toMatch(forbiddenStagingRe);
      }
    }
  });

  it("documents public npm install, marks aihub agy experimental, and omits staging flags/hosts in README and --help", async () => {
    const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const forbiddenStagingRe = new RegExp("stg-" + "tokenhub", "i");
    expect(readme).toContain("npm install -g belive-aihub");
    expect(readme).toContain("https://aihub.belive.sg/docs/cli");
    expect(readme).toContain("AIHUB_BASE_URL");
    expect(readme).not.toMatch(/gh release download|internal dogfood|agy-diverged|--env prod\|staging/i);
    expect(readme).not.toMatch(forbiddenStagingRe);

    const out: string[] = [];
    const code = await runCli(["--help"], { writeStdout: (s) => out.push(s) });
    expect(code).toBe(0);
    const help = out.join("");
    expect(help).not.toMatch(/--env prod\|staging/i);
    expect(help).not.toMatch(forbiddenStagingRe);
    expect(help).toContain("--base-url <origin>");
    expect(help).toContain("AIHUB_BASE_URL");
    expect(help).toMatch(/aihub agy[^\n]*experimental/i);
  });

  it("verifies exact v<package.json version> tag alignment", () => {
    expect(() => verifyReleaseTag("v0.4.0", "0.4.0")).not.toThrow();
    expect(() => verifyReleaseTag("0.4.0", "0.4.0")).toThrow(/must equal v0\.4\.0/);
    expect(() => verifyReleaseTag("v0.4.1", "0.4.0")).toThrow(/must equal v0\.4\.0/);
    expect(() => verifyReleaseTag("", "0.4.0")).toThrow(/must equal v0\.4\.0/);
  });

  it("ships a GitHub Actions npm publish workflow with OIDC provenance and tag verification", () => {
    const workflow = fs.readFileSync(
      new URL("../.github/workflows/publish.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain('registry-url: "https://registry.npmjs.org"');
    expect(workflow).toContain("node-version: 22");
    expect(workflow).toContain("node scripts/verify-release-tag.mjs");
    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("npm run typecheck");
    expect(workflow).toContain("npm test");
    expect(workflow).toContain("npm run build");
    expect(workflow).toContain("npm publish --provenance --access public");
  });
});
