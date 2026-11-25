import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TargetEnv } from "../credentials.js";

export const CLAUDE_CREDENTIAL_AND_ENDPOINT_KEYS = {
  topLevel: ["apiKeyHelper", "forceLoginMethod"] as const,
  env: [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_FOUNDRY_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ] as const,
};

export const CLAUDE_MODEL_KEYS = {
  topLevel: ["model"] as const,
  env: [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
  ] as const,
};

const USER_NON_SECRET_OVERRIDABLE_ENV_KEYS = new Set<string>([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_ATTRIBUTION_HEADER",
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
  ...CLAUDE_MODEL_KEYS.env,
]);

const UNSET_PARENT_ENV_KEYS = [
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
] as const;

export const CLAUDE_DEFAULT_TIERED_ROLES = {
  sessionModel: "anthropic/claude-opus-5-5",
  opus: "anthropic/claude-opus-5-5",
  sonnet: "anthropic/claude-sonnet-5-5",
  haiku: "anthropic/claude-haiku-5-5",
  fable: "anthropic/claude-fable-5-2",
  subagent: "anthropic/claude-sonnet-5-5",
} as const;

export interface ClaudeSettingsInspectionOptions {
  cwd?: string;
  homeDir?: string;
  parentEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  managedDirOverride?: string;
  forwardedArgs?: readonly string[];
  callerPassedSettingsFlag?: boolean;
}

export interface ClaudeSettingsDiagnostic {
  blockingErrors: string[];
  overriddenWarnings: string[];
  inspectedFiles: string[];
}

function defaultManagedDir(platform: NodeJS.Platform): string {
  return platform === "darwin"
    ? "/Library/Application Support/ClaudeCode"
    : "/etc/claude-code";
}

function resolveClaudeUserConfigDir(
  homeDir: string,
  cwd: string,
  parentEnv: NodeJS.ProcessEnv | undefined,
): string {
  const override = parentEnv?.CLAUDE_CONFIG_DIR?.trim();
  if (override) {
    return path.resolve(cwd, override);
  }
  return path.join(homeDir, ".claude");
}

function collectManagedFiles(managedDir: string): string[] {
  const out: string[] = [];
  const mainFile = path.join(managedDir, "managed-settings.json");
  if (fs.existsSync(mainFile)) out.push(mainFile);
  const dropInDir = path.join(managedDir, "managed-settings.d");
  try {
    if (fs.existsSync(dropInDir) && fs.statSync(dropInDir).isDirectory()) {
      const entries = fs
        .readdirSync(dropInDir)
        .filter((name) => name.endsWith(".json"))
        .sort();
      for (const name of entries) {
        out.push(path.join(dropInDir, name));
      }
    }
  } catch {
    // Unreadable system directory is ignored unless a specific file exists and fails parsing
  }
  return out;
}

function safeRealpath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved;
    return path.join(safeRealpath(parent), path.basename(resolved));
  }
}

function collectProjectAndLocalSettingsFiles(
  cwd: string,
  homeDir: string,
  userConfigDir: string,
): string[] {
  const resolvedHome = safeRealpath(homeDir);
  const resolvedUserConfigDir = safeRealpath(userConfigDir);
  const userMainSettings = safeRealpath(path.join(resolvedUserConfigDir, "settings.json"));

  const seen = new Set<string>();
  const files: string[] = [];
  const addIfExists = (candidate: string) => {
    const resolved = safeRealpath(candidate);
    if (resolved === userMainSettings || seen.has(resolved)) return;
    if (fs.existsSync(resolved)) {
      seen.add(resolved);
      files.push(resolved);
    }
  };

  let cur = safeRealpath(cwd);
  while (true) {
    addIfExists(path.join(cur, ".claude", "settings.json"));
    addIfExists(path.join(cur, ".claude", "settings.local.json"));
    if (fs.existsSync(path.join(cur, ".git")) || cur === resolvedHome) {
      break;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  // Also ensure <userConfigDir>/settings.local.json is always checked under strict local rules
  addIfExists(path.join(resolvedUserConfigDir, "settings.local.json"));
  return files;
}

interface ParsedSettingsSnapshot {
  topKeys: Map<string, unknown>;
  envKeys: Map<string, unknown>;
}

function parseSettingsObject(
  raw: string,
  sourceDescription: string,
): { ok: true; snapshot: ParsedSettingsSnapshot } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: `Claude settings ${sourceDescription} contains invalid JSON; refusing to launch without verifying settings.`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `Claude settings ${sourceDescription} must contain a JSON object.`,
    };
  }
  const obj = parsed as Record<string, unknown>;
  const topKeys = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== "") {
      topKeys.set(k, v);
    }
  }
  const envKeys = new Map<string, unknown>();
  if (obj.env !== undefined && obj.env !== null) {
    if (typeof obj.env !== "object" || Array.isArray(obj.env)) {
      return {
        ok: false,
        error: `Claude settings ${sourceDescription} has a non-object "env" field.`,
      };
    }
    for (const [k, v] of Object.entries(obj.env as Record<string, unknown>)) {
      if (v !== undefined && v !== null && v !== "") {
        envKeys.set(k, v);
      }
    }
  }
  return { ok: true, snapshot: { topKeys, envKeys } };
}

