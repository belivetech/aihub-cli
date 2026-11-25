import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { TargetEnv } from "../credentials.js";

export const DSH_DEFAULT_MODEL = "qwen/qwen3.8-flash";
export const DSH_DEFAULT_PROFILE = "tui";

const DSH_KNOWN_PROFILES = new Set(["tui", "web", "headless", "acp", "plugin"]);
const DSH_BUILTIN_MODELS = new Set([
  "qwen/qwen3.8-flash",
  "qwen/qwen3.8-max",
  "deepseek/deepseek-v4.1-flash-1017",
  "deepseek/deepseek-v4-pro",
]);

export interface BuildDshInvocationOptions {
  aihubHome: string;
  target: TargetEnv;
  apiKey: string;
  model?: string;
  effort?: string;
  parentEnv?: NodeJS.ProcessEnv;
  forwardedArgs: readonly string[];
}

export interface DshInvocation {
  args: string[];
  env: NodeJS.ProcessEnv;
  dshHome: string;
  patchPath?: string;
  cleanup: () => void;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function renderStaticCordisPatch(apiOrigin: string): string {
  const baseUrl = `${apiOrigin}/api/v1`;
  return [
    "# Managed by aihub — pass --model / --effort or dsh --patch <file> for per-session overrides",
    "- id: llm-pi-ai",
    "  config:",
    "    providers:",
    "      belive-aihub:",
    "        displayName: BeLive AI Hub",
    "        apiKeyEnv: BELIVE_TOKENHUB_API_KEY",
    "        api: openai-completions",
    `        baseURL: ${yamlString(baseUrl)}`,
    "        compat:",
    "          supportsDeveloperRole: false",
    "        models:",
    "          - id: qwen/qwen3.8-flash",
    "            name: Qwen3.8 Flash",
    "            contextWindow: 1000000",
    "            maxTokens: 32768",
    "            input: [text, image]",
    "            compat:",
    "              thinkingFormat: qwen",
    "              supportsReasoningEffort: false",
    "            reasoningEfforts:",
    "              high: high",
    "              off:",
    "          - id: qwen/qwen3.8-max",
    "            name: Qwen3.8 Max",
    "            contextWindow: 1000000",
    "            maxTokens: 32768",
    "            input: [text, image]",
    "            compat:",
    "              thinkingFormat: qwen",
    "              supportsReasoningEffort: false",
    "            reasoningEfforts:",
    "              high: high",
    "              off:",
    "          - id: deepseek/deepseek-v4.1-flash-1017",
    "            name: DeepSeek V4.1 Flash",
    "            contextWindow: 1024000",
    "            maxTokens: 32768",
    "            input: [text, image]",
    "            reasoningEfforts:",
    "              minimal: minimal",
    "              low: low",
    "              medium: medium",
    "              high: high",
    "              xhigh: xhigh",
    "              max: max",
    "              off: none",
    "          - id: deepseek/deepseek-v4-pro",
    "            name: DeepSeek V4 Pro",
    "            contextWindow: 1000000",
    "            maxTokens: 32768",
    "            input: [text]",
    "",
    "- id: agent-default-model",
    "  config:",
    "    provider: belive-aihub",
    `    model: ${DSH_DEFAULT_MODEL}`,
    "    reasoningEffort: high",
    "",
  ].join("\n");
}

function renderSessionOverridePatch(model: string, effort?: string): string {
  const lines: string[] = [];
  if (!DSH_BUILTIN_MODELS.has(model)) {
    lines.push(
      "- id: llm-pi-ai",
      "  config:",
      "    providers:",
      "      belive-aihub:",
      "        models:",
      `          - id: ${yamlString(model)}`,
      `            name: ${yamlString(model)}`,
      "            contextWindow: 1000000",
      "            maxTokens: 32768",
      "            input: [text, image]",
      "",
    );
  }
  lines.push(
    "- id: agent-default-model",
    "  config:",
    "    provider: belive-aihub",
    `    model: ${yamlString(model)}`,
  );
  if (effort !== undefined) {
    lines.push(`    reasoningEffort: ${yamlString(effort)}`);
  }
  lines.push("");
  return lines.join("\n");
}

function ensureStaticDshConfig(dshHome: string, apiOrigin: string): void {
  fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
  const patchPath = path.join(dshHome, "cordis.patch.yml");
  const expected = renderStaticCordisPatch(apiOrigin);
  let current = "";
  try {
    current = fs.readFileSync(patchPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (current === expected) return;
  const tmpPath = `${patchPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, expected, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmpPath, patchPath);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sweepDeadDshSessionPatches(baseDir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = /^pid-(\d+)-/.exec(entry.name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 0 || isProcessAlive(pid)) continue;
    try {
      fs.rmSync(path.join(baseDir, entry.name), { recursive: true, force: true });
    } catch {
      // best-effort sweep of dead-PID dirs
    }
  }
}

function isDirectHelpOrVersion(args: readonly string[]): boolean {
  const first = args[0];
  return first === "-V" || first === "--version" || first === "-h" || first === "--help";
}

function buildDshArgs(forwardedArgs: readonly string[], overridePatchPath?: string): string[] {
  if (isDirectHelpOrVersion(forwardedArgs)) {
    return [...forwardedArgs];
  }
  const first = forwardedArgs[0];
  const hasExplicitProfile =
    first !== undefined &&
    (DSH_KNOWN_PROFILES.has(first) || first === "--profile" || first.startsWith("--profile="));

  if (!overridePatchPath) {
    return hasExplicitProfile ? [...forwardedArgs] : [DSH_DEFAULT_PROFILE, ...forwardedArgs];
  }

  if (!hasExplicitProfile) {
    return [DSH_DEFAULT_PROFILE, "--patch", overridePatchPath, ...forwardedArgs];
  }

  if (first === "--profile" && forwardedArgs.length >= 2) {
    return [
      forwardedArgs[0]!,
      forwardedArgs[1]!,
      "--patch",
      overridePatchPath,
      ...forwardedArgs.slice(2),
    ];
  }

  if (first === "plugin") {
    return [...forwardedArgs];
  }

  return [first!, "--patch", overridePatchPath, ...forwardedArgs.slice(1)];
}

export function buildDshInvocation(opts: BuildDshInvocationOptions): DshInvocation {
  const dshHome = path.join(opts.aihubHome, "dsh", opts.target.codexSlot);
  ensureStaticDshConfig(dshHome, opts.target.apiOrigin);

  const env: NodeJS.ProcessEnv = { ...(opts.parentEnv ?? process.env) };
  env.DSH_HOME = dshHome;
  env.BELIVE_TOKENHUB_API_KEY = opts.apiKey;
  // Never pass DEEPSEEK_API_KEY: DeepSeek Harness mounts dsh-web-search-deepseek
  // and sends that key directly to api.deepseek.com when set.
  delete env.DEEPSEEK_API_KEY;
  delete env.DEEPSEEK_BASE_URL;

  const model = opts.model?.trim();
  const effort = opts.effort?.trim();
  let patchPath: string | undefined;
  let sessionDir: string | undefined;

  if (model || effort) {
    const baseDir = path.join(opts.aihubHome, "dsh-session-patches");
    fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    sweepDeadDshSessionPatches(baseDir);
    const rand = crypto.randomBytes(4).toString("hex");
    sessionDir = path.join(baseDir, `pid-${process.pid}-${rand}`);
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    patchPath = path.join(sessionDir, "override.patch.yml");
    fs.writeFileSync(
      patchPath,
      renderSessionOverridePatch(model || DSH_DEFAULT_MODEL, effort),
      { encoding: "utf8", mode: 0o600 },
    );
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned || !sessionDir) return;
    cleaned = true;
    fs.rmSync(sessionDir, { recursive: true, force: true });
  };

  return {
    args: buildDshArgs(opts.forwardedArgs, patchPath),
    env,
    dshHome,
    patchPath,
    cleanup,
  };
}
