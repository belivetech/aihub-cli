import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSupportedPlatform,
  clearStoredApiKey,
  inspectCredentialState,
  resolveApiKey,
  resolveTargetEnv,
  saveStoredApiKey,
} from "../src/credentials.js";
import { scrubSecrets } from "../src/redact.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aihub-cred-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("platform gate", () => {
  it("accepts darwin and linux and rejects win32 with WSL2 guidance", () => {
    expect(() => assertSupportedPlatform("darwin")).not.toThrow();
    expect(() => assertSupportedPlatform("linux")).not.toThrow();
    expect(() => assertSupportedPlatform("win32")).toThrow(/WSL2/i);
  });
});

describe("target environment resolution", () => {
  it("defaults to prod, supports AIHUB_BASE_URL, and requires a base URL for undocumented staging alias", () => {
    const prod = resolveTargetEnv({}, {});
    expect(prod).toEqual({
      envName: "prod",
      apiOrigin: "https://tokenhub-api.belive.sg",
      consoleOrigin: "https://aihub.belive.sg",
      codexSlot: "prod",
      isCustomBaseUrl: false,
    });

    expect(() => resolveTargetEnv({}, { AIHUB_ENV: "staging" })).toThrow(/AIHUB_BASE_URL/);

    const stgFromEnv = resolveTargetEnv(
      {},
      {
        AIHUB_ENV: "staging",
        AIHUB_BASE_URL: "https://staging.example.test/",
        AIHUB_CONSOLE_URL: "https://console.staging.example.test/",
      },
    );
    expect(stgFromEnv.envName).toBe("staging");
    expect(stgFromEnv.apiOrigin).toBe("https://staging.example.test");
    expect(stgFromEnv.consoleOrigin).toBe("https://console.staging.example.test");
    expect(stgFromEnv.codexSlot).toBe("staging");
    expect(stgFromEnv.isCustomBaseUrl).toBe(false);

    const stgFromFlag = resolveTargetEnv(
      { env: "staging", baseUrl: "https://staging.example.test" },
      { AIHUB_ENV: "prod" },
    );
    expect(stgFromFlag.envName).toBe("staging");
    expect(stgFromFlag.apiOrigin).toBe("https://staging.example.test");

    const envOverride = resolveTargetEnv({}, { AIHUB_BASE_URL: "http://127.0.0.1:8787/" });
    expect(envOverride.envName).toBe("prod");
    expect(envOverride.apiOrigin).toBe("http://127.0.0.1:8787");
    expect(envOverride.isCustomBaseUrl).toBe(true);
    expect(envOverride.codexSlot).toMatch(/^custom-[0-9a-f]{8}$/);
  });

  it("marks arbitrary --base-url as custom while recognizing built-in origins", () => {
    const local = resolveTargetEnv({ baseUrl: "http://127.0.0.1:8787/" }, {});
    expect(local.apiOrigin).toBe("http://127.0.0.1:8787");
    expect(local.isCustomBaseUrl).toBe(true);
    expect(local.codexSlot).toMatch(/^custom-[0-9a-f]{8}$/);

    const builtinProd = resolveTargetEnv({ baseUrl: "https://tokenhub-api.belive.sg/" }, {});
    expect(builtinProd.isCustomBaseUrl).toBe(false);
    expect(builtinProd.envName).toBe("prod");

    expect(() => resolveTargetEnv({ baseUrl: "ftp://example.com" }, {})).toThrow(/http/i);
  });
});

describe("secret scrubbing", () => {
  it("redacts explicit secret values and sk-tokenhub-* tokens", () => {
    const secret = "custom-raw-secret-999";
    const msg = `Failed with ${secret} and sk-tokenhub-abcdef1234567890 in header`;
    const scrubbed = scrubSecrets(msg, [secret]);
    expect(scrubbed).not.toContain(secret);
    expect(scrubbed).not.toContain("sk-tokenhub-abcdef1234567890");
    expect(scrubbed).toContain("[REDACTED]");
  });
});

