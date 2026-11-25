#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgyInvocation, checkAgySupport } from "./adapters/agy.js";
import { buildClaudeInvocation } from "./adapters/claude.js";
import { buildCodexInvocation, detectCodexSupportsNoDaemon } from "./adapters/codex.js";
import { buildDshInvocation } from "./adapters/dsh.js";
import { buildOpenCodeInvocation } from "./adapters/opencode.js";
import { resolveBinaryOnPath, runDoctor } from "./commands/doctor.js";
import { runSetup } from "./commands/setup.js";
import {
  assertSupportedPlatform,
  hasIgnoredNonAihubFallbackKey,
  KEY_SECRET_PREFIX,
  resolveAihubHome,
  resolveApiKey,
  resolveTargetEnv,
} from "./credentials.js";
import { scrubSecrets } from "./redact.js";
import { spawnHarness } from "./spawn.js";

function readCliVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const parsed = JSON.parse(fs.readFileSync(pkgUrl, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const CLI_VERSION = readCliVersion();

const INSTALL_HINTS: Record<"claude" | "codex" | "agy" | "dsh" | "opencode", string> = {
  claude: "https://code.claude.com/docs/en/quickstart",
  codex: "npm install -g @openai/codex",
  agy: "Install Google Antigravity CLI ('agy') and ensure it is on your PATH",
  dsh: "npm install -g @deepseek-ai/dsh (requires Node.js >= 24.9.0)",
  opencode: "npm install -g opencode-ai (or https://opencode.ai/docs/)",
};

const HELP_TEXT = `aihub v${CLI_VERSION} — BeLive AI Hub launcher for Claude Code, Codex CLI, DeepSeek Harness, OpenCode, and Antigravity CLI

Usage:
  aihub setup    [--open] [--clear]
  aihub doctor   [--base-url <origin>] [--smoke]
  aihub claude   [--base-url <origin>] [--model <id>] [<claude args...>]
  aihub codex    [--base-url <origin>] [--model <id>] [--effort low|medium|high|xhigh] [<codex args...>]
  aihub dsh      [--base-url <origin>] [--model <id>] [--effort <level>] [<dsh args...>]
  aihub opencode [--base-url <origin>] [--model <id>] [<opencode args...>]
  aihub agy      [--base-url <origin>] [--model <id>] [<agy args...>]   (experimental, requires agy >= 1.5)

Credentials & environment:
  1. BELIVE_TOKENHUB_API_KEY   Primary env var (recommended for CI/scripts; avoids clashing with Tencent TokenHub's TOKENHUB_API_KEY)
  2. ~/.aihub/credentials.json Mode 0600 file saved by 'aihub setup' (skipped on custom --base-url / AIHUB_BASE_URL)
  3. TOKENHUB_API_KEY          Fallback env var when neither of the above is set
  AIHUB_BASE_URL               Optional gateway origin override (overridden by --base-url)

Notes & boundaries:
  - Zero local proxy: each CLI connects directly to BeLive AI Hub's native gateway routes.
  - Child processes inherit the resolved key in their environment; use a dedicated workspace key with a spend cap.
  - 'aihub claude' shares ~/.claude (note: MDM or server-delivered Claude managed policy is not locally inspectable).
  - 'aihub codex' uses an isolated static CODEX_HOME (~/.aihub/codex/<env>) and does not read ~/.codex.
  - 'aihub dsh' uses an isolated DSH_HOME (~/.aihub/dsh/<env>) with cordis.patch.yml and unsets DEEPSEEK_API_KEY so web-search plugins never leak keys.
  - 'aihub opencode' injects runtime OPENCODE_CONFIG_CONTENT without modifying opencode.json or ~/.config/opencode.
  - 'aihub agy' (experimental, requires agy >= 1.5) shares ~/.gemini/antigravity-cli using session-only 'agy --settings'. AI Hub serves Gemini 4 Argon, Carbon, Hydrogen, and 3.8/3.7/3.6 Flash (not Neon).
`;

export interface RunCliDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  managedDirOverride?: string;
  isTTY?: boolean;
  stdin?: NodeJS.ReadableStream;
  writeStdout?: (s: string) => void;
  writeStderr?: (s: string) => void;
}

interface ParsedCommandLine {
  command: "help" | "version" | "setup" | "doctor" | "claude" | "codex" | "agy" | "dsh" | "opencode";
  env?: string;
  baseUrl?: string;
  model?: string;
  effort?: string;
  openBrowser: boolean;
  clear: boolean;
  smoke: boolean;
  forwardedArgs: string[];
}

function takeFlagValue(argv: readonly string[], idx: number, flag: string): [string, number] {
  const cur = argv[idx]!;
  if (cur.startsWith(`${flag}=`)) {
    return [cur.slice(flag.length + 1), idx];
  }
  const next = argv[idx + 1];
  if (next === undefined) {
    throw new Error(`Flag ${flag} requires a value.`);
  }
  return [next, idx + 1];
}

function parseCommandLine(argv: readonly string[]): ParsedCommandLine {
  let env: string | undefined;
  let baseUrl: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let openBrowser = false;
  let clear = false;
  let smoke = false;
  let command: ParsedCommandLine["command"] | undefined;
  const forwardedArgs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (!command) {
      if (arg === "--help" || arg === "-h" || arg === "help") {
        return { command: "help", openBrowser, clear, smoke, forwardedArgs: [] };
      }
      if (arg === "--version" || arg === "-v" || arg === "version") {
        return { command: "version", openBrowser, clear, smoke, forwardedArgs: [] };
      }
      if (arg === "--env" || arg.startsWith("--env=")) {
        [env, i] = takeFlagValue(argv, i, "--env");
        continue;
      }
      if (arg === "--base-url" || arg.startsWith("--base-url=")) {
        [baseUrl, i] = takeFlagValue(argv, i, "--base-url");
        continue;
      }
      if (
        arg === "setup" ||
        arg === "doctor" ||
        arg === "claude" ||
        arg === "codex" ||
        arg === "agy" ||
        arg === "dsh" ||
        arg === "opencode"
      ) {
        command = arg;
        continue;
      }
      throw new Error(`Unknown command or flag "${arg}". Run 'aihub --help' for usage.`);
    }

    if (arg === "--") {
      forwardedArgs.push(...argv.slice(i + 1));
      break;
    }

    if (command === "setup") {
      if (arg === "--env" || arg.startsWith("--env=")) {
        [env, i] = takeFlagValue(argv, i, "--env");
        continue;
      }
      if (arg === "--base-url" || arg.startsWith("--base-url=")) {
        [baseUrl, i] = takeFlagValue(argv, i, "--base-url");
        continue;
      }
      if (arg === "--open") {
        openBrowser = true;
        continue;
      }
      if (arg === "--clear") {
        clear = true;
        continue;
      }
      if (arg === "--help" || arg === "-h") {
        return { command: "help", openBrowser, clear, smoke, forwardedArgs: [] };
      }
      throw new Error(`Unknown flag "${arg}" for 'aihub setup'.`);
    }

    if (command === "doctor") {
      if (arg === "--env" || arg.startsWith("--env=")) {
        [env, i] = takeFlagValue(argv, i, "--env");
        continue;
      }
      if (arg === "--base-url" || arg.startsWith("--base-url=")) {
        [baseUrl, i] = takeFlagValue(argv, i, "--base-url");
        continue;
      }
      if (arg === "--smoke") {
        smoke = true;
        continue;
      }
      if (arg === "--help" || arg === "-h") {
        return { command: "help", openBrowser, clear, smoke, forwardedArgs: [] };
      }
      throw new Error(`Unknown flag "${arg}" for 'aihub doctor'.`);
    }

    // Launcher commands (claude, codex, agy): consume wrapper flags only before forwarded args start
    if (arg === "--help" || arg === "-h") {
      return { command: "help", openBrowser, clear, smoke, forwardedArgs: [] };
    }
    if (arg === "--env" || arg.startsWith("--env=")) {
      [env, i] = takeFlagValue(argv, i, "--env");
      continue;
    }
    if (arg === "--base-url" || arg.startsWith("--base-url=")) {
      [baseUrl, i] = takeFlagValue(argv, i, "--base-url");
      continue;
    }
    if (arg === "--model" || arg.startsWith("--model=")) {
      [model, i] = takeFlagValue(argv, i, "--model");
      continue;
    }
    if (
      (command === "codex" || command === "dsh") &&
      (arg === "--effort" || arg.startsWith("--effort="))
    ) {
      [effort, i] = takeFlagValue(argv, i, "--effort");
      continue;
    }

    // First non-wrapper arg begins verbatim forwarding for the rest of argv
    forwardedArgs.push(...argv.slice(i));
    break;
  }

  return {
    command: command ?? "help",
    env,
    baseUrl,
    model,
    effort,
    openBrowser,
    clear,
    smoke,
    forwardedArgs,
  };
}

