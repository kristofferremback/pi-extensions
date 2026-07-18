---
name: spawn-claude-channel-worktree
description: Spin up a new Threa worktree with a Claude Code channel agent in a new tmux window, linked to a Threa scratchpad via the claude-code-remote channel. Use when the user wants a Claude Code channels agent / Claude remote agent for Threa in an isolated worktree.
---

# Spawn Claude Code channel worktree

A sibling to `spawn-pi-remote-worktree`, but for Claude Code channels.

It automates the fiddly flow for the Threa `extensions/claude-code-remote/`
channel:

1. `git fetch origin main` in the main Threa checkout.
2. `git worktree add -b <branch> ../threa.<name> origin/main`.
3. `bun run setup:worktree` in the new worktree (unless skipped; same behavior
   as the Pi-remote skill — it auto-skips when `threa-postgres` is not running).
4. Run `bun install` **leaf → root** across the channel's `file:` dep chain —
   `extensions/bot-runtime-client/`, then `extensions/remote-session/`, then
   `extensions/claude-code-remote/`. These extensions are intentionally not part
   of the root workspace, so the root install done by `setup:worktree` does
   **not** install their MCP deps. Installing only the top package leaves
   `remote-session`'s own `@threa/bot-runtime-client` import unresolved (bun
   resolves symlinked `file:` packages by realpath), and the stdio bridge dies
   at load with `Cannot find module '@threa/bot-runtime-client'` — a silent,
   deaf channel.
5. Pre-create/reuse the Threa runtime session by calling `/bot-runtime/sessions`
   with the same deterministic ids the channel derives from `hostname + cwd`.
   This prints the exact scratchpad URL before Claude starts, and Claude then
   attaches to that same stream on startup.
6. Register the channel as a **user-scope**, repo-stable Claude MCP server:
   `claude mcp add threa-channel --scope user -e THREA_CHANNEL_SERVER_KEY=threa-channel -- bun <main-checkout>/extensions/claude-code-remote/src/index.ts`,
   and drop any stale local/user `threa` (pre-rename) entry. The env key is REQUIRED: without `THREA_CHANNEL_SERVER_KEY` matching the registered name, the bridge loads as a plain (deaf) MCP server and never links a scratchpad. `--scope local` is keyed by the git
   **common dir**, so every worktree of one repo shares ONE local entry — they
   cannot each pin their own copy, and concurrent spawns clobber it (last writer
   wins), dangling a worktree's channel path the moment a sibling is removed.
   Pointing user scope at the always-present main checkout makes every spawn
   write the identical value (concurrency converges, nothing goes stale); the
   bridge still derives its scratchpad from `process.cwd()`, so each worktree
   links to its own scratchpad while running the identical main-checkout channel
   code. To run a worktree's OWN modified channel code, launch it with
   `--mcp-config <file>` naming its `index.ts`, or `--no-register` + a hand-wired
   entry.
7. Launch Claude Code in a new tmux window with:
   - `--dangerously-load-development-channels server:threa-channel`
   - `--dangerously-skip-permissions` (Claude Code YOLO/bypass mode)
8. Auto-accept Claude Code's expected development-channel warning:
   **“I am using this for local development”**.

## When to use

- The user says “spin up a Claude Code channels agent”, “Claude remote agent”,
  “use the Claude channel extension”, or similar.
- You need Claude Code (not Pi) running in an isolated Threa worktree and linked
  to a Threa scratchpad.

## How to run

Resolve relative paths against this skill directory (the parent of this file),
then run the script:

```bash
bash /Users/kristofferremback/dev/personal/pi-extensions/skills/spawn-claude-channel-worktree/spawn.sh \
  <name> [options]
```

Example:

```bash
bash /Users/kristofferremback/dev/personal/pi-extensions/skills/spawn-claude-channel-worktree/spawn.sh \
  explore-claude-agent --branch explore/claude-agent
```

## Arguments

- `<name>` — used for the worktree dir (`../threa.<name>`), tmux window name,
  and the default branch name.