function parseSettingsFileSnapshot(
  filePath: string,
): { ok: true; snapshot: ParsedSettingsSnapshot } | { ok: false; error: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return {
      ok: false,
      error: `Cannot read Claude settings file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return parseSettingsObject(raw, `file ${filePath}`);
}

export function hasFlagInArgs(args: readonly string[], flagNames: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--") break;
    for (const flag of flagNames) {
      if (arg === flag || arg.startsWith(`${flag}=`)) return true;
    }
  }
  return false;
}

function extractCallerSettingsSpecs(
  args: readonly string[],
): { ok: true; values: string[] } | { ok: false; error: string } {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg === "--settings") {
      const next = args[i + 1];
      if (next === undefined) {
        return { ok: false, error: "Caller passed '--settings' without a value." };
      }
      values.push(next);
      i++;
      continue;
    }
    if (arg.startsWith("--settings=")) {
      values.push(arg.slice("--settings=".length));
    }
  }
  return { ok: true, values };
}

export function inspectClaudeSettings(opts: ClaudeSettingsInspectionOptions): ClaudeSettingsDiagnostic {
  const cwd = opts.cwd ?? process.cwd();
  const homeDir = opts.homeDir ?? os.homedir();
  const platform = opts.platform ?? process.platform;
  const managedDir = opts.managedDirOverride ?? defaultManagedDir(platform);
  const userConfigDir = resolveClaudeUserConfigDir(homeDir, cwd, opts.parentEnv);
  const forwardedArgs = opts.forwardedArgs ?? [];
  const callerPassedSettingsFlag =
    opts.callerPassedSettingsFlag ?? hasFlagInArgs(forwardedArgs, ["--settings"]);

  const blockingErrors: string[] = [];
  const overriddenWarnings: string[] = [];
  const inspectedFiles: string[] = [];

  const allWatchedTop = [...CLAUDE_CREDENTIAL_AND_ENDPOINT_KEYS.topLevel, ...CLAUDE_MODEL_KEYS.topLevel];
  const allWatchedEnv = [...CLAUDE_CREDENTIAL_AND_ENDPOINT_KEYS.env, ...CLAUDE_MODEL_KEYS.env];

  // 0. Caller-supplied --settings (inline JSON or file path): inspect and refuse on auth/endpoint keys
  const callerSpecs = extractCallerSettingsSpecs(forwardedArgs);
  if (!callerSpecs.ok) {
    blockingErrors.push(callerSpecs.error);
  } else {
    for (const spec of callerSpecs.values) {
      const trimmed = spec.trim();
      let parsedRes: { ok: true; snapshot: ParsedSettingsSnapshot } | { ok: false; error: string };
      let label: string;
      if (trimmed.startsWith("{")) {
        label = "inline --settings JSON";
        parsedRes = parseSettingsObject(trimmed, label);
      } else {
        const resolvedPath = path.resolve(cwd, trimmed);
        label = `--settings file ${resolvedPath}`;
        inspectedFiles.push(resolvedPath);
        parsedRes = parseSettingsFileSnapshot(resolvedPath);
      }
      if (!parsedRes.ok) {
        blockingErrors.push(parsedRes.error);
        continue;
      }
      const hits: string[] = [];
      for (const k of CLAUDE_CREDENTIAL_AND_ENDPOINT_KEYS.topLevel) {
        if (parsedRes.snapshot.topKeys.has(k)) hits.push(k);
      }
      for (const k of CLAUDE_CREDENTIAL_AND_ENDPOINT_KEYS.env) {
        if (parsedRes.snapshot.envKeys.has(k)) hits.push(`env.${k}`);
      }
      if (hits.length > 0) {
        blockingErrors.push(
          `Caller ${label} sets ${hits.join(", ")}, which conflicts with aihub's AI Hub routing/auth.`,
        );
      }
    }
  }

  // 1. Managed settings: highest precedence, cannot be overridden
  for (const filePath of collectManagedFiles(managedDir)) {
    inspectedFiles.push(filePath);
    const res = parseSettingsFileSnapshot(filePath);
    if (!res.ok) {
      blockingErrors.push(res.error);
      continue;
    }
    const hits: string[] = [];
    for (const k of allWatchedTop) {
      if (res.snapshot.topKeys.has(k)) hits.push(k);
    }
    for (const k of allWatchedEnv) {
      if (res.snapshot.envKeys.has(k)) hits.push(`env.${k}`);
    }
    if (hits.length > 0) {
      blockingErrors.push(
        `Managed Claude policy ${filePath} sets ${hits.join(", ")}, which overrides aihub configuration.`,
      );
    }
  }

  // 2. Project / local settings (<cwd> up to enclosing .git root + settings.local.json): refuse auth/endpoint keys
  for (const filePath of collectProjectAndLocalSettingsFiles(cwd, homeDir, userConfigDir)) {
    inspectedFiles.push(filePath);
    const res = parseSettingsFileSnapshot(filePath);
    if (!res.ok) {
      blockingErrors.push(res.error);
      continue;
    }
    const authHits: string[] = [];
    for (const k of CLAUDE_CREDENTIAL_AND_ENDPOINT_KEYS.topLevel) {
      if (res.snapshot.topKeys.has(k)) authHits.push(k);
    }
    for (const k of CLAUDE_CREDENTIAL_AND_ENDPOINT_KEYS.env) {
      if (res.snapshot.envKeys.has(k)) authHits.push(`env.${k}`);
    }
    if (authHits.length > 0) {
      blockingErrors.push(
        `Project/local Claude settings ${filePath} sets ${authHits.join(", ")}; refusing to send your AI Hub key when local settings override auth or base URL.`,
      );
    }

    const modelHits: string[] = [];
    for (const k of CLAUDE_MODEL_KEYS.topLevel) {
      if (res.snapshot.topKeys.has(k)) modelHits.push(k);
    }
    for (const k of CLAUDE_MODEL_KEYS.env) {
      if (res.snapshot.envKeys.has(k)) modelHits.push(`env.${k}`);
    }
    if (modelHits.length > 0) {
      if (callerPassedSettingsFlag) {
        blockingErrors.push(
          `Project Claude settings ${filePath} sets ${modelHits.join(", ")} while custom --settings was passed.`,
        );
      } else {
        overriddenWarnings.push(`${filePath} (${modelHits.join(", ")}) overridden via --settings`);
      }
    }
  }

  // 3. User settings ($CLAUDE_CONFIG_DIR/settings.json or ~/.claude/settings.json): refuse secret/auth helpers; override non-secret via --settings
  const userFile = path.join(userConfigDir, "settings.json");
  if (fs.existsSync(userFile)) {
    inspectedFiles.push(userFile);
    const res = parseSettingsFileSnapshot(userFile);
    if (!res.ok) {
      blockingErrors.push(res.error);
    } else {
      const blockingUserHits: string[] = [];
      const overridableHits: string[] = [];

      for (const k of CLAUDE_CREDENTIAL_AND_ENDPOINT_KEYS.topLevel) {
        if (res.snapshot.topKeys.has(k)) blockingUserHits.push(k);
      }
      for (const k of CLAUDE_MODEL_KEYS.topLevel) {
        if (res.snapshot.topKeys.has(k)) overridableHits.push(k);
      }
      for (const k of [...CLAUDE_CREDENTIAL_AND_ENDPOINT_KEYS.env, ...CLAUDE_MODEL_KEYS.env]) {
        if (!res.snapshot.envKeys.has(k)) continue;
        if (USER_NON_SECRET_OVERRIDABLE_ENV_KEYS.has(k)) {
          overridableHits.push(`env.${k}`);
        } else {
          blockingUserHits.push(`env.${k}`);
        }
      }

      if (blockingUserHits.length > 0) {
        blockingErrors.push(
          `User Claude settings ${userFile} sets credential/provider keys (${blockingUserHits.join(", ")}) that override process env; remove them from ${userFile} to run 'aihub claude'.`,
        );
      }
      if (overridableHits.length > 0) {
        if (callerPassedSettingsFlag) {
          blockingErrors.push(
            `User Claude settings ${userFile} sets ${overridableHits.join(", ")}, and cannot be auto-overridden because --settings was passed in arguments.`,
          );
        } else {
          overriddenWarnings.push(`${userFile} (${overridableHits.join(", ")}) overridden via --settings`);
        }
      }
    }
  }

  return { blockingErrors, overriddenWarnings, inspectedFiles };
}

