import { spawn } from "node:child_process";
import readline from "node:readline";
import {
  clearStoredApiKey,
  DEFAULT_CATALOGUE_MODELS,
  saveStoredApiKey,
  type TargetEnv,
} from "../credentials.js";
import { scrubSecrets } from "../redact.js";

export interface RunSetupOptions {
  aihubHome: string;
  target: TargetEnv;
  openBrowser: boolean;
  clear: boolean;
  stdin?: NodeJS.ReadableStream;
  isTTY?: boolean;
  platform?: NodeJS.Platform;
  writeOut?: (text: string) => void;
  openUrl?: (url: string) => void;
}

function defaultOpenUrl(url: string, platform: NodeJS.Platform): void {
  const cmd = platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
  child.on("error", () => {
    // Non-fatal on headless Linux without xdg-open
  });
  child.unref();
}

async function readLineFromStream(input: NodeJS.ReadableStream): Promise<string> {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    rl.close();
    return line;
  }
  return "";
}

async function readHiddenFromTTY(
  stdin: NodeJS.ReadStream,
  writePrompt: (s: string) => void,
): Promise<string> {
  writePrompt("Paste your BeLive AI Hub workspace inference key (input hidden): ");
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          writePrompt("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          writePrompt("\n");
          reject(new Error("Setup cancelled."));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };

    stdin.on("data", onData);
  });
}

export async function runSetup(opts: RunSetupOptions): Promise<number> {
  const write = opts.writeOut ?? ((text: string) => process.stdout.write(text));
  const platform = opts.platform ?? process.platform;

  if (opts.target.isCustomBaseUrl) {
    write(
      `aihub setup stores keys for the default AI Hub endpoint only. For custom --base-url or AIHUB_BASE_URL (${opts.target.apiOrigin}), pass BELIVE_TOKENHUB_API_KEY in the environment.\n`,
    );
    return 1;
  }

  if (opts.clear) {
    const removed = clearStoredApiKey(opts.aihubHome, opts.target.envName);
    write(
      removed
        ? `Cleared stored AI Hub key for '${opts.target.envName}'.\n`
        : `No stored AI Hub key found for '${opts.target.envName}'.\n`,
    );
    return 0;
  }

  const keysUrl = `${opts.target.consoleOrigin}/dashboard/keys`;
  write(`Environment: ${opts.target.envName} (${opts.target.apiOrigin})\n`);
  write(`Create a dedicated workspace inference key with a spend cap at: ${keysUrl}\n`);
  write(
    `Note: child coding-agent processes inherit the key in their environment, so a dedicated key is recommended.\n`,
  );
  write(`Optional 6-model allowlist for default launchers:\n`);
  for (const id of DEFAULT_CATALOGUE_MODELS) {
    write(`  - ${id}\n`);
  }
  write(
    `Tip: in CI or shell scripts, export BELIVE_TOKENHUB_API_KEY (avoids clashing with Tencent TokenHub's TOKENHUB_API_KEY).\n`,
  );

  if (opts.openBrowser) {
    const opener = opts.openUrl ?? ((u: string) => defaultOpenUrl(u, platform));
    opener(keysUrl);
  }

  const input = opts.stdin ?? process.stdin;
  const isTTY = opts.isTTY ?? Boolean((input as NodeJS.ReadStream).isTTY);

  let rawKey = "";
  try {
    rawKey = isTTY
      ? await readHiddenFromTTY(input as NodeJS.ReadStream, write)
      : await readLineFromStream(input);
    const savedPath = saveStoredApiKey(opts.aihubHome, opts.target.envName, rawKey);
    write(`Saved '${opts.target.envName}' key to ${savedPath} (mode 0600).\n`);
    write(
      `Key format checked locally (AI Hub has no free key self-check route). Run 'aihub doctor --smoke' for a live authenticated check (< USD 0.01).\n`,
    );
    return 0;
  } catch (err) {
    const msg = scrubSecrets(err instanceof Error ? err.message : String(err), [rawKey]);
    write(`aihub setup failed: ${msg}\n`);
    return 1;
  }
}
