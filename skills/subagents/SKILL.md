---
name: subagents
description: Run and coordinate isolated background subagents using Pi, Claude Agent SDK, or Codex. Use when the user asks for subagents, delegation, parallel investigation, or an independent review.
---

# Subagents

Each child is headless, has its own context window, cannot see the parent conversation, and cannot ask the user or recursively launch subagents/workflows. Give every child a self-contained prompt with paths, constraints, and the expected report.

## Harness policy

Choose the harness deliberately:

- `pi` — default when no harness is requested. `openai-codex/*`, `opencode-go/*`, and `alibaba-cloud/*` models are permitted. With no model or effort, it inherits the parent model and thinking level.
- `claude` — Claude Agent SDK using the locally authenticated Claude Code installation and the user's Claude subscription. Never route Claude through Pi.
- `codex` — Codex CLI/app-server using the user's Codex authentication. Use for OpenAI models when an independent Codex harness is useful.

### Pi model examples

- `openai-codex/gpt-5.6-sol` — strong default for demanding coding; usually `high`
- `openai-codex/gpt-5.6-terra` — `high`
- `openai-codex/gpt-5.6-luna` — `high`
- `opencode-go/kimi-k3`
- `opencode-go/kimi-k2.7-code`
- `opencode-go/deepseek-v4-flash`
- `opencode-go/glm-5.2`
- `alibaba-cloud/qwen3.8-max-preview`
- Other currently registered models from the permitted providers when their strengths fit the task

### Claude

Use model aliases understood by Claude Code, such as `fable`, `opus`, or `sonnet`. Prefer `fable` with `high` effort unless the user requests another Claude model.

### Codex

Prefer `gpt-5.6-sol` with `high` effort unless the user requests another OpenAI model.

Reasoning efforts accepted by all harnesses: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Each backend maps this scale to its native controls.

## Run, spawn, and manage

Choose the control path deliberately:

- `subagent_run(...)`: run one child to completion in a single blocking tool call. Prefer this when its result is the next dependency and the parent has no useful concurrent work; it avoids a separate spawn→wait model round trip.
- `subagent_spawn(...)`: fire-and-forget background work. Continue useful parent work. Settlements are coalesced and pushed at the next model boundary with the number of children still running.
- `subagent_worktree_run(...)`: create a retained git branch/worktree and run one child there to completion. Use for isolated autonomous coding; report the retained path/branch for inspection or cleanup.

All three accept a complete `prompt`, short `name`, chosen `harness`, and optional model/effort controls. `subagent_spawn` and `subagent_run` also accept `working_dir`. At most four children run concurrently.

Management tools:

- `subagent_check({ id })`: nonblocking peek. Do not repeatedly poll it.
- `subagent_list()`: list all runs.
- `subagent_wait({ ids, mode: "all" })`: event-driven block until every selected child settles.
- `subagent_wait({ ids, mode: "next" })`: event-driven block until the next settlement, then inspect `pending` and decide whether to work, spawn, or await again.
- `subagent_cancel({ ids })`: stop runs while preserving partial transcripts.
- `/subagents`: interactive inspection in a Pi TUI; use tools and plain results when operating remotely through Threa.

Explicit run/wait/cancel tool results include nested child usage in Pi session accounting when the backend reports it. Automatically pushed/background results persist usage audit entries, but Pi custom messages cannot yet add that usage to core session totals.
