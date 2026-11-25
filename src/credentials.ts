import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type EnvName = "prod" | "staging";

export interface TargetEnv {
  envName: EnvName;
  apiOrigin: string;
  consoleOrigin: string;
  codexSlot: string;
  isCustomBaseUrl: boolean;
}

export type CredentialSource = "env:BELIVE_TOKENHUB_API_KEY" | "file" | "env:TOKENHUB_API_KEY";

export interface ResolvedCredential {
  key: string;
  source: CredentialSource;
  credentialsPath?: string;
}

export interface CredentialDiagnostic {
  status: "ok" | "missing" | "bad-permissions" | "corrupt-file";
  source?: CredentialSource;
  credentialsPath: string;
  detail: string;
}

export const KEY_SECRET_PREFIX = "sk-tokenhub-";
const VALID_KEY_REGEX = /^sk-tokenhub-[!-~]+$/;
const CONTROL_CHAR_REGEX = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export const BUILTIN_ENVS: Record<"prod", { apiOrigin: string; consoleOrigin: string }> = {
  prod: {
    apiOrigin: "https://tokenhub-api.belive.sg",
    consoleOrigin: "https://aihub.belive.sg",
  },
};

export const DEFAULT_CATALOGUE_MODELS = [
  "anthropic/claude-opus-5-5",
  "anthropic/claude-sonnet-5-5",
  "anthropic/claude-haiku-5-5",
  "anthropic/claude-fable-5-2",
  "openai/gpt-6.1-sol",
  "google/gemini-4-argon",
] as const;

export function assertSupportedPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === "darwin" || platform === "linux") return;
  throw new Error(
    `aihub v1 supports macOS and Linux only (detected platform: ${platform}). On Windows, run inside WSL2 or follow the manual setup guides at https://aihub.belive.sg/docs/coding-agents.`,
  );
}

export function resolveAihubHome(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  const override = env.AIHUB_HOME?.trim();
  if (override) return path.resolve(override);
  return path.join(homeDir, ".aihub");
}

function parseEnvName(raw: string | undefined): EnvName {
  if (!raw || raw === "prod") return "prod";
  if (raw === "staging") return "staging";
  throw new Error(`Invalid environment "${raw}". Expected "prod" or "staging".`);
}

function normalizeOrigin(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid --base-url "${rawUrl}". Expected an http:// or https:// origin.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid --base-url protocol "${parsed.protocol}". Expected http:// or https://.`);
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${cleanPath}`;
}

export function resolveTargetEnv(
  opts: { env?: string; baseUrl?: string },
  env: NodeJS.ProcessEnv = process.env,
): TargetEnv {
  const envName = parseEnvName(opts.env ?? env.AIHUB_ENV?.trim());
  const rawBaseUrl = opts.baseUrl ?? env.AIHUB_BASE_URL?.trim();
  const rawConsoleUrl = env.AIHUB_CONSOLE_URL?.trim();
  const consoleOrigin = rawConsoleUrl ? normalizeOrigin(rawConsoleUrl) : BUILTIN_ENVS.prod.consoleOrigin;

  if (envName === "staging") {
    if (!rawBaseUrl) {
      throw new Error(
        `Environment "staging" requires AIHUB_BASE_URL or --base-url <origin>.`,
      );
    }
    const normalized = normalizeOrigin(rawBaseUrl);
    return {
      envName: "staging",
      apiOrigin: normalized,
      consoleOrigin,
      codexSlot: "staging",
      isCustomBaseUrl: false,
    };
  }

  if (rawBaseUrl) {
    const normalized = normalizeOrigin(rawBaseUrl);
    if (normalized === BUILTIN_ENVS.prod.apiOrigin) {
      return {
        envName: "prod",
        apiOrigin: BUILTIN_ENVS.prod.apiOrigin,
        consoleOrigin,
        codexSlot: "prod",
        isCustomBaseUrl: false,
      };
    }
    const hash8 = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 8);
    return {
      envName: "prod",
      apiOrigin: normalized,
      consoleOrigin,
      codexSlot: `custom-${hash8}`,
      isCustomBaseUrl: true,
    };
  }
  return {
    envName: "prod",
    apiOrigin: BUILTIN_ENVS.prod.apiOrigin,
    consoleOrigin,
    codexSlot: "prod",
    isCustomBaseUrl: false,
  };
}

interface StoredCredentialsFile {
  keys?: Partial<Record<EnvName, string>>;
}

function verifyRegularPrivateFile(credPath: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(credPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Refusing non-regular credential file ${credPath}.`);
  }
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `Credential file ${credPath} has insecure permissions (0${mode.toString(8)}). Fix with: chmod 600 ${credPath}`,
    );
  }
  return true;
}

