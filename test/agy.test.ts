import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgyInvocation, checkAgySupport } from "../src/adapters/agy.js";
import { resolveBinaryOnPath } from "../src/commands/doctor.js";
import { resolveTargetEnv } from "../src/credentials.js";
import { runCli } from "../src/cli.js";

const tempDirs: string[] = [];

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aihub-agy-test-"));
  tempDirs.push(root);
  const homeDir = path.join(root, "home");
  const aihubHome = path.join(homeDir, ".aihub");
  fs.mkdirSync(path.join(homeDir, ".ssh"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".gitconfig"), "[user]\nname = Test\n");
  fs.mkdirSync(path.join(homeDir, ".gemini", "antigravity-cli", "skills"), { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, ".gemini", "antigravity-cli", "settings.json"),
    JSON.stringify({
      modelProvider: "google",
      model: "gemini-google-oauth-model",
      theme: "dark",
      customModelsConfig: { old: true },
    }),
  );
  return { root, homeDir, aihubHome };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("agy adapter (requires agy >= 1.5, session --settings on real HOME)", () => {
  it("refuses agy < 1.5 or missing --settings with one clear error naming the installed version and telling the user to update (#26)", () => {
    const sb = makeSandbox();
    const target = resolveTargetEnv({ env: "prod" }, {});
    const binDir = path.join(sb.root, "bin");
    fs.mkdirSync(binDir, { recursive: true });

    const oldBin = path.join(binDir, "agy-old");
    fs.writeFileSync(
      oldBin,
      [
        `#!${process.execPath}`,
        'if (process.argv.includes("--version")) { console.log("1.4.9"); process.exit(0); }',
        'if (process.argv.includes("--help")) { console.log("Usage: agy"); process.exit(0); }',
      ].join("\n"),
      { mode: 0o755 },
    );
    const oldCheck = checkAgySupport(oldBin, {});
    expect(oldCheck.supported).toBe(false);
    if (!oldCheck.supported) {
      expect(oldCheck.version).toBe("1.4.9");
      expect(oldCheck.reason).toContain("1.4.9");
      expect(oldCheck.reason).toMatch(/1\.5\.0/);
      expect(oldCheck.reason).toMatch(/agy update/i);
    }

    const noSettingsBin = path.join(binDir, "agy-nosettings");
    fs.writeFileSync(
      noSettingsBin,
      [
        `#!${process.execPath}`,
        'if (process.argv.includes("--version")) { console.log("1.5.0"); process.exit(0); }',
        'if (process.argv.includes("--help")) { console.log("Usage: agy"); process.exit(0); }',
      ].join("\n"),
      { mode: 0o755 },
    );
    const noSettingsCheck = checkAgySupport(noSettingsBin, {});
    expect(noSettingsCheck.supported).toBe(false);
    if (!noSettingsCheck.supported) {
      expect(noSettingsCheck.version).toBe("1.5.0");
      expect(noSettingsCheck.reason).toMatch(/agy update/i);
    }

    const goodBin = path.join(binDir, "agy-good");
    fs.writeFileSync(
      goodBin,
      [
        `#!${process.execPath}`,
        'if (process.argv.includes("--version")) { console.log("1.5.13"); process.exit(0); }',
        'if (process.argv.includes("--help")) { console.log("Usage: agy --settings <json>"); process.exit(0); }',
      ].join("\n"),
      { mode: 0o755 },
    );
    expect(checkAgySupport(goodBin, {})).toEqual({ supported: true, version: "1.5.13" });

    // Pre-1.5.0 release candidate (1.5.0-rc.1) is ordered below 1.5.0 and refused (#30)
    const rcBin = path.join(binDir, "agy-rc");
    fs.writeFileSync(
      rcBin,
      [
        `#!${process.execPath}`,
        'if (process.argv.includes("--version")) { console.log("1.5.0-rc.1"); process.exit(0); }',
        'if (process.argv.includes("--help")) { console.log("  --settings  Session settings"); process.exit(0); }',
      ].join("\n"),
      { mode: 0o755 },
    );
    const rcCheck = checkAgySupport(rcBin, {});
    expect(rcCheck.supported).toBe(false);
    if (!rcCheck.supported) {
      expect(rcCheck.version).toBe("1.5.0-rc.1");
      expect(rcCheck.reason).toContain("1.5.0-rc.1");
      expect(rcCheck.reason).toMatch(/agy update/i);
    }

    // Longer option name (--settings-file / --no-settings) does NOT satisfy exact --settings (#30)
    const settingsFileOnlyBin = path.join(binDir, "agy-settings-file-only");
    fs.writeFileSync(
      settingsFileOnlyBin,
      [
        `#!${process.execPath}`,
        'if (process.argv.includes("--version")) { console.log("1.5.13"); process.exit(0); }',
        'if (process.argv.includes("--help")) { console.log("  --settings-file <path>\\n  --no-settings"); process.exit(0); }',
      ].join("\n"),
      { mode: 0o755 },
    );
    const settingsFileOnlyCheck = checkAgySupport(settingsFileOnlyBin, {});
    expect(settingsFileOnlyCheck.supported).toBe(false);
    if (!settingsFileOnlyCheck.supported) {
      expect(settingsFileOnlyCheck.version).toBe("1.5.13");
      expect(settingsFileOnlyCheck.reason).toContain("1.5.13");
      expect(settingsFileOnlyCheck.reason).toMatch(/agy update/i);
    }

    // Post-1.5.0 prerelease (1.5.1-rc.1) and 1.5.0+build metadata with [--settings=<json>] ARE >= 1.5.0
    const buildMetaBin = path.join(binDir, "agy-build-meta");
    fs.writeFileSync(
      buildMetaBin,
      [
        `#!${process.execPath}`,
        'if (process.argv.includes("--version")) { console.log("1.5.0+20261120"); process.exit(0); }',
        'if (process.argv.includes("--help")) { console.log("Usage: agy [--settings=<json>]"); process.exit(0); }',
      ].join("\n"),
      { mode: 0o755 },
    );
    expect(checkAgySupport(buildMetaBin, {})).toEqual({ supported: true, version: "1.5.0+20261120" });

    const nextPatchRcBin = path.join(binDir, "agy-151-rc");
    fs.writeFileSync(
      nextPatchRcBin,
      [
        `#!${process.execPath}`,
        'if (process.argv.includes("--version")) { console.log("1.5.1-rc.1"); process.exit(0); }',
        'if (process.argv.includes("--help")) { console.log("  -s, --settings, --config"); process.exit(0); }',
      ].join("\n"),
      { mode: 0o755 },
    );
    expect(checkAgySupport(nextPatchRcBin, {})).toEqual({ supported: true, version: "1.5.1-rc.1" });

    // Slow first-run binary (e.g. macOS Gatekeeper scanning a newly updated 230 MB agy binary):
    // - times out with ETIMEDOUT and retry hint (never claiming version "unknown" / "agy update") under a tight timeout
    // - succeeds under the default 15s probe timeout
    const slowBin = path.join(binDir, "agy-slow");
    fs.writeFileSync(
      slowBin,
      [
        `#!${process.execPath}`,
        "setTimeout(() => {",
        '  if (process.argv.includes("--version")) { console.log("1.5.16"); process.exit(0); }',
        '  if (process.argv.includes("--help")) { console.log("  --settings  Session settings"); process.exit(0); }',
        "}, 120);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const timedOutCheck = checkAgySupport(slowBin, {}, 40);
    expect(timedOutCheck.supported).toBe(false);
    if (!timedOutCheck.supported) {
      expect(timedOutCheck.probeFailed).toBe(true);
      expect(timedOutCheck.reason).toContain("ETIMEDOUT");
      expect(timedOutCheck.reason).not.toMatch(/version "unknown"|agy update/i);
    }
    expect(checkAgySupport(slowBin, {})).toEqual({ supported: true, version: "1.5.16" });

    for (const badVer of ["1.4.9", "1.5.0-rc.1", "1.5-beta.1", "0.1.5.0"]) {
      expect(() =>
        buildAgyInvocation({
          aihubHome: sb.aihubHome,
          homeDir: sb.homeDir,
          target,
          apiKey: "sk-tokenhub-1",
          installedVersion: badVer,
          parentEnv: { PATH: "/usr/bin" },
          forwardedArgs: ["-p", "hello"],
        }),
      ).toThrow(new RegExp(`${badVer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*agy update`, "i"));
    }

    expect(fs.existsSync(path.join(sb.aihubHome, "agy-home"))).toBe(false);
    expect(fs.existsSync(path.join(sb.aihubHome, "agy-session-settings"))).toBe(false);
  });

  it("uses session --settings clearing customModelsConfig, unsets competing Google/Vertex env vars, skips --model on non-chat subcommands, and maps only the default alias (#8, #9, #26)", () => {
    const sb = makeSandbox();
    const secret = "sk-tokenhub-agy-flag-777";
    const target = resolveTargetEnv({ env: "prod" }, {});

    const invPassThrough = buildAgyInvocation({
      aihubHome: sb.aihubHome,
      homeDir: sb.homeDir,
      target,
      apiKey: secret,
      model: "gemini-4-hydrogen",
      installedVersion: "1.5.13",
      parentEnv: {
        PATH: "/usr/bin",
        GOOGLE_API_KEY: "other-key",
        GOOGLE_GENAI_USE_VERTEXAI: "true",
        GOOGLE_CLOUD_PROJECT: "some-project",
        GOOGLE_CLOUD_LOCATION: "us-central1",
        GOOGLE_VERTEX_BASE_URL: "https://vertex.example",
      },
      forwardedArgs: ["--effort", "xhigh", "-p", "hello"],
    });

    expect(invPassThrough.env.HOME).toBe(sb.homeDir);
    expect(invPassThrough.env.GOOGLE_API_KEY).toBeUndefined();
    expect(invPassThrough.env.GOOGLE_GENAI_USE_VERTEXAI).toBeUndefined();
    expect(invPassThrough.env.GOOGLE_CLOUD_PROJECT).toBeUndefined();
    expect(invPassThrough.env.GOOGLE_CLOUD_LOCATION).toBeUndefined();
    expect(invPassThrough.env.GOOGLE_VERTEX_BASE_URL).toBeUndefined();
    expect(invPassThrough.env.GOOGLE_GEMINI_BASE_URL).toBe("https://tokenhub-api.belive.sg/api");
    expect(invPassThrough.env.GEMINI_API_KEY).toBe(secret);
    expect(fs.existsSync(path.join(sb.aihubHome, "agy-home"))).toBe(false);
    expect(invPassThrough.args).toEqual([
      "--settings",
      '{"modelProvider":"gemini","customModelsConfig":{}}',
      "--model",
      "gemini-4-hydrogen",
      "--effort",
      "xhigh",
      "-p",
      "hello",
    ]);

    // Default alias google/gemini-4-argon maps to gemini-4-argon-medium by default, or base gemini-4-argon when native --effort is forwarded
    const invDefaultAlias = buildAgyInvocation({
      aihubHome: sb.aihubHome,
      homeDir: sb.homeDir,
      target,
      apiKey: secret,
      model: "google/gemini-4-argon",
      parentEnv: { PATH: "/usr/bin" },
      forwardedArgs: ["-p", "hello"],
    });
    expect(invDefaultAlias.args).toEqual([
      "--settings",
      '{"modelProvider":"gemini","customModelsConfig":{}}',
      "--model",
      "gemini-4-argon-medium",
      "-p",
      "hello",
    ]);

    const invDefaultWithEffort = buildAgyInvocation({
      aihubHome: sb.aihubHome,
      homeDir: sb.homeDir,
      target,
      apiKey: secret,
      model: "google/gemini-4-argon",
      parentEnv: { PATH: "/usr/bin" },
      forwardedArgs: ["--effort", "xhigh", "-p", "hello"],
    });
    expect(invDefaultWithEffort.args).toEqual([
      "--settings",
      '{"modelProvider":"gemini","customModelsConfig":{}}',
      "--model",
      "gemini-4-argon",
      "--effort",
      "xhigh",
      "-p",
      "hello",
    ]);

    // Non-chat subcommand omits --model, and a prompt whose text is '--settings' is passed through as the prompt
    const invSub = buildAgyInvocation({
      aihubHome: sb.aihubHome,
      homeDir: sb.homeDir,
      target,
      apiKey: secret,
      parentEnv: { PATH: "/usr/bin" },
      forwardedArgs: ["models"],
    });
    expect(invSub.args).toEqual([
      "--settings",
      '{"modelProvider":"gemini","customModelsConfig":{}}',
      "models",
    ]);

    const invLiteralPrompt = buildAgyInvocation({
      aihubHome: sb.aihubHome,
      homeDir: sb.homeDir,
      target,
      apiKey: secret,
      parentEnv: { PATH: "/usr/bin" },
      forwardedArgs: ["-p", "--settings"],
    });
    expect(invLiteralPrompt.args).toEqual([
      "--settings",
      '{"modelProvider":"gemini","customModelsConfig":{}}',
      "--model",
      "gemini-4-argon-medium",
      "-p",
      "--settings",
    ]);
  });

  it("merges caller --settings (inline JSON or per-launch 0600 file), sweeps dead-PID SIGKILL directories, and enforces strict cleanup (#15, #17, #21, #23)", () => {
    const sb = makeSandbox();
    const target = resolveTargetEnv({ env: "prod" }, {});
    const secret = "sk-tokenhub-agy-settings-merge-1";

    // 1. Caller --settings with model omits duplicate default --model and stays on real HOME
    const invWithModel = buildAgyInvocation({
      aihubHome: sb.aihubHome,
      homeDir: sb.homeDir,
      cwd: sb.root,
      target,
      apiKey: secret,
      parentEnv: { PATH: "/usr/bin" },
      forwardedArgs: ["--settings", '{"model":"gemini-4-carbon-high"}', "-p", "Reply OK"],
    });
    expect(invWithModel.env.HOME).toBe(sb.homeDir);
    expect(fs.existsSync(path.join(sb.aihubHome, "agy-home"))).toBe(false);
    expect(invWithModel.args).toEqual([
      "--settings",
      '{"model":"gemini-4-carbon-high","modelProvider":"gemini","customModelsConfig":{}}',
      "-p",
      "Reply OK",
    ]);

    // 2. Caller --settings=<file.json> keeps file-based transport (never expanding private file contents into argv), merges AI Hub fields, and removes on cleanup
    const customSettingsFile = path.join(sb.root, "caller-settings.json");
    const privateMarker = "CONFIDENTIAL_PREF_MARKER_991";
    fs.writeFileSync(
      customSettingsFile,
      JSON.stringify({
        colorScheme: "dark",
        privateNote: privateMarker,
        allowNonWorkspaceAccess: true,
        modelProvider: "google",
        customModelsConfig: { hijack: true },
      }),
      { mode: 0o600 },
    );
    const invFile = buildAgyInvocation({
      aihubHome: sb.aihubHome,
      homeDir: sb.homeDir,
      cwd: sb.root,
      target,
      apiKey: secret,
      parentEnv: { PATH: "/usr/bin" },
      forwardedArgs: [`--settings=${path.basename(customSettingsFile)}`, "-p", "Reply OK"],
    });
    expect(invFile.env.HOME).toBe(sb.homeDir);
    expect(invFile.args.join(" ")).not.toContain(privateMarker);
    expect(invFile.args.join(" ")).not.toContain("colorScheme");
    expect(invFile.sessionSettingsPath).toBeTruthy();
    expect(invFile.args[0]).toBe("--settings");
    expect(invFile.args[1]).toBe(invFile.sessionSettingsPath);
    const slotStat = fs.lstatSync(invFile.sessionSettingsPath!);
    expect(slotStat.isSymbolicLink()).toBe(false);
    expect(slotStat.mode & 0o077).toBe(0);
    expect(JSON.parse(fs.readFileSync(invFile.sessionSettingsPath!, "utf8"))).toEqual({
      colorScheme: "dark",
      privateNote: privateMarker,
      allowNonWorkspaceAccess: true,
      modelProvider: "gemini",
      customModelsConfig: {},
    });
    expect(invFile.args.slice(2)).toEqual(["--model", "gemini-4-argon-medium", "-p", "Reply OK"]);

    // Pre-existing dead-PID SIGKILL orphan directory is swept on the next launch (#21)
    const staleDir = path.join(sb.aihubHome, "agy-session-settings", "pid-99999999-stale");
    fs.mkdirSync(staleDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(staleDir, "settings.json"), '{"stale":true}\n', { mode: 0o600 });

    const invFile2 = buildAgyInvocation({
      aihubHome: sb.aihubHome,
      homeDir: sb.homeDir,
      cwd: sb.root,
      target,
      apiKey: secret,
      parentEnv: { PATH: "/usr/bin" },
      forwardedArgs: ["--settings", customSettingsFile, "-p", "Reply OK"],
    });
    expect(invFile2.sessionSettingsPath).not.toBe(invFile.sessionSettingsPath);
    expect(fs.existsSync(staleDir)).toBe(false);

    // Simulate filesystem error preventing removal: cleanup throws naming path without leaking privateMarker, and retries cleanly once writable (#20)
    const sessionDir1 = path.dirname(invFile.sessionSettingsPath!);
    fs.chmodSync(sessionDir1, 0o500);
    try {
      let thrown: Error | undefined;
      try {
        invFile.cleanup();
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown).toBeDefined();
      expect(thrown!.message).toContain(invFile.sessionSettingsPath!);
      expect(thrown!.message).not.toContain(privateMarker);
    } finally {
      fs.chmodSync(sessionDir1, 0o700);
    }

    // Simulate unsearchable sessionsRoot (lookup EACCES, not ENOENT): cleanup must NOT treat lookup error as absent (#23)
    const sessionsRoot = path.dirname(path.dirname(invFile2.sessionSettingsPath!));
    fs.chmodSync(sessionsRoot, 0o000);
    try {
      let lookupThrown: Error | undefined;
      try {
        invFile2.cleanup();
      } catch (err) {
        lookupThrown = err as Error;
      }
      expect(lookupThrown).toBeDefined();
      expect(lookupThrown!.message).toContain(invFile2.sessionSettingsPath!);
      expect(lookupThrown!.message).toContain("EACCES");
      expect(lookupThrown!.message).not.toContain(privateMarker);
    } finally {
      fs.chmodSync(sessionsRoot, 0o700);
    }

    invFile.cleanup();
    invFile2.cleanup();
    expect(fs.existsSync(invFile.sessionSettingsPath!)).toBe(false);
    expect(fs.existsSync(sessionDir1)).toBe(false);
    expect(fs.existsSync(invFile2.sessionSettingsPath!)).toBe(false);

    // 3. Invalid --settings rejects cleanly
    expect(() =>
      buildAgyInvocation({
        aihubHome: sb.aihubHome,
        homeDir: sb.homeDir,
        cwd: sb.root,
        target,
        apiKey: secret,
        parentEnv: { PATH: "/usr/bin" },
        forwardedArgs: ["--settings", "[]", "-p", "Reply OK"],
      }),
    ).toThrow(/--settings/);
  });

  it("validates xhigh on hydrogen, rejects unsupported Argon xhigh with available efforts, and overrides customModelsConfig without persisting modelProvider (#8, #9)", async () => {
    const agyBin = resolveBinaryOnPath("agy", process.env.PATH);
    if (!agyBin) return;

    const sb = makeSandbox();
    const realSettingsPath = path.join(sb.homeDir, ".gemini", "antigravity-cli", "settings.json");
    fs.writeFileSync(
      realSettingsPath,
      JSON.stringify({
        model: "claude-opus-4-6",
        customModelsConfig: {
          models: [{ id: "gemini-4-argon-medium", baseUrl: "http://127.0.0.1:9/hijack" }],
        },
      }),
    );

    const seenPaths: string[] = [];
    const srv = http.createServer((req, res) => {
      seenPaths.push(req.url ?? "");
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"OK"}]},"finishReason":"STOP"}]}\n\n');
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = (srv.address() as { port: number }).port;

    try {
      const baseEnv = {
        PATH: process.env.PATH ?? "",
        AIHUB_HOME: sb.aihubHome,
        BELIVE_TOKENHUB_API_KEY: "sk-tokenhub-live-agy-mock",
      };

      // 1. Unsupported Argon xhigh fails before inference and reports supported efforts
      const badCode = await runCli(
        ["agy", "--base-url", `http://127.0.0.1:${port}`, "--model", "google/gemini-4-argon", "--effort", "xhigh", "-p", "Reply OK"],
        { env: baseEnv, homeDir: sb.homeDir, cwd: sb.root, isTTY: false },
      );
      expect(badCode).not.toBe(0);
      expect(seenPaths).toHaveLength(0);

      // 2. Valid Hydrogen xhigh succeeds and hits our mock server
      const okHydrogen = await runCli(
        ["agy", "--base-url", `http://127.0.0.1:${port}`, "--model", "gemini-4-hydrogen", "--effort", "xhigh", "-p", "Reply OK"],
        { env: baseEnv, homeDir: sb.homeDir, cwd: sb.root, isTTY: false },
      );
      expect(okHydrogen).toBe(0);
      expect(seenPaths.some((p) => p.includes("gemini-4-hydrogen:streamGenerateContent"))).toBe(true);

      // 3. Default Argon launch overrides customModelsConfig and does not persist modelProvider to settings.json
      seenPaths.length = 0;
      const okDefault = await runCli(
        ["agy", "--base-url", `http://127.0.0.1:${port}`, "-p", "Reply OK"],
        { env: baseEnv, homeDir: sb.homeDir, cwd: sb.root, isTTY: false },
      );
      expect(okDefault).toBe(0);
      expect(seenPaths.some((p) => p.includes("gemini-4-argon:streamGenerateContent"))).toBe(true);
      const afterSettings = JSON.parse(fs.readFileSync(realSettingsPath, "utf8")) as Record<string, unknown>;
      expect(afterSettings.modelProvider).toBeUndefined();

      // 4. Caller-supplied native --settings object stays on real HOME without creating agy-home (#15)
      seenPaths.length = 0;
      const okCallerSettings = await runCli(
        ["agy", "--base-url", `http://127.0.0.1:${port}`, "--settings", '{"colorScheme":"dark"}', "-p", "Reply OK"],
        { env: baseEnv, homeDir: sb.homeDir, cwd: sb.root, isTTY: false },
      );
      expect(okCallerSettings).toBe(0);
      expect(seenPaths.some((p) => p.includes("gemini-4-argon:streamGenerateContent"))).toBe(true);
      expect(fs.existsSync(path.join(sb.aihubHome, "agy-home"))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});
