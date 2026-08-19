---
name: vision-guide-dog
description: Offload vision to a persistent vision-capable sub-agent (a "guide dog"). Use when the user sends an image, screenshot, photo, or anything visual that you cannot see yourself, or asks you to look at / describe / answer questions about a picture, or follow up on a previously shared image. The dog remembers the conversation so you can ask follow-ups without re-sending the image.
---

# Vision Guide Dog

> Resolve `PI_EXTENSIONS_ROOT` from this skill file before running commands:

```bash
PI_EXTENSIONS_ROOT="$(cd "<skill-directory>/../.." && pwd)"
```

You (the active Pi agent) have no vision. This skill gives you a persistent
"guide dog": a **second Pi session** running a **vision-capable model**, pinned
to a **session file** so it remembers prior images and questions. You drive it
from `bash`; it prints text back. That's your eyes.

Because the dog's session file is reused across calls, it retains conversation
history — so you can ask a follow-up question *without re-sending the image*,
exactly like chatting with someone who is looking at the photo.

## When to use

- The user sends an image, screenshot, or photo and asks anything about it
  ("what's in this?", "does this look right?", "read this error dialog").
- The user refers to a picture you already received ("what about the cap?",
  "now zoom into the top-left") — a follow-up you can relay to the dog.
- You need visual context for a task (a UI mock, a stack trace screenshot,
  a diagram, a photo of a whiteboard).

If the user's question is purely textual, do **not** invoke the dog.

## How it works (the mechanism)

The helper `vision-dog.sh` runs, in non-interactive print mode:

```
pi -p --no-tools --no-extensions \
  --model <vision-model> \
  --session <persistent-session-file> \
  --name "Vision Guide Dog" \
  --system-prompt "<dog persona>" \
  @<image>  "<question>"
```

- `--session <path>` pins a jsonl session file. Pi appends to it and reloads
  history on each call → that is the persistence. No daemon, no socket, no
  long-lived process to manage. Survives your own restarts.
- `--no-tools` keeps the dog from trying to edit files; it only describes.
- `--no-extensions` keeps it lightweight and avoids unrelated print-mode
  extension crashes.
- `@<image>` attaches the image (Pi's native file-attachment syntax).

## The script

Resolve relative paths against this skill directory (the parent of this file).

```bash
SKILL_DIR="$(dirname "$(readlink -f $PI_EXTENSIONS_ROOT/skills/vision-guide-dog/SKILL.md 2>/dev/null || echo $PI_EXTENSIONS_ROOT/skills/vision-guide-dog/SKILL.md)")"
bash "$SKILL_DIR/vision-dog.sh" [options] [IMAGE] [QUESTION]
```

Or directly (path is stable):

```bash
bash $PI_EXTENSIONS_ROOT/skills/vision-guide-dog/vision-dog.sh [options] [IMAGE] [QUESTION]
```

### Arguments

- `IMAGE` — path to an image file. The **first non-flag argument that is an
  existing file** is treated as the image and attached with `@`. Omit it for a
  pure follow-up.
- `QUESTION` — everything else is the question. If an image is given with no
  question, defaults to a general description prompt.

### Options

- `--model <id>` — vision model id. Default: `$VISION_DOG_MODEL` or
  `openai-codex/gpt-5.4-mini`.
- `--session <path>` — session file. Default: `$VISION_DOG_SESSION` or
  `~/.pi/agent/sessions/vision-guide-dog/vision-dog.jsonl`.
- `--new` — wipe the session file first (start a fresh dog with no memory).
- `--name <name>` — session display name (default: "Vision Guide Dog").
- `-h, --help` — usage.

## Vision-capable models

These models currently accept images (`pi --list-models`, `images=yes`):

| Provider | Model | Notes |
|----------|-------|-------|
| openai-codex | `gpt-5.4-mini` | **default** — cheap, strong vision |
| openai-codex | `gpt-5.4` | smarter, pricier |
| openai-codex | `gpt-5.5` | smartest, priciest |
| opencode-go | `qwen3.7-plus` | cheap, 1M context |
| opencode-go | `qwen3.6-plus` | cheap, 1M context |
| opencode-go | `kimi-k2.6` | cheap |
| opencode-go | `mimo-v2.5` | cheap, 1M context |
| opencode-go | `minimax-m3` | 3× usage cost |

Pick a cheap one for routine description; escalate to `gpt-5.4`/`gpt-5.5` for
hard OCR, diagrams, or fine detail. Override per call with `--model`, or set
`VISION_DOG_MODEL` in your environment for a global default.

## Patterns

### 1. Describe a new image

```bash
bash $PI_EXTENSIONS_ROOT/skills/vision-guide-dog/vision-dog.sh \
  /path/to/image.png "What is in this image?"
```

### 2. Ask a follow-up (no image re-sent)

The dog remembers the last image because the session file persists:

```bash
bash $PI_EXTENSIONS_ROOT/skills/vision-guide-dog/vision-dog.sh \
  "What color was the child's cap, and was there any text on it?"
```

### 3. Switch topic / new image, fresh memory

```bash
bash $PI_EXTENSIONS_ROOT/skills/vision-guide-dog/vision-dog.sh \
  --new /path/to/other.png "Describe this one."
```

### 4. Separate conversation threads via separate session files

```bash
bash $PI_EXTENSIONS_ROOT/skills/vision-guide-dog/vision-dog.sh \
  --session ~/.pi/agent/sessions/vision-guide-dog/ui-review.jsonl \
  screenshot.png "Does this dialog have a cancel button?"
```

## How to use the dog's output

- The dog's answer goes to **stdout**. Capture it with `$(...)` or read the
  `bash` tool output, then relay a paraphrase to the user. You are the
  interface; the user never has to talk to the dog directly.
- If the user asks a follow-up, relay it to the dog (pattern 2) and relay the
  answer back. You can do this several times — each is one `bash` call.
- Large images (multi-MB photos) take longer to upload; allow a generous
  timeout (the `bash` tool default is fine; bump it for very large files).
- If the dog seems confused about which image you mean, send the image again
  or start `--new`.

## Gotchas

- The dog is **not you**: it cannot edit files, run code, or see your repo.
  It only looks at images and answers questions. Do not ask it to do work.
- The dog's session file is plain jsonl under `~/.pi/agent/sessions/`. You can
  inspect or export it with `pi --export <file>`.
- The first arg that is an existing file is treated as the image. If your
  question text happens to be a path that exists, pass the image explicitly
  or reorder so the path is the question (or quote and put the image first).
- `--no-extensions` means the dog will not pick up project-local providers
  registered via extensions. The built-in `openai-codex` and `opencode-go`
  providers work fine. If you register a vision model via a custom extension
  provider, drop `--no-extensions` in a local copy of the script.

## Do not

- Do not invoke the dog for purely textual questions — it just wastes a vision
  token call and a process spawn.
- Do not edit the dog's session file by hand; let Pi manage it. Use `--new` to
  reset, or delete the file.
- Do not run the dog in interactive/TUI mode. It is designed for `-p` print
  mode so you can capture stdout from `bash`.
