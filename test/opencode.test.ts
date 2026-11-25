import { describe, expect, it } from "vitest";
import {
  buildOpenCodeInvocation,
  OPENCODE_DEFAULT_MODEL,
  OPENCODE_PROVIDER_ID,
} from "../src/adapters/opencode.js";
import { resolveTargetEnv } from "../src/credentials.js";

describe("opencode adapter (OpenCode)", () => {
  it("injects OPENCODE_CONFIG_CONTENT with {env:BELIVE_TOKENHUB_API_KEY} and never embeds raw secrets", () => {
    const target = resolveTargetEnv({}, {});
    const inv = buildOpenCodeInvocation({
      target,
      apiKey: "sk-tokenhub-opencode-secret-123",
      parentEnv: { PATH: "/usr/bin" },
      forwardedArgs: ["run", "say hi"],
    });

    expect(inv.args).toEqual(["run", "say hi"]);
    expect(inv.env.BELIVE_TOKENHUB_API_KEY).toBe("sk-tokenhub-opencode-secret-123");
    expect(inv.modelRef).toBe(`${OPENCODE_PROVIDER_ID}/${OPENCODE_DEFAULT_MODEL}`);

    const rawCfg = inv.env.OPENCODE_CONFIG_CONTENT;
    expect(rawCfg).toBeDefined();
    expect(rawCfg).not.toContain("sk-tokenhub-opencode-secret-123");

    const parsed = JSON.parse(rawCfg!) as {
      provider: Record<string, { npm: string; options: { baseURL: string; apiKey: string }; models: Record<string, unknown> }>;
      model: string;
      small_model: string;
    };
    expect(parsed.provider.tokenhub?.npm).toBe("@ai-sdk/openai-compatible");
    expect(parsed.provider.tokenhub?.options.baseURL).toBe("https://tokenhub-api.belive.sg/api/v1");
    expect(parsed.provider.tokenhub?.options.apiKey).toBe("{env:BELIVE_TOKENHUB_API_KEY}");
    expect(parsed.model).toBe(`tokenhub/${OPENCODE_DEFAULT_MODEL}`);
    expect(parsed.small_model).toBe(`tokenhub/${OPENCODE_DEFAULT_MODEL}`);
  });

  it("normalizes custom --model (with or without tokenhub/ prefix) and merges existing OPENCODE_CONFIG_CONTENT", () => {
    const target = resolveTargetEnv({ baseUrl: "http://127.0.0.1:8787" }, {});
    const inv = buildOpenCodeInvocation({
      target,
      apiKey: "sk-tokenhub-opencode-456",
      model: "tokenhub/qwen/qwen3.8-max",
      parentEnv: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          theme: "dark",
          provider: {
            other: { name: "Other" },
          },
        }),
      },
      forwardedArgs: [],
    });

    expect(inv.modelRef).toBe("tokenhub/qwen/qwen3.8-max");
    const parsed = JSON.parse(inv.env.OPENCODE_CONFIG_CONTENT!) as {
      theme: string;
      provider: Record<string, { options?: { baseURL?: string }; models?: Record<string, unknown> }>;
      model: string;
      small_model: string;
    };
    expect(parsed.theme).toBe("dark");
    expect(parsed.provider.other).toEqual({ name: "Other" });
    expect(parsed.provider.tokenhub?.options?.baseURL).toBe("http://127.0.0.1:8787/api/v1");
    expect(parsed.model).toBe("tokenhub/qwen/qwen3.8-max");
    expect(parsed.small_model).toBe("tokenhub/qwen/qwen3.8-max");

    const customModel = buildOpenCodeInvocation({
      target,
      apiKey: "sk-tokenhub-opencode-456",
      model: "x-ai/grok-4.6",
      parentEnv: {},
      forwardedArgs: [],
    });
    const customParsed = JSON.parse(customModel.env.OPENCODE_CONFIG_CONTENT!) as {
      provider: { tokenhub: { models: Record<string, { name: string }> } };
      model: string;
    };
    expect(customParsed.model).toBe("tokenhub/x-ai/grok-4.6");
    expect(customParsed.provider.tokenhub.models["x-ai/grok-4.6"]).toEqual({ name: "x-ai/grok-4.6" });
  });
});
