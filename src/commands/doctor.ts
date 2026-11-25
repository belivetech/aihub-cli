import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AGY_DEFAULT_WIRE_MODEL, checkAgySupport } from "../adapters/agy.js";
import { CLAUDE_DEFAULT_TIERED_ROLES, inspectClaudeSettings } from "../adapters/claude.js";
import { CODEX_DEFAULT_MODEL } from "../adapters/codex.js";
import {
  DEFAULT_CATALOGUE_MODELS,
  inspectCredentialState,
  resolveApiKey,
  type TargetEnv,
} from "../credentials.js";
import { scrubSecrets } from "../redact.js";

export interface RunDoctorOptions {
  aihubHome: string;
  homeDir?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  managedDirOverride?: string;
  target: TargetEnv;
  env?: NodeJS.ProcessEnv;
  smoke: boolean;
  writeOut?: (text: string) => void;
}

export function resolveBinaryOnPath(binName: string, pathEnv: string | undefined): string | null {
  if (!pathEnv) return null;
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binName);
    try {
      const st = fs.statSync(candidate);
      if (st.isFile() && (st.mode & 0o111) !== 0) {
        return candidate;
      }
    } catch {
      // ignore missing
    }
  }
  return null;
}

const WATCHED_PARENT_SHELL_VARS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
] as const;

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

