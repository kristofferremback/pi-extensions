---
name: spawn-pi-remote-worktree
description: Spin up a new Threa worktree (off origin/main) with a Pi instance in a new tmux window and /remote-control linked to a fresh Threa scratchpad. Use when the user wants to start exploring/working on Threa in an isolated worktree with a Pi remote control attached.
---

# Spawn Pi remote worktree

A one-shot helper that does the full flow you'd otherwise reason out each time:

1. `git fetch origin main` in the main Threa checkout.
2. `git worktree add -b <branch> ../threa.<name> origin/main`.
3. `bun run setup:worktree` in the new worktree (installs deps, clones a dedicated
   postgres DB `<name>` + control-plane DB from the main worktree's DB, copies
   `.env` and MCP config). Skipped automatically if the `threa-postgres` container
   isn't running, or via `--skip-setup`.
4. Launch a Pi instance in a **new tmux window** (cwd = the worktree).
5. Send `/remote-control` to the Pi pane so a **new Threa scratchpad** is linked
   (against `app.threa.io` — works without a local dev server).

## When to use

- The user says things like "spawn a new pi remote in a threa worktree", "set up a
  worktree for exploring X", "open a pi remote in tmux for this worktree".
- You need an isolated Threa worktree + Pi remote to investigate something
  (e.g. long-chat performance).

## How to run

The script lives next to this SKILL.md. Resolve relative paths against this
skill directory (the parent of this file). Run it with bash:

```bash
SKILL_DIR="$(dirname "$(readlink -f /Users/kristofferremback/dev/personal/pi-extensions/skills/spawn-pi-remote-worktree/SKILL.md 2>/dev/null || echo /Users/kristofferremback/dev/personal/pi-extensions/skills/spawn-pi-remote-worktree/SKILL.md)")"
bash "$SKILL_DIR/spawn.sh" <name> [options]
```

Or directly (path is stable):

```bash
bash /Users/kristofferremback/dev/personal/pi-extensions/skills/spawn-pi-remote-worktree/spawn.sh <name> [options]
```

### Arguments

- `<name>` — used for the worktree dir (`../threa.<name>`) and the default branch.

### Options

- `--branch <ref>` — branch name (default: `<name>`). Use a convention prefix
  like `explore/foo` or `fix-foo` to match the repo's branch style.
- `--base <ref>` — base ref (default `origin/main`).
- `--repo <path>` — main Threa checkout (default
  `/Users/kristofferremback/dev/personal/threa`).
- `--tmux <session>` — tmux session to add the window to (default `0`).
- `--pi-bin <path>` — Pi binary (default `/Users/kristofferremback/.bun/bin/pi`).
- `--boot-wait <s>` — seconds to wait for Pi to boot before sending
  `/remote-control` (default `8`).
- `--skip-setup` — skip `bun run setup:worktree` (use when docker/postgres
  isn't running, or you don't need the local dev DB).
- `--no-remote` — skip the `/remote-control` step (just create worktree + Pi).

## Choosing `<name>` and `--branch`

Follow the repo convention (see `~/.agents/skills/` in a worktree, or recent
branches with `git branch -a`):

- exploration: `--branch explore/long-chat-perf`, name `explore-long-chat-perf`
- a fix: `--branch fix-something`, name `fix-something`
- a refactor: `--branch refactor/foo`, name `refactor-foo`

Example — reproduce the long-chat perf worktree:

```bash
bash /Users/kristofferremback/dev/personal/pi-extensions/skills/spawn-pi-remote-worktree/spawn.sh \
  explore-long-chat-perf --branch explore/long-chat-perf
```

## What the script reports

At the end it prints the worktree path, branch, and the tmux window to attach
to, plus the tail of the Pi pane showing the `Threa remote linked: …` line
with the new scratchpad URL. Tell the user:

- the tmux window to switch to (e.g. `Ctrl+b 2`, or `tmux select-window -t 0:<win>`)
- the scratchpad URL that appeared
- that `bun run dev` (in the worktree) is a separate step for local dev-server
  work against the cloned DB — the remote scratchpad works without it.

## Preconditions / gotchas

- **tmux** must be running with a session (default `0`). The script errors out
  if not. Override the session with `--tmux`.
- **docker + `threa-postgres`** must be running for `bun run setup:worktree` to
  clone the DB. If it isn't, the script auto-skips setup and continues (the
  remote link still works). Start it in the main worktree with
  `bun run db:start` and re-run `bun run setup:worktree` manually if you need
  the local DB later.
- The **main worktree** must have `apps/backend/.env` (the script copies it).
- **Pi remote target is production `app.threa.io`** (from
  `~/.pi/agent/threa-remote.json`), not a local dev server.
- If Pi shows a **project-trust prompt** in the new dir on first boot, the
  `/remote-control` text may be eaten. After trusting, just run
  `/remote-control` manually in that pane; the worktree is already created.
- If you only need to work locally (no Threa remote), pass `--no-remote`.
- If a worktree dir or branch already exists, the script errors out — clean up
  or pick a new name.

## Do not

- Don't recreate the steps by hand — that's the whole point of this skill. Run
  the script.
- Don't run `bun run dev` from inside the script; it's long-running and belongs
  in its own pane when the user wants local dev. The script only does
  `bun run setup:worktree` (which terminates).
- Don't edit the installed `~/.pi/agent/extensions/threa-remote/` copy. The
  repo `extensions/pi-remote/` is the source of truth (see the
  `update-pi-remote-plugin` skill in the Threa repo).
