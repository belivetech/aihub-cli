import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CATALOGUE_MODELS, resolveTargetEnv } from "../src/credentials.js";
import { runDoctor } from "../src/commands/doctor.js";
import { runSetup } from "../src/commands/setup.js";

const tempDirs: string[] = [];
const servers: http.Server[] = [];

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aihub-doc-test-"));
  tempDirs.push(root);
  const homeDir = path.join(root, "home");
  const aihubHome = path.join(homeDir, ".aihub");
  const managedDir = path.join(root, "managed");
  const cwd = path.join(root, "proj");
  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  fs.mkdirSync(managedDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return { root, homeDir, aihubHome, managedDir, cwd };
}

async function startTestGateway(opts?: {
  retiringModel?: { id: string; retiring_on: string; replacement: string };
  omitModel?: string;
  failSmokeStatus?: number;
}) {
  const requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const srv = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: req.headers,
      body,
    });

    if (req.method === "GET" && req.url === "/api/v1/models") {
      const data = DEFAULT_CATALOGUE_MODELS.filter((id) => id !== opts?.omitModel).map((id) => ({
        id,
        retiring_on: opts?.retiringModel?.id === id ? opts.retiringModel.retiring_on : null,
        replacement: opts?.retiringModel?.id === id ? opts.retiringModel.replacement : null,
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data }));
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/api/v1/models?client_version=")) {
      if (req.headers.originator !== "codex_cli_rs") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing Originator header" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ slug: "openai/gpt-6.1-sol" }] }));
      return;
    }

    if (req.method === "GET" && req.url === "/api/v1beta/models?pageSize=5") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "models/google/gemini-4-argon" }] }));
      return;
    }

    if (req.method === "POST") {
      const status = opts?.failSmokeStatus ?? 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status === 200 ? { ok: true } : { error: { message: "forbidden" } }));
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  servers.push(srv);
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { origin: `http://127.0.0.1:${port}`, requests };
}

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop()!;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("aihub setup", () => {
  it("saves key from stdin with 0600 mode, prints allowlist IDs, opens console with --open, and never prints the secret", async () => {
    const sb = makeSandbox();
    const secret = "sk-tokenhub-setup-secret-777";
    const out: string[] = [];
    const opened: string[] = [];

    const code = await runSetup({
      aihubHome: sb.aihubHome,
      target: resolveTargetEnv({ env: "prod" }, {}),
      openBrowser: true,
      clear: false,
      stdin: Readable.from([`${secret}\n`]),
      isTTY: false,
      writeOut: (s) => out.push(s),
      openUrl: (u) => opened.push(u),
    });

    expect(code).toBe(0);
    expect(opened).toEqual(["https://aihub.belive.sg/dashboard/keys"]);
    const fullOutput = out.join("");
    expect(fullOutput).not.toContain(secret);
    expect(fullOutput).toContain("BELIVE_TOKENHUB_API_KEY");
    for (const modelId of DEFAULT_CATALOGUE_MODELS) {
      expect(fullOutput).toContain(modelId);
    }

    const clearOut: string[] = [];
    const clearCode = await runSetup({
      aihubHome: sb.aihubHome,
      target: resolveTargetEnv({ env: "prod" }, {}),
      openBrowser: false,
      clear: true,
      stdin: Readable.from([]),
      isTTY: false,
      writeOut: (s) => clearOut.push(s),
    });
    expect(clearCode).toBe(0);
    expect(clearOut.join("")).toMatch(/removed|cleared/i);
  });
});