## Options

- `--branch <ref>` — branch name (default: `<name>`). Prefer Threa conventions
  like `explore/foo`, `fix/foo`, `refactor/foo`.
- `--base <ref>` — base ref (default: `origin/main`).
- `--repo <path>` — main Threa checkout (default
  `/Users/kristofferremback/dev/personal/threa`).
- `--tmux <session>` — tmux session to add the window to (default `0`).
- `--claude-bin <path>` — Claude Code binary (default: first `claude` on PATH).
- `--channel <name>` — MCP/channel name (default `threa-channel`).
- `--boot-wait <s>` — seconds to wait before auto-accepting the dev-channel
  prompt (default `5`).
- `--accept-wait <s>` — seconds to wait after accepting before reporting pane
  tail (default `6`).
- `--skip-setup` — skip `bun run setup:worktree`.
- `--no-register` — do not write a local Claude MCP entry.
- `--no-auto-accept` — leave the dev-channel warning for the user to accept.
- `--no-yolo` — do not pass `--dangerously-skip-permissions`.

## Preconditions / gotchas

- **Claude Code 2.1.80+** is required. Check with `claude --version`.
- **Credentials live outside the repo**, normally in
  `~/.claude/threa-channel/config.json`:
  - `baseUrl`: `https://app.threa.io`
  - `workspaceId`: `ws_…`
  - `apiKey`: `threa_bk_…`
  - optional `defaultLabel`: `coding`
- **Do not put API keys in any MCP config.** The MCP entry is just
  `bun <path>/index.ts`; the channel reads credentials from the home-dir
  `~/.claude/threa-channel/config.json`. The script registers `threa-channel` at
  **user scope** pointing at the main checkout (see step 6) — never a
  per-worktree local entry, which cannot be pinned per worktree anyway.
- If `claude mcp get threa-channel` shows `Failed to connect`, check that the channel's
  `file:` deps are installed **leaf → root** (`bun install` in
  `extensions/bot-runtime-client/`, `extensions/remote-session/`,
  `extensions/claude-code-remote/`) in whichever checkout the entry points at —
  by default the **main** checkout, since that's where the user-scope entry runs
  from. Diagnose by running it directly: `bun extensions/claude-code-remote/src/index.ts`
  (a healthy start prints `[threa-channel] shutting down (stdin closed by parent)`).
- Claude Code custom channels require the dangerous development flag. The script
  intentionally accepts the **local development** warning because this channel is
  being launched from the local Threa checkout.
- By default it enables YOLO mode with `--dangerously-skip-permissions`, so tools
  run without prompts. Only use in trusted local dev worktrees.
- The scratchpad name is usually `Claude Code - <worktree-dir-name>`. The channel
  derives stable instance/session ids from hostname + cwd, so relaunching in the
  same worktree reuses the same scratchpad.
- The channel logs diagnostics under Claude Code's debug/session logs; the
  scratchpad should also appear in Threa's sidebar with the configured default
  label if set.

## What to tell the user after running

Report:

- the worktree path and branch,
- the tmux window (`tmux select-window -t 0:<name>`),
- that Claude Code is running with development channels + YOLO permissions,
- the exact scratchpad as a Markdown link, e.g. `[Open scratchpad](https://app.threa.io/...)` — do not put the URL in a code block,
- the scratchpad name `Claude Code - <worktree>`.

If Claude is stuck on a prompt, switch to the tmux window and press Enter for
“**I am using this for local development**”. If MCP/channel did not load, run
`/mcp` in Claude Code and verify `threa-channel` is connected.

## Do not

- Do not hand-edit any MCP config with secrets.
- Do not use this for untrusted directories — YOLO mode bypasses permissions.
- Do not point the user-scope `threa-channel` server at a worktree path — worktrees get
  deleted and the entry dangles. It must point at the main checkout.
- Do not re-introduce per-worktree `--scope local` `threa-channel` entries: they collide
  across a repo's worktrees (shared common-dir key) and race on concurrent spawns.
