/** All model-facing strings for the subagents tools. */

/** Describes subagent_spawn, including harnesses and the fixed concurrency cap. */
export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
  "Spawn a background subagent: a fully autonomous, headless agent with its own context window. You choose the harness it runs on: pi (in-process Pi session with built-in tools plus normal skills/context, but no parent-session extensions), claude (Claude Code), or codex (Codex CLI). Fire-and-forget: this returns immediately with an id. The subagent's final output is queued back to you as a message when it settles, or collect it explicitly with subagent_wait. Children cannot orchestrate more agents/workflows or ask the user, and cannot see this conversation, so the prompt must be self-contained. Max 4 subagents can be running at once across all harnesses.";

/** Adds background subagent delegation to the parent model's available-tools prompt. */
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Spawn a background subagent on a chosen harness (pi, Claude Code, or Codex; own context, normal tools) for a self-contained task";

/** Guides the parent model to delegate standalone tasks and avoid unnecessary blocking waits. */
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Use subagent_spawn to delegate self-contained tasks that can run in the background; give it a complete, standalone prompt.",
  "Use subagent_run instead when you need one child's result immediately and have no useful parent work to do; it avoids a separate spawn-then-wait round trip.",
  "Use subagent_worktree_run when an autonomous coding task needs its own retained git branch/worktree rather than sharing the parent's checkout.",
  "Pick the subagent harness deliberately: pi unless you have a reason to prefer Claude Code or Codex (e.g. the user asked for one, or the task suits that harness).",
  "After subagent_spawn, keep working; completion events are pushed automatically and report how many children remain. Only call subagent_wait when you intentionally want to block.",
];

/** Model-facing schema descriptions for subagent_spawn task and execution options. */
export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  prompt:
    "Task prompt for the subagent. Must be self-contained: include all needed context, file paths, and what to report back.",
  name: "Short human-readable name for this subagent, shown in listings and the UI",
  harness:
    'Harness to run the subagent on: "pi" (in-process pi session; inherits this environment), "claude" (Claude Code), or "codex" (Codex CLI). Choose deliberately per task.',
  workingDir: "Working directory (default: current working directory)",
  model:
    'Model hint, interpreted by the chosen harness (pi: "provider/model-id" or model id; claude: model alias like "sonnet"/"opus"; codex: model slug). Omit for the harness default (pi inherits the current model).',
  reasoningEffort:
    "Reasoning effort on a shared scale; the harness maps it to its nearest native equivalent (pi thinking level, codex reasoning effort, claude thinking budget). Omit for the harness default (pi inherits the current level).",
};

/** Builds the subagent_spawn result that tells the parent model how to continue or inspect the child. */
export function buildSubagentSpawnResult(options: {
  id: string;
  title: string;
  harness: string;
  modelLabel: string;
  cwd: string;
}) {
  return (
    `Spawned subagent ${options.id} "${options.title}" (${options.harness}: ${options.modelLabel}, ${options.cwd}).\n` +
    `It runs in the background. Its result will be delivered to you when it finishes, ` +
    `or use subagent_wait(ids: ["${options.id}"]) to block for it, subagent_cancel to stop it, subagent_check to peek, subagent_list to see all.`
  );
}

/** Describes explicit blocking collection of one or more subagent results. */
export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
  'Block for listed subagents without polling. mode="all" waits for every id; mode="next" yields after at least one settles and reports the remaining running ids so you can decide what to do next. Prefer automatic pushed results when you can continue useful work.';

/** Model-facing schema description for the subagent ids to await. */
export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to wait for, e.g. ["sa-1", "sa-2"]',
  mode: '"all" (default) waits for every id; "next" returns on the next settlement and includes remaining ids.',
};

/** Blocking spawn-and-collect path that saves one parent-model round trip. */
export const SUBAGENT_RUN_TOOL_DESCRIPTION =
  "Run one autonomous subagent and block until it settles, returning its final output directly. Use this instead of subagent_spawn followed immediately by subagent_wait. For work that can overlap with parent work, use subagent_spawn instead.";

export const SUBAGENT_RUN_PROMPT_SNIPPET =
  "Run one subagent to completion in a single blocking tool call";

export const SUBAGENT_WORKTREE_RUN_TOOL_DESCRIPTION =
  "Create a retained git branch/worktree, run one autonomous subagent there to completion, and return its result plus the worktree path. This is the managed isolated-coding path; it is event-driven and does not poll tmux or a remote pane. The worktree is intentionally retained for inspection, continuation, commit, or cleanup.";

export const SUBAGENT_WORKTREE_RUN_PROMPT_SNIPPET =
  "Create a retained git worktree and run one isolated coding subagent there to completion";

/** Describes aborting running subagents while retaining their partial transcripts. */
export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
  "Cancel one or more running subagents. This aborts their active work but preserves their partial session transcripts on disk.";

/** Model-facing schema description for the subagent ids to cancel. */
export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to cancel, e.g. ["sa-1", "sa-2"]',
};

/** Describes nonblocking inspection of a subagent without consuming its result. */
export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
  "Peek at a subagent's status and recent activity without blocking. Does not consume its result.";

/** Model-facing schema description for the subagent id to inspect. */
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id",
};

/** Describes listing all tracked running and settled subagents. */
export const SUBAGENT_LIST_TOOL_DESCRIPTION =
  "List all subagents (running and finished) with their harness and status.";

/** Builds the child completion/failure wrapper injected into the parent model's context. */
export function buildSubagentResultMessage(options: {
  id: string;
  title: string;
  status: "running" | "done" | "error";
  errorText?: string;
  output: string;
}) {
  const verb = options.status === "error" ? "failed" : "finished";
  let text = `Subagent ${options.id} "${options.title}" ${verb}.`;
  if (options.errorText) text += `\nError: ${options.errorText}`;
  text += `\n\n${options.output}`;
  return text;
}

export function buildSubagentResultBatchMessage(options: {
  results: ReadonlyArray<{
    id: string;
    title: string;
    status: "running" | "done" | "error";
    errorText?: string;
    output: string;
  }>;
  remaining: ReadonlyArray<{ id: string; title: string }>;
}) {
  const sections = options.results.map((result) =>
    buildSubagentResultMessage(result),
  );
  sections.push(
    options.remaining.length > 0
      ? `${options.remaining.length} other subagent${options.remaining.length === 1 ? " is" : "s are"} still running: ${options.remaining.map((item) => `${item.id} “${item.title}”`).join(", ")}.`
      : "No other subagents are running.",
  );
  return sections.join("\n\n---\n\n");
}
