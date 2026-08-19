---
name: quota-status
description: Reports the current API quota/usage for the active AI provider (OpenAI Codex or OpenCode Go). Use when the user asks about remaining tokens, quota, usage, or rate limits.
---

# Quota Status

> Resolve `PI_EXTENSIONS_ROOT` from this skill file before running commands:

```bash
PI_EXTENSIONS_ROOT="$(cd "<skill-directory>/../.." && pwd)"
```

Reports the current API quota/usage for the active AI provider.

## Supported providers

- `openai-codex` — reads from ChatGPT's `wham/usage` endpoint.
- `opencode-go` — scrapes usage from the OpenCode workspace page (requires a cookie; configure with `/quota-status cookie set`).

## Usage

Run the report script. It uses `defaultProvider` from `~/.pi/agent/settings.json` unless a provider is passed as an argument.

```bash
# Use the default provider
bun run $PI_EXTENSIONS_ROOT/skills/quota-status/report.ts

# Or specify a provider
bun run $PI_EXTENSIONS_ROOT/skills/quota-status/report.ts openai-codex
bun run $PI_EXTENSIONS_ROOT/skills/quota-status/report.ts opencode-go
```

## What to report

Print the script's stdout directly. The skill intentionally uses a detailed multi-line format; the compact Pi status-line plugin output is unchanged. If the script exits with an error, explain the issue and suggest:

- For **OpenAI**: check that `~/.pi/agent/auth.json` or `~/.codex/auth.json` has a valid token.
- For **OpenCode**: run `/quota-status cookie set <cookie-value>` to refresh the cookie.

## Example

User: "What's my remaining quota?"

Response:
```text
Quota for opencode-go
Checked: 2026-06-17, 19:20:00 (2026-06-17T17:20:00.000Z)
Windows: 3

- Rolling
  Remaining: 66.0%
  Used:      34.0%
  Meter:     [████████████████░░░░░░░░]
  Reset:     2026-06-17, 23:02:00 (in 3h 42m; 2026-06-17T21:02:00.000Z)

- Weekly
  Remaining: 62.0%
  Used:      38.0%
  Meter:     [███████████████░░░░░░░░░]
  Reset:     2026-06-23, 09:00:00 (in 5d 13h 40m; 2026-06-23T07:00:00.000Z)
```

