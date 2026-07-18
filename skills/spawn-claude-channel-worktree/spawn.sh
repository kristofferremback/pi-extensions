#!/usr/bin/env bash
# spawn-claude-channel-worktree.sh
#
# Create a fresh Threa worktree off origin/main, run `bun run setup:worktree`,
# register the Threa Claude Code channel as a local MCP server for that worktree,
# then launch Claude Code in a new tmux window with the development-channel flag
# and YOLO permissions enabled.
#
# Usage:
#   spawn-claude-channel-worktree.sh <name> [options]
#
#   <name>              Used for the worktree dir (../threa.<name>) and, unless
#                       --branch is given, the git branch.
#
# Options:
#   --branch <ref>      Branch name (default: <name>). Use a convention prefix
#                       like explore/foo or fix-foo.
#   --base <ref>        Base ref to branch from (default: origin/main).
#   --repo <path>       Main Threa checkout to add the worktree from
#                       (default: /Users/kristofferremback/dev/personal/threa).
#   --tmux <session>    tmux session to add the window to (default: 0).
#   --claude-bin <path> Claude Code binary (default: first `claude` on PATH).
#   --channel <name>    MCP/channel server name (default: threa-channel).
#   --boot-wait <s>     Seconds to wait for Claude's local-dev warning before
#                       pressing Enter (default: 5).
#   --accept-wait <s>   Seconds to wait after accepting the warning before
#                       reporting pane tail (default: 6).
#   --skip-setup        Skip `bun run setup:worktree` (use if docker/postgres
#                       isn't running or you don't need the local dev DB).
#   --no-register       Skip `claude mcp add --scope local`.
#   --no-auto-accept    Do not auto-press Enter on the development-channel
#                       "local development only" warning.
#   --no-yolo           Do not pass --dangerously-skip-permissions.
#   -h, --help          Show this help.
#
# Notes:
#   - This uses Claude Code's development-channel flag:
#       --dangerously-load-development-channels server:<channel>
#     and, by default, YOLO mode:
#       --dangerously-skip-permissions
#   - The development-channel warning is expected. This script auto-accepts it
#     because this is local Threa channel development against your own checkout.
#   - Credentials must live outside the repo, normally in
#     ~/.claude/threa-channel/config.json.

set -euo pipefail

NAME=""
BRANCH=""
BASE="origin/main"
REPO="/Users/kristofferremback/dev/personal/threa"
TMUX_SESSION="0"
CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
CHANNEL="threa-channel"
BOOT_WAIT="5"
ACCEPT_WAIT="6"
SKIP_SETUP=0
NO_REGISTER=0
NO_AUTO_ACCEPT=0
NO_YOLO=0

print_help() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) print_help ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --tmux) TMUX_SESSION="$2"; shift 2 ;;
    --claude-bin) CLAUDE_BIN="$2"; shift 2 ;;
    --channel) CHANNEL="$2"; shift 2 ;;
    --boot-wait) BOOT_WAIT="$2"; shift 2 ;;
    --accept-wait) ACCEPT_WAIT="$2"; shift 2 ;;
    --skip-setup) SKIP_SETUP=1; shift ;;
    --no-register) NO_REGISTER=1; shift ;;
    --no-auto-accept) NO_AUTO_ACCEPT=1; shift ;;
    --no-yolo) NO_YOLO=1; shift ;;
    --) shift; break ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *)
      if [[ -z "$NAME" ]]; then NAME="$1"; shift
      else echo "Unexpected extra argument: $1" >&2; exit 2; fi
      ;;
  esac
done

if [[ -z "$NAME" ]]; then
  echo "Usage: spawn-claude-channel-worktree.sh <name> [options]" >&2
  echo "Run with --help for details." >&2
  exit 2
fi
[[ -z "$BRANCH" ]] && BRANCH="$NAME"

WORKTREE_DIR="$(cd "$REPO" && pwd)/../threa.$NAME"
WORKTREE_DIR="$(cd "$WORKTREE_DIR" 2>/dev/null && pwd || printf '%s\n' "$(cd "$REPO/.." && pwd)/threa.$NAME")"
CHANNEL_ENTRY="$WORKTREE_DIR/extensions/claude-code-remote/src/index.ts"
CONFIG_FILE="$HOME/.claude/threa-channel/config.json"

