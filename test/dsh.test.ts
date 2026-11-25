import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDshInvocation, DSH_DEFAULT_MODEL } from "../src/adapters/dsh.js";
import { resolveTargetEnv } from "../src/credentials.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aihub-dsh-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("dsh adapter (DeepSeek Harness)", () => {
  it("writes static 0600 cordis.patch.yml in isolated DSH_HOME, defaults to tui, and unsets DEEPSEEK_API_KEY", () => {
    const aihubHome = path.join(makeTempDir(), ".aihub");
    const target = resolveTargetEnv({}, {});

    const inv = buildDshInvocation({
      aihubHome,
      target,
      apiKey: "sk-tokenhub-dsh-secret-111",
      parentEnv: {
        PATH: "/usr/bin",
        DEEPSEEK_API_KEY: "sk-leaked-deepseek-key",
        DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      },
      forwardedArgs: [],
    });

    expect(inv.dshHome).toBe(path.join(aihubHome, "dsh", "prod"));
    expect(inv.env.DSH_HOME).toBe(inv.dshHome);
    expect(inv.env.BELIVE_TOKENHUB_API_KEY).toBe("sk-tokenhub-dsh-secret-111");
    expect(inv.env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(inv.env.DEEPSEEK_BASE_URL).toBeUndefined();
    expect(inv.args).toEqual(["tui"]);
    expect(inv.patchPath).toBeUndefined();

    const patchFile = path.join(inv.dshHome, "cordis.patch.yml");
    const mode = fs.statSync(patchFile).mode & 0o777;
    expect(mode).toBe(0o600);
    const content = fs.readFileSync(patchFile, "utf8");
    expect(content).toContain('baseURL: "https://tokenhub-api.belive.sg/api/v1"');
    expect(content).toContain("apiKeyEnv: BELIVE_TOKENHUB_API_KEY");
    expect(content).toContain("supportsDeveloperRole: false");
    expect(content).toContain(`model: ${DSH_DEFAULT_MODEL}`);
    expect(content).not.toContain("sk-tokenhub-dsh-secret-111");
  });

  it("isolates concurrent --model and --effort overrides via per-launch 0600 --patch files and cleans up", () => {
    const aihubHome = path.join(makeTempDir(), ".aihub");
    const target = resolveTargetEnv({}, {});

    const inv1 = buildDshInvocation({
      aihubHome,
      target,
      apiKey: "sk-tokenhub-dsh-1",
      model: "deepseek/deepseek-v4.1-flash-1017",
      effort: "off",
      parentEnv: {},
      forwardedArgs: ["--profile", "headless", "say hi"],
    });

    const inv2 = buildDshInvocation({
      aihubHome,
      target,
      apiKey: "sk-tokenhub-dsh-1",
      model: "custom/my-new-model",
      effort: "medium",
      parentEnv: {},
      forwardedArgs: ["headless", "say bye"],
    });

    expect(inv1.patchPath).toBeDefined();
    expect(inv2.patchPath).toBeDefined();
    expect(inv1.patchPath).not.toBe(inv2.patchPath);
    expect(inv1.args).toEqual(["--profile", "headless", "--patch", inv1.patchPath!, "say hi"]);
    expect(inv2.args).toEqual(["headless", "--patch", inv2.patchPath!, "say bye"]);

    const p1 = fs.readFileSync(inv1.patchPath!, "utf8");
    expect(p1).toContain('model: "deepseek/deepseek-v4.1-flash-1017"');
    expect(p1).toContain('reasoningEffort: "off"');
    expect(p1).not.toContain("id: llm-pi-ai");

    const p2 = fs.readFileSync(inv2.patchPath!, "utf8");
    expect(p2).toContain("id: llm-pi-ai");
    expect(p2).toContain('id: "custom/my-new-model"');
    expect(p2).toContain('model: "custom/my-new-model"');
    expect(p2).toContain('reasoningEffort: "medium"');

    inv1.cleanup();
    inv2.cleanup();
    expect(fs.existsSync(inv1.patchPath!)).toBe(false);
    expect(fs.existsSync(inv2.patchPath!)).toBe(false);
  });

  it("passes --version and explicit profiles through without prepending tui", () => {
    const aihubHome = path.join(makeTempDir(), ".aihub");
    const target = resolveTargetEnv({}, {});

    const ver = buildDshInvocation({
      aihubHome,
      target,
      apiKey: "sk-tokenhub-dsh-1",
      parentEnv: {},
      forwardedArgs: ["--version"],
    });
    expect(ver.args).toEqual(["--version"]);

    const web = buildDshInvocation({
      aihubHome,
      target,
      apiKey: "sk-tokenhub-dsh-1",
      parentEnv: {},
      forwardedArgs: ["web", "--port", "3080"],
    });
    expect(web.args).toEqual(["web", "--port", "3080"]);
  });
});
