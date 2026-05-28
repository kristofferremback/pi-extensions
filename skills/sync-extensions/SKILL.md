---
name: sync-extensions
description: Registers new pi extension files from the pi-extensions repository into ~/.pi/agent/settings.json. Use when you've added a new .ts extension file to the repo and need it to be auto-loaded by pi.
---

# Sync Extensions

This skill keeps your pi extension registry in sync with the `pi-extensions` repository.

## When to use

- You've added a new `.ts` extension file to `/Users/kristofferremback/dev/personal/pi-extensions/`
- A previously added extension isn't loading
- You want to verify all extensions in the repo are registered

## Instructions

To register new extensions, follow these steps exactly:

### 1. Scan for extension files

List all `.ts` files in `/Users/kristofferremback/dev/personal/pi-extensions/` (non-recursive — only top-level `.ts` files are extensions). Exclude:
- Files in the `skills/` directory
- Any `.d.ts` declaration files
- Any files starting with `.` or `_` (internal helpers)

```bash
ls /Users/kristofferremback/dev/personal/pi-extensions/*.ts 2>/dev/null
```

### 2. Read the current registry

Read `/Users/kristofferremback/.pi/agent/settings.json` and note the `extensions` array.

### 3. Compare and register

For each `.ts` file found in step 1, construct the absolute path:
```
/Users/kristofferremback/dev/personal/pi-extensions/<filename>.ts
```

If a path is **not already present** in the `extensions` array, add it. The `extensions` array should remain alphabetically sorted for readability.

### 4. Update settings.json

Use the `edit` tool to add any missing entries to the `extensions` array in `/Users/kristofferremback/.pi/agent/settings.json`.

If no new extensions are found, report that everything is already synced.

### 5. Confirm

After updating, run `/reload` so pi picks up the new extension(s) immediately.

## Example

User: "I just added `auto-commit.ts` to pi-extensions, can you register it?"

Response:
1. Scan shows: `message-stash.ts`, `quota-status.ts`, `web-search.ts`, `auto-commit.ts`
2. Settings already has the first three
3. `auto-commit.ts` is new → add `/Users/kristofferremback/dev/personal/pi-extensions/auto-commit.ts`
4. Edit settings.json
5. Done — run `/reload` to activate