function isQuietNonInteractiveArgs(args: readonly string[]): boolean {
  return args.some(
    (a) => a === "-p" || a === "--print" || a === "--prompt" || a === "exec" || a === "--quiet",
  );
}

export async function runCli(argv: readonly string[], deps: RunCliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const homeDir = deps.homeDir ?? os.homedir();
  const platform = deps.platform ?? process.platform;
  const writeStdout = deps.writeStdout ?? ((s: string) => process.stdout.write(s));
  const writeStderr = deps.writeStderr ?? ((s: string) => process.stderr.write(s));
  const isTTY = deps.isTTY ?? Boolean(process.stderr.isTTY);

  const knownSecrets = [
    env.BELIVE_TOKENHUB_API_KEY ?? "",
    env.TOKENHUB_API_KEY ?? "",
  ].filter(Boolean);

  try {
    const parsed = parseCommandLine(argv);
    if (parsed.command === "help") {
      writeStdout(HELP_TEXT);
      return 0;
    }
    if (parsed.command === "version") {
      writeStdout(`${CLI_VERSION}\n`);
      return 0;
    }

    assertSupportedPlatform(platform);
    const aihubHome = resolveAihubHome(env, homeDir);
    const target = resolveTargetEnv({ env: parsed.env, baseUrl: parsed.baseUrl }, env);

    if (parsed.command === "setup") {
      return await runSetup({
        aihubHome,
        target,
        openBrowser: parsed.openBrowser,
        clear: parsed.clear,
        stdin: deps.stdin,
        isTTY: deps.isTTY,
        platform,
        writeOut: writeStdout,
      });
    }

    if (parsed.command === "doctor") {
      return await runDoctor({
        aihubHome,
        homeDir,
        cwd,
        platform,
        managedDirOverride: deps.managedDirOverride,
        target,
        env,
        smoke: parsed.smoke,
        writeOut: writeStdout,
      });
    }

    // Launcher command: claude, codex, or agy
    const resolvedCred = resolveApiKey(aihubHome, target, env);
    if (!resolvedCred) {
      const ignoredNote = hasIgnoredNonAihubFallbackKey(env)
        ? ` (ignored TOKENHUB_API_KEY because it does not start with '${KEY_SECRET_PREFIX}')`
        : "";
      if (target.isCustomBaseUrl) {
        throw new Error(
          `Custom --base-url (${target.apiOrigin}) requires BELIVE_TOKENHUB_API_KEY in the environment${ignoredNote} (stored credentials are not sent to custom origins).`,
        );
      }
      throw new Error(
        `No BeLive AI Hub API key configured for '${target.envName}'${ignoredNote}. Run 'aihub setup${target.envName === "staging" ? " --env staging" : ""}' or export BELIVE_TOKENHUB_API_KEY.`,
      );
    }
    knownSecrets.push(resolvedCred.key);

    const binPath = resolveBinaryOnPath(parsed.command, env.PATH);
    if (!binPath) {
      throw new Error(
        `'${parsed.command}' binary not found on PATH. Install hint: ${INSTALL_HINTS[parsed.command]}`,
      );
    }

    if (
      (target.envName === "staging" || target.isCustomBaseUrl) &&
      isTTY &&
      !isQuietNonInteractiveArgs(parsed.forwardedArgs)
    ) {
      const label = target.isCustomBaseUrl ? "custom" : target.envName;
      writeStderr(`[aihub] env=${label} (${target.apiOrigin})\n`);
    }

    if (parsed.command === "claude") {
      const inv = buildClaudeInvocation({
        target,
        apiKey: resolvedCred.key,
        model: parsed.model,
        parentEnv: env,
        cwd,
        homeDir,
        platform,
        managedDirOverride: deps.managedDirOverride,
        forwardedArgs: parsed.forwardedArgs,
      });
      return await spawnHarness({ binPath, args: inv.args, env: inv.env, cwd });
    }

    if (parsed.command === "codex") {
      const supportsNoDaemon = detectCodexSupportsNoDaemon(binPath, env);
      const inv = buildCodexInvocation({
        aihubHome,
        target,
        apiKey: resolvedCred.key,
        model: parsed.model,
        effort: parsed.effort,
        supportsNoDaemon,
        parentEnv: env,
        forwardedArgs: parsed.forwardedArgs,
      });
      return await spawnHarness({ binPath, args: inv.args, env: inv.env, cwd });
    }

    if (parsed.command === "opencode") {
      const inv = buildOpenCodeInvocation({
        target,
        apiKey: resolvedCred.key,
        model: parsed.model,
        parentEnv: env,
        forwardedArgs: parsed.forwardedArgs,
      });
      return await spawnHarness({ binPath, args: inv.args, env: inv.env, cwd });
    }

    if (parsed.command === "dsh") {
      const inv = buildDshInvocation({
        aihubHome,
        target,
        apiKey: resolvedCred.key,
        model: parsed.model,
        effort: parsed.effort,
        parentEnv: env,
        forwardedArgs: parsed.forwardedArgs,
      });
      const onProcessExit = () => {
        try {
          inv.cleanup();
        } catch (err) {
          const raw = err instanceof Error ? err.message : String(err);
          writeStderr(`aihub: ${scrubSecrets(raw, knownSecrets)}\n`);
          process.exitCode = process.exitCode || 1;
        }
      };
      process.once("exit", onProcessExit);
      let childCode = 0;
      let spawnErr: unknown = null;
      try {
        childCode = await spawnHarness({ binPath, args: inv.args, env: inv.env, cwd });
      } catch (err) {
        spawnErr = err;
      } finally {
        process.removeListener("exit", onProcessExit);
      }
      try {
        inv.cleanup();
      } catch (cleanupErr) {
        const raw = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        writeStderr(`aihub: ${scrubSecrets(raw, knownSecrets)}\n`);
        if (!spawnErr && childCode === 0) {
          return 1;
        }
      }
      if (spawnErr) throw spawnErr;
      return childCode;
    }

    const agySupport = checkAgySupport(binPath, env);
    if (!agySupport.supported) {
      throw new Error(agySupport.reason);
    }
    const inv = buildAgyInvocation({
      aihubHome,
      homeDir,
      cwd,
      target,
      apiKey: resolvedCred.key,
      model: parsed.model,
      installedVersion: agySupport.version,
      parentEnv: env,
      forwardedArgs: parsed.forwardedArgs,
    });
    const onProcessExit = () => {
      try {
        inv.cleanup();
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        writeStderr(`aihub: ${scrubSecrets(raw, knownSecrets)}\n`);
        process.exitCode = process.exitCode || 1;
      }
    };
    process.once("exit", onProcessExit);
    let childCode = 0;
    let spawnErr: unknown = null;
    try {
      childCode = await spawnHarness({ binPath, args: inv.args, env: inv.env, cwd });
    } catch (err) {
      spawnErr = err;
    } finally {
      process.removeListener("exit", onProcessExit);
    }
    try {
      inv.cleanup();
    } catch (cleanupErr) {
      const raw = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      writeStderr(`aihub: ${scrubSecrets(raw, knownSecrets)}\n`);
      if (!spawnErr && childCode === 0) {
        return 1;
      }
    }
    if (spawnErr) throw spawnErr;
    return childCode;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    writeStderr(`aihub: ${scrubSecrets(raw, knownSecrets)}\n`);
    return 1;
  }
}

function isExecutedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  }
}

if (isExecutedDirectly()) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      const raw = err instanceof Error ? err.message : String(err);
      process.stderr.write(`aihub: ${scrubSecrets(raw)}\n`);
      process.exitCode = 1;
    },
  );
}
