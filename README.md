# `aihub` — BeLive AI Hub CLI

Unified zero-proxy launcher and setup CLI for running **Claude Code** (`claude`), **Codex CLI** (`codex`), **DeepSeek Harness** (`dsh`), **OpenCode** (`opencode`), and **Google Antigravity CLI** (`agy`, experimental) directly against BeLive AI Hub on **macOS and Linux**.

Documentation: <https://aihub.belive.sg/docs/cli>

## Requirements

- macOS or Linux
- Node.js `>= 22.0.0` (DeepSeek Harness `dsh` itself requires Node.js `>= 24.9.0`)
- One or more supported coding-agent CLIs installed on `PATH`:
  - `claude` (recommended `>= 2.1.290`)
  - `codex` (`>= 0.144.0`)
  - `dsh` (`npm install -g @deepseek-ai/dsh`)
  - `opencode` (`npm install -g opencode-ai`)
  - `agy` (`>= 1.5.0` required for `aihub agy`, experimental)

## Install

```bash
npm install -g belive-aihub
```

## Quickstart

1. Create a dedicated workspace inference key (`sk-tokenhub-…`) with a spend cap at <https://aihub.belive.sg/dashboard/keys> and save it locally (`0600` `~/.aihub/credentials.json`):

   ```bash
   aihub setup --open
   ```

   Or pass the key via environment variable (recommended in CI/scripts; uses `BELIVE_TOKENHUB_API_KEY` so it never collides with Tencent TokenHub's `TOKENHUB_API_KEY`):

   ```bash
   export BELIVE_TOKENHUB_API_KEY="sk-tokenhub-…"
   ```

2. Verify local configuration, installed CLIs, public gateway routes, and model retirement notices:

   ```bash
   aihub doctor
   # Optional live authenticated check across Messages, Responses, and Gemini v1beta (< USD 0.01):
   aihub doctor --smoke
   ```

3. Launch any agent against BeLive AI Hub (plain `claude`, `codex`, `dsh`, `opencode`, and `agy` keep your normal vendor logins):

   ```bash
   aihub claude
   aihub codex
   aihub dsh
   aihub opencode
   aihub agy
   ```

## Commands

```text
aihub setup    [--open] [--clear]
aihub doctor   [--base-url <origin>] [--smoke]
aihub claude   [--base-url <origin>] [--model <id>] [<claude args...>]
aihub codex    [--base-url <origin>] [--model <id>] [--effort low|medium|high|xhigh] [<codex args...>]
aihub dsh      [--base-url <origin>] [--model <id>] [--effort <level>] [<dsh args...>]
aihub opencode [--base-url <origin>] [--model <id>] [<opencode args...>]
aihub agy      [--base-url <origin>] [--model <id>] [<agy args...>]   (experimental, requires agy >= 1.5)
```

You can also set `AIHUB_BASE_URL` in the environment to override the gateway origin (overridden by `--base-url`).

## Isolation and security boundaries

| Launcher | Isolation mechanism | Shares existing harness state? | Notes |
| --- | --- | --- | --- |
| `aihub claude` | Child `env` + non-secret `--settings <json>` override | **Yes** — shares `~/.claude` | Tiered role defaults (`opus-5-5`, `sonnet-5-5`, `haiku-5-5`, `fable-5-2`), or pass `--model <id>` to pin all roles to one model. Sets `CLAUDE_CODE_ATTRIBUTION_HEADER=0` and `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`. Refuses on managed/project auth overrides or user secret helpers. MDM/server-delivered Claude policy is not locally inspectable. |
| `aihub codex` | Static per-env `CODEX_HOME=~/.aihub/codex/<env>` + `-m` / `-c` launch flags | **No** — does not read `~/.codex` | Concurrent-safe across sessions with different `--model` / `--effort` flags. Pass ad-hoc Codex config via `-c key=value`. |
| `aihub dsh` | Static per-env `DSH_HOME=~/.aihub/dsh/<env>` (`cordis.patch.yml`) + per-launch `0600` `--patch` override for `--model`/`--effort` | **No** — does not read `~/.deepseek-harness` | Defaults to `dsh tui` (pass `headless`, `web`, or `--profile <name>` to pick another profile). Unsets `DEEPSEEK_API_KEY` so `dsh-web-search-deepseek` never leaks keys to `api.deepseek.com`. |
| `aihub opencode` | Runtime `OPENCODE_CONFIG_CONTENT` JSON override referencing `{env:BELIVE_TOKENHUB_API_KEY}` | **Yes** — preserves `~/.config/opencode` and project `opencode.json` without editing them | Routes `tokenhub/<author/slug>` through `@ai-sdk/openai-compatible` over `/api/v1/chat/completions`; never writes raw keys to disk or config JSON. |
| `aihub agy` *(experimental)* | Session `--settings '{"modelProvider":"gemini","customModelsConfig":{}}'` on real `HOME` (requires `agy >= 1.5`, merged with any caller `--settings`) | **Yes** — shares `~/.gemini/antigravity-cli` (settings, key bindings, history) | Experimental; requires `agy >= 1.5.0`. Session `--settings` is never persisted; file-sourced `--settings` uses a private per-launch `0600` file removed at child exit. AI Hub serves Gemini 4 Argon, Carbon, Hydrogen, and 3.8/3.7/3.6 Flash (not Neon). |

- **Child environment boundary:** Wrapped harnesses inherit the resolved key in their process environment (`ANTHROPIC_AUTH_TOKEN`, `BELIVE_TOKENHUB_API_KEY`, `GEMINI_API_KEY`), so shell commands or local MCP servers run by the agent can read it. Always use a dedicated workspace key with a spend cap.
- **Custom `--base-url` / `AIHUB_BASE_URL`:** Stored keys in `~/.aihub/credentials.json` are never sent to a custom gateway origin; export `BELIVE_TOKENHUB_API_KEY` when targeting a non-default origin.
- **Billing source of truth:** Console Activity (<https://aihub.belive.sg/dashboard/activity>) is the source of truth for billed cost across all CLIs.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```
