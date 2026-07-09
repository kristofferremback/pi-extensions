#!/usr/bin/env bash
# vision-dog.sh — a persistent vision sub-agent for a blind Pi agent.
#
# Spawns a non-interactive Pi session pinned to a session file, using a
# vision-capable model. Because the session file is reused across calls,
# the dog remembers prior images and questions — so you can ask follow-ups
# without re-sending the image.
#
# Usage:
#   vision-dog.sh [IMAGE] [QUESTION]          # see/describe an image
#   vision-dog.sh [QUESTION]                  # follow-up (no new image)
#   vision-dog.sh --new [IMAGE] [QUESTION]    # wipe the dog's memory first
#   vision-dog.sh --model M [IMAGE] [QUESTION]
#   vision-dog.sh --session PATH [IMAGE] [QUESTION]
#
# Options:
#   --model <id>      Vision model id (default: $VISION_DOG_MODEL or
#                     openai-codex/gpt-5.4-mini). See SKILL.md for alternatives.
#   --session <path>  Session file to use (default: $VISION_DOG_SESSION or
#                     ~/.pi/agent/sessions/vision-guide-dog/vision-dog.jsonl).
#   --new             Delete the session file before this call (fresh dog).
#   --name <name>     Session display name (default: "Vision Guide Dog").
#   -h, --help        Show this help.
#
# The first non-flag argument that is an existing file path is treated as the
# image (attached with @). All other non-flag arguments form the question.
# If an image is given with no question, defaults to "Describe this image."

set -euo pipefail

MODEL="${VISION_DOG_MODEL:-openai-codex/gpt-5.4-mini}"
SESSION="${VISION_DOG_SESSION:-$HOME/.pi/agent/sessions/vision-guide-dog/vision-dog.jsonl}"
NAME="Vision Guide Dog"
FRESH=0

usage() {
  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

# --- arg parsing ---
positional=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)   MODEL="$2"; shift 2;;
    --session) SESSION="$2"; shift 2;;
    --name)    NAME="$2"; shift 2;;
    --new)     FRESH=1; shift;;
    -h|--help) usage 0;;
    --)        shift; while [[ $# -gt 0 ]]; do positional+=("$1"); shift; done;;
    -*)        echo "vision-dog: unknown option: $1" >&2; usage 1;;
    *)         positional+=("$1"); shift;;
  esac
done

# --- resolve image vs question ---
IMAGE=""
question_parts=()
for arg in "${positional[@]:-}"; do
  [[ -z "$arg" ]] && continue
  if [[ -z "$IMAGE" && -f "$arg" ]]; then
    IMAGE="$arg"
  else
    question_parts+=("$arg")
  fi
done

QUESTION="${question_parts[*]:-}"
if [[ -z "$IMAGE" && -z "$QUESTION" ]]; then
  echo "vision-dog: provide an image and/or a question." >&2
  usage 1
fi
if [[ -n "$IMAGE" && -z "$QUESTION" ]]; then
  QUESTION="Describe this image: setting, objects, people, text, colors. Be concise but complete."
fi

# --- session file ---
mkdir -p "$(dirname "$SESSION")"
if [[ "$FRESH" -eq 1 && -f "$SESSION" ]]; then
  rm -f "$SESSION"
fi

# System prompt: a focused, factual vision describer that also answers follow-ups.
SYS_PROMPT='You are a vision guide dog for a blind coding agent that has no vision of its own. Your job is to be its eyes. When given an image, describe what you see accurately, specifically, and concisely — setting, objects, people, text, colors, layout, anything notable. Answer follow-up questions about previously described images from memory. Be factual; if unsure, say so. Do not invent details. Do not refuse benign images. Keep prose tight; no preamble.'

# --- run the dog ---
# --no-tools:       the dog only describes/answers, it does not edit files.
# --no-extensions:  keeps the dog lightweight and avoids unrelated extension
#                   crashes in print mode (e.g. stale-ctx on shutdown).
args=(pi -p --no-tools --no-extensions
  --model "$MODEL"
  --session "$SESSION"
  --name "$NAME"
  --system-prompt "$SYS_PROMPT")

if [[ -n "$IMAGE" ]]; then
  args+=(@"$IMAGE")
fi
args+=("$QUESTION")

exec "${args[@]}"