export interface BuildClaudeInvocationOptions {
  target: TargetEnv;
  apiKey: string;
  model?: string;
  parentEnv?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  managedDirOverride?: string;
  forwardedArgs: readonly string[];
}

export interface ClaudeInvocation {
  args: string[];
  env: NodeJS.ProcessEnv;
  overriddenWarnings: string[];
}

export function buildClaudeInvocation(opts: BuildClaudeInvocationOptions): ClaudeInvocation {
  const callerPassedSettingsFlag = hasFlagInArgs(opts.forwardedArgs, ["--settings"]);
  const callerPassedModelFlag = hasFlagInArgs(opts.forwardedArgs, ["--model"]);

  const diag = inspectClaudeSettings({
    cwd: opts.cwd,
    homeDir: opts.homeDir,
    parentEnv: opts.parentEnv,
    platform: opts.platform,
    managedDirOverride: opts.managedDirOverride,
    forwardedArgs: opts.forwardedArgs,
    callerPassedSettingsFlag,
  });

  if (diag.blockingErrors.length > 0) {
    throw new Error(diag.blockingErrors.join("\n"));
  }

  const explicitModel = opts.model?.trim();
  const roles = explicitModel
    ? {
        sessionModel: explicitModel,
        opus: explicitModel,
        sonnet: explicitModel,
        haiku: explicitModel,
        fable: explicitModel,
        subagent: explicitModel,
      }
    : CLAUDE_DEFAULT_TIERED_ROLES;

  const baseUrl = `${opts.target.apiOrigin}/api`;
  const env: NodeJS.ProcessEnv = { ...(opts.parentEnv ?? process.env) };
  for (const key of UNSET_PARENT_ENV_KEYS) {
    delete env[key];
  }

  env.ANTHROPIC_BASE_URL = baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = opts.apiKey;
  env.ANTHROPIC_API_KEY = "";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  // Defense-in-depth alongside the gateway strip (#2867): omits Claude Code's direct-API billing
  // tag and suppresses future experimental beta headers before upstream routes reject them, at the
  // cost of Claude Code's experimental beta features (such as server-side context management).
  env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";
  env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = roles.opus;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = roles.sonnet;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = roles.haiku;
  env.ANTHROPIC_DEFAULT_FABLE_MODEL = roles.fable;
  env.CLAUDE_CODE_SUBAGENT_MODEL = roles.subagent;

  const nonSecretSettingsOverride = {
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_CUSTOM_HEADERS: "",
      ANTHROPIC_MODEL: "",
      ANTHROPIC_SMALL_FAST_MODEL: "",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
      ANTHROPIC_DEFAULT_OPUS_MODEL: roles.opus,
      ANTHROPIC_DEFAULT_SONNET_MODEL: roles.sonnet,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: roles.haiku,
      ANTHROPIC_DEFAULT_FABLE_MODEL: roles.fable,
      CLAUDE_CODE_SUBAGENT_MODEL: roles.subagent,
    },
  };

  const args: string[] = [];
  if (!callerPassedSettingsFlag) {
    args.push("--settings", JSON.stringify(nonSecretSettingsOverride));
  }
  if (!callerPassedModelFlag) {
    args.push("--model", roles.sessionModel);
  }
  args.push(...opts.forwardedArgs);

  return {
    args,
    env,
    overriddenWarnings: diag.overriddenWarnings,
  };
}