describe("credential storage and precedence", () => {
  it("writes 0600 credentials inside 0700 AIHUB_HOME and clears per env", () => {
    const aihubHome = path.join(makeTempDir(), ".aihub");
    saveStoredApiKey(aihubHome, "prod", "sk-tokenhub-prod-111");
    saveStoredApiKey(aihubHome, "staging", "sk-tokenhub-stg-222");

    const dirMode = fs.statSync(aihubHome).mode & 0o777;
    const fileMode = fs.statSync(path.join(aihubHome, "credentials.json")).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);

    const prodTarget = resolveTargetEnv({ env: "prod" }, {});
    expect(resolveApiKey(aihubHome, prodTarget, {})).toEqual({
      key: "sk-tokenhub-prod-111",
      source: "file",
      credentialsPath: path.join(aihubHome, "credentials.json"),
    });

    const cleared = clearStoredApiKey(aihubHome, "prod");
    expect(cleared).toBe(true);
    expect(resolveApiKey(aihubHome, prodTarget, {})).toBeNull();

    const stgTarget = resolveTargetEnv(
      { env: "staging" },
      { AIHUB_BASE_URL: "https://staging.example.test" },
    );
    expect(resolveApiKey(aihubHome, stgTarget, {})?.key).toBe("sk-tokenhub-stg-222");
  });

  it("enforces BELIVE_TOKENHUB_API_KEY > 0600 file > fallback TOKENHUB_API_KEY to avoid Tencent clash", () => {
    const aihubHome = path.join(makeTempDir(), ".aihub");
    saveStoredApiKey(aihubHome, "prod", "sk-tokenhub-stored-belive");
    const target = resolveTargetEnv({ env: "prod" }, {});

    // Stored BeLive key beats a Tencent TOKENHUB_API_KEY in shell env
    const vsTencent = resolveApiKey(aihubHome, target, {
      TOKENHUB_API_KEY: "sk-tencent-other-service",
    });
    expect(vsTencent?.key).toBe("sk-tokenhub-stored-belive");
    expect(vsTencent?.source).toBe("file");

    // Explicit BELIVE_TOKENHUB_API_KEY beats stored file and TOKENHUB_API_KEY
    const explicitBelive = resolveApiKey(aihubHome, target, {
      BELIVE_TOKENHUB_API_KEY: "sk-tokenhub-env-override",
      TOKENHUB_API_KEY: "sk-tencent-other-service",
    });
    expect(explicitBelive?.key).toBe("sk-tokenhub-env-override");
    expect(explicitBelive?.source).toBe("env:BELIVE_TOKENHUB_API_KEY");

    // Fallback TOKENHUB_API_KEY works when neither BELIVE_TOKENHUB_API_KEY nor stored key exists
    clearStoredApiKey(aihubHome, "prod");
    const fallback = resolveApiKey(aihubHome, target, {
      TOKENHUB_API_KEY: "sk-tokenhub-legacy-env",
    });
    expect(fallback?.key).toBe("sk-tokenhub-legacy-env");
    expect(fallback?.source).toBe("env:TOKENHUB_API_KEY");
  });

  it("refuses group/world-readable credentials.json with chmod 600 guidance", () => {
    const aihubHome = path.join(makeTempDir(), ".aihub");
    saveStoredApiKey(aihubHome, "prod", "sk-tokenhub-prod-111");
    const credPath = path.join(aihubHome, "credentials.json");
    fs.chmodSync(credPath, 0o644);

    const target = resolveTargetEnv({ env: "prod" }, {});
    expect(() => resolveApiKey(aihubHome, target, {})).toThrow(/chmod 600/);
  });

  it("never sends stored credentials.json to a custom --base-url", () => {
    const aihubHome = path.join(makeTempDir(), ".aihub");
    saveStoredApiKey(aihubHome, "prod", "sk-tokenhub-prod-111");
    const customTarget = resolveTargetEnv({ baseUrl: "http://127.0.0.1:8787" }, {});

    expect(resolveApiKey(aihubHome, customTarget, {})).toBeNull();
    expect(
      resolveApiKey(aihubHome, customTarget, { BELIVE_TOKENHUB_API_KEY: "sk-tokenhub-dev-local" })?.key,
    ).toBe("sk-tokenhub-dev-local");
  });

  it("rejects empty, whitespace, control characters, or non-sk-tokenhub- keys across setup and env vars", () => {
    const aihubHome = path.join(makeTempDir(), ".aihub");
    const target = resolveTargetEnv({ env: "prod" }, {});

    expect(() => saveStoredApiKey(aihubHome, "prod", "   ")).toThrow(/empty/i);
    expect(() => saveStoredApiKey(aihubHome, "prod", "sk-tokenhub-a b")).toThrow(/whitespace/i);
    expect(() => saveStoredApiKey(aihubHome, "prod", "sk-tokenhub-abc\x04def")).toThrow(
      /control|printable|sk-tokenhub-/i,
    );
    expect(() => saveStoredApiKey(aihubHome, "prod", "sk-tokenhub-")).toThrow(/sk-tokenhub-/i);
    expect(() => saveStoredApiKey(aihubHome, "prod", "some-other-vendor-key")).toThrow(
      /sk-tokenhub-/i,
    );

    // Fallback TOKENHUB_API_KEY without sk-tokenhub- prefix (e.g. Tencent) is ignored cleanly rather than throwing format error
    expect(
      resolveApiKey(aihubHome, target, { TOKENHUB_API_KEY: "some-other-vendor-key" }),
    ).toBeNull();
    const diag = inspectCredentialState(aihubHome, target, {
      TOKENHUB_API_KEY: "some-other-vendor-key",
    });
    expect(diag.status).toBe("missing");
    expect(diag.detail).toMatch(/ignored TOKENHUB_API_KEY/i);
    expect(diag.detail).not.toContain("some-other-vendor-key");

    // Malformed sk-tokenhub- key in fallback OR non-sk-tokenhub- in explicit BELIVE_TOKENHUB_API_KEY still throws
    expect(() =>
      resolveApiKey(aihubHome, target, { TOKENHUB_API_KEY: "sk-tokenhub-bad\x04char" }),
    ).toThrow(/control/i);
    expect(() =>
      resolveApiKey(aihubHome, target, { BELIVE_TOKENHUB_API_KEY: "sk-other-vendor" }),
    ).toThrow(/sk-tokenhub-/i);
  });

  it("repairs a corrupt 0600 credentials.json on saveStoredApiKey and clearStoredApiKey while still refusing 0644", () => {
    const aihubHome = path.join(makeTempDir(), ".aihub");
    fs.mkdirSync(aihubHome, { recursive: true, mode: 0o700 });
    const credPath = path.join(aihubHome, "credentials.json");
    fs.writeFileSync(credPath, "{ corrupt json", { mode: 0o600 });

    // 0644 corrupt file is still refused on permissions
    fs.chmodSync(credPath, 0o644);
    expect(() => saveStoredApiKey(aihubHome, "prod", "sk-tokenhub-repaired-111")).toThrow(
      /chmod 600/,
    );

    // 0600 corrupt file is replaced cleanly by saveStoredApiKey
    fs.chmodSync(credPath, 0o600);
    saveStoredApiKey(aihubHome, "prod", "sk-tokenhub-repaired-111");
    expect(resolveApiKey(aihubHome, resolveTargetEnv({}, {}), {})?.key).toBe(
      "sk-tokenhub-repaired-111",
    );

    // 0600 corrupt file is also repaired cleanly by clearStoredApiKey
    fs.writeFileSync(credPath, "not-json", { mode: 0o600 });
    fs.chmodSync(credPath, 0o600);
    expect(() => clearStoredApiKey(aihubHome, "prod")).not.toThrow();
    expect(resolveApiKey(aihubHome, resolveTargetEnv({}, {}), {})).toBeNull();
  });
});
