---
name: workflows
description: Run sandboxed multi-agent workflows with ordered phases, parallel fan-out, mixed Pi/Claude/Codex harnesses, structured outputs, and background execution. Use when the user explicitly requests a workflow, ultracode, or coordinated multi-agent work.
---

# Workflows

Use the `workflow` tool for tasks that genuinely benefit from multiple isolated agents with dependencies or parallel fan-out. For one independent delegation, use `subagent_spawn` instead.

Workflow scripts are sandboxed async JavaScript function bodies. They can use only:

- `phase(title)` — mark progress through declared phases.
- `await agent(prompt, options)` — run one isolated child.
- `await parallel([() => agent(...), ...], { concurrency? })` — run child thunks concurrently, globally capped at four.
- `args` — parsed JSON from the tool's `args` parameter.
- Normal JavaScript control flow and JSON-serializable return values.

They cannot import modules or access filesystem, network, process, eval, or timers directly. Agents do the actual work.

## Metadata

Start scripts with static metadata:

```js
export const meta = {
  name: "review-and-synthesize",
  description: "Parallel review followed by synthesis",
  phases: [{ title: "Review" }, { title: "Synthesis" }],
};
```

## Harness and model policy

`agent()` options:

```js
{
  label?,
  phase?,
  schema?,
  harness?,  // "pi" (default), "claude", or "codex"
  model?,
  provider?, // Pi only
  effort?,   // off|minimal|low|medium|high|xhigh|max
}
```

- `pi`: only `openai-codex/*` and `opencode-go/*`; inherits the parent model and effort by default.
- `claude`: Claude Agent SDK using the locally authenticated Claude subscription. Use native aliases such as `fable`, `opus`, or `sonnet`; prefer `fable` and `high` unless requested otherwise.
- `codex`: Codex CLI/app-server using Codex authentication. Prefer `gpt-5.6-sol` and `high` unless requested otherwise.

For Pi, prefer a full model string such as `model: "opencode-go/kimi-k3"`. `provider` plus a bare model is also accepted.

## Reliability rules

`agent()` never throws into the workflow. It always resolves to:

```js
{ ok, output, structured?, error? }
```

Always check `.ok` before consuming output. Pass a JSON Schema when later phases need to branch on fields rather than prose.

```js
const FINDINGS = {
  type: "object",
  properties: {
    issues: { type: "array", items: { type: "string" } },
  },
  required: ["issues"],
};

phase("Review");
const reviews = await parallel([
  () =>
    agent("Review authentication", {
      label: "auth",
      harness: "pi",
      model: "opencode-go/kimi-k3",
      schema: FINDINGS,
    }),
  () =>
    agent("Review persistence", {
      label: "storage",
      harness: "claude",
      model: "fable",
      effort: "high",
      schema: FINDINGS,
    }),
]);

const findings = reviews
  .filter((result) => result.ok)
  .map((result) => result.structured);
phase("Synthesis");
const report = await agent(`Synthesize: ${JSON.stringify(findings)}`, {
  label: "synthesis",
  harness: "codex",
  model: "gpt-5.6-sol",
  effort: "high",
});
return { findings, report: report.ok ? report.output : report.error };
```

Use `background: true` for long workflows when immediate blocking is unnecessary. Completion/failure is coalesced with nearby workflow settlements and pushed at the next model boundary, including the number of other workflows still running. Continue useful parent work, or call `workflow_wait({ run_ids, mode: "next" | "all" })` for an event-driven dependency wait; never poll `/workflows`. Foreground workflow and explicit wait results return nested child usage through Pi tool accounting; automatically pushed runs persist usage audit entries because custom completion messages cannot yet contribute to core session totals. Artifacts are stored under `~/.pi/agent/workflows/<runId>/`. Through Threa, rely on plain tool results and `/workflows <runId>` for manual inspection rather than TUI dashboards.
