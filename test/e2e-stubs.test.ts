import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { saveStoredApiKey } from "../src/credentials.js";
import { runCli } from "../src/cli.js";

const tempDirs: string[] = [];

function createStubEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aihub-e2e-"));
  tempDirs.push(root);
  const homeDir = path.join(root, "home");
  const aihubHome = path.join(homeDir, ".aihub");
  const binDir = path.join(root, "bin");
  const dumpDir = path.join(root, "dumps");
  const managedDir = path.join(root, "managed");
  const cwd = path.join(root, "workspace");

  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".gemini", "antigravity-cli"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(dumpDir, { recursive: true });
  fs.mkdirSync(managedDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });

  fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), '{"permissions":{}}\n');
  fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"), 'model = "user-plain-codex"\n');
  fs.writeFileSync(
    path.join(homeDir, ".gemini", "antigravity-cli", "settings.json"),
    '{"modelProvider":"google","model":"oauth-default"}\n',
  );

  const nodePath = process.execPath;
  for (const name of ["claude", "codex", "agy"]) {
    const script = [
      `#!${nodePath}`,
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const argv = process.argv.slice(2);',
      'if (argv.includes("--version") && process.env.STUB_CAPTURE_VERSION !== "1") {',
      `  if (${JSON.stringify(name)} === "claude") console.log("2.1.318 (Claude Code)");`,
      `  if (${JSON.stringify(name)} === "codex") console.log(process.env.STUB_OLD_CODEX === "1" ? "codex-cli 0.144.1" : "codex-cli 0.167.2");`,
      `  if (${JSON.stringify(name)} === "agy") console.log(process.env.STUB_OLD_AGY === "1" ? "1.4.2" : "1.5.13");`,
      '  process.exit(0);',
      '}',
      'if (argv.includes("--help") && process.env.STUB_CAPTURE_HELP !== "1") {',,
      `  if (${JSON.stringify(name)} === "codex") console.log(process.env.STUB_OLD_CODEX === "1" ? "Usage: codex" : "Usage: codex --no-daemon");`,
      `  if (${JSON.stringify(name)} === "agy") console.log(process.env.STUB_OLD_AGY === "1" ? "Usage: agy" : "Usage: agy --settings");`,
      '  process.exit(0);',
      '}',
      `const outFile = path.join(${JSON.stringify(dumpDir)}, "${name}-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(16).slice(2) + ".json");`,
      "let settingsFileText = null;",
      'const sIdx = argv.indexOf("--settings");',
      "if (sIdx !== -1 && argv[sIdx + 1] && !argv[sIdx + 1].trim().startsWith('{') && fs.existsSync(argv[sIdx + 1])) {",
      '  settingsFileText = fs.readFileSync(argv[sIdx + 1], "utf8");',
      "}",
      "fs.writeFileSync(outFile, JSON.stringify({",
      "  argv,",
      "  settingsFileText,",
      "  HOME: process.env.HOME,",
      "  CODEX_HOME: process.env.CODEX_HOME,",
      "  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,",
      "  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,",
      "  ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,",
      "  CLAUDE_CODE_ATTRIBUTION_HEADER: process.env.CLAUDE_CODE_ATTRIBUTION_HEADER,",
      "  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS,",
      "  BELIVE_TOKENHUB_API_KEY: process.env.BELIVE_TOKENHUB_API_KEY,",
      "  GOOGLE_GEMINI_BASE_URL: process.env.GOOGLE_GEMINI_BASE_URL,",
      "  GEMINI_API_KEY: process.env.GEMINI_API_KEY,",
      "}));",
      "process.exit(process.env.STUB_EXIT_CODE ? Number(process.env.STUB_EXIT_CODE) : 0);",
      "",
    ].join("\n");
    const binFile = path.join(binDir, name);
    fs.writeFileSync(binFile, script, { mode: 0o755 });
  }

  return { root, homeDir, aihubHome, binDir, dumpDir, managedDir, cwd };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("aihub CLI end-to-end with stub harnesses", () => {
  it("prints help listing all 5 v1 commands, experimental agy, BELIVE_TOKENHUB_API_KEY, and MDM limit", async () => {
    const sb = createStubEnv();
    const out: string[] = [];
    const code = await runCli(["--help"], {
      env: { PATH: sb.binDir, AIHUB_HOME: sb.aihubHome },
      homeDir: sb.homeDir,
      cwd: sb.cwd,
      managedDirOverride: sb.managedDir,
      writeStdout: (s) => out.push(s),
      writeStderr: (s) => out.push(s),
    });

    expect(code).toBe(0);
    const helpText = out.join("");
    expect(helpText).toContain("aihub setup");
    expect(helpText).toContain("aihub doctor");
    expect(helpText).toContain("aihub claude");
    expect(helpText).toContain("aihub codex");
    expect(helpText).toContain("aihub agy");
    expect(helpText).not.toMatch(/aihub agy[^\n]*--effort/);
    expect(helpText).toContain("~/.gemini/antigravity-cli");
    expect(helpText).toContain("agy >= 1.5");
    expect(helpText).not.toMatch(/overlay|agy-home/i);
    expect(helpText).toMatch(/experimental/i);
    expect(helpText).toContain("BELIVE_TOKENHUB_API_KEY");
    expect(helpText).toMatch(/MDM|server-delivered/i);
  });

  it("launches claude, concurrent codex sessions, and agy without mutating real user configs, and propagates child exit codes", async () => {
    const sb = createStubEnv();
    const secret = "sk-tokenhub-e2e-secret-321";
    saveStoredApiKey(sb.aihubHome, "prod", secret);

    const baseEnv = {
      PATH: `${sb.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AIHUB_HOME: sb.aihubHome,
    };

    // 1. aihub claude (with child exit code 42 propagation check)
    const claudeCode = await runCli(["claude", "-p", "read sample"], {
      env: { ...baseEnv, STUB_EXIT_CODE: "42" },
      homeDir: sb.homeDir,
      cwd: sb.cwd,
      managedDirOverride: sb.managedDir,
      isTTY: false,
    });
    expect(claudeCode).toBe(42);

    // 2. Two concurrent aihub codex runs with different models and efforts
    const [codex1, codex2] = await Promise.all([
      runCli(["codex", "--model", "openai/gpt-6.1-terra", "--effort", "xhigh", "exec", "task1"], {
        env: baseEnv,
        homeDir: sb.homeDir,
        cwd: sb.cwd,
        managedDirOverride: sb.managedDir,
        isTTY: false,
      }),
      runCli(["codex", "--model", "openai/gpt-6-luna", "--effort", "medium", "exec", "task2"], {
        env: baseEnv,
        homeDir: sb.homeDir,
        cwd: sb.cwd,
        managedDirOverride: sb.managedDir,
        isTTY: false,
      }),
    ]);
    expect(codex1).toBe(0);
    expect(codex2).toBe(0);

    // 3. aihub agy
    const agyCode = await runCli(["agy", "--dangerously-skip-permissions", "-p", "read 3"], {
      env: baseEnv,
      homeDir: sb.homeDir,
      cwd: sb.cwd,
      managedDirOverride: sb.managedDir,
      isTTY: false,
    });
    expect(agyCode).toBe(0);

    // Inspect stub dumps
    const dumps = fs.readdirSync(sb.dumpDir).map((f) => ({
      name: f,
      data: JSON.parse(fs.readFileSync(path.join(sb.dumpDir, f), "utf8")) as Record<string, unknown>,
    }));

    const claudeDump = dumps.find((d) => d.name.startsWith("claude-"))!.data;
    expect(claudeDump.ANTHROPIC_BASE_URL).toBe("https://tokenhub-api.belive.sg/api");
    expect(claudeDump.ANTHROPIC_AUTH_TOKEN).toBe(secret);
    expect(claudeDump.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("anthropic/claude-haiku-5-5");
    expect(claudeDump.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe("0");
    expect(claudeDump.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("1");

    const codexDumps = dumps.filter((d) => d.name.startsWith("codex-")).map((d) => d.data);
    expect(codexDumps).toHaveLength(2);
    const allCodexArgs = codexDumps.map((d) => (d.argv as string[]).join(" "));
    expect(allCodexArgs.some((s) => s.includes("openai/gpt-6.1-terra") && s.includes('model_reasoning_effort="xhigh"'))).toBe(true);
    expect(allCodexArgs.some((s) => s.includes("openai/gpt-6-luna") && s.includes('model_reasoning_effort="medium"'))).toBe(true);

    const agyDump = dumps.find((d) => d.name.startsWith("agy-"))!.data;
    expect(agyDump.HOME).toBe(sb.homeDir);
    expect(agyDump.GOOGLE_GEMINI_BASE_URL).toBe("https://tokenhub-api.belive.sg/api");
    expect(agyDump.GEMINI_API_KEY).toBe(secret);
    expect((agyDump.argv as string[]).slice(0, 2)).toEqual([
      "--settings",
      '{"modelProvider":"gemini","customModelsConfig":{}}',
    ]);

    // Older Codex (0.144.1 without --no-daemon in --help) omits --no-daemon cleanly
    const oldCodexCode = await runCli(["codex", "exec", "legacy-check"], {
      env: { ...baseEnv, STUB_OLD_CODEX: "1" },
      homeDir: sb.homeDir,
      cwd: sb.cwd,
      managedDirOverride: sb.managedDir,
      isTTY: false,
    });
    expect(oldCodexCode).toBe(0);
    const afterDumps = fs.readdirSync(sb.dumpDir).filter((f) => f.startsWith("codex-"));
    const legacyDump = afterDumps
      .map((f) => JSON.parse(fs.readFileSync(path.join(sb.dumpDir, f), "utf8")) as { argv: string[] })
      .find((d) => d.argv.includes("legacy-check"))!;
    expect(legacyDump.argv).not.toContain("--no-daemon");

    // Real user configs remain untouched
    expect(fs.readFileSync(path.join(sb.homeDir, ".claude", "settings.json"), "utf8")).toBe(
      '{"permissions":{}}\n',
    );
    expect(fs.readFileSync(path.join(sb.homeDir, ".codex", "config.toml"), "utf8")).toBe(
      'model = "user-plain-codex"\n',
    );
    expect(
      fs.readFileSync(path.join(sb.homeDir, ".gemini", "antigravity-cli", "settings.json"), "utf8"),
    ).toBe('{"modelProvider":"google","model":"oauth-default"}\n');

    // File-sourced agy --settings keeps private values out of child argv while delivering merged file to child and scrubbing on exit (#17)
    const privateSettingsFile = path.join(sb.cwd, "private-agy.json");
    const e2eMarker = "PRIVATE_MARKER_E2E_77";
    fs.writeFileSync(
      privateSettingsFile,
      JSON.stringify({ colorScheme: "dark", secretPref: e2eMarker, modelProvider: "google" }),
      { mode: 0o600 },
    );
    const agyFileCode = await runCli(
      ["agy", "--settings", "private-agy.json", "-p", "file-settings-check"],
      {
        env: baseEnv,
        homeDir: sb.homeDir,
        cwd: sb.cwd,
        managedDirOverride: sb.managedDir,
        isTTY: false,
      },
    );
    expect(agyFileCode).toBe(0);
    const fileSettingsDump = fs
      .readdirSync(sb.dumpDir)
      .filter((f) => f.startsWith("agy-"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(sb.dumpDir, f), "utf8")) as { argv: string[]; settingsFileText: string | null })
      .find((d) => d.argv.includes("file-settings-check"))!;
    expect(fileSettingsDump.argv.join(" ")).not.toContain(e2eMarker);
    expect(fileSettingsDump.settingsFileText).toBeTruthy();
    expect(JSON.parse(fileSettingsDump.settingsFileText!)).toEqual({
      colorScheme: "dark",
      secretPref: e2eMarker,
      modelProvider: "gemini",
      customModelsConfig: {},
    });
    const sessionSlotFile = fileSettingsDump.argv[fileSettingsDump.argv.indexOf("--settings") + 1]!;
    expect(fs.existsSync(sessionSlotFile)).toBe(false);

    // Nonzero child exit also removes its per-launch session settings file and preserves exit code (#20)
    const agyNonZero = await runCli(
      ["agy", "--settings", "private-agy.json", "-p", "nonzero-file-settings"],
      {
        env: { ...baseEnv, STUB_EXIT_CODE: "7" },
        homeDir: sb.homeDir,
        cwd: sb.cwd,
        managedDirOverride: sb.managedDir,
        isTTY: false,
      },
    );
    expect(agyNonZero).toBe(7);
    const nonZeroDump = fs
      .readdirSync(sb.dumpDir)
      .filter((f) => f.startsWith("agy-"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(sb.dumpDir, f), "utf8")) as { argv: string[] })
      .find((d) => d.argv.includes("nonzero-file-settings"))!;
    const nonZeroSettingsFile = nonZeroDump.argv[nonZeroDump.argv.indexOf("--settings") + 1]!;
    expect(fs.existsSync(nonZeroSettingsFile)).toBe(false);
  });

  it("isolates 16 concurrent multi-process aihub agy --settings <file> launches without cross-session leakage or mid-run scrubbing, and reports failed cleanup (#19, #20, #21)", async () => {
    const sb = createStubEnv();
    const secret = "sk-tokenhub-concurrent-agy-16";
    saveStoredApiKey(sb.aihubHome, "prod", secret);

    // Replace stub agy with one that reads --settings at start AND after a staggered delay, or chmods sessionDir 0500 when STUB_FAIL_CLEANUP=1
    const agyStubPath = path.join(sb.binDir, "agy");
    fs.writeFileSync(
      agyStubPath,
      [
        `#!${process.execPath}`,
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const argv = process.argv.slice(2);',
        'if (argv.includes("--version")) {',
        '  console.log(process.env.STUB_AGY_VERSION || (process.env.STUB_OLD_AGY === "1" ? "1.4.2" : "1.5.13"));',
        '  process.exit(0);',
        '}',
        'if (argv.includes("--help")) {',
        '  console.log(process.env.STUB_AGY_HELP || (process.env.STUB_OLD_AGY === "1" ? "Usage: agy" : "Usage: agy --settings"));',
        '  process.exit(0);',
        '}',
        'const sIdx = argv.indexOf("--settings");',
        'const settingsArg = sIdx !== -1 ? argv[sIdx + 1] : "{}";',
        'const isInline = settingsArg.trim().startsWith("{");',
        'const firstRead = isInline ? settingsArg : fs.readFileSync(settingsArg, "utf8");',
        'if (process.env.STUB_FAIL_CLEANUP === "1") {',
        '  fs.chmodSync(path.dirname(settingsArg), 0o500);',
        '  process.stdout.write(JSON.stringify({ settingsPath: settingsArg }));',
        '  process.exit(0);',
        '}',
        'if (process.env.STUB_FAIL_LOOKUP === "1") {',
        '  fs.chmodSync(path.dirname(path.dirname(settingsArg)), 0o000);',
        '  process.stdout.write(JSON.stringify({ settingsPath: settingsArg }));',
        '  process.exit(0);',
        '}',
        'const delayMs = Number(process.env.STUB_DELAY_MS || "80");',
        'setTimeout(() => {',
        '  const secondRead = isInline ? settingsArg : fs.readFileSync(settingsArg, "utf8");',
        '  process.stdout.write(JSON.stringify({ settingsPath: settingsArg, first: JSON.parse(firstRead), second: JSON.parse(secondRead) }));',
        '  process.exit(0);',
        '}, delayMs);',
      ].join("\n"),
      { mode: 0o755 },
    );

    const tscBin = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
    const tsconfigBuild = fileURLToPath(new URL("../tsconfig.build.json", import.meta.url));
    const builtDir = path.join(sb.root, "built");
    execFileSync(process.execPath, [tscBin, "-p", tsconfigBuild, "--outDir", builtDir], { stdio: "pipe" });
    const cliBuiltPath = path.join(builtDir, "cli.js");

    // 1. Spawn 16 real concurrent OS processes with staggered delays (20ms vs 140ms) so early finishers clean up while siblings still run
    const count = 16;
    const files: string[] = [];
    for (let i = 0; i < count; i++) {
      const f = path.join(sb.cwd, `s${i}.json`);
      fs.writeFileSync(f, JSON.stringify({ trustedWorkspaces: [`/ws-${i}`] }), { mode: 0o600 });
      files.push(f);
    }

    const results = await Promise.all(
      files.map(
        (file, i) =>
          new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
            const child = spawn(
              process.execPath,
              [cliBuiltPath, "agy", "--settings", file, "-p", `hi-${i}`],
              {
                cwd: sb.cwd,
                env: {
                  PATH: `${sb.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
                  HOME: sb.homeDir,
                  AIHUB_HOME: sb.aihubHome,
                  STUB_DELAY_MS: i % 2 === 0 ? "20" : "140",
                },
                stdio: ["ignore", "pipe", "pipe"],
              },
            );
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (c) => {
              stdout += String(c);
            });
            child.stderr.on("data", (c) => {
              stderr += String(c);
            });
            child.on("close", (code) => resolve({ code, stdout, stderr }));
          }),
      ),
    );

    const seenPaths = new Set<string>();
    results.forEach((r, i) => {
      expect(r.code, `stderr=${r.stderr}`).toBe(0);
      const parsed = JSON.parse(r.stdout) as {
        settingsPath: string;
        first: Record<string, unknown>;
        second: Record<string, unknown>;
      };
      seenPaths.add(parsed.settingsPath);
      expect(parsed.first).toEqual({
        trustedWorkspaces: [`/ws-${i}`],
        modelProvider: "gemini",
        customModelsConfig: {},
      });
      expect(parsed.second).toEqual(parsed.first);
    });
    expect(seenPaths.size).toBe(count);
    const sessionsRoot = path.join(sb.aihubHome, "agy-session-settings");
    expect(fs.readdirSync(sessionsRoot)).toEqual([]);

    // 2. Failed cleanup reports path on stderr without leaking file values and exits 1 (#20)
    const errLines: string[] = [];
    let capturedLockedDir = "";
    try {
      const failCode = await runCli(["agy", "--settings", files[0]!, "-p", "fail-cleanup"], {
        env: {
          PATH: `${sb.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          AIHUB_HOME: sb.aihubHome,
          STUB_FAIL_CLEANUP: "1",
        },
        homeDir: sb.homeDir,
        cwd: sb.cwd,
        managedDirOverride: sb.managedDir,
        isTTY: false,
        writeStderr: (s) => errLines.push(s),
      });
      const remaining = fs.readdirSync(sessionsRoot);
      if (remaining.length > 0) {
        capturedLockedDir = path.join(sessionsRoot, remaining[0]!);
      }
      expect(failCode).toBe(1);
      const errText = errLines.join("");
      expect(errText).toContain("agy-session-settings");
      expect(errText).not.toContain("/ws-0");
    } finally {
      if (capturedLockedDir && fs.existsSync(capturedLockedDir)) {
        fs.chmodSync(capturedLockedDir, 0o700);
      }
    }

    // 3. Unsearchable sessionsRoot (lookup EACCES, #23) also exits 1, reports path + EACCES without values, and stays recoverable
    const lookupErrLines: string[] = [];
    try {
      const lookupFailCode = await runCli(["agy", "--settings", files[0]!, "-p", "fail-lookup"], {
        env: {
          PATH: `${sb.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          AIHUB_HOME: sb.aihubHome,
          STUB_FAIL_LOOKUP: "1",
        },
        homeDir: sb.homeDir,
        cwd: sb.cwd,
        managedDirOverride: sb.managedDir,
        isTTY: false,
        writeStderr: (s) => lookupErrLines.push(s),
      });
      expect(lookupFailCode).toBe(1);
      const lookupErrText = lookupErrLines.join("");
      expect(lookupErrText).toContain("agy-session-settings");
      expect(lookupErrText).toContain("EACCES");
      expect(lookupErrText).not.toContain("/ws-0");
    } finally {
      fs.chmodSync(sessionsRoot, 0o700);
    }

    // 4. Older agy (< 1.5) refuses with one clear error naming the installed version and telling the user to update (#26)
    const oldAgyErr: string[] = [];
    const oldAgyCode = await runCli(["agy", "-p", "old-agy-check"], {
      env: {
        PATH: `${sb.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        AIHUB_HOME: sb.aihubHome,
        STUB_OLD_AGY: "1",
      },
      homeDir: sb.homeDir,
      cwd: sb.cwd,
      managedDirOverride: sb.managedDir,
      isTTY: false,
      writeStderr: (s) => oldAgyErr.push(s),
    });
    expect(oldAgyCode).toBe(1);
    const oldAgyErrText = oldAgyErr.join("");
    expect(oldAgyErrText).toContain("1.4.2");
    expect(oldAgyErrText).toMatch(/1\.5\.0/);
    expect(oldAgyErrText).toMatch(/agy update/i);
    expect(oldAgyErrText).not.toContain(secret);
    expect(fs.existsSync(path.join(sb.aihubHome, "agy-home"))).toBe(false);

    // 5. Controlled compatibility fixtures from #30: 1.5.0-rc.1 and --settings-file both refuse cleanly
    for (const fixture of [
      { ver: "1.5.0-rc.1", help: "  --settings  Session settings" },
      { ver: "1.5.13", help: "  --settings-file <path>" },
    ]) {
      const fixErr: string[] = [];
      const fixCode = await runCli(["agy", "-p", "fixture-check"], {
        env: {
          PATH: `${sb.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          AIHUB_HOME: sb.aihubHome,
          STUB_AGY_VERSION: fixture.ver,
          STUB_AGY_HELP: fixture.help,
        },
        homeDir: sb.homeDir,
        cwd: sb.cwd,
        managedDirOverride: sb.managedDir,
        isTTY: false,
        writeStderr: (s) => fixErr.push(s),
      });
      expect(fixCode).toBe(1);
      const fixErrText = fixErr.join("");
      expect(fixErrText.trim().split(/\r?\n/)).toHaveLength(1);
      expect(fixErrText).toContain(fixture.ver);
      expect(fixErrText).toMatch(/agy update/i);
      expect(fixErrText).not.toContain(secret);
    }
  });

  it("reports missing binary cleanly without leaking secret", async () => {
    const sb = createStubEnv();
    const secret = "sk-tokenhub-missing-bin-999";
    const errOut: string[] = [];
    const code = await runCli(["claude"], {
      env: { PATH: "/nonexistent-dir", BELIVE_TOKENHUB_API_KEY: secret, AIHUB_HOME: sb.aihubHome },
      homeDir: sb.homeDir,
      cwd: sb.cwd,
      managedDirOverride: sb.managedDir,
      writeStderr: (s) => errOut.push(s),
    });

    expect(code).toBe(1);
    expect(errOut.join("")).toMatch(/claude.*not found/i);
    expect(errOut.join("")).not.toContain(secret);
  });

  it("stops consuming wrapper flags once forwarded args begin and supports 'aihub agy --help' without a key", async () => {
    const sb = createStubEnv();
    const helpOut: string[] = [];
    const helpCode = await runCli(["agy", "--help"], {
      env: { PATH: sb.binDir, AIHUB_HOME: sb.aihubHome },
      homeDir: sb.homeDir,
      cwd: sb.cwd,
      managedDirOverride: sb.managedDir,
      writeStdout: (s) => helpOut.push(s),
    });
    expect(helpCode).toBe(0);
    expect(helpOut.join("")).toMatch(/experimental/i);

    const runCode = await runCli(["claude", "-p", "--env", "literal-prompt-arg"], {
      env: {
        PATH: `${sb.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        BELIVE_TOKENHUB_API_KEY: "sk-tokenhub-stop-parse-test",
        AIHUB_HOME: sb.aihubHome,
      },
      homeDir: sb.homeDir,
      cwd: sb.cwd,
      managedDirOverride: sb.managedDir,
      isTTY: false,
    });
    expect(runCode).toBe(0);
    const dumpFile = fs.readdirSync(sb.dumpDir).find((f) => f.startsWith("claude-"))!;
    const dump = JSON.parse(fs.readFileSync(path.join(sb.dumpDir, dumpFile), "utf8")) as {
      argv: string[];
    };
    expect(dump.argv.slice(-3)).toEqual(["-p", "--env", "literal-prompt-arg"]);

    const verOut: string[] = [];
    const verCode = await runCli(["--version"], {
      env: { PATH: sb.binDir, AIHUB_HOME: sb.aihubHome },
      writeStdout: (s) => verOut.push(s),
    });
    const pkg = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(verCode).toBe(0);
    expect(verOut.join("").trim()).toBe(pkg.version);

    // Non-AI-Hub TOKENHUB_API_KEY reports missing key + ignored note (never format error or key leak)
    const missingErr: string[] = [];
    const missingCode = await runCli(["claude", "-p", "hi"], {
      env: {
        PATH: sb.binDir,
        AIHUB_HOME: sb.aihubHome,
        TOKENHUB_API_KEY: "tencent-secret-token-xyz",
      },
      homeDir: sb.homeDir,
      cwd: sb.cwd,
      managedDirOverride: sb.managedDir,
      writeStderr: (s) => missingErr.push(s),
    });
    expect(missingCode).toBe(1);
    expect(missingErr.join("")).toMatch(/No BeLive AI Hub API key configured.*ignored TOKENHUB_API_KEY/i);
    expect(missingErr.join("")).not.toContain("tencent-secret-token-xyz");
  });
});
