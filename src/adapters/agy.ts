import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TargetEnv } from "../credentials.js";

export const AGY_DEFAULT_CLIENT_MODEL = "gemini-4-argon-medium";
export const AGY_DEFAULT_BASE_MODEL = "gemini-4-argon";
export const AGY_DEFAULT_WIRE_MODEL = "google/gemini-4-argon";

const UNSET_GOOGLE_PARENT_ENV_KEYS = [
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_VERTEX_BASE_URL",
] as const;

const AGY_NON_CHAT_SUBCOMMANDS = new Set([
  "acp",
  "agent",
  "agents",
  "changelog",
  "help",
  "install",
  "mcp",
  "mic-serve",
  "models",
  "plugin",
  "plugins",
  "remote-control",
  "update",
  "version",
]);

const AGY_VALUE_TAKING_FLAGS = new Set([
  "--add-dir",
  "--agent",
  "--conversation",
  "--effort",
  "-i",
  "--prompt-interactive",
  "--input-format",
  "--json-schema",
  "--log-file",
  "--mode",
  "--model",
  "--output-format",
  "-p",
  "--print",
  "--print-timeout",
  "--project",
  "--prompt",
]);

export interface BuildAgyInvocationOptions {
  aihubHome: string;
  homeDir?: string;
  cwd?: string;
  target: TargetEnv;
  apiKey: string;
  model?: string;
  installedVersion?: string;
  parentEnv?: NodeJS.ProcessEnv;
  forwardedArgs: readonly string[];
}

export interface AgyInvocation {
  args: string[];
  env: NodeJS.ProcessEnv;
  sessionSettingsPath: string | null;
  cleanup: () => void;
}

export type AgySupportCheck =
  | { supported: true; version: string }
  | { supported: false; version: string; probeFailed?: boolean; detail?: string; reason: string };

const DEFAULT_AGY_PROBE_TIMEOUT_MS = 15000;

interface ParsedAgyVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

const AGY_VERSION_RE =
  /(?:^|(?<=[\s(:=/vV]))(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?(?=$|[\s),])/;

const AGY_EXACT_SETTINGS_FLAG_RE = /(?<![A-Za-z0-9_./-])--settings(?![A-Za-z0-9_./-])/;

function parseAgyVersion(versionText: string): ParsedAgyVersion | null {
  const m = AGY_VERSION_RE.exec(versionText);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3] ?? 0),
    prerelease: m[4] ?? null,
  };
}

export function isSupportedAgyVersion(versionText: string): boolean {
  const parsed = parseAgyVersion(versionText);
  if (!parsed) return false;
  if (parsed.major !== 1) return parsed.major > 1;
  if (parsed.minor !== 5) return parsed.minor > 5;
  if (parsed.patch > 0) return true;
  return parsed.prerelease === null;
}

function formatUnsupportedAgyError(versionText: string, detail?: string): string {
  const suffix = detail ? ` (${detail})` : "";
  return `Unsupported Antigravity CLI ('agy') version "${versionText}"${suffix}: 'aihub agy' requires agy >= 1.5.0. Run 'agy update' to upgrade.`;
}

export function checkAgySupport(
  binPath: string,
  env: NodeJS.ProcessEnv,
  probeTimeoutMs: number = DEFAULT_AGY_PROBE_TIMEOUT_MS,
): AgySupportCheck {
  const verRes = spawnSync(binPath, ["--version"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: probeTimeoutMs,
    encoding: "utf8",
  });
  if (verRes.error) {
    const code = (verRes.error as NodeJS.ErrnoException).code ?? verRes.error.message;
    return {
      supported: false,
      version: "unknown",
      probeFailed: true,
      detail: code,
      reason: `Failed to inspect Antigravity CLI ('agy') at "${binPath}" (${code}). If 'agy' was just installed or updated, retry once after macOS finishes verifying the binary.`,
    };
  }
  const firstLine = (verRes.stdout || verRes.stderr || "").trim().split(/\r?\n/)[0]?.trim() ?? "";
  const version =
    firstLine && (verRes.status === 0 || parseAgyVersion(firstLine) !== null)
      ? firstLine
      : "unknown";

  if (!isSupportedAgyVersion(version)) {
    return {
      supported: false,
      version,
      reason: formatUnsupportedAgyError(version),
    };
  }

  const helpRes = spawnSync(binPath, ["--help"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: probeTimeoutMs,
    encoding: "utf8",
  });
  if (helpRes.error) {
    const code = (helpRes.error as NodeJS.ErrnoException).code ?? helpRes.error.message;
    return {
      supported: false,
      version,
      probeFailed: true,
      detail: code,
      reason: `Failed to inspect Antigravity CLI ('agy') '--help' at "${binPath}" (${code}). Retry once after macOS finishes verifying the binary.`,
    };
  }
  const helpText = `${helpRes.stdout ?? ""}\n${helpRes.stderr ?? ""}`;
  if (!AGY_EXACT_SETTINGS_FLAG_RE.test(helpText)) {
    const detail = "missing '--settings' support";
    return {
      supported: false,
      version,
      detail,
      reason: formatUnsupportedAgyError(version, detail),
    };
  }

  return { supported: true, version };
}

