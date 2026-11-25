import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { TargetEnv } from "../credentials.js";

export const CODEX_DEFAULT_MODEL = "openai/gpt-6.1-sol";
export const CODEX_DEFAULT_EFFORT = "low";
const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

export interface BuildCodexInvocationOptions {
  aihubHome: string;
  target: TargetEnv;
  apiKey: string;
  model?: string;
  effort?: string;
  supportsNoDaemon?: boolean;
  parentEnv?: NodeJS.ProcessEnv;
  forwardedArgs: readonly string[];
}

export function detectCodexSupportsNoDaemon(binPath: string, env: NodeJS.ProcessEnv): boolean {
  const res = spawnSync(binPath, ["--help"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
    encoding: "utf8",
  });
  const text = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  return /(?<![A-Za-z0-9_./-])--no-daemon(?![A-Za-z0-9_./-])/.test(text);
}

export interface CodexInvocation {
  args: string[];
  env: NodeJS.ProcessEnv;
  codexHome: string;
}

function renderManagedCodexHeader(apiOrigin: string): string {
  const baseUrl = `${apiOrigin}/api/v1`;
  return [
    "# Managed by aihub — pass model/effort or ad-hoc overrides via codex -m / -c flags",
    'model_provider = "tokenhub"',
    'web_search = "disabled"',
    "",
    "[model_providers.tokenhub]",
    'name = "AI Hub"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'wire_api = "responses"',
    'http_headers = { Originator = "codex_cli_rs" }',
    "stream_idle_timeout_ms = 300000",
    "",
    "[model_providers.tokenhub.auth]",
    'command = "sh"',
    'args = ["-c", "printf \'%s\' \\"$BELIVE_TOKENHUB_API_KEY\\""]',
  ].join("\n");
}

function extractPreservedCodexTables(existingToml: string): string[] {
  const keptBlocks: string[] = [];
  let currentBlock: string[] | null = null;

  const flush = () => {
    if (!currentBlock) return;
    while (currentBlock.length > 0 && currentBlock[currentBlock.length - 1]!.trim() === "") {
      currentBlock.pop();
    }
    if (currentBlock.length > 0) {
      keptBlocks.push(currentBlock.join("\n"));
    }
    currentBlock = null;
  };

  for (const line of existingToml.split(/\r?\n/)) {
    const headerMatch = /^\s*\[+([^\]\r\n]+)\]+\s*(?:#.*)?$/.exec(line);
    if (headerMatch) {
      flush();
      const tableName = headerMatch[1]!.trim();
      const isManaged =
        tableName === "model_providers.tokenhub" ||
        tableName.startsWith("model_providers.tokenhub.");
      if (!isManaged) {
        currentBlock = [line];
      }
      continue;
    }
    if (currentBlock !== null) {
      currentBlock.push(line);
    }
  }
  flush();
  return keptBlocks;
}

function renderCodexToml(apiOrigin: string, existingToml: string): string {
  const header = renderManagedCodexHeader(apiOrigin);
  const preserved = extractPreservedCodexTables(existingToml);
  if (preserved.length === 0) {
    return `${header}\n`;
  }
  return `${header}\n\n${preserved.join("\n\n")}\n`;
}

function ensureStaticCodexConfig(codexHome: string, apiOrigin: string): void {
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const configPath = path.join(codexHome, "config.toml");
  let current = "";
  try {
    current = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const expected = renderCodexToml(apiOrigin, current);
  if (current === expected) return;
  const tmpPath = `${configPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, expected, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
}

function callerHasModelArg(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === "-m" || arg === "--model" || arg.startsWith("-m=") || arg.startsWith("--model=")) {
      return true;
    }
    if (arg.startsWith("-c=") && arg.includes("model")) return true;
  }
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "--") break;
    if ((args[i] === "-c" || args[i] === "--config") && /^\s*model\s*=/.test(args[i + 1] ?? "")) {
      return true;
    }
  }
  return false;
}

function callerHasEffortArg(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg.startsWith("-c=") || arg.startsWith("--config=")) {
      if (arg.includes("model_reasoning_effort")) return true;
    }
    if ((arg === "-c" || arg === "--config") && (args[i + 1] ?? "").includes("model_reasoning_effort")) {
      return true;
    }
  }
  return false;
}

function callerHasNoDaemon(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === "--no-daemon") return true;
  }
  return false;
}

export function buildCodexInvocation(opts: BuildCodexInvocationOptions): CodexInvocation {
  const effort = opts.effort?.trim() ?? CODEX_DEFAULT_EFFORT;
  if (!VALID_EFFORTS.has(effort)) {
    throw new Error(
      `Invalid --effort "${effort}". Expected one of: low, medium, high, xhigh.`,
    );
  }
  const model = opts.model?.trim() || CODEX_DEFAULT_MODEL;
  const codexHome = path.join(opts.aihubHome, "codex", opts.target.codexSlot);
  ensureStaticCodexConfig(codexHome, opts.target.apiOrigin);

  const env: NodeJS.ProcessEnv = { ...(opts.parentEnv ?? process.env) };
  env.CODEX_HOME = codexHome;
  env.BELIVE_TOKENHUB_API_KEY = opts.apiKey;

  const args: string[] = [];
  if ((opts.supportsNoDaemon ?? true) && !callerHasNoDaemon(opts.forwardedArgs)) {
    args.push("--no-daemon");
  }
  if (!callerHasModelArg(opts.forwardedArgs)) {
    args.push("-m", model);
  }
  if (!callerHasEffortArg(opts.forwardedArgs)) {
    args.push("-c", `model_reasoning_effort="${effort}"`);
  }
  args.push(...opts.forwardedArgs);

  return { args, env, codexHome };
}