log() { printf '\033[1;34m[claude-channel]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[claude-channel]\033[0m %s\n' "$*" >&2; }
err() { printf '\033[1;31m[claude-channel]\033[0m %s\n' "$*" >&2; }
quote_cmd() { printf '%q ' "$@"; }

# --- preflight ---------------------------------------------------------------
command -v git >/dev/null || { err "git not found"; exit 1; }
command -v tmux >/dev/null || { err "tmux not found"; exit 1; }
command -v bun >/dev/null || { err "bun not found"; exit 1; }
[[ -n "$CLAUDE_BIN" && -x "$CLAUDE_BIN" ]] || { err "claude binary not executable: ${CLAUDE_BIN:-<empty>}"; exit 1; }
[[ -d "$REPO/.git" || -f "$REPO/.git" ]] || { err "repo not found: $REPO"; exit 1; }
tmux has-session -t "$TMUX_SESSION" 2>/dev/null || { err "tmux session '$TMUX_SESSION' not found"; exit 1; }

if [[ -e "$WORKTREE_DIR" ]]; then
  err "worktree dir already exists: $WORKTREE_DIR"
  exit 1
fi

if [[ ! -f "$CONFIG_FILE" && -z "${THREA_API_KEY:-}" ]]; then
  warn "no $CONFIG_FILE and THREA_API_KEY is not set; the channel may fail to link."
fi

# --- 1. fetch + create worktree ---------------------------------------------
log "fetching $BASE in $REPO"
git -C "$REPO" fetch origin "$(echo "$BASE" | sed 's|^origin/||')" 2>&1 | sed 's/^/    /'

log "creating worktree $WORKTREE_DIR (branch $BRANCH off $BASE)"
git -C "$REPO" worktree add -b "$BRANCH" "$WORKTREE_DIR" "$BASE" 2>&1 | sed 's/^/    /'

# --- 2. setup:worktree -------------------------------------------------------
if [[ $SKIP_SETUP -eq 1 ]]; then
  warn "--skip-setup: skipping bun run setup:worktree"
else
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^threa-postgres'; then
    warn "threa-postgres container not running; falling back to --skip-setup."
    warn "run 'bun run db:start' in the main worktree and re-run setup:worktree manually if needed."
    SKIP_SETUP=1
  fi
fi
if [[ $SKIP_SETUP -eq 0 ]]; then
  log "running bun run setup:worktree"
  if ! (cd "$WORKTREE_DIR" && bun run setup:worktree) 2>&1 | sed 's/^/    /'; then
    warn "setup:worktree reported errors — continuing (Claude channel can still link to prod)."
  fi
fi

[[ -f "$CHANNEL_ENTRY" ]] || { err "channel entry not found: $CHANNEL_ENTRY"; exit 1; }

# --- 3. install channel dependencies ----------------------------------------
# claude-code-remote is intentionally not part of the root workspace, so the
# root `bun install` done by setup:worktree does not install its MCP deps.
#
# The dep chain is claude-code-remote -> remote-session -> bot-runtime-client,
# all wired as `file:` (symlink) packages. bun resolves symlinked packages by
# realpath, so remote-session's own `import "@threa/bot-runtime-client"` only
# resolves if remote-session's OWN node_modules is populated — installing just
# the top package leaves the leaf unresolved and the stdio bridge dies at load
# with `Cannot find module '@threa/bot-runtime-client'`, which silently kills
# the whole channel. Install leaf -> root so every link in the chain resolves.
log "installing Claude channel dependencies (leaf -> root)"
for dep in bot-runtime-client remote-session claude-code-remote; do
  dep_dir="$WORKTREE_DIR/extensions/$dep"
  [[ -f "$dep_dir/package.json" ]] || continue
  log "  bun install: extensions/$dep"
  (cd "$dep_dir" && bun install) 2>&1 | sed 's/^/    /'
done

