import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodexInvocation } from "../src/adapters/codex.js";
import { resolveTargetEnv } from "../src/credentials.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aihub-codex-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("codex adapter", () => {
  it("writes static per-env config.toml without secret, model, or effort, and preserves parent TOKENHUB_API_KEY", () => {
    const aihubHome = path.join(makeTempDir(), ".aihub");
    const secret = "sk-tokenhub-codex-secret-999";
    const target = resolveTargetEnv({ env: "prod" }, {});

    const inv = buildCodexInvocation({
      aihubHome,
      target,
      apiKey: secret,
      parentEnv: {
        PATH: "/usr/bin",
        TOKENHUB_API_KEY: "sk-tencent-untouched",
      },
      forwardedArgs: ["exec", "say hi"],
    });

    const configPath = path.join(aihubHome, "codex", "prod", "config.toml");
    expect(fs.existsSync(configPath)).toBe(true);
    const toml = fs.readFileSync(configPath, "utf8");
    expect(toml).toContain('model_provider = "tokenhub"');
    expect(toml).toContain('web_search = "disabled"');
    expect(toml).toContain('base_url = "https://tokenhub-api.belive.sg/api/v1"');
    expect(toml).toContain('http_headers = { Originator = "codex_cli_rs" }');
    expect(toml).toContain('printf \'%s\' \\"$BELIVE_TOKENHUB_API_KEY\\"');
    expect(toml).not.toContain(secret);
    expect(toml).not.toMatch(/^model\s*=/m);
    expect(toml).not.toMatch(/model_reasoning_effort/);

    expect(inv.env.CODEX_HOME).toBe(path.join(aihubHome, "codex", "prod"));
    expect(inv.env.BELIVE_TOKENHUB_API_KEY).toBe(secret);
    expect(inv.env.TOKENHUB_API_KEY).toBe("sk-tencent-untouched");
    expect(inv.args).toEqual([
      "--no-daemon",
      "-m",
      "openai/gpt-6.1-sol",
      "-c",
      'model_reasoning_effort="low"',
      "exec",
      "say hi",
    ]);
  });

  it("keeps config.toml byte-identical across concurrent invocations with different --model and --effort", () => {
    const aihubHome = path.join(makeTempDir(), ".aihub");
    const target = resolveTargetEnv(
      { env: "staging" },
      { AIHUB_BASE_URL: "https://staging.example.test" },
    );

    const first = buildCodexInvocation({
      aihubHome,
      target,
      apiKey: "sk-tokenhub-1",
      model: "openai/gpt-6.1-terra",
      effort: "xhigh",
      parentEnv: {},
      forwardedArgs: [],
    });
    const configPath = path.join(aihubHome, "codex", "staging", "config.toml");
    const mtime1 = fs.statSync(configPath).mtimeMs;
    const content1 = fs.readFileSync(configPath, "utf8");

    const second = buildCodexInvocation({
      aihubHome,
      target,
      apiKey: "sk-tokenhub-1",
      model: "openai/gpt-6-luna",
      effort: "medium",
      parentEnv: {},
      forwardedArgs: [],
    });
    const mtime2 = fs.statSync(configPath).mtimeMs;
    const content2 = fs.readFileSync(configPath, "utf8");

    expect(content1).toBe(content2);
    expect(mtime1).toBe(mtime2);
    expect(first.args).toContain("openai/gpt-6.1-terra");
    expect(first.args).toContain('model_reasoning_effort="xhigh"');
    expect(second.args).toContain("openai/gpt-6-luna");
    expect(second.args).toContain('model_reasoning_effort="medium"');
  });

  it("rejects invalid --effort levels and respects caller -m / model_reasoning_effort flags", () => {
    const aihubHome = path.join(makeTempDir(), ".aihub");
    const target = resolveTargetEnv({}, {});

    expect(() =>
      buildCodexInvocation({
        aihubHome,
        target,
        apiKey: "sk-tokenhub-1",
        effort: "turbo",
        parentEnv: {},
        forwardedArgs: [],
      }),
    ).toThrow(/effort/i);

    const passthrough = buildCodexInvocation({
      aihubHome,
      target,
      apiKey: "sk-tokenhub-1",
      parentEnv: {},
      forwardedArgs: ["-m", "openai/custom", "-c", 'model_reasoning_effort="high"'],
    });
    expect(passthrough.args).toEqual([
      "--no-daemon",
      "-m",
      "openai/custom",
      "-c",
      'model_reasoning_effort="high"',
    ]);

    // Older Codex (e.g. 0.144.1) without --no-daemon omits that flag cleanly (issue #6 finding 2)
    const olderCodex = buildCodexInvocation({
      aihubHome,
      target,
      apiKey: "sk-tokenhub-1",
      supportsNoDaemon: false,
      parentEnv: {},
      forwardedArgs: ["exec", "task"],
    });
    expect(olderCodex.args).toEqual([
      "-m",
      "openai/gpt-6.1-sol",
      "-c",
      'model_reasoning_effort="low"',
      "exec",
      "task",
    ]);
  });

  it("upgrades legacy config.toml with Originator header while preserving Codex TUI [tui] and [projects] tables without rewriting on subsequent runs", () => {
    const aihubHome = path.join(makeTempDir(), ".aihub");
    const target = resolveTargetEnv({ env: "prod" }, {});
    const codexDir = path.join(aihubHome, "codex", "prod");
    fs.mkdirSync(codexDir, { recursive: true, mode: 0o700 });
    const configPath = path.join(codexDir, "config.toml");

    fs.writeFileSync(
      configPath,
      [
        "# Managed by aihub — pass model/effort or ad-hoc overrides via codex -m / -c flags",
        'model = "stale-saved-model"',
        'model_provider = "tokenhub"',
        'web_search = "disabled"',
        "",
        "[model_providers.tokenhub]",
        'name = "AI Hub"',
        'base_url = "https://tokenhub-api.belive.sg/api/v1"',
        'wire_api = "responses"',
        "stream_idle_timeout_ms = 300000",
        "",
        "[model_providers.tokenhub.auth]",
        'command = "sh"',
        'args = ["-c", "printf \'%s\' \\"$BELIVE_TOKENHUB_API_KEY\\""]',
        "",
        "[tui]",
        "screen_reader_detection_done = true",
        "",
        '[projects."/Users/dev/work/repo"]',
        'trust_level = "trusted"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    buildCodexInvocation({
      aihubHome,
      target,
      apiKey: "sk-tokenhub-upgrade-1",
      parentEnv: {},
      forwardedArgs: [],
    });

    const upgraded = fs.readFileSync(configPath, "utf8");
    expect(upgraded).toContain('http_headers = { Originator = "codex_cli_rs" }');
    expect(upgraded).not.toMatch(/^model\s*=/m);
    expect(upgraded).toContain("[tui]\nscreen_reader_detection_done = true");
    expect(upgraded).toContain('[projects."/Users/dev/work/repo"]\ntrust_level = "trusted"');

    const mtimeAfterUpgrade = fs.statSync(configPath).mtimeMs;
    buildCodexInvocation({
      aihubHome,
      target,
      apiKey: "sk-tokenhub-upgrade-1",
      model: "openai/gpt-6-astra",
      effort: "high",
      parentEnv: {},
      forwardedArgs: [],
    });
    expect(fs.readFileSync(configPath, "utf8")).toBe(upgraded);
    expect(fs.statSync(configPath).mtimeMs).toBe(mtimeAfterUpgrade);
  });
});
