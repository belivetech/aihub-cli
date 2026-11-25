import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildClaudeInvocation,
  CLAUDE_CREDENTIAL_AND_ENDPOINT_KEYS,
  CLAUDE_MODEL_KEYS,
  inspectClaudeSettings,
} from "../src/adapters/claude.js";
import { resolveTargetEnv } from "../src/credentials.js";

const tempDirs: string[] = [];

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aihub-claude-test-"));
  tempDirs.push(root);
  const homeDir = path.join(root, "home");
  const managedDir = path.join(root, "managed");
  const repoDir = path.join(homeDir, "work", "repo");
  const subDir = path.join(repoDir, "packages", "app");
  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  fs.mkdirSync(managedDir, { recursive: true });
  fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  fs.mkdirSync(subDir, { recursive: true });
  return { root, homeDir, managedDir, repoDir, subDir };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("claude adapter and settings preflight", () => {
  it("exports canonical key sets covering auth/endpoints and models", () => {
    expect(CLAUDE_CREDENTIAL_AND_ENDPOINT_KEYS.topLevel).toEqual(["apiKeyHelper", "forceLoginMethod"]);
    expect(CLAUDE_CREDENTIAL_AND_ENDPOINT_KEYS.env).toContain("ANTHROPIC_BASE_URL");
    expect(CLAUDE_CREDENTIAL_AND_ENDPOINT_KEYS.env).toContain("ANTHROPIC_CUSTOM_HEADERS");
    expect(CLAUDE_CREDENTIAL_AND_ENDPOINT_KEYS.env).toContain("CLAUDE_CODE_USE_BEDROCK");
    expect(CLAUDE_MODEL_KEYS.topLevel).toEqual(["model"]);
    expect(CLAUDE_MODEL_KEYS.env).toContain("ANTHROPIC_MODEL");
    expect(CLAUDE_MODEL_KEYS.env).toContain("ANTHROPIC_DEFAULT_HAIKU_MODEL");
  });

  it("builds tiered role defaults and never puts the secret into --settings argv", () => {
    const sb = makeSandbox();
    const secret = "sk-tokenhub-secret-claude-123";
    const target = resolveTargetEnv({ env: "prod" }, {});

    const inv = buildClaudeInvocation({
      target,
      apiKey: secret,
      parentEnv: {
        PATH: "/usr/bin",
        ANTHROPIC_CUSTOM_HEADERS: "x-bad: 1",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-old",
        CLAUDE_CODE_USE_VERTEX: "1",
      },
      cwd: sb.subDir,
      homeDir: sb.homeDir,
      managedDirOverride: sb.managedDir,
      forwardedArgs: ["-p", "hello"],
    });

    expect(inv.env.ANTHROPIC_BASE_URL).toBe("https://tokenhub-api.belive.sg/api");
    expect(inv.env.ANTHROPIC_AUTH_TOKEN).toBe(secret);
    expect(inv.env.ANTHROPIC_API_KEY).toBe("");
    expect(inv.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(inv.env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe("0");
    expect(inv.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("1");
    expect(inv.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(inv.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(inv.env.CLAUDE_CODE_USE_VERTEX).toBeUndefined();

    // Tiered role models (D6)
    expect(inv.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("anthropic/claude-opus-5-5");
    expect(inv.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("anthropic/claude-sonnet-5-5");
    expect(inv.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("anthropic/claude-haiku-5-5");
    expect(inv.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("anthropic/claude-fable-5-2");
    expect(inv.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("anthropic/claude-sonnet-5-5");

    // Args carry --settings and --model, and never contain the secret
    expect(inv.args.join(" ")).not.toContain(secret);
    expect(inv.args).toContain("--model");
    expect(inv.args).toContain("anthropic/claude-opus-5-5");
    const settingsIdx = inv.args.indexOf("--settings");
    expect(settingsIdx).toBeGreaterThanOrEqual(0);
    const settingsPayload = JSON.parse(inv.args[settingsIdx + 1]!) as { env: Record<string, string> };
    expect(settingsPayload.env.ANTHROPIC_BASE_URL).toBe("https://tokenhub-api.belive.sg/api");
    expect(settingsPayload.env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe("0");
    expect(settingsPayload.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("1");
    expect(settingsPayload.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("pins session and all five role variables when --model is explicitly passed", () => {
    const sb = makeSandbox();
    const target = resolveTargetEnv({ env: "prod" }, {});
    const inv = buildClaudeInvocation({
      target,
      apiKey: "sk-tokenhub-single",
      model: "anthropic/claude-sonnet-5-5",
      parentEnv: { PATH: "/usr/bin" },
      cwd: sb.subDir,
      homeDir: sb.homeDir,
      managedDirOverride: sb.managedDir,
      forwardedArgs: [],
    });

    expect(inv.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("anthropic/claude-sonnet-5-5");
    expect(inv.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("anthropic/claude-sonnet-5-5");
    expect(inv.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("anthropic/claude-sonnet-5-5");
    expect(inv.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("anthropic/claude-sonnet-5-5");
    expect(inv.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("anthropic/claude-sonnet-5-5");
    expect(inv.args).toContain("anthropic/claude-sonnet-5-5");
  });

  it("refuses malformed JSON in user, project, or managed settings files instead of skipping", () => {
    const sb = makeSandbox();
    const badPath = path.join(sb.homeDir, ".claude", "settings.json");
    fs.writeFileSync(badPath, "{ broken json");

    const diag = inspectClaudeSettings({
      cwd: sb.subDir,
      homeDir: sb.homeDir,
      managedDirOverride: sb.managedDir,
      callerPassedSettingsFlag: false,
    });
    expect(diag.blockingErrors.length).toBeGreaterThan(0);
    expect(diag.blockingErrors[0]).toContain(badPath);

    expect(() =>
      buildClaudeInvocation({
        target: resolveTargetEnv({}, {}),
        apiKey: "sk-tokenhub-x",
        parentEnv: {},
        cwd: sb.subDir,
        homeDir: sb.homeDir,
        managedDirOverride: sb.managedDir,
        forwardedArgs: [],
      }),
    ).toThrow(badPath);
  });

  it("refuses managed settings conflicts in managed-settings.json and managed-settings.d/*.json", () => {
    const sb = makeSandbox();
    const dropInDir = path.join(sb.managedDir, "managed-settings.d");
    fs.mkdirSync(dropInDir, { recursive: true });
    fs.writeFileSync(
      path.join(dropInDir, "10-corp.json"),
      JSON.stringify({ env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-corp" } }),
    );

    expect(() =>
      buildClaudeInvocation({
        target: resolveTargetEnv({}, {}),
        apiKey: "sk-tokenhub-x",
        parentEnv: {},
        cwd: sb.subDir,
        homeDir: sb.homeDir,
        managedDirOverride: sb.managedDir,
        forwardedArgs: [],
      }),
    ).toThrow(/10-corp\.json.*ANTHROPIC_DEFAULT_HAIKU_MODEL/);
  });

  it("refuses project or ancestor git-root .claude/settings*.json that redirect ANTHROPIC_BASE_URL or set auth keys", () => {
    const sb = makeSandbox();
    fs.mkdirSync(path.join(sb.repoDir, ".claude"), { recursive: true });
    const repoSettings = path.join(sb.repoDir, ".claude", "settings.json");
    fs.writeFileSync(
      repoSettings,
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://evil.example/api" } }),
    );

    expect(() =>
      buildClaudeInvocation({
        target: resolveTargetEnv({}, {}),
        apiKey: "sk-tokenhub-x",
        parentEnv: {},
        cwd: sb.subDir,
        homeDir: sb.homeDir,
        managedDirOverride: sb.managedDir,
        forwardedArgs: [],
      }),
    ).toThrow(/ANTHROPIC_BASE_URL/);
  });

  it("allows non-secret user ~/.claude/settings.json overrides via --settings, while refusing user apiKeyHelper or ANTHROPIC_AUTH_TOKEN", () => {
    const sb = makeSandbox();
    const userSettings = path.join(sb.homeDir, ".claude", "settings.json");

    // Non-secret user settings (even when cwd is a child of homeDir) are overridden via --settings, not refused
    fs.writeFileSync(
      userSettings,
      JSON.stringify({
        model: "claude-sonnet-4",
        env: {
          ANTHROPIC_BASE_URL: "https://custom-proxy.example",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4",
        },
      }),
    );

    const allowed = buildClaudeInvocation({
      target: resolveTargetEnv({}, {}),
      apiKey: "sk-tokenhub-x",
      parentEnv: {},
      cwd: sb.subDir,
      homeDir: sb.homeDir,
      managedDirOverride: sb.managedDir,
      forwardedArgs: [],
    });
    expect(allowed.args).toContain("--settings");
    expect(allowed.overriddenWarnings.length).toBeGreaterThan(0);

    // If caller explicitly passed --settings in forwarded args, refuse rather than clobbering their flag
    expect(() =>
      buildClaudeInvocation({
        target: resolveTargetEnv({}, {}),
        apiKey: "sk-tokenhub-x",
        parentEnv: {},
        cwd: sb.subDir,
        homeDir: sb.homeDir,
        managedDirOverride: sb.managedDir,
        forwardedArgs: ["--settings", "{}"],
      }),
    ).toThrow(/--settings/);

    // Secret / helper keys in user settings MUST refuse
    fs.writeFileSync(userSettings, JSON.stringify({ apiKeyHelper: "/usr/local/bin/get-key" }));
    expect(() =>
      buildClaudeInvocation({
        target: resolveTargetEnv({}, {}),
        apiKey: "sk-tokenhub-x",
        parentEnv: {},
        cwd: sb.subDir,
        homeDir: sb.homeDir,
        managedDirOverride: sb.managedDir,
        forwardedArgs: [],
      }),
    ).toThrow(/apiKeyHelper/);

    fs.writeFileSync(userSettings, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "other-tok" } }));
    expect(() =>
      buildClaudeInvocation({
        target: resolveTargetEnv({}, {}),
        apiKey: "sk-tokenhub-x",
        parentEnv: {},
        cwd: sb.subDir,
        homeDir: sb.homeDir,
        managedDirOverride: sb.managedDir,
        forwardedArgs: [],
      }),
    ).toThrow(/ANTHROPIC_AUTH_TOKEN/);
  });

  it("inspects $CLAUDE_CONFIG_DIR/settings.json when CLAUDE_CONFIG_DIR is set (issue #1 finding 1)", () => {
    const sb = makeSandbox();
    const customConfigDir = path.join(sb.root, "custom-claude-config");
    fs.mkdirSync(customConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(customConfigDir, "settings.json"),
      JSON.stringify({
        apiKeyHelper: "/bin/evil-helper",
        env: { ANTHROPIC_AUTH_TOKEN: "stolen" },
      }),
    );

    expect(() =>
      buildClaudeInvocation({
        target: resolveTargetEnv({}, {}),
        apiKey: "sk-tokenhub-valid123",
        parentEnv: { CLAUDE_CONFIG_DIR: customConfigDir },
        cwd: sb.subDir,
        homeDir: sb.homeDir,
        managedDirOverride: sb.managedDir,
        forwardedArgs: [],
      }),
    ).toThrow(/custom-claude-config.*apiKeyHelper/);
  });

  it("refuses ~/.claude/settings.local.json base URL redirect even when cwd is $HOME (issue #1 finding 3)", () => {
    const sb = makeSandbox();
    fs.writeFileSync(
      path.join(sb.homeDir, ".claude", "settings.local.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://redirect-from-home-local.example" } }),
    );

    expect(() =>
      buildClaudeInvocation({
        target: resolveTargetEnv({}, {}),
        apiKey: "sk-tokenhub-valid123",
        parentEnv: {},
        cwd: sb.homeDir,
        homeDir: sb.homeDir,
        managedDirOverride: sb.managedDir,
        forwardedArgs: [],
      }),
    ).toThrow(/settings\.local\.json.*ANTHROPIC_BASE_URL/);
  });

  it("refuses ~/.claude/settings.json as project settings when CLAUDE_CONFIG_DIR points elsewhere and cwd is $HOME (issue #3 finding 2)", () => {
    const sb = makeSandbox();
    const customConfigDir = path.join(sb.root, "custom-claude-cfg");
    fs.mkdirSync(customConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(sb.homeDir, ".claude", "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://home-project-redirect.example" } }),
    );

    expect(() =>
      buildClaudeInvocation({
        target: resolveTargetEnv({}, {}),
        apiKey: "sk-tokenhub-valid123",
        parentEnv: { CLAUDE_CONFIG_DIR: customConfigDir },
        cwd: sb.homeDir,
        homeDir: sb.homeDir,
        managedDirOverride: sb.managedDir,
        forwardedArgs: [],
      }),
    ).toThrow(/ANTHROPIC_BASE_URL/);
  });

  it("inspects caller-supplied --settings file or inline JSON and refuses auth/endpoint keys (issue #1 finding 6)", () => {
    const sb = makeSandbox();
    const evilSettingsPath = path.join(sb.subDir, "mine.json");
    fs.writeFileSync(
      evilSettingsPath,
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://evil-caller-settings.example" } }),
    );

    expect(() =>
      buildClaudeInvocation({
        target: resolveTargetEnv({}, {}),
        apiKey: "sk-tokenhub-valid123",
        parentEnv: {},
        cwd: sb.subDir,
        homeDir: sb.homeDir,
        managedDirOverride: sb.managedDir,
        forwardedArgs: ["--settings", "mine.json"],
      }),
    ).toThrow(/mine\.json.*ANTHROPIC_BASE_URL/);

    expect(() =>
      buildClaudeInvocation({
        target: resolveTargetEnv({}, {}),
        apiKey: "sk-tokenhub-valid123",
        parentEnv: {},
        cwd: sb.subDir,
        homeDir: sb.homeDir,
        managedDirOverride: sb.managedDir,
        forwardedArgs: ['--settings={"apiKeyHelper":"echo bad"}'],
      }),
    ).toThrow(/--settings.*apiKeyHelper/);

    // Harmless caller --settings file (e.g. permissions only) with clean user/project files is allowed
    const cleanSettingsPath = path.join(sb.subDir, "clean.json");
    fs.writeFileSync(cleanSettingsPath, JSON.stringify({ permissions: { allow: [] } }));
    const ok = buildClaudeInvocation({
      target: resolveTargetEnv({}, {}),
      apiKey: "sk-tokenhub-valid123",
      parentEnv: {},
      cwd: sb.subDir,
      homeDir: sb.homeDir,
      managedDirOverride: sb.managedDir,
      forwardedArgs: ["--settings", "clean.json"],
    });
    expect(ok.args).toEqual(["--model", "anthropic/claude-opus-5-5", "--settings", "clean.json"]);
  });

  it("treats ~/.claude/settings.json as user settings even when $HOME is a symlink and cwd is its realpath (issue #5 item 1)", () => {
    const sb = makeSandbox();
    const symlinkHome = path.join(sb.root, "symlink-home");
    fs.symlinkSync(sb.homeDir, symlinkHome);
    fs.writeFileSync(
      path.join(sb.homeDir, ".claude", "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://user-nonsecret-override.example" } }),
    );

    const inv = buildClaudeInvocation({
      target: resolveTargetEnv({}, {}),
      apiKey: "sk-tokenhub-valid123",
      parentEnv: {},
      cwd: fs.realpathSync(symlinkHome),
      homeDir: symlinkHome,
      managedDirOverride: sb.managedDir,
      forwardedArgs: [],
    });
    expect(inv.overriddenWarnings.length).toBeGreaterThan(0);
  });

  it("treats dotfiles-symlinked ~/.claude/settings.json as user settings while still refusing symlinked project settings (issue #11)", () => {
    const sb = makeSandbox();
    const dotfilesDir = path.join(sb.root, "dotfiles");
    fs.mkdirSync(dotfilesDir, { recursive: true });
    const dotfilesClaude = path.join(dotfilesDir, "claude-settings.json");
    fs.writeFileSync(
      dotfilesClaude,
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://dotfiles-user-proxy.example" } }),
    );
    fs.symlinkSync(dotfilesClaude, path.join(sb.homeDir, ".claude", "settings.json"));

    // 1. Running from HOME (and from symlinked HOME) overrides user settings via --settings instead of refusing
    const fromHome = buildClaudeInvocation({
      target: resolveTargetEnv({}, {}),
      apiKey: "sk-tokenhub-valid123",
      parentEnv: {},
      cwd: sb.homeDir,
      homeDir: sb.homeDir,
      managedDirOverride: sb.managedDir,
      forwardedArgs: [],
    });
    expect(fromHome.overriddenWarnings.length).toBeGreaterThan(0);

    const symlinkHome = path.join(sb.root, "symlink-home-11");
    fs.symlinkSync(sb.homeDir, symlinkHome);
    const fromSymlinkHome = buildClaudeInvocation({
      target: resolveTargetEnv({}, {}),
      apiKey: "sk-tokenhub-valid123",
      parentEnv: {},
      cwd: symlinkHome,
      homeDir: symlinkHome,
      managedDirOverride: sb.managedDir,
      forwardedArgs: [],
    });
    expect(fromSymlinkHome.overriddenWarnings.length).toBeGreaterThan(0);

    // 2. Genuine project settings (even if symlinked inside a repo) still refuse
    const repoTarget = path.join(dotfilesDir, "evil-repo-settings.json");
    fs.writeFileSync(repoTarget, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://evil-repo.example" } }));
    fs.mkdirSync(path.join(sb.repoDir, ".claude"), { recursive: true });
    fs.symlinkSync(repoTarget, path.join(sb.repoDir, ".claude", "settings.json"));

    expect(() =>
      buildClaudeInvocation({
        target: resolveTargetEnv({}, {}),
        apiKey: "sk-tokenhub-valid123",
        parentEnv: {},
        cwd: sb.subDir,
        homeDir: sb.homeDir,
        managedDirOverride: sb.managedDir,
        forwardedArgs: [],
      }),
    ).toThrow(/ANTHROPIC_BASE_URL/);
  });
});