function lstatOrNull(targetPath: string): fs.Stats | null {
  try {
    return fs.lstatSync(targetPath);
  } catch {
    return null;
  }
}

function isSameUserProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function verifyConfirmedAbsent(targetPath: string): unknown {
  try {
    fs.lstatSync(targetPath);
    return new Error(`Path still exists: ${targetPath}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return err;
  }
}

function sweepDeadSessionDirs(sessionsRoot: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsRoot);
  } catch {
    return;
  }

  for (const name of entries) {
    const m = /^pid-(\d+)-/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || isSameUserProcessAlive(pid)) continue;
    const dirPath = path.join(sessionsRoot, name);
    const dirStat = lstatOrNull(dirPath);
    if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue;
    const staleFile = path.join(dirPath, "settings.json");
    const fileStat = lstatOrNull(staleFile);
    try {
      if (fileStat && !fileStat.isSymbolicLink() && fileStat.isFile()) {
        fs.unlinkSync(staleFile);
      }
      fs.rmdirSync(dirPath);
    } catch {
      // Leave recoverable on disk for a subsequent sweep if permissions or a concurrent sweep intervened
    }
  }
}

function createSessionSettingsFile(
  aihubHome: string,
  sessionSettings: Record<string, unknown>,
): { settingsPath: string; cleanup: () => void } {
  fs.mkdirSync(aihubHome, { recursive: true, mode: 0o700 });
  const homeStat = lstatOrNull(aihubHome);
  if (!homeStat || homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
    throw new Error(`Refusing non-directory AIHUB_HOME "${aihubHome}".`);
  }
  fs.chmodSync(aihubHome, 0o700);

  const sessionsRoot = path.join(aihubHome, "agy-session-settings");
  fs.mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
  const rootStat = lstatOrNull(sessionsRoot);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Refusing non-directory session settings path "${sessionsRoot}".`);
  }
  fs.chmodSync(sessionsRoot, 0o700);

  sweepDeadSessionDirs(sessionsRoot);

  const sessionDir = fs.mkdtempSync(path.join(sessionsRoot, `pid-${process.pid}-`));
  fs.chmodSync(sessionDir, 0o700);
  const settingsPath = path.join(sessionDir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify(sessionSettings) + "\n", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  fs.chmodSync(settingsPath, 0o600);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    let firstErr: unknown = null;
    try {
      fs.unlinkSync(settingsPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        firstErr = err;
        try {
          fs.writeFileSync(settingsPath, "{}\n", { encoding: "utf8", mode: 0o600 });
        } catch {
          // Best-effort scrub when parent directory prevented unlinking
        }
      }
    }
    try {
      fs.rmdirSync(sessionDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" && !firstErr) {
        firstErr = err;
      }
    }
    const fileCheckErr = verifyConfirmedAbsent(settingsPath);
    const dirCheckErr = verifyConfirmedAbsent(sessionDir);
    const failure = firstErr ?? fileCheckErr ?? dirCheckErr;
    if (failure !== null) {
      const code = (failure as NodeJS.ErrnoException | null)?.code;
      const reason = code ? ` (${code})` : "";
      throw new Error(`Failed to remove session settings file "${settingsPath}"${reason}.`);
    }
    cleaned = true;
  };

  return { settingsPath, cleanup };
}