# --- 4. pre-link Threa scratchpad -------------------------------------------
# The channel itself will create/reuse the same link on startup, but doing it
# here lets the script print the exact scratchpad URL immediately. Keep this
# derivation in sync with extensions/claude-code-remote/src/config.ts.
STREAM_URL=""
log "creating/reusing Threa scratchpad link"
if STREAM_URL=$(cd "$WORKTREE_DIR" && node <<'NODE'
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const crypto = require("node:crypto")

function str(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}
function sanitizeId(raw) {
  return raw.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
}
function deriveStableId(prefix, seed) {
  const hash = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16)
  return `${prefix}-${hash}`.slice(0, 64)
}
function defaultDisplayName(cwd, override) {
  const prefix = override?.trim() ? override.trim() : "Claude Code"
  const dir = cwd.split("/").filter(Boolean).pop() || "session"
  const name = `${prefix} - ${dir}`
  return name.length > 100 ? name.slice(0, 100) : name
}

async function main() {
  const configPath = path.join(os.homedir(), ".claude", "threa-channel", "config.json")
  let file = {}
  try {
    file = JSON.parse(fs.readFileSync(configPath, "utf8"))
  } catch {}

  const env = process.env
  const cwd = process.cwd()
  const baseUrl = (str(env.THREA_BASE_URL) || str(file.baseUrl) || "https://app.threa.io").replace(/\/$/, "")
  const workspaceId = str(env.THREA_WORKSPACE_ID) || str(file.workspaceId)
  const apiKey = str(env.THREA_API_KEY) || str(file.apiKey)
  if (!workspaceId || !apiKey) throw new Error(`missing THREA_WORKSPACE_ID/THREA_API_KEY or ${configPath}`)

  const seed = `${os.hostname()}:${cwd}`
  const instanceId = sanitizeId(str(env.THREA_INSTANCE_ID) || str(file.instanceId) || deriveStableId("cc", seed)).slice(0, 64)
  const runtimeSessionId = sanitizeId(str(env.THREA_RUNTIME_SESSION_ID) || str(file.runtimeSessionId) || deriveStableId("ccs", seed)).slice(0, 64)
  const displayName = defaultDisplayName(cwd, str(env.THREA_DISPLAY_NAME) || str(file.displayName))
  const defaultLabel = str(env.THREA_DEFAULT_LABEL) || str(file.defaultLabel)

  const res = await fetch(`${baseUrl}/api/v1/workspaces/${workspaceId}/bot-runtime/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      runtimeKind: "claude-code-channel",
      instanceId,
      runtimeSessionId,
      displayName,
      localCwd: cwd,
      ...(defaultLabel && { labelName: defaultLabel }),
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Threa API ${res.status}: ${body.slice(0, 500)}`)
  }
  const json = await res.json()
  const sp = json?.data?.streamUrlPath
  if (!sp || typeof sp !== "string") throw new Error("session response missing data.streamUrlPath")
  console.log(`${baseUrl}${sp}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
NODE
); then
  log "scratchpad: $STREAM_URL"
else
  warn "could not pre-link scratchpad; Claude channel will retry on startup."
fi

# --- 5. register the channel MCP server (repo-stable, user scope) ------------
# Claude keys `--scope local` MCP config by the git COMMON dir, not the worktree
# — so EVERY worktree of one repo shares a single `threa` local entry (stored
# under projects["<main repo>"]). Per-worktree local pinning is therefore
# impossible: two concurrent spawns clobber the one shared entry (last writer
# wins), and whichever worktree's index.ts it lands on dangles the moment that
# worktree is removed. Instead register ONE user-scope `threa` that points at
# the MAIN checkout's channel entry (always present). Every spawn writes the
# identical value, so concurrent spawns CONVERGE instead of racing, and nothing
# goes stale when a feature worktree is deleted. Correctness is preserved
# because the bridge derives its scratchpad from process.cwd() (the worktree,
# set by tmux -c), not from the entry path — each worktree still links to its
# own scratchpad while running the (identical) main-checkout channel code.
#
# Trade-off: a worktree that is itself modifying the channel code under
# extensions/claude-code-remote won't run its own copy. To do that, launch that
# worktree's Claude with `--mcp-config <file>` naming its own index.ts, or use
# --no-register here and wire a bespoke entry by hand.
if [[ $NO_REGISTER -eq 1 ]]; then
  warn "--no-register: leaving Claude MCP config unchanged."
else
  MAIN_ENTRY="$(cd "$REPO" && pwd)/extensions/claude-code-remote/src/index.ts"
  [[ -f "$MAIN_ENTRY" ]] || warn "main-checkout channel entry not found: $MAIN_ENTRY (channel may fail to load)"
  log "registering user-scope MCP server '$CHANNEL' -> $MAIN_ENTRY (repo-stable)"
  "$CLAUDE_BIN" mcp remove "$CHANNEL" --scope user >/dev/null 2>&1 || true
  # THREA_CHANNEL_SERVER_KEY must repeat the registered server name: since the
  # threa->threa-channel rename the bridge links a scratchpad ONLY when its own
  # registration carries this key AND the launch flag names it. Without the env
  # the server loads as a plain (deaf) MCP server and the scratchpad never links.
  "$CLAUDE_BIN" mcp add "$CHANNEL" --scope user -e "THREA_CHANNEL_SERVER_KEY=$CHANNEL" -- bun "$MAIN_ENTRY" 2>&1 | sed 's/^/    /'
  # Drop the pre-rename user-scope entry: a stale 'threa' twin loads the same
  # script a second time and can shadow-claim the scratchpad (twin-bridge bug).
  if [[ "$CHANNEL" != "threa" ]]; then
    "$CLAUDE_BIN" mcp remove threa --scope user >/dev/null 2>&1 || true
  fi
  # Drop any stale shared local entry (keyed by this repo's common dir) so it
  # can't override the stable user-scope server with a per-worktree path.
  (cd "$REPO" && "$CLAUDE_BIN" mcp remove "$CHANNEL" --scope local >/dev/null 2>&1 || true)
fi

# --- 6. launch Claude Code in tmux ------------------------------------------
WIN_NAME="$NAME"
if tmux list-windows -t "$TMUX_SESSION" -F '#{window_name}' 2>/dev/null | grep -qx "$WIN_NAME"; then
  WIN_NAME="${NAME}-$RANDOM"
fi

CLAUDE_ARGS=("$CLAUDE_BIN" --name "threa.$NAME" --dangerously-load-development-channels "server:$CHANNEL")
if [[ $NO_YOLO -eq 0 ]]; then
  CLAUDE_ARGS+=(--dangerously-skip-permissions)
fi
CMD="$(quote_cmd "${CLAUDE_ARGS[@]}")"

log "launching Claude Code in tmux session '$TMUX_SESSION' window '$WIN_NAME'"
log "command: ${CMD}"
tmux new-window -t "$TMUX_SESSION" -a -n "$WIN_NAME" -c "$WORKTREE_DIR" "$CMD"

# --- 7. accept development-channel warning ----------------------------------
if [[ $NO_AUTO_ACCEPT -eq 1 ]]; then
  warn "--no-auto-accept: leaving the local-development warning for you to confirm."
else
  log "waiting ${BOOT_WAIT}s for Claude's local-development warning…"
  sleep "$BOOT_WAIT"
  log "accepting development-channel local-dev warning (Enter)"
  tmux send-keys -t "$TMUX_SESSION:$WIN_NAME" Enter
  sleep "$ACCEPT_WAIT"
fi

# --- 8. report ---------------------------------------------------------------
echo
log "done."
echo "  worktree: $WORKTREE_DIR"
echo "  branch:   $BRANCH (off $BASE)"
echo "  channel:  server:$CHANNEL (user-scope MCP entry -> main checkout, repo-stable)"
echo "  yolo:     $([[ $NO_YOLO -eq 0 ]] && echo 'enabled (--dangerously-skip-permissions)' || echo 'disabled')"
echo "  tmux:     session '$TMUX_SESSION', window '$WIN_NAME'  →  attach: tmux select-window -t '$TMUX_SESSION:$WIN_NAME'"
echo "  scratchpad name: Claude Code - $(basename "$WORKTREE_DIR")"
if [[ -n "$STREAM_URL" ]]; then
  echo "  scratchpad: [Open scratchpad]($STREAM_URL)"
fi
echo "  pane tail:"
tmux capture-pane -t "$TMUX_SESSION:$WIN_NAME" -p -S -24 2>/dev/null | sed 's/^/    /' || true