function readStoredCredentials(
  aihubHome: string,
  opts: { allowCorruptJson: boolean } = { allowCorruptJson: false },
): { path: string; keys: Partial<Record<EnvName, string>>; wasCorrupt: boolean } | null {
  const credPath = path.join(aihubHome, "credentials.json");
  if (!verifyRegularPrivateFile(credPath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(credPath, "utf8"));
  } catch {
    if (opts.allowCorruptJson) {
      return { path: credPath, keys: {}, wasCorrupt: true };
    }
    throw new Error(`Credential file ${credPath} is not valid JSON. Re-run 'aihub setup' to replace it.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (opts.allowCorruptJson) {
      return { path: credPath, keys: {}, wasCorrupt: true };
    }
    throw new Error(`Credential file ${credPath} has an unexpected structure. Re-run 'aihub setup'.`);
  }
  const keysRaw = (parsed as StoredCredentialsFile).keys;
  const keys: Partial<Record<EnvName, string>> = {};
  if (keysRaw && typeof keysRaw === "object" && !Array.isArray(keysRaw)) {
    for (const k of ["prod", "staging"] as const) {
      const val = keysRaw[k];
      if (typeof val === "string" && val.trim().length > 0) {
        keys[k] = val;
      }
    }
  }
  return { path: credPath, keys, wasCorrupt: false };
}

export function validateKeyFormat(raw: string, sourceLabel?: string): string {
  const where = sourceLabel ? ` in ${sourceLabel}` : "";
  const withoutCrLf = raw.replace(/[\r\n]+$/, "");
  if (CONTROL_CHAR_REGEX.test(withoutCrLf)) {
    throw new Error(`API key${where} contains non-printable control characters.`);
  }
  const trimmed = withoutCrLf.trim();
  if (trimmed.length === 0) {
    throw new Error(`API key${where} must not be empty.`);
  }
  if (/\s/.test(trimmed)) {
    throw new Error(`API key${where} must not contain whitespace.`);
  }
  if (!VALID_KEY_REGEX.test(trimmed)) {
    throw new Error(
      `Invalid API key format${where}: BeLive AI Hub workspace inference keys must start with '${KEY_SECRET_PREFIX}' followed by printable ASCII characters.`,
    );
  }
  return trimmed;
}

function writeCredentialsAtomically(credPath: string, keys: Partial<Record<EnvName, string>>): void {
  const tmpPath = `${credPath}.tmp.${process.pid}.${Date.now()}`;
  const payload = JSON.stringify({ keys }, null, 2) + "\n";
  fs.writeFileSync(tmpPath, payload, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, credPath);
  fs.chmodSync(credPath, 0o600);
}

export function saveStoredApiKey(aihubHome: string, envName: EnvName, rawKey: string): string {
  const key = validateKeyFormat(rawKey);
  fs.mkdirSync(aihubHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(aihubHome, 0o700);

  let existing: Partial<Record<EnvName, string>> = {};
  const loaded = readStoredCredentials(aihubHome, { allowCorruptJson: true });
  if (loaded) {
    existing = { ...loaded.keys };
  }
  existing[envName] = key;

  const credPath = path.join(aihubHome, "credentials.json");
  writeCredentialsAtomically(credPath, existing);
  return credPath;
}

export function clearStoredApiKey(aihubHome: string, envName: EnvName): boolean {
  const loaded = readStoredCredentials(aihubHome, { allowCorruptJson: true });
  if (!loaded) return false;
  if (loaded.wasCorrupt) {
    writeCredentialsAtomically(loaded.path, {});
    return true;
  }
  if (!loaded.keys[envName]) return false;
  const nextKeys = { ...loaded.keys };
  delete nextKeys[envName];
  writeCredentialsAtomically(loaded.path, nextKeys);
  return true;
}

export function hasIgnoredNonAihubFallbackKey(env: NodeJS.ProcessEnv = process.env): boolean {
  const fallbackRaw = env.TOKENHUB_API_KEY;
  if (fallbackRaw === undefined) return false;
  const trimmed = fallbackRaw.replace(/[\r\n]+$/, "").trim();
  return trimmed.length > 0 && !trimmed.startsWith(KEY_SECRET_PREFIX);
}

export function resolveApiKey(
  aihubHome: string,
  target: TargetEnv,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCredential | null {
  const primaryRaw = env.BELIVE_TOKENHUB_API_KEY;
  if (primaryRaw !== undefined && primaryRaw.trim().length > 0) {
    return {
      key: validateKeyFormat(primaryRaw, "BELIVE_TOKENHUB_API_KEY"),
      source: "env:BELIVE_TOKENHUB_API_KEY",
    };
  }

  if (!target.isCustomBaseUrl) {
    const stored = readStoredCredentials(aihubHome, { allowCorruptJson: false });
    const fromFile = stored?.keys[target.envName];
    if (fromFile !== undefined) {
      return {
        key: validateKeyFormat(fromFile, stored!.path),
        source: "file",
        credentialsPath: stored!.path,
      };
    }
  }

  const fallbackRaw = env.TOKENHUB_API_KEY;
  if (fallbackRaw !== undefined && fallbackRaw.trim().length > 0) {
    const trimmed = fallbackRaw.replace(/[\r\n]+$/, "").trim();
    if (!trimmed.startsWith(KEY_SECRET_PREFIX)) {
      return null;
    }
    return {
      key: validateKeyFormat(fallbackRaw, "TOKENHUB_API_KEY"),
      source: "env:TOKENHUB_API_KEY",
    };
  }

  return null;
}

export function inspectCredentialState(
  aihubHome: string,
  target: TargetEnv,
  env: NodeJS.ProcessEnv = process.env,
): CredentialDiagnostic {
  const credentialsPath = path.join(aihubHome, "credentials.json");
  try {
    const resolved = resolveApiKey(aihubHome, target, env);
    if (!resolved) {
      const ignoredNote = hasIgnoredNonAihubFallbackKey(env)
        ? ` (ignored TOKENHUB_API_KEY without '${KEY_SECRET_PREFIX}' prefix)`
        : "";
      if (target.isCustomBaseUrl) {
        return {
          status: "missing",
          credentialsPath,
          detail: `custom --base-url requires BELIVE_TOKENHUB_API_KEY in environment${ignoredNote}`,
        };
      }
      return {
        status: "missing",
        credentialsPath,
        detail: `missing${ignoredNote} — run 'aihub setup${target.envName === "staging" ? " --env staging" : ""}' or export BELIVE_TOKENHUB_API_KEY`,
      };
    }
    const detail =
      resolved.source === "file"
        ? `file:${credentialsPath} (0600)`
        : resolved.source === "env:TOKENHUB_API_KEY"
          ? "env:TOKENHUB_API_KEY (fallback; prefer BELIVE_TOKENHUB_API_KEY to avoid Tencent TokenHub clash)"
          : "env:BELIVE_TOKENHUB_API_KEY";
    return {
      status: "ok",
      source: resolved.source,
      credentialsPath,
      detail,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isPerm = /insecure permissions|chmod 600/i.test(message);
    return {
      status: isPerm ? "bad-permissions" : "corrupt-file",
      credentialsPath,
      detail: message,
    };
  }
}
