# AGENTS.md — aihub-cli (`belive-aihub`)

Shared contract for AI coding agents working in `belivetech/aihub-cli`.

## What this repo is

The public zero-proxy launcher and setup CLI (`belive-aihub` on npm, binary `aihub`) for running
**Claude Code** (`claude`), **Codex CLI** (`codex`), and **Google Antigravity CLI** (`agy`,
experimental) directly against BeLive AI Hub on macOS and Linux.

- Source: `src/` (`cli.ts`, `credentials.ts`, `redact.ts`, `spawn.ts`, `commands/`, `adapters/`).
- Tests: `test/*.test.ts` (Vitest).
- Public docs: <https://aihub.belive.sg/docs/cli>.

## Rules

- **No secrets.** Never commit, print, or transmit API keys, tokens, or `~/.aihub/credentials.json`
  contents. Tests use placeholders (`sk-tokenhub-…`). Keep redaction coverage in `src/redact.ts`.
- **Work in a worktree, not the main checkout.** Plain commits with no AI attribution footers or
  co-author trailers.
- **Node `>= 22.0.0`**, npm (`package-lock.json`).
- **Local proof before push:**
  ```bash
  npm run typecheck
  npm test
  npm run build
  ```
  Record commands and results in the PR body.
- **CI:** `.github/workflows/ci.yml` runs `verify-linux` (`ubuntu-24.04-arm`) on PRs to `main` and
  adds `verify-macos` on `v*` tags or `workflow_dispatch`.
- **Publishing:** Never bump version tags or run `npm publish` without explicit owner approval.

## Launcher and security invariants

Do not break these without an explicit owner decision and regression tests:

- **Env var name:** Use `BELIVE_TOKENHUB_API_KEY` (never `TOKENHUB_API_KEY`, which collides with
  Tencent Cloud TokenHub).
- **Custom origin guard:** Stored keys in `~/.aihub/credentials.json` (`0600`) must never be sent
  to a non-default `--base-url` / `AIHUB_BASE_URL`; require `BELIVE_TOKENHUB_API_KEY` for custom
  origins.
- **Claude adapter (`src/adapters/claude.ts`):** Uses child `env` + non-secret `--settings`, sets
  `CLAUDE_CODE_ATTRIBUTION_HEADER=0` and `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, and refuses
  on managed/project auth overrides or user secret helpers.
- **Codex adapter (`src/adapters/codex.ts`):** Isolates `CODEX_HOME=~/.aihub/codex/<env>`, sets
  the Codex TUI `Originator` header, and preserves TUI config tables without reading `~/.codex`.
- **Antigravity adapter (`src/adapters/agy.ts`):** Requires `agy >= 1.5.0` (refuse older versions).
  Merges session `--settings` on real `HOME` without persisting `modelProvider` into
  `settings.json`; file-sourced `--settings` uses a private `0600` per-launch file under
  `~/.aihub/agy-session-settings/` scrubbed on exit (and dead-PID dirs swept on next launch).
- **Binary probes:** Keep the 15 s binary probe timeout and explicit probe error reporting.
