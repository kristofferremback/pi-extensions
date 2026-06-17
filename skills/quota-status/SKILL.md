---
name: quota-status
description: Reports the current API quota/usage for the active AI provider (OpenAI Codex or OpenCode Go). Use when the user asks about remaining tokens, quota, usage, or rate limits.
---

# Quota Status

Reports the current API quota/usage for the active AI provider.

## Supported providers

- `openai-codex` — reads from ChatGPT's `wham/usage` endpoint.
- `opencode-go` — scrapes usage from the OpenCode workspace page (requires a cookie; configure with `/quota-status cookie set`).

## Usage

Run the report script. It uses `defaultProvider` from `~/.pi/agent/settings.json` unless a provider is passed as an argument.

```bash
# Use the default provider
bun run /Users/kristofferremback/dev/personal/pi-extensions/skills/quota-status/report.ts

# Or specify a provider
bun run /Users/kristofferremback/dev/personal/pi-extensions/skills/quota-status/report.ts openai-codex
bun run /Users/kristofferremback/dev/personal/pi-extensions/skills/quota-status/report.ts opencode-go
```

## What to report

Print the script's stdout directly. If the script exits with an error, explain the issue and suggest:

- For **OpenAI**: check that `~/.pi/agent/auth.json` or `~/.codex/auth.json` has a valid token.
- For **OpenCode**: run `/quota-status cookie set <cookie-value>` to refresh the cookie.

## Example

User: "What's my remaining quota?"

Response:
```
Rolling [███████░░] 78% left | Weekly [████████░░] 82% left | Monthly [████░░░░░░] 35% left (resets tomorrow 08:00)
```