function parseSemver(versionText: string): ParsedSemver | null {
  const m =
    /(?:^|(?<=[\s(:=/vV]))(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?(?=$|[\s),])/.exec(
      versionText,
    );
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

function isSemverLess(a: ParsedSemver, floor: [number, number, number]): boolean {
  if (a.major !== floor[0]) return a.major < floor[0];
  if (a.minor !== floor[1]) return a.minor < floor[1];
  if (a.patch !== floor[2]) return a.patch < floor[2];
  return a.prerelease !== null;
}

function readBinaryVersion(binPath: string, env: NodeJS.ProcessEnv): string {
  const r = spawnSync(binPath, ["--version"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
    encoding: "utf8",
  });
  const firstLine = (r.stdout || r.stderr || "").trim().split(/\r?\n/)[0]?.trim();
  return firstLine || "installed";
}

interface CatalogueModelEntry {
  id?: unknown;
  retiring_on?: unknown;
  replacement?: unknown;
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 10000,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

export async function runDoctor(opts: RunDoctorOptions): Promise<number> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const rawWrite = opts.writeOut ?? ((text: string) => process.stdout.write(text));

  let resolvedKeyValue = "";
  try {
    resolvedKeyValue = resolveApiKey(opts.aihubHome, opts.target, env)?.key ?? "";
  } catch {
    resolvedKeyValue = "";
  }
  const extraSecrets = [
    resolvedKeyValue,
    env.BELIVE_TOKENHUB_API_KEY ?? "",
    env.TOKENHUB_API_KEY ?? "",
  ].filter(Boolean);
  const write = (line: string) => rawWrite(scrubSecrets(line, extraSecrets));

  let hardFailures = 0;

  // 1. Environment & platform
  const platformSupported = platform === "darwin" || platform === "linux";
  write(
    `[${platformSupported ? "OK" : "FAIL"}] platform: ${platform}, target=${opts.target.isCustomBaseUrl ? `custom (${opts.target.apiOrigin})` : `${opts.target.envName} (${opts.target.apiOrigin})`}\n`,
  );
  if (!platformSupported) hardFailures++;

  // 2. Credential source & hygiene
  const credDiag = inspectCredentialState(opts.aihubHome, opts.target, env);
  if (credDiag.status === "ok") {
    write(`[OK] credential: ${credDiag.detail}\n`);
  } else {
    write(`[FAIL] credential: ${credDiag.detail}\n`);
    hardFailures++;
  }

  // 3. Installed binaries, version floors, parent shell env, & Claude settings preflight
  const versionSpecs: Array<{
    bin: "claude" | "codex";
    label: string;
    warnBelow: [number, number, number];
    warnReason: string;
  }> = [
    {
      bin: "claude",
      label: "claude",
      warnBelow: [2, 1, 290],
      warnReason:
        "older than Anthropic's minimum for Fable 5.2 (2.1.290; Opus 5.5 is 2.1.280; older versions still work via AI Hub's gateway strip)",
    },
    {
      bin: "codex",
      label: "codex",
      warnBelow: [0, 144, 0],
      warnReason: "older than minimum tested 0.144.0",
    },
  ];

  for (const spec of versionSpecs) {
    const found = resolveBinaryOnPath(spec.bin, env.PATH);
    if (!found) {
      write(`[WARN] binary ${spec.label}: not found on PATH\n`);
      continue;
    }
    const verStr = readBinaryVersion(found, env);
    const parsedVer = parseSemver(verStr);
    if (parsedVer && isSemverLess(parsedVer, spec.warnBelow)) {
      write(`[WARN] binary ${spec.label}: ${verStr} (${found}) — ${spec.warnReason}\n`);
    } else {
      write(`[OK] binary ${spec.label}: ${verStr} (${found})\n`);
    }
  }

  const agyFound = resolveBinaryOnPath("agy", env.PATH);
  if (!agyFound) {
    write("[WARN] binary agy: not found on PATH\n");
  } else {
    const agySupport = checkAgySupport(agyFound, env);
    if (!agySupport.supported) {
      if (agySupport.probeFailed) {
        write(
          `[FAIL] binary agy: (${agyFound}) — probe failed (${agySupport.detail ?? "error"}; retry once if macOS is verifying a newly updated binary)\n`,
        );
      } else {
        const detailPrefix = agySupport.detail ? `${agySupport.detail}; ` : "";
        write(
          `[FAIL] binary agy: ${agySupport.version} (${agyFound}) — unsupported (${detailPrefix}'aihub agy' requires >= 1.5.0; run 'agy update')\n`,
        );
      }
      hardFailures++;
    } else {
      write(`[OK] binary agy: ${agySupport.version} (${agyFound})\n`);
    }
  }

  const exportedShellVars = WATCHED_PARENT_SHELL_VARS.filter((k) => {
    const v = env[k];
    return v !== undefined && v.trim().length > 0;
  });
  if (exportedShellVars.length > 0) {
    write(
      `[INFO] parent shell env: ${exportedShellVars.join(", ")} exported in shell (overridden cleanly inside aihub launches)\n`,
    );
  }

  const claudeDiag = inspectClaudeSettings({
    cwd: opts.cwd,
    homeDir: opts.homeDir,
    parentEnv: env,
    platform,
    managedDirOverride: opts.managedDirOverride,
    callerPassedSettingsFlag: false,
  });
  if (claudeDiag.blockingErrors.length > 0) {
    for (const err of claudeDiag.blockingErrors) {
      write(`[FAIL] claude settings: ${err}\n`);
      hardFailures++;
    }
  } else if (claudeDiag.overriddenWarnings.length > 0) {
    for (const w of claudeDiag.overriddenWarnings) {
      write(`[INFO] claude settings: ${w}\n`);
    }
  } else {
    write(`[OK] claude settings: no conflicting overrides detected (note: MDM/server policy is not locally inspectable)\n`);
  }

  // 4. Unauthenticated discovery + retirement checks
  try {
    const v1 = await fetchJsonWithTimeout(`${opts.target.apiOrigin}/api/v1/models`, { method: "GET" });
    const list =
      v1.body && typeof v1.body === "object" && Array.isArray((v1.body as { data?: unknown }).data)
        ? ((v1.body as { data: CatalogueModelEntry[] }).data)
        : null;
    if (v1.status !== 200 || !list) {
      write(`[FAIL] discovery GET /api/v1/models: HTTP ${v1.status}\n`);
      hardFailures++;
    } else {
      write(`[OK] discovery GET /api/v1/models: HTTP 200 (${list.length} models)\n`);
      const byId = new Map<string, CatalogueModelEntry>();
      for (const item of list) {
        if (item && typeof item.id === "string") {
          byId.set(item.id, item);
        }
      }
      for (const defaultId of DEFAULT_CATALOGUE_MODELS) {
        const entry = byId.get(defaultId);
        if (!entry) {
          write(`[WARN] default model missing from catalogue: ${defaultId}\n`);
          continue;
        }
        if (typeof entry.retiring_on === "string" && entry.retiring_on.length > 0) {
          const repl =
            typeof entry.replacement === "string" && entry.replacement.length > 0
              ? ` -> replacement: ${entry.replacement}`
              : "";
          write(`[WARN] default model retiring: ${defaultId} (retiring_on=${entry.retiring_on}${repl})\n`);
        }
      }
    }
  } catch (err) {
    write(
      `[FAIL] discovery GET /api/v1/models: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    hardFailures++;
  }

  try {
    const codexDisc = await fetchJsonWithTimeout(
      `${opts.target.apiOrigin}/api/v1/models?client_version=0.166.0`,
      { method: "GET", headers: { Originator: "codex_cli_rs" } },
    );
    const models =
      codexDisc.body &&
      typeof codexDisc.body === "object" &&
      Array.isArray((codexDisc.body as { models?: unknown }).models)
        ? (codexDisc.body as { models: unknown[] }).models
        : null;
    if (codexDisc.status !== 200 || !models || models.length === 0) {
      write(`[FAIL] discovery Codex /api/v1/models: HTTP ${codexDisc.status}\n`);
      hardFailures++;
    } else {
      write(`[OK] discovery Codex /api/v1/models: HTTP 200 (${models.length} models)\n`);
    }
  } catch (err) {
    write(
      `[FAIL] discovery Codex /api/v1/models: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    hardFailures++;
  }

  try {
    const gemDisc = await fetchJsonWithTimeout(
      `${opts.target.apiOrigin}/api/v1beta/models?pageSize=5`,
      { method: "GET" },
    );
    const models =
      gemDisc.body &&
      typeof gemDisc.body === "object" &&
      Array.isArray((gemDisc.body as { models?: unknown }).models)
        ? (gemDisc.body as { models: unknown[] }).models
        : null;
    if (gemDisc.status !== 200 || !models || models.length === 0) {
      write(`[FAIL] discovery Gemini /api/v1beta/models: HTTP ${gemDisc.status}\n`);
      hardFailures++;
    } else {
      write(`[OK] discovery Gemini /api/v1beta/models: HTTP 200 (${models.length} models)\n`);
    }
  } catch (err) {
    write(
      `[FAIL] discovery Gemini /api/v1beta/models: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    hardFailures++;
  }

  // 5. Optional paid smoke check (--smoke)
  if (opts.smoke) {
    if (!resolvedKeyValue) {
      write(`[FAIL] smoke: cannot run --smoke without a resolved API key\n`);
      hardFailures++;
    } else {
      const checks: Array<{ name: string; url: string; init: RequestInit }> = [
        {
          name: `POST /api/v1/messages (${CLAUDE_DEFAULT_TIERED_ROLES.sessionModel})`,
          url: `${opts.target.apiOrigin}/api/v1/messages`,
          init: {
            method: "POST",
            headers: {
              authorization: `Bearer ${resolvedKeyValue}`,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: CLAUDE_DEFAULT_TIERED_ROLES.sessionModel,
              max_tokens: 1,
              messages: [{ role: "user", content: "OK" }],
            }),
          },
        },
        {
          name: `POST /api/v1/responses (${CODEX_DEFAULT_MODEL})`,
          url: `${opts.target.apiOrigin}/api/v1/responses`,
          init: {
            method: "POST",
            headers: {
              authorization: `Bearer ${resolvedKeyValue}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: CODEX_DEFAULT_MODEL,
              input: "OK",
              reasoning: { effort: "low" },
              max_output_tokens: 16,
            }),
          },
        },
        {
          name: `POST /api/v1beta/models/${AGY_DEFAULT_WIRE_MODEL}:generateContent`,
          url: `${opts.target.apiOrigin}/api/v1beta/models/${AGY_DEFAULT_WIRE_MODEL}:generateContent`,
          init: {
            method: "POST",
            headers: {
              "x-goog-api-key": resolvedKeyValue,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: "OK" }] }],
              generationConfig: { maxOutputTokens: 32, thinkingConfig: { thinkingLevel: "LOW" } },
            }),
          },
        },
      ];

      for (const check of checks) {
        try {
          const r = await fetchJsonWithTimeout(check.url, check.init, 25000);
          if (r.status === 200) {
            write(`[OK] smoke ${check.name}: HTTP 200\n`);
          } else {
            write(`[FAIL] smoke ${check.name}: HTTP ${r.status}\n`);
            hardFailures++;
          }
        } catch (err) {
          write(
            `[FAIL] smoke ${check.name}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          hardFailures++;
        }
      }
    }
  }

  return hardFailures === 0 ? 0 : 1;
}
