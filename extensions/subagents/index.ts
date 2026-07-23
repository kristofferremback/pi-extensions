/**
 * Subagents — spawn background subagents on one of three backends
 * (pi, Claude Code, Codex) unified behind a single Effect service interface.
 *
 * Tools (for the parent LLM):
 * - subagent_spawn: fire-and-forget spawn (prompt, title, agent, working_dir,
 *   model, reasoning_effort). Max 4 running at once across all backends.
 * - subagent_run: spawn and collect one dependency in one blocking call.
 * - subagent_worktree_run: create a retained branch/worktree and run there.
 * - subagent_wait: event-driven wait for all or the next settlement.
 * - subagent_cancel: stop one or more running subagents.
 * - subagent_check: peek at a subagent's status and recent activity.
 * - subagent_list: list all subagents.
 *
 * Unawaited settlements are coalesced and steered into the parent at the next
 * model boundary. `/subagents` opens a picker + full takeover view.
 *
 * Architecture: Effect v4 generators throughout (backends -> manager ->
 * runtime); this file is the async boundary where tool handlers run effects
 * against one shared ManagedRuntime. All three backends are real: pi runs
 * in-process SDK sessions, claude drives the Claude Agent SDK, codex speaks
 * JSON-RPC to a scoped `codex app-server` process.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getAgentDir,
  getMarkdownTheme,
  ProjectTrustStore,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { deriveBtwTitle, isModelVisible } from "./src/by-the-way.ts";
import {
  BACKEND_NAMES,
  formatElapsed,
  latestText,
  REASONING_EFFORTS,
  type SubagentSnapshot,
} from "./src/domain.ts";
import {
  formatActivityStatus,
  formatContextUtilization,
} from "./src/format.ts";
import { SubagentManager, type SubagentManagerShape } from "./src/manager.ts";
import {
  buildSubagentResultBatchMessage,
  buildSubagentResultMessage,
  buildSubagentSpawnResult,
  SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CANCEL_TOOL_DESCRIPTION,
  SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CHECK_TOOL_DESCRIPTION,
  SUBAGENT_LIST_TOOL_DESCRIPTION,
  SUBAGENT_RUN_PROMPT_SNIPPET,
  SUBAGENT_RUN_TOOL_DESCRIPTION,
  SUBAGENT_WORKTREE_RUN_PROMPT_SNIPPET,
  SUBAGENT_WORKTREE_RUN_TOOL_DESCRIPTION,
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PROMPT_SNIPPET,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
  SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS,
  SUBAGENT_WAIT_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";
import { hasUsage, sumUsage, usageDelta } from "../shared/usage.ts";
import {
  createSubagentRuntime,
  runTool,
  type SubagentRuntime,
} from "./src/runtime.ts";
import { createManagedWorktree, resolveGitCommonDir } from "./src/worktree.ts";
import { openSubagentPicker, openSubagentTakeover } from "./src/ui/takeover.ts";

const SUBAGENT_OUTPUT_MAX_BYTES = 24 * 1024;
const WAIT_OUTPUT_MAX_BYTES = 48 * 1024;
const WAIT_PER_AGENT_MAX_BYTES = 16 * 1024;
const AUTO_DELIVERY_DEBOUNCE_MS = 150;
const AUTO_DELIVERY_OUTPUT_BUDGET = 40 * 1024;

interface SpawnToolParams {
  prompt: string;
  name: string;
  harness: (typeof BACKEND_NAMES)[number];
  working_dir?: string;
  model?: string;
  reasoning_effort?: (typeof REASONING_EFFORTS)[number];
}

interface BtwResultData {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentSnapshot["status"];
  readonly errorText?: string;
  readonly prompt: string;
  readonly answer: string;
  readonly sessionFilePath?: string;
}

function describeSubagent(snap: SubagentSnapshot) {
  const details = [
    `${snap.backend}: ${snap.meta.modelLabel ?? "?"}`,
    formatContextUtilization(snap.usage),
    formatElapsed(snap),
    snap.cwd,
  ].filter(Boolean);
  return `${snap.id} [${snap.status}] "${snap.title}" (${details.join(", ")})`;
}

function truncatedOutput(
  snap: SubagentSnapshot,
  maxBytes = SUBAGENT_OUTPUT_MAX_BYTES,
): string {
  const output = snap.finalText || "(no output)";
  const truncation = truncateHead(output, {
    maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
    maxLines: Math.min(600, DEFAULT_MAX_LINES),
  });
  let text = truncation.content;
  if (truncation.truncated) {
    text += `\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} shown. Full transcript in session file: ${snap.meta.sessionFilePath ?? "?"}]`;
  }
  return text;
}

/**
 * Same-directory children inherit the live parent decision. An alternate cwd
 * is trusted only when pi's persisted trust store explicitly trusts it (or a
 * containing directory); unreadable/invalid trust data fails closed.
 */
