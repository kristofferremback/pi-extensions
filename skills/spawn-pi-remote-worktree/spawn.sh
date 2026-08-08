#!/usr/bin/env bash
# spawn-pi-remote-worktree.sh
#
# Create a fresh Threa worktree off origin/main, run `bun run setup:worktree`,
# launch a Pi instance in a new tmux window inside it, and enable
# /remote-control so a new Threa scratchpad is linked. Prints the scratchpad
# URL and the tmux window location at the end.
#
# Usage:
#   spawn-pi-remote-worktree.sh <name> [options]
#
#   <name>            Used for the worktree dir (../threa.<name>) and, unless
#                     --branch is given, the git branch.
#
# Options:
#   --branch <ref>    Branch name (default: <name>). Use a convention prefix
#                     like explore/foo or fix-foo.
#   --base <ref>      Base ref to branch from (default: origin/main).
#   --repo <path>     Main Threa checkout to add the worktree from
#                     (default: /Users/kristofferremback/dev/personal/threa).
#   --tmux <session>  tmux session to add the window to (default: 0).
#   --pi-bin <path>   Pi binary (default: /Users/kristofferremback/.bun/bin/pi).
#   --boot-wait <s>   Seconds to wait for Pi to boot before sending
#                     /remote-control (default: 8).
#   --skip-setup      Skip `bun run setup:worktree` (use if docker/postgres
#                     isn't running or you don't need the local dev DB).
#   --no-remote       Skip the /remote-control step (just create worktree +
#                     launch Pi).
#   -h, --help        Show this help.
#
# Notes:
#   - The Threa Pi remote points at app.threa.io (production), so the
#     scratchpad link works even without `bun run dev`. setup:worktree only
#     matters for local dev-server work against the cloned DB.
#   - Requires: git, tmux, bun, and (unless --skip-setup) docker with the
#     threa-postgres container running and the main worktree's
#     apps/backend/.env present.

set -euo pipefail

NAME=""
BRANCH=""
BASE="origin/main"
REPO="/Users/kristofferremback/dev/personal/threa"
TMUX_SESSION="0"
PI_BIN="/Users/kristofferremback/.bun/bin/pi"
BOOT_WAIT="8"
SKIP_SETUP=0
NO_REMOTE=0

print_help() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) print_help ;;
    --branch)  BRANCH="$2"; shift 2 ;;
    --base)    BASE="$2"; shift 2 ;;
    --repo)    REPO="$2"; shift 2 ;;
    --tmux)    TMUX_SESSION="$2"; shift 2 ;;
    --pi-bin)  PI_BIN="$2"; shift 2 ;;
    --boot-wait) BOOT_WAIT="$2"; shift 2 ;;
    --skip-setup) SKIP_SETUP=1; shift ;;
    --no-remote)  NO_REMOTE=1; shift ;;
    --) shift; break ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *)
      if [[ -z "$NAME" ]]; then NAME="$1"; shift
      else echo "Unexpected extra argument: $1" >&2; exit 2; fi
      ;;
  esac
done

if [[ -z "$NAME" ]]; then
  echo "Usage: spawn-pi-remote-worktree.sh <name> [options]" >&2
  echo "Run with --help for details." >&2
  exit 2
fi
[[ -z "$BRANCH" ]] && BRANCH="$NAME"

# Resolve paths relative to the repo (worktrees live as siblings: ../threa.<name>).
WORKTREE_DIR="$(cd "$REPO" && pwd)/../threa.$NAME"
WORKTREE_DIR="$(cd "$WORKTREE_DIR" 2>/dev/null && pwd || printf '%s\n' "$(cd "$REPO/.." && pwd)/threa.$NAME")"

log() { printf '\033[1;34m[spawn]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[spawn]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m[spawn]\033[0m %s\n' "$*" >&2; }

# --- preflight ---------------------------------------------------------------
command -v git >/dev/null  || { err "git not found"; exit 1; }
command -v tmux >/dev/null || { err "tmux not found"; exit 1; }
command -v bun >/dev/null  || { err "bun not found"; exit 1; }
[[ -d "$REPO/.git" || -f "$REPO/.git" ]] || { err "repo not found: $REPO"; exit 1; }
[[ -x "$PI_BIN" ]] || { err "pi binary not executable: $PI_BIN"; exit 1; }
tmux has-session -t "$TMUX_SESSION" 2>/dev/null || { err "tmux session '$TMUX_SESSION' not found"; exit 1; }

if [[ -e "$WORKTREE_DIR" ]]; then
  err "worktree dir already exists: $WORKTREE_DIR"
  exit 1
fi

# --- 1. fetch + create worktree ----------------------------------------------
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
    warn "run 'bun run db:start' in the main worktree and re-run setup:worktree manually."
    SKIP_SETUP=1
  fi
fi
if [[ $SKIP_SETUP -eq 0 ]]; then
  log "running bun run setup:worktree"
  if ! (cd "$WORKTREE_DIR" && bun run setup:worktree) 2>&1 | sed 's/^/    /'; then
    warn "setup:worktree reported errors — continuing (remote link still works)."
  fi
fi

# --- 3. launch Pi in a new tmux window --------------------------------------
# Pick a unique window name; fall back if it already exists.
WIN_NAME="$NAME"
if tmux list-windows -t "$TMUX_SESSION" -F '#{window_name}' 2>/dev/null | grep -qx "$WIN_NAME"; then
  WIN_NAME="${NAME}-$RANDOM"
fi
log "launching Pi in tmux session '$TMUX_SESSION' window '$WIN_NAME'"
tmux new-window -t "$TMUX_SESSION" -a -n "$WIN_NAME" -c "$WORKTREE_DIR" "$PI_BIN"

# --- 4. enable /remote-control ----------------------------------------------
if [[ $NO_REMOTE -eq 1 ]]; then
  warn "--no-remote: skipping /remote-control (run it yourself in the Pi pane)."
else
  log "waiting ${BOOT_WAIT}s for Pi to boot…"
  sleep "$BOOT_WAIT"
  log "sending /remote-control to the Pi pane"
  tmux send-keys -t "$TMUX_SESSION:$WIN_NAME" '/remote-control' Enter
  # give the extension time to create the scratchpad and print the link
  sleep 6
fi

# --- 5. report ---------------------------------------------------------------
echo
log "done."
echo "  worktree: $WORKTREE_DIR"
echo "  branch:   $BRANCH (off $BASE)"
echo "  tmux:     session '$TMUX_SESSION', window '$WIN_NAME'  →  attach: tmux select-window -t '$TMUX_SESSION:$WIN_NAME'"
if [[ $NO_REMOTE -eq 0 ]]; then
  echo "  pi pane tail:"
  tmux capture-pane -t "$TMUX_SESSION:$WIN_NAME" -p -S -20 2>/dev/null | grep -E 'Threa remote|linked|stream_' | sed 's/^/    /' || true
fi
