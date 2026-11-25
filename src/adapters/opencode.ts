import type { TargetEnv } from "../credentials.js";

export const OPENCODE_DEFAULT_MODEL = "deepseek/deepseek-v4-pro";
export const OPENCODE_PROVIDER_ID = "tokenhub";

const OPENCODE_DEFAULT_MODELS: Record<string, { name: string }> = {
  "deepseek/deepseek-v4-pro": { name: "DeepSeek V4 Pro" },
  "qwen/qwen3.8-flash": { name: "Qwen3.8 Flash" },
  "qwen/qwen3.8-max": { name: "Qwen3.8 Max" },
  "deepseek/deepseek-v4.1-flash-1017": { name: "DeepSeek V4.1 Flash" },
  "qwen/qwen3-coder-flash": { name: "Qwen3 Coder Flash" },
};

export interface BuildOpenCodeInvocationOptions {
  target: TargetEnv;
  apiKey: string;
  model?: string;
  parentEnv?: NodeJS.ProcessEnv;
  forwardedArgs: readonly string[];
}

export interface OpenCodeInvocation {
  args: string[];
  env: NodeJS.ProcessEnv;
  modelRef: string;
}

function normalizeModelId(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return OPENCODE_DEFAULT_MODEL;
  const prefix = `${OPENCODE_PROVIDER_ID}/`;
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

function parseParentConfigContent(raw: string | undefined): Record<string, unknown> {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) };
    }
  } catch {
    // Ignore invalid parent OPENCODE_CONFIG_CONTENT and apply clean AI Hub config
  }
  return {};
}

export function buildOpenCodeInvocation(opts: BuildOpenCodeInvocationOptions): OpenCodeInvocation {
  const modelId = normalizeModelId(opts.model);
  const modelRef = `${OPENCODE_PROVIDER_ID}/${modelId}`;
  const baseUrl = `${opts.target.apiOrigin}/api/v1`;

  const parentEnv = opts.parentEnv ?? process.env;
  const baseConfig = parseParentConfigContent(parentEnv.OPENCODE_CONFIG_CONTENT);
  const existingProviders =
    baseConfig.provider && typeof baseConfig.provider === "object" && !Array.isArray(baseConfig.provider)
      ? { ...(baseConfig.provider as Record<string, unknown>) }
      : {};

  const models: Record<string, { name: string }> = { ...OPENCODE_DEFAULT_MODELS };
  if (!models[modelId]) {
    models[modelId] = { name: modelId };
  }

  const mergedConfig: Record<string, unknown> = {
    ...baseConfig,
    $schema: "https://opencode.ai/config.json",
    provider: {
      ...existingProviders,
      [OPENCODE_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "BeLive AI Hub",
        options: {
          baseURL: baseUrl,
          apiKey: "{env:BELIVE_TOKENHUB_API_KEY}",
        },
        models,
      },
    },
    model: modelRef,
    small_model: modelRef,
  };

  const env: NodeJS.ProcessEnv = { ...parentEnv };
  env.BELIVE_TOKENHUB_API_KEY = opts.apiKey;
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(mergedConfig);

  return {
    args: [...opts.forwardedArgs],
    env,
    modelRef,
  };
}