function resolveChildProjectTrust(options: {
  parentCwd: string;
  childCwd: string;
  parentTrusted: boolean;
}) {
  if (path.resolve(options.childCwd) === path.resolve(options.parentCwd)) {
    return options.parentTrusted;
  }
  try {
    const trustStore = new ProjectTrustStore(getAgentDir());
    return trustStore.get(options.childCwd) === true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  let runtime: SubagentRuntime | undefined;
  let managerPromise: Promise<SubagentManagerShape> | undefined;
  let sessionContext: ExtensionContext | undefined;
  let ui: ExtensionUIContext | undefined;
  let unsubStatus: (() => void) | undefined;
  let activeManager: SubagentManagerShape | undefined;
  let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
  const resultDelivery = createDeferredResultDelivery<SubagentSnapshot>();
  const accountedUsage = new Map<string, Usage>();
  const auditedUsage = new Map<string, Usage>();
  const failedToolUsage = new Map<string, Usage>();

  const getRuntime = () => (runtime ??= createSubagentRuntime());

  /** Resolve the manager service once per runtime and wire the extension hooks. */
  const getManager = () => {
    managerPromise ??= getRuntime()
      .runPromise(SubagentManager)
      .then((manager) => {
        activeManager = manager;
        manager.view.setOnSettled(onSettled);
        unsubStatus?.();
        unsubStatus = manager.view.subscribe(() => updateStatus(manager));
        updateStatus(manager);
        return manager;
      });
    return managerPromise;
  };

  const updateStatus = (manager: SubagentManagerShape) => {
    if (!ui) return;
    const subs = manager.view.list();
    if (subs.length === 0) {
      ui.setStatus("subagents", undefined);
      return;
    }
    const running = subs.filter((snap) => snap.status === "running").length;
    const failed = subs.filter((snap) => snap.status === "error").length;
    const done = subs.length - running - failed;
    ui.setStatus(
      "subagents",
      formatActivityStatus(ui.theme, { running, done, failed }),
    );
  };

  const collectUsage = (snap: SubagentSnapshot) => {
    const cumulative = snap.usage.billing;
    if (!cumulative) return undefined;
    const delta = usageDelta(cumulative, accountedUsage.get(snap.id));
    accountedUsage.set(snap.id, structuredClone(cumulative));
    return hasUsage(delta) ? delta : undefined;
  };

  const flushResults = () => {
    if (deliveryTimer) clearTimeout(deliveryTimer);
    deliveryTimer = undefined;
    const results = resultDelivery.drain();
    if (results.length === 0) return;
    const remaining = (activeManager?.view.list() ?? [])
      .filter((snap) => snap.origin === "model" && snap.status === "running")
      .map((snap) => ({ id: snap.id, title: snap.title }));
    const perResultBudget = Math.max(
      2 * 1024,
      Math.min(
        12 * 1024,
        Math.floor(AUTO_DELIVERY_OUTPUT_BUDGET / results.length),
      ),
    );
    const content = buildSubagentResultBatchMessage({
      results: results.map((snap) => ({
        id: snap.id,
        title: snap.title,
        status: snap.status,
        errorText: snap.errorText,
        output: truncatedOutput(snap, perResultBudget),
      })),
      remaining,
    });
    pi.sendMessage(
      {
        customType: "subagent-result",
        content,
        display: true,
        details: {
          id: results.length === 1 ? results[0]?.id : undefined,
          title: results.length === 1 ? results[0]?.title : undefined,
          status: results.some((snap) => snap.status === "error")
            ? "error"
            : "done",
          count: results.length,
          remaining: remaining.length,
        },
      },
      // Yield at the next model boundary rather than waiting for the parent
      // run to finish. Near-simultaneous settles are coalesced above.
      { deliverAs: "steer", triggerTurn: true },
    );
    // Custom messages cannot carry Pi Usage yet. Persist an audit record so
    // automatic deliveries remain diagnosable; explicit wait/run collection
    // returns the same usage on its tool result for native session totals.
    for (const snap of results) {
      if (!snap.usage.billing) continue;
      const delta = usageDelta(snap.usage.billing, auditedUsage.get(snap.id));
      auditedUsage.set(snap.id, structuredClone(snap.usage.billing));
      if (hasUsage(delta)) {
        pi.appendEntry("subagent-usage", {
          id: snap.id,
          usage: delta,
          accountedInToolResult: false,
        });
      }
    }
  };

  const scheduleResultFlush = () => {
    if (deliveryTimer) return;
    deliveryTimer = setTimeout(flushResults, AUTO_DELIVERY_DEBOUNCE_MS);
    deliveryTimer.unref?.();
  };

  const deliverBtwResult = (snap: SubagentSnapshot) => {
    // appendEntry is a synchronous SessionManager operation and emits an
    // entry_appended event, so it is safe while the parent is streaming and
    // never enters the model's context or follow-up queue.
    pi.appendEntry<BtwResultData>("btw-result", {
      id: snap.id,
      title: snap.title,
      status: snap.status,
      errorText: snap.errorText,
      prompt: snap.prompt,
      answer: truncatedOutput(snap),
      sessionFilePath: snap.meta.sessionFilePath,
    });
    ui?.notify(
      snap.status === "error"
        ? `by the way “${snap.title}” failed — reopen it with /subagents`
        : `by the way “${snap.title}” answered — reopen it with /subagents`,
      snap.status === "error" ? "error" : "info",
    );
  };

  const onSettled = (snap: SubagentSnapshot, consumed: boolean) => {
    // A shutdown can settle children while disposing their scopes. Never
    // append into a session whose extension runtime is already closing.
    if (!sessionContext) return;
    if (snap.origin === "btw") {
      deliverBtwResult({ ...snap, meta: { ...snap.meta } });
      return;
    }
    if (consumed) {
      resultDelivery.consume([snap.id]);
      return;
    }
    // Keep the result briefly retractable so a concurrently starting wait can
    // consume it before the coalesced steer is queued. Defer a copy: the live
    // snapshot keeps mutating if the subagent is restarted later.
    resultDelivery.defer({ ...snap, meta: { ...snap.meta } });
    scheduleResultFlush();
  };

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
    if (ctx.hasUI) ui = ctx.ui;
  });

  pi.on("agent_settled", scheduleResultFlush);

  pi.on("session_shutdown", async () => {
    sessionContext = undefined;
    if (deliveryTimer) clearTimeout(deliveryTimer);
    deliveryTimer = undefined;
    resultDelivery.clear();
    accountedUsage.clear();
    auditedUsage.clear();
    failedToolUsage.clear();
    activeManager = undefined;
    unsubStatus?.();
    unsubStatus = undefined;
    ui?.setStatus("subagents", undefined);
    ui = undefined;
    const closing = runtime;
    runtime = undefined;
    managerPromise = undefined;
    // Disposing the runtime runs the manager finalizer, which tears down all
    // subagent scopes (and, later, their real child processes).
    await closing?.dispose();
  });

  pi.on("tool_result", (event) => {
    if (
      event.toolName !== "subagent_run" &&
      event.toolName !== "subagent_worktree_run"
    ) {
      return;
    }
    const usage = failedToolUsage.get(event.toolCallId);
    if (!usage) return;
    failedToolUsage.delete(event.toolCallId);
    return { usage };
  });

  // --- Tools -------------------------------------------------------------

  const spawnForTool = async (
    params: SpawnToolParams,
    ctx: ExtensionContext,
    delivery: "automatic" | "manual",
    projectTrustedOverride?: boolean,
  ) => {
    const manager = await getManager();
    const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error(`working_dir is not a directory: ${cwd}`);
    }
    const title = params.name.trim().slice(0, 160) || "subagent";
    const snap = await runTool(
      getRuntime(),
      manager.spawn(params.harness, {
        prompt: params.prompt,
        title,
        cwd,
        delivery,
        model: params.model,
        reasoningEffort: params.reasoning_effort,
        parent: {
          parentCwd: ctx.cwd,
          projectTrusted:
            projectTrustedOverride ??
            resolveChildProjectTrust({
              parentCwd: ctx.cwd,
              childCwd: cwd,
              parentTrusted: ctx.isProjectTrusted(),
            }),
          inheritedModel: ctx.model
            ? { provider: ctx.model.provider, id: ctx.model.id }
            : undefined,
          inheritedThinkingLevel: pi.getThinkingLevel(),
          modelRegistry: ctx.modelRegistry,
        },
      }),
    );
    return { manager, snap, cwd };
  };

  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    promptSnippet: SUBAGENT_SPAWN_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_SPAWN_PROMPT_GUIDELINES,
    parameters: Type.Object({
      prompt: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
      }),
      name: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.name,
      }),
      harness: StringEnum(BACKEND_NAMES, {
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.harness,
      }),
      working_dir: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.workingDir,
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.model,
        }),
      ),
      reasoning_effort: Type.Optional(
        StringEnum(REASONING_EFFORTS, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { snap, cwd } = await spawnForTool(
        params as SpawnToolParams,
        ctx,
        "automatic",
      );

      return {
        content: [
          {
            type: "text",
            text: buildSubagentSpawnResult({
              id: snap.id,
              title: snap.title,
              harness: params.harness,
              modelLabel: snap.meta.modelLabel ?? "?",
              cwd,
            }),
          },
        ],
        details: {
          id: snap.id,
          title: snap.title,
          cwd,
          harness: params.harness,
          model: snap.meta.modelLabel,
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_run",
    label: "Run Subagent",
    description: SUBAGENT_RUN_TOOL_DESCRIPTION,
    promptSnippet: SUBAGENT_RUN_PROMPT_SNIPPET,
    parameters: Type.Object({
      prompt: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
      }),
      name: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.name,
      }),
      harness: StringEnum(BACKEND_NAMES, {
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.harness,
      }),
      working_dir: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.workingDir,
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.model,
        }),
      ),
      reasoning_effort: Type.Optional(
        StringEnum(REASONING_EFFORTS, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
        }),
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { manager, snap } = await spawnForTool(
        params as SpawnToolParams,
        ctx,
        "manual",
      );
      try {
        await runTool(
          getRuntime(),
          manager.waitFor([snap.id], (pending) => {
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `Running ${pending.join(", ")}…`,
                },
              ],
              details: { pending },
            });
          }),
          {
            signal,
            interruptMessage: "Run aborted; cancelling the subagent.",
          },
        );
      } catch (error) {
        await runTool(getRuntime(), manager.cancel([snap.id])).catch(() => {});
        const failed = manager.view.get(snap.id) ?? snap;
        const usage = collectUsage(failed);
        if (usage) failedToolUsage.set(toolCallId, usage);
        throw error;
      }

      resultDelivery.consume([snap.id]);
      const settled = manager.view.get(snap.id) ?? snap;
      const usage = collectUsage(settled);
      return {
        content: [
          {
            type: "text",
            text: buildSubagentResultMessage({
              id: settled.id,
              title: settled.title,
              status: settled.status,
              errorText: settled.errorText,
              output: truncatedOutput(settled, WAIT_OUTPUT_MAX_BYTES),
            }),
          },
        ],
        details: {
          id: settled.id,
          title: settled.title,
          status: settled.status,
        },
        ...(usage ? { usage } : {}),
      };
    },
  });

  pi.registerTool({
    name: "subagent_worktree_run",
    label: "Run Subagent in Worktree",
    description: SUBAGENT_WORKTREE_RUN_TOOL_DESCRIPTION,
    promptSnippet: SUBAGENT_WORKTREE_RUN_PROMPT_SNIPPET,
    parameters: Type.Object({
      prompt: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
      }),
      name: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.name,
      }),
      harness: StringEnum(BACKEND_NAMES, {
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.harness,
      }),
      repo: Type.Optional(
        Type.String({
          description:
            "Git repository path (default: current working directory).",
        }),
      ),
      branch: Type.String({
        description: "New branch name for the retained worktree.",
      }),
      base: Type.Optional(
        Type.String({ description: "Base revision (default: HEAD)." }),
      ),
      worktree_path: Type.Optional(
        Type.String({
          description:
            "Destination path. Relative paths resolve from the repository root; omitted creates a unique sibling directory.",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.model,
        }),
      ),
      reasoning_effort: Type.Optional(
        StringEnum(REASONING_EFFORTS, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
        }),
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: "text", text: "Creating managed worktree…" }],
        details: { phase: "worktree" },
      });
      const worktree = await createManagedWorktree(pi, {
        repo: path.resolve(ctx.cwd, params.repo ?? "."),
        branch: params.branch,
        base: params.base,
        worktreePath: params.worktree_path,
        signal,
      });
      let worktreeTrusted = resolveChildProjectTrust({
        parentCwd: ctx.cwd,
        childCwd: worktree.repoRoot,
        parentTrusted: ctx.isProjectTrusted(),
      });
      if (ctx.isProjectTrusted()) {
        try {
          const parentCommonDir = await resolveGitCommonDir(
            pi,
            ctx.cwd,
            signal,
          );
          if (parentCommonDir === worktree.commonDir) worktreeTrusted = true;
        } catch {
          // Persisted trust resolution above remains the fail-closed fallback.
        }
      }
      let spawned: Awaited<ReturnType<typeof spawnForTool>>;
      try {
        spawned = await spawnForTool(
          {
            prompt: params.prompt,
            name: params.name,
            harness: params.harness,
            working_dir: worktree.path,
            model: params.model,
            reasoning_effort: params.reasoning_effort,
          },
          ctx,
          "manual",
          worktreeTrusted,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Managed worktree was retained at ${worktree.path}, but the subagent failed to start: ${message}`,
        );
      }
      const { manager, snap } = spawned;
      try {
        await runTool(
          getRuntime(),
          manager.waitFor([snap.id], (pending) => {
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `Running ${pending.join(", ")} in ${worktree.path}…`,
                },
              ],
              details: { phase: "agent", pending, worktree },
            });
          }),
          {
            signal,
            interruptMessage: "Run aborted; cancelling the subagent.",
          },
        );
      } catch (error) {
        await runTool(getRuntime(), manager.cancel([snap.id])).catch(() => {});
        const failed = manager.view.get(snap.id) ?? snap;
        const usage = collectUsage(failed);
        if (usage) failedToolUsage.set(toolCallId, usage);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${message} Retained worktree: ${worktree.path} (branch ${worktree.branch}).`,
        );
      }

      const settled = manager.view.get(snap.id) ?? snap;
      const usage = collectUsage(settled);
      return {
        content: [
          {
            type: "text",
            text: `${buildSubagentResultMessage({
              id: settled.id,
              title: settled.title,
              status: settled.status,
              errorText: settled.errorText,
              output: truncatedOutput(settled, WAIT_OUTPUT_MAX_BYTES),
            })}\n\nRetained worktree: ${worktree.path}\nBranch: ${worktree.branch} (base ${worktree.base})`,
          },
        ],
        details: {
          id: settled.id,
          title: settled.title,
          status: settled.status,
          worktree,
        },
        ...(usage ? { usage } : {}),
      };
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagents",
    description: SUBAGENT_WAIT_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        maxItems: 64,
        description: SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.ids,
      }),
      mode: Type.Optional(
        StringEnum(["all", "next"] as const, {
          description: SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.mode,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");
      const known = manager.view
        .list()
        .filter(isModelVisible)
        .map((snap) => snap.id);
      const unknown = ids.filter((id) => {
        const snap = manager.view.get(id);
        return !snap || !isModelVisible(snap);
      });
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      const notifyPending = (pending: string[]) => {
        onUpdate?.({
          content: [
            { type: "text", text: `Waiting for ${pending.join(", ")}...` },
          ],
          details: { pending },
        });
      };
      const mode = params.mode ?? "all";
      let settledIds: string[];
      let pendingIds: string[];
      if (mode === "next") {
        const outcome = await runTool(
          getRuntime(),
          manager.waitForNext(ids, notifyPending),
          {
            signal,
            interruptMessage: "Wait aborted. Subagents keep running.",
          },
        );
        settledIds = outcome.settled;
        pendingIds = outcome.pending;
      } else {
        await runTool(getRuntime(), manager.waitFor(ids, notifyPending), {
          signal,
          interruptMessage: "Wait aborted. Subagents keep running.",
        });
        settledIds = ids;
        pendingIds = [];
      }

      // Remove only results returned by this invocation. In next mode the
      // remaining children retain automatic push delivery.
      resultDelivery.consume(settledIds);

      const sections: string[] = [];
      let remainingBytes = WAIT_OUTPUT_MAX_BYTES;
      const settledSnapshots: SubagentSnapshot[] = [];
      for (const id of settledIds) {
        const snap = manager.view.get(id);
        if (!snap) {
          sections.push(`## ${id}\n\n(no longer tracked)`);
          continue;
        }
        settledSnapshots.push(snap);
        const verb = snap.status === "error" ? "failed" : "finished";
        let section = `## ${snap.id} "${snap.title}" ${verb}`;
        if (snap.errorText) section += `\nError: ${snap.errorText}`;
        const headerBytes = Buffer.byteLength(section, "utf8") + 2;
        const outputBudget = Math.max(
          512,
          Math.min(WAIT_PER_AGENT_MAX_BYTES, remainingBytes - headerBytes),
        );
        section += `\n\n${truncatedOutput(snap, outputBudget)}`;
        const sectionBytes = Buffer.byteLength(section, "utf8");
        if (sectionBytes > remainingBytes) {
          sections.push(
            `## ${snap.id} "${snap.title}"\n\n[omitted: total wait output limit reached]`,
          );
          break;
        }
        sections.push(section);
        remainingBytes -= sectionBytes;
      }
      sections.push(
        pendingIds.length > 0
          ? `${pendingIds.length} selected subagent${pendingIds.length === 1 ? " is" : "s are"} still running: ${pendingIds.join(", ")}.`
          : "No selected subagents are still running.",
      );

      const combined = sections.join("\n\n---\n\n");
      const bounded = truncateHead(combined, {
        maxBytes: WAIT_OUTPUT_MAX_BYTES - 128,
        maxLines: DEFAULT_MAX_LINES,
      });
      const text = bounded.truncated
        ? `${bounded.content}\n\n[wait output truncated at the total output limit]`
        : bounded.content;
      const usage = sumUsage(settledSnapshots.map(collectUsage));
      return {
        content: [{ type: "text", text }],
        details: {
          mode,
          results: settledSnapshots.map((snap) => ({
            id: snap.id,
            title: snap.title,
            status: snap.status,
          })),
          pending: pendingIds,
        },
        ...(hasUsage(usage) ? { usage } : {}),
      };
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Subagents",
    description: SUBAGENT_CANCEL_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");

      const known = manager.view
        .list()
        .filter(isModelVisible)
        .map((snap) => snap.id);
      const unknown = ids.filter((id) => {
        const snap = manager.view.get(id);
        return !snap || !isModelVisible(snap);
      });
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      const report = await runTool(getRuntime(), manager.cancel(ids));
      resultDelivery.consume(ids);
      const usage = sumUsage(
        ids.map((id) => {
          const snap = manager.view.get(id);
          return snap ? collectUsage(snap) : undefined;
        }),
      );

      const lines = report.map((entry) =>
        entry.cancelled
          ? `Cancelled ${entry.id} "${entry.title}".`
          : `${entry.id} "${entry.title}" was already ${entry.status}.`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          results: report.map((entry) => ({
            id: entry.id,
            title: entry.title,
            status: entry.status,
          })),
        },
        ...(hasUsage(usage) ? { usage } : {}),
      };
    },
  });

  pi.registerTool({
    name: "subagent_check",
    label: "Check Subagent",
    description: SUBAGENT_CHECK_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS.id,
      }),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      const snap = manager.view.get(params.id);
      if (!snap || !isModelVisible(snap)) {
        const known = manager.view
          .list()
          .filter(isModelVisible)
          .map((s) => s.id);
        throw new Error(
          `Unknown subagent id "${params.id}". Known: ${known.join(", ") || "none"}.`,
        );
      }

      let text = `${describeSubagent(snap)}\nTurns: ${snap.turns}`;
      if (snap.errorText) text += `\nError: ${snap.errorText}`;

      const output = latestText(snap);
      if (output) {
        const preview = truncateHead(output, { maxBytes: 2048, maxLines: 20 });
        text += `\n\nLatest output:\n${preview.content}`;
        if (preview.truncated) text += "\n[...]";
      } else if (snap.status === "running") {
        text += "\n\n(no text output yet)";
      }

      return {
        content: [{ type: "text", text }],
        details: { id: snap.id, status: snap.status, turns: snap.turns },
      };
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: SUBAGENT_LIST_TOOL_DESCRIPTION,
    parameters: Type.Object({}),
    async execute() {
      const manager = await getManager();
      const subs = manager.view.list().filter(isModelVisible);
      const text =
        subs.length === 0
          ? "No subagents."
          : subs.map((snap) => describeSubagent(snap)).join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          subagents: subs.map((snap) => ({
            id: snap.id,
            title: snap.title,
            harness: snap.backend,
            status: snap.status,
          })),
        },
      };
    },
  });

  // --- Result message rendering ------------------------------------------

  pi.registerMessageRenderer(
    "subagent-result",
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
        id?: string;
        title?: string;
        status?: string;
        count?: number;
        remaining?: number;
      };
      const failed = details.status === "error";
      const count = details.count ?? 1;
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const label =
        count > 1
          ? `${count} subagents settled`
          : `subagent ${details.id ?? "?"}`;
      const suffix =
        count > 1
          ? ` · ${details.remaining ?? 0} running`
          : ` · ${details.title ?? ""} · ${failed ? "failed" : "finished"}`;
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(label)) +
        theme.fg("muted", suffix);

      const content =
        typeof message.content === "string" ? message.content : "";
      // A single-result card repeats its summary in the header; batch cards
      // retain every result heading so no child identity is lost.
      const body =
        count > 1
          ? content.trim()
          : content.split("\n").slice(1).join("\n").trim();

      if (expanded) {
        const md = new Markdown(`${body}`, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const previewLines = body.split("\n").slice(0, 8);
      let text = header;
      for (const line of previewLines)
        text += `\n${theme.fg("toolOutput", line)}`;
      if (body.split("\n").length > 8)
        text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
    },
  );

  pi.registerEntryRenderer<BtwResultData>(
    "btw-result",
    (entry, { expanded }, theme) => {
      const data = entry.data;
      const failed = data?.status === "error";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`by the way · ${data?.title ?? "?"}`)) +
        theme.fg(
          "muted",
          ` · ${failed ? "failed" : "answered"} · ${data?.id ?? "?"}`,
        );
      const body = [
        data?.errorText ? `Error: ${data.errorText}` : "",
        data?.answer ?? "(no answer)",
      ]
        .filter(Boolean)
        .join("\n\n");

      if (expanded) {
        const md = new Markdown(body, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const lines = body.split("\n");
      let text = header;
      for (const line of lines.slice(0, 8))
        text += `\n${theme.fg("toolOutput", line)}`;
      if (lines.length > 8)
        text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
    },
  );

  // --- Commands -----------------------------------------------------------

  const runByTheWay = async (rawArgs: string, ctx: ExtensionCommandContext) => {
    if (ctx.mode !== "tui") {
      if (ctx.hasUI)
        ctx.ui.notify("by the way is only available in the TUI", "error");
      return;
    }

    let prompt = rawArgs.trim();
    if (!prompt) {
      const input = await ctx.ui.input("by the way", "Ask a one-off question…");
      prompt = input?.trim() ?? "";
      if (!prompt) return;
    }

    const manager = await getManager();
    let snap: SubagentSnapshot;
    try {
      snap = await runTool(
        getRuntime(),
        manager.spawn("pi", {
          origin: "btw",
          prompt,
          title: deriveBtwTitle(prompt),
          cwd: ctx.cwd,
          parent: {
            parentCwd: ctx.cwd,
            projectTrusted: ctx.isProjectTrusted(),
            inheritedModel: ctx.model
              ? { provider: ctx.model.provider, id: ctx.model.id }
              : undefined,
            inheritedThinkingLevel: pi.getThinkingLevel(),
            modelRegistry: ctx.modelRegistry,
          },
        }),
      );
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
      return;
    }

    await openSubagentTakeover(ctx, manager.view, snap.id, {
      badge: "by the way",
    });
  };

  pi.registerCommand("btw", {
    description:
      "Ask a one-off side question while the main agent keeps working",
    handler: runByTheWay,
  });

  pi.registerCommand("subagents", {
    description: "List, inspect, and take over subagents",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify(
            "Subagent takeover is only available in the TUI",
            "error",
          );
        return;
      }
      const manager = await getManager();
      if (manager.view.size() === 0) {
        ctx.ui.notify(
          "No subagents yet. The agent spawns them with subagent_spawn.",
          "info",
        );
        return;
      }
      await openSubagentPicker(ctx, manager.view);
    },
  });
}