describe("aihub doctor", () => {
  it("passes discovery, reports retirement/missing-model warnings, executes --smoke on default wire models, and never prints secret", async () => {
    const sb = makeSandbox();
    const secret = "sk-tokenhub-doctor-secret-888";
    const gw = await startTestGateway({
      retiringModel: {
        id: "openai/gpt-6.1-sol",
        retiring_on: "2026-12-31",
        replacement: "openai/gpt-6.3-sol",
      },
      omitModel: "anthropic/claude-fable-5-2",
    });

    const lines: string[] = [];
    const code = await runDoctor({
      aihubHome: sb.aihubHome,
      homeDir: sb.homeDir,
      cwd: sb.cwd,
      managedDirOverride: sb.managedDir,
      target: resolveTargetEnv({ baseUrl: gw.origin }, {}),
      env: {
        PATH: process.env.PATH,
        BELIVE_TOKENHUB_API_KEY: secret,
        ANTHROPIC_BASE_URL: "https://parent-shell-override.example",
      },
      smoke: true,
      writeOut: (s) => lines.push(s),
    });

    const report = lines.join("");
    expect(code).toBe(0);
    expect(report).not.toContain(secret);
    expect(report).not.toContain("parent-shell-override.example");
    expect(report).toContain("ANTHROPIC_BASE_URL");
    expect(report).toContain("env:BELIVE_TOKENHUB_API_KEY");
    expect(report).toContain("2026-12-31");
    expect(report).toContain("openai/gpt-6.3-sol");
    expect(report).toContain("anthropic/claude-fable-5-2");

    const posts = gw.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(3);

    const msgReq = posts.find((r) => r.url === "/api/v1/messages")!;
    expect(msgReq.headers.authorization).toBe(`Bearer ${secret}`);
    expect(JSON.parse(msgReq.body)).toMatchObject({
      model: "anthropic/claude-opus-5-5",
      max_tokens: 1,
    });

    const respReq = posts.find((r) => r.url === "/api/v1/responses")!;
    expect(respReq.headers.authorization).toBe(`Bearer ${secret}`);
    expect(JSON.parse(respReq.body)).toMatchObject({
      model: "openai/gpt-6.1-sol",
      max_output_tokens: 16,
      reasoning: { effort: "low" },
    });

    const gemReq = posts.find((r) => r.url === "/api/v1beta/models/google/gemini-4-argon:generateContent")!;
    expect(gemReq.headers["x-goog-api-key"]).toBe(secret);
    expect(gemReq.url).not.toContain("key=");
    expect(JSON.parse(gemReq.body)).toMatchObject({
      generationConfig: { maxOutputTokens: 32, thinkingConfig: { thinkingLevel: "LOW" } },
    });
  });

  it("returns non-zero exit code when credentials are missing or Claude settings conflict", async () => {
    const sb = makeSandbox();
    const gw = await startTestGateway();
    fs.writeFileSync(
      path.join(sb.homeDir, ".claude", "settings.json"),
      JSON.stringify({ apiKeyHelper: "echo bad" }),
    );

    const lines: string[] = [];
    const code = await runDoctor({
      aihubHome: sb.aihubHome,
      homeDir: sb.homeDir,
      cwd: sb.cwd,
      managedDirOverride: sb.managedDir,
      target: resolveTargetEnv({ baseUrl: gw.origin }, {}),
      env: { PATH: process.env.PATH },
      smoke: false,
      writeOut: (s) => lines.push(s),
    });

    expect(code).toBe(1);
    expect(lines.join("")).toContain("apiKeyHelper");
  });

  it("warns without blocking when Claude Code is older than 2.1.290, explains Anthropic's model version gate, and marks Codex 0.144.1 OK without obsolete decode advice (#8, #13)", async () => {
    const sb = makeSandbox();
    const gw = await startTestGateway();
    const binDir = path.join(sb.root, "old-bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, "claude"),
      `#!${process.execPath}\nconsole.log("2.1.259 (Claude Code)");\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(binDir, "codex"),
      `#!${process.execPath}\nconsole.log("codex-cli 0.144.1");\n`,
      { mode: 0o755 },
    );

    const lines: string[] = [];
    const code = await runDoctor({
      aihubHome: sb.aihubHome,
      homeDir: sb.homeDir,
      cwd: sb.cwd,
      managedDirOverride: sb.managedDir,
      target: resolveTargetEnv({ baseUrl: gw.origin }, {}),
      env: { PATH: binDir, BELIVE_TOKENHUB_API_KEY: "sk-tokenhub-doc-ver-1" },
      smoke: false,
      writeOut: (s) => lines.push(s),
    });

    const report = lines.join("");
    expect(code).toBe(0);
    expect(report).toContain("older than Anthropic's minimum for Fable 5.2 (2.1.290");
    expect(report).not.toContain("minimum tested 2.1.290");
    expect(report).toContain("[OK] binary codex: codex-cli 0.144.1");
    expect(report).not.toMatch(/discovery decode warning|0\.166\.0/i);
  });

  it("reports agy below 1.5 as unsupported ([FAIL], exit 1) and agy >= 1.5 as [OK] (#26)", async () => {
    const sb = makeSandbox();
    const gw = await startTestGateway();
    const binDir = path.join(sb.root, "agy-ver-bin");
    fs.mkdirSync(binDir, { recursive: true });

    const agyStub = path.join(binDir, "agy");
    fs.writeFileSync(
      agyStub,
      [
        `#!${process.execPath}`,
        'if (process.argv.includes("--version")) { console.log("1.4.9"); process.exit(0); }',
        'if (process.argv.includes("--help")) { console.log("Usage: agy"); process.exit(0); }',
      ].join("\n"),
      { mode: 0o755 },
    );

    const failLines: string[] = [];
    const failCode = await runDoctor({
      aihubHome: sb.aihubHome,
      homeDir: sb.homeDir,
      cwd: sb.cwd,
      managedDirOverride: sb.managedDir,
      target: resolveTargetEnv({ baseUrl: gw.origin }, {}),
      env: { PATH: binDir, BELIVE_TOKENHUB_API_KEY: "sk-tokenhub-doc-agy-1" },
      smoke: false,
      writeOut: (s) => failLines.push(s),
    });

    const failReport = failLines.join("");
    expect(failCode).toBe(1);
    expect(failReport).toContain("[FAIL] binary agy: 1.4.9");
    expect(failReport).toMatch(/unsupported.*1\.5\.0/i);
    expect(failReport).not.toMatch(/overlay|agy-home|agy-diverged|slot-/i);

    // Pre-1.5.0 release candidate (1.5.0-rc.1) and longer flag name (--settings-file) also report [FAIL] and exit 1 (#30)
    for (const badFixture of [
      { ver: "1.5.0-rc.1", help: "  --settings  Session settings" },
      { ver: "1.5.13", help: "  --settings-file <path>" },
    ]) {
      fs.writeFileSync(
        agyStub,
        [
          `#!${process.execPath}`,
          `if (process.argv.includes("--version")) { console.log(${JSON.stringify(badFixture.ver)}); process.exit(0); }`,
          `if (process.argv.includes("--help")) { console.log(${JSON.stringify(badFixture.help)}); process.exit(0); }`,
        ].join("\n"),
        { mode: 0o755 },
      );
      const fixLines: string[] = [];
      const fixCode = await runDoctor({
        aihubHome: sb.aihubHome,
        homeDir: sb.homeDir,
        cwd: sb.cwd,
        managedDirOverride: sb.managedDir,
        target: resolveTargetEnv({ baseUrl: gw.origin }, {}),
        env: { PATH: binDir, BELIVE_TOKENHUB_API_KEY: "sk-tokenhub-doc-agy-1" },
        smoke: false,
        writeOut: (s) => fixLines.push(s),
      });
      const fixReport = fixLines.join("");
      expect(fixCode).toBe(1);
      expect(fixReport).toContain(`[FAIL] binary agy: ${badFixture.ver}`);
      expect(fixReport).toMatch(/unsupported.*agy update/i);
    }

    fs.writeFileSync(
      agyStub,
      [
        `#!${process.execPath}`,
        'if (process.argv.includes("--version")) { console.log("1.5.0"); process.exit(0); }',
        'if (process.argv.includes("--help")) { console.log("Usage: agy --settings <json>"); process.exit(0); }',
      ].join("\n"),
      { mode: 0o755 },
    );

    const okLines: string[] = [];
    const okCode = await runDoctor({
      aihubHome: sb.aihubHome,
      homeDir: sb.homeDir,
      cwd: sb.cwd,
      managedDirOverride: sb.managedDir,
      target: resolveTargetEnv({ baseUrl: gw.origin }, {}),
      env: { PATH: binDir, BELIVE_TOKENHUB_API_KEY: "sk-tokenhub-doc-agy-1" },
      smoke: false,
      writeOut: (s) => okLines.push(s),
    });
    expect(okCode).toBe(0);
    expect(okLines.join("")).toContain("[OK] binary agy: 1.5.0");
  });
});