function parseJsonSettingsValue(
  raw: string,
  cwd: string,
): { parsed: Record<string, unknown>; fromFile: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Invalid --settings value: expected a JSON object or path to a JSON file.");
  }
  let jsonText = trimmed;
  let fromFile = false;
  if (!trimmed.startsWith("{")) {
    fromFile = true;
    const filePath = path.resolve(cwd, raw);
    try {
      jsonText = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid --settings file "${raw}": ${msg}`);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid --settings JSON: ${msg}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid --settings JSON: expected a JSON object.");
  }
  return { parsed: parsed as Record<string, unknown>, fromFile };
}

export function buildAgyInvocation(opts: BuildAgyInvocationOptions): AgyInvocation {
  if (opts.installedVersion !== undefined && !isSupportedAgyVersion(opts.installedVersion)) {
    throw new Error(formatUnsupportedAgyError(opts.installedVersion));
  }

  const homeDir = opts.homeDir ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();

  const mergedCallerSettings: Record<string, unknown> = {};
  const remainingArgs: string[] = [];
  let callerUsedSettingsFile = false;
  let callerHasModel = false;
  let callerHasEffort = false;
  let callerHasHelpOrVersion = false;

  for (let i = 0; i < opts.forwardedArgs.length; i++) {
    const arg = opts.forwardedArgs[i]!;
    if (arg === "--") {
      remainingArgs.push(...opts.forwardedArgs.slice(i));
      break;
    }
    if (arg === "--settings" || arg.startsWith("--settings=")) {
      let rawVal: string;
      if (arg === "--settings") {
        const next = opts.forwardedArgs[i + 1];
        if (next === undefined) {
          throw new Error("Flag --settings requires a JSON object or file path.");
        }
        rawVal = next;
        i++;
      } else {
        rawVal = arg.slice("--settings=".length);
      }
      const { parsed, fromFile } = parseJsonSettingsValue(rawVal, cwd);
      if (fromFile) callerUsedSettingsFile = true;
      Object.assign(mergedCallerSettings, parsed);
      continue;
    }
    if (arg === "--model" || arg.startsWith("--model=")) callerHasModel = true;
    if (arg === "--effort" || arg.startsWith("--effort=")) callerHasEffort = true;
    if (arg === "--help" || arg === "-h" || arg === "--version") {
      callerHasHelpOrVersion = true;
    }
    remainingArgs.push(arg);
    if (AGY_VALUE_TAKING_FLAGS.has(arg) && i + 1 < opts.forwardedArgs.length) {
      remainingArgs.push(opts.forwardedArgs[++i]!);
    }
  }

  const env: NodeJS.ProcessEnv = { ...(opts.parentEnv ?? process.env) };
  for (const key of UNSET_GOOGLE_PARENT_ENV_KEYS) {
    delete env[key];
  }
  env.HOME = homeDir;
  env.GOOGLE_GEMINI_BASE_URL = `${opts.target.apiOrigin}/api`;
  env.GEMINI_API_KEY = opts.apiKey;

  const firstArg = remainingArgs[0];
  const isSubcommand = firstArg !== undefined && AGY_NON_CHAT_SUBCOMMANDS.has(firstArg);
  const callerSetModelInSettings =
    typeof mergedCallerSettings.model === "string" && mergedCallerSettings.model.trim().length > 0;

  let sessionSettingsPath: string | null = null;
  let cleanup = () => {};
  const args: string[] = [];
  if (!callerHasHelpOrVersion) {
    const sessionSettings = {
      ...mergedCallerSettings,
      modelProvider: "gemini",
      customModelsConfig: {},
    };
    if (callerUsedSettingsFile) {
      const created = createSessionSettingsFile(opts.aihubHome, sessionSettings);
      sessionSettingsPath = created.settingsPath;
      cleanup = created.cleanup;
      args.push("--settings", created.settingsPath);
    } else {
      const existingRoot = path.join(opts.aihubHome, "agy-session-settings");
      const existingStat = lstatOrNull(existingRoot);
      if (existingStat && !existingStat.isSymbolicLink() && existingStat.isDirectory()) {
        sweepDeadSessionDirs(existingRoot);
      }
      args.push("--settings", JSON.stringify(sessionSettings));
    }
  } else {
    const existingRoot = path.join(opts.aihubHome, "agy-session-settings");
    const existingStat = lstatOrNull(existingRoot);
    if (existingStat && !existingStat.isSymbolicLink() && existingStat.isDirectory()) {
      sweepDeadSessionDirs(existingRoot);
    }
  }

  const explicitModel = opts.model?.trim();
  const defaultArgonModel = callerHasEffort ? AGY_DEFAULT_BASE_MODEL : AGY_DEFAULT_CLIENT_MODEL;
  if (explicitModel) {
    args.push("--model", explicitModel === AGY_DEFAULT_WIRE_MODEL ? defaultArgonModel : explicitModel);
  } else if (!callerHasModel && !callerSetModelInSettings && !callerHasHelpOrVersion && !isSubcommand) {
    args.push("--model", defaultArgonModel);
  }
  args.push(...remainingArgs);

  return { args, env, sessionSettingsPath, cleanup };
}
