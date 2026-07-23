/**
 * workflows: model-authored multi-agent orchestration.
 *
 * A `workflow` tool that runs a JavaScript orchestration script written inline
 * by the model. The script executes ordered phases, fanning work out to
 * isolated subagents:
 *
 *   export const meta = { name, description, phases: [{ title, detail? }] }
 *   phase(title)                                  // mark runtime phase progression
 *   await agent(prompt, { label?, phase?, schema?, model?, provider?, effort? })
 *   await parallel([() => agent(...), ...], { concurrency? })
 *   args                                          // parsed JSON args passed with the tool call
 *
 * `agent()` always resolves to `{ ok, output, structured?, error? }` — it
 * never throws into the script. Scripts branch on `ok` explicitly.
 *
 * Runs are blocking by default (live progress in the tool block). Pass
 * `background: true` to return immediately and get a coalesced steer event at
 * the next model boundary when the run finishes. Run artifacts are saved
 * under `~/.pi/agent/workflows/<runId>/` for inspection; result and bounded
 * transcripts use separate artifacts, and there is no resume.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import * as path from "node:path";
import {
  DEFAULT_MAX_LINES,
  getAgentDir,
  getMarkdownTheme,
  keyHint,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { formatActivityStatus } from "../shared/activity-status.ts";
import { hasUsage, sumUsage, usageDelta } from "../shared/usage.ts";
import {
  SubagentManager,
  type SubagentManagerShape,
} from "../subagents/src/manager.ts";
import {
  createSubagentRuntime,
  runTool as runSubagentTool,
  type SubagentRuntime,
} from "../subagents/src/runtime.ts";
import type {
  BackendName,
  SubagentSnapshot,
  TranscriptItem,
} from "../subagents/src/domain.ts";
import { createWorkflowPersistence, persistWorkflowJson } from "./artifacts.ts";
import { RunController } from "./controller.ts";
import { sessionWorkflowRunIds, showWorkflowDashboard } from "./dashboard.ts";
import {
  extractMeta,
  prepareWorkflowScript,
  type WorkflowMeta,
} from "./meta.ts";
import {
  agentContext,
  aggregateUsage,
  countStates,
  emptyUsage,
  formatElapsed,
  formatUsage,
  phaseGroups,
  resultJson,
  stateSquare,
  statusColor,
  statusWord,
  SQUARE,
  type AgentRecord,
  type TranscriptEntry,
  type WorkflowDetails,
} from "./model.ts";
import {
  buildBackgroundWorkflowFollowUp,
  buildBackgroundWorkflowLaunchResult,
  buildWorkflowAgentPrompt,
  buildWorkflowResultMessage,
  WORKFLOW_PARAMETER_DESCRIPTIONS,
  WORKFLOW_PROMPT_GUIDELINES,
  WORKFLOW_PROMPT_SNIPPET,
  WORKFLOW_TOOL_DESCRIPTION,
} from "./prompt.ts";
import {
  createWorkflowResources,
  runAgent,
  type ThinkingLevel,
  type WorkflowModel,
} from "./runner.ts";
import { runWorkflowSandbox } from "./sandbox.ts";
import { safeStringify, writeFileAtomic } from "./serialization.ts";

const PREVIEW_LENGTH = 200;
const EMIT_INTERVAL_MS = 120;
const BACKGROUND_DELIVERY_DEBOUNCE_MS = 150;
const BACKGROUND_DELIVERY_OUTPUT_BUDGET = 40 * 1024;

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** What `agent()` resolves to inside the script. */
interface ScriptAgentResult {
  ok: boolean;
  output: string;
  structured?: unknown;
  error?: string;
}

interface AgentCallOptions {
  label?: unknown;
  phase?: unknown;
  schema?: unknown;
  harness?: unknown;
  model?: unknown;
  provider?: unknown;
  effort?: unknown;
}

const WorkflowParams = Type.Object({
  script: Type.String({
    description: WORKFLOW_PARAMETER_DESCRIPTIONS.script,
  }),
  args: Type.Optional(
    Type.String({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.args,
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.background,
    }),
  ),
});

type WorkflowInput = Static<typeof WorkflowParams>;

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    16 * 1024,
  );
}

const WORKFLOW_HARNESSES = new Set<BackendName>(["pi", "claude", "codex"]);
const ALLOWED_PI_WORKFLOW_PROVIDERS = new Set(["openai-codex", "opencode-go"]);

function workflowTranscript(items: ReadonlyArray<TranscriptItem>) {
  const transcript: TranscriptEntry[] = [];
  for (const item of items) {
    if (item.kind === "user") {
      transcript.push({ role: "user", text: item.text });
      continue;
    }
    if (item.kind === "toolResult") {
      transcript.push({
        role: "toolResult",
        text: item.outputPreview ?? "",
        name: item.name,
        toolCallId: item.toolId,
        isError: item.isError,
      });
      continue;
    }
    for (const part of item.parts) {
      if (part.type === "text") {
        transcript.push({ role: "assistant", text: part.text });
      } else if (part.type === "thinking") {
        transcript.push({ role: "thinking", text: part.text });
      } else {
        transcript.push({
          role: "tool",
          text: part.argsPreview ?? "",
          name: part.name,
          toolCallId: part.toolId,
        });
      }
    }
  }
  return transcript;
}

function parseStructuredOutput(output: string, schema: unknown) {
  const trimmed = output.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) candidates.push(fenced);
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = trimmed.indexOf(open);
    const end = trimmed.lastIndexOf(close);
    if (start >= 0 && end > start)
      candidates.push(trimmed.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Check(schema as TSchema, parsed)) return parsed;
    } catch {
      // Try the next bounded extraction candidate.
    }
  }
  throw new Error("agent returned no JSON value matching the requested schema");
}

function externalStructuredPrompt(prompt: string, schema: unknown) {
  if (schema === undefined) return prompt;
  return `${prompt}\n\nReturn your final answer as JSON only, matching this JSON Schema exactly:\n${JSON.stringify(schema)}`;
}

function summaryLine(details: WorkflowDetails): string {
  const { done, failed } = countStates(details);
  const settled = done + failed;
  return `workflow ${details.name ?? details.runId}: ${settled}/${details.agents.length} agents${
    details.currentPhase ? ` · ${details.currentPhase}` : ""
  }`;
}

function writeRunFile(runDir: string, name: string, content: string) {
  writeFileAtomic(path.join(runDir, name), content);
}

function compactToolDetails(details: WorkflowDetails): WorkflowDetails {
  return {
    ...details,
    ...(details.result !== undefined
      ? {
          result: JSON.parse(
            safeStringify(details.result, { maxBytes: 64 * 1024 }),
          ),
        }
      : {}),
    agents: details.agents.map((agent) => ({ ...agent, transcript: [] })),
  };
}

interface RunSummary {
  runId: string;
  name?: string;
  status: string;
  done: number;
  total: number;
  startedAt: number;
  active: boolean;
}

function listRuns(
  activeRuns: Map<string, WorkflowDetails>,
  sessionId: string,
  referencedRunIds: ReadonlySet<string>,
): RunSummary[] {
  const base = path.join(getAgentDir(), "workflows");
  let names: string[] = [];
  try {
    names = fs.readdirSync(base).filter((name) => name.startsWith("wf_"));
  } catch {
    // No runs yet.
  }
  const summaries: RunSummary[] = [];
  for (const runId of names) {
    const live = activeRuns.get(runId);
    if (live) {
      const { done, failed } = countStates(live);
      summaries.push({
        runId,
        name: live.name,
        status: live.status,
        done: done + failed,
        total: live.agents.length,
        startedAt: live.startedAt,
        active: true,
      });
      continue;
    }
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(base, runId, "workflow.json"), "utf8"),
      ) as Partial<WorkflowDetails>;
      if (parsed.sessionId !== sessionId && !referencedRunIds.has(runId)) {
        continue;
      }
      const agents = parsed.agents ?? [];
      summaries.push({
        runId,
        name: parsed.name,
        status:
          parsed.status === "running"
            ? "aborted"
            : (parsed.status ?? "unknown"),
        done: agents.filter((agent) => agent.state !== "running").length,
        total: agents.length,
        startedAt: parsed.startedAt ?? 0,
        active: false,
      });
    } catch {
      // Ignore unreadable artifacts because their session cannot be verified.
    }
  }
  return summaries.sort((a, b) => b.startedAt - a.startedAt);
}

function runDetailText(
  run: RunSummary,
  activeRuns: Map<string, WorkflowDetails>,
): string {
  const runDir = path.join(getAgentDir(), "workflows", run.runId);
  const live = activeRuns.get(run.runId);
  if (live) return buildWorkflowResultMessage(live, runDir);
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(runDir, "workflow.json"), "utf8"),
    ) as WorkflowDetails;
    return buildWorkflowResultMessage(parsed, runDir);
  } catch {
    return `Run ${run.runId} — ${run.status}`;
  }
}

export default function workflows(pi: ExtensionAPI) {
  /** Live background runs, for /workflows and shutdown cleanup. */
  const activeRuns = new Map<
    string,
    {
      details: WorkflowDetails;
      controller: RunController;
      completion?: Promise<void>;
    }
  >();
  let sessionActive = false;
  const accountedWorkflowUsage = new Map<string, Usage>();
  const failedToolUsage = new Map<string, Usage>();
  const activeDetails = () =>
    new Map(
      [...activeRuns].map(([runId, run]) => [runId, run.details] as const),
    );

  const pendingBackgroundResults: Array<{
    runId: string;
    status: WorkflowDetails["status"];
    result: string;
    usage?: ReturnType<typeof sumUsage>;
  }> = [];
  let backgroundDeliveryTimer: ReturnType<typeof setTimeout> | undefined;
  const flushBackgroundResults = () => {
    if (backgroundDeliveryTimer) clearTimeout(backgroundDeliveryTimer);
    if (!sessionActive) {
      backgroundDeliveryTimer = undefined;
      pendingBackgroundResults.length = 0;
      return;
    }
    backgroundDeliveryTimer = undefined;
    const settled = pendingBackgroundResults.splice(0);
    if (settled.length === 0) return;
    const perResultBudget = Math.max(
      2 * 1024,
      Math.min(
        16 * 1024,
        Math.floor(BACKGROUND_DELIVERY_OUTPUT_BUDGET / settled.length),
      ),
    );
    const content = [
      ...settled.map(({ runId, status, result }) => {
        const bounded = truncateHead(result, {
          maxBytes: perResultBudget,
          maxLines: DEFAULT_MAX_LINES,
        });
        return buildBackgroundWorkflowFollowUp({
          runId,
          status,
          result: bounded.truncated
            ? `${bounded.content}\n[workflow completion output truncated; inspect its run artifacts]`
            : bounded.content,
        });
      }),
      `${activeRuns.size} other workflow${activeRuns.size === 1 ? " is" : "s are"} still running.`,
    ].join("\n\n---\n\n");
    pi.sendMessage(
      {
        customType: "workflow-result",
        content,
        display: true,
        details: {
          count: settled.length,
          failed: settled.filter(({ status }) => status !== "completed").length,
          remaining: activeRuns.size,
        },
      },
      { deliverAs: "steer", triggerTurn: true },
    );
    for (const { runId, usage } of settled) {
      if (hasUsage(usage)) {
        pi.appendEntry("workflow-usage", {
          runId,
          usage,
          accountedInToolResult: false,
        });
      }
    }
  };
  const scheduleBackgroundDelivery = () => {
    if (backgroundDeliveryTimer) return;
    backgroundDeliveryTimer = setTimeout(
      flushBackgroundResults,
      BACKGROUND_DELIVERY_DEBOUNCE_MS,
    );
    backgroundDeliveryTimer.unref?.();
  };

  /** Finished counts remain visible until the dashboard acknowledges them. */
  let lastUi: ExtensionContext["ui"] | undefined;
  let completedRuns = 0;
  let failedRuns = 0;
  const updateIndicator = () => {
    const ui = lastUi;
    if (!ui) return;
    try {
      const running = activeRuns.size;
      if (running === 0 && completedRuns === 0 && failedRuns === 0) {
        ui.setStatus("workflows", undefined);
        return;
      }
      ui.setStatus(
        "workflows",
        formatActivityStatus(ui.theme, "workflows", {
          running,
          done: completedRuns,
          failed: failedRuns,
        }),
      );
    } catch {
      // UI may be unavailable.
    }
  };

  const recordSettledRun = (status: WorkflowDetails["status"]) => {
    if (status === "completed") completedRuns += 1;
    else failedRuns += 1;
  };

  pi.on("session_start", (_event, ctx) => {
    sessionActive = true;
    if (ctx.hasUI) lastUi = ctx.ui;
    updateIndicator();
  });

  pi.on("session_shutdown", async () => {
    sessionActive = false;
    if (backgroundDeliveryTimer) clearTimeout(backgroundDeliveryTimer);
    backgroundDeliveryTimer = undefined;
    pendingBackgroundResults.length = 0;
    accountedWorkflowUsage.clear();
    failedToolUsage.clear();
    const runs = [...activeRuns.values()];
    for (const run of runs) run.controller.abort("Session is shutting down");
    await Promise.all(
      runs.map((run) => run.controller.settle({ abort: true })),
    );
    const completions = runs
      .map((run) => run.completion)
      .filter(
        (completion): completion is Promise<void> => completion !== undefined,
      );
    if (completions.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 8_000);
        timer.unref?.();
      });
      await Promise.race([Promise.allSettled(completions), timeout]);
      if (timer) clearTimeout(timer);
    }
    lastUi?.setStatus("workflows", undefined);
    lastUi = undefined;
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "workflow") return;
    const usage = failedToolUsage.get(event.toolCallId);
    if (!usage) return;
    failedToolUsage.delete(event.toolCallId);
    return { usage };
  });

  pi.registerCommand("workflows", {
    description:
      "List workflow runs (`/workflows <runId>` for one run's detail)",
    handler: async (rawArgs, ctx) => {
      const arg = rawArgs.trim();
      if (ctx.mode === "tui") {
        lastUi = ctx.ui;
        await showWorkflowDashboard(ctx, activeDetails, arg || undefined);
        // Opening the dashboard acknowledges finished runs.
        completedRuns = 0;
        failedRuns = 0;
        updateIndicator();
        return;
      }
      // Non-TUI fallback: plain text listing.
      const runs = listRuns(
        activeDetails(),
        ctx.sessionManager.getSessionId(),
        sessionWorkflowRunIds(ctx),
      );
      if (runs.length === 0) {
        ctx.ui.notify("No workflow runs yet.", "info");
        return;
      }
      if (arg) {
        const run = runs.find((r) => r.runId === arg || r.runId.endsWith(arg));
        ctx.ui.notify(
          run
            ? runDetailText(run, activeDetails())
            : `No workflow run matching "${arg}".`,
          run ? "info" : "warning",
        );
        return;
      }
      const labels = runs.map(
        (r) =>
          `${r.active ? "* " : "  "}${r.runId}  ${r.status}  ${r.name ?? ""}  ${r.done}/${r.total}`,
      );
      if (!ctx.hasUI) {
        ctx.ui.notify(labels.join("\n"), "info");
        return;
      }
      const choice = await ctx.ui.select("Workflow runs", labels);
      if (!choice) return;
      const run = runs[labels.indexOf(choice)];
      if (run) ctx.ui.notify(runDetailText(run, activeDetails()), "info");
    },
  });

  pi.registerTool({
    name: "workflow_wait",
    label: "Wait for Workflows",
    description:
      'Event-driven wait for background workflows without polling. mode="all" waits for every selected run; mode="next" yields after the next selected run settles and reports which runs remain.',
    parameters: Type.Object({
      run_ids: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: 32,
        description: "Active background workflow run ids.",
      }),
      mode: Type.Optional(
        StringEnum(["all", "next"] as const, {
          description:
            '"all" (default) waits for every selected run; "next" returns after the next settlement.',
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const ids = [...new Set(params.run_ids)];
      const selected = ids.map((id) => {
        const run = activeRuns.get(id);
        if (!run || !run.details.background) {
          throw new Error(
            `Unknown active background workflow "${id}". Active: ${
              [...activeRuns.entries()]
                .filter(([, candidate]) => candidate.details.background)
                .map(([runId]) => runId)
                .join(", ") || "none"
            }.`,
          );
        }
        return { id, run };
      });
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Waiting for workflow ${params.mode === "next" ? "progress" : "completion"}: ${ids.join(", ")}…`,
          },
        ],
        details: { pending: ids, mode: params.mode ?? "all" },
      });

      const completions = selected.map(({ run }) =>
        (run.completion ?? Promise.resolve()).catch(() => undefined),
      );
      const wait =
        (params.mode ?? "all") === "next"
          ? Promise.race(completions)
          : Promise.allSettled(completions).then(() => undefined);
      let abortListener: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        abortListener = () =>
          reject(new Error("Workflow wait aborted; workflows keep running."));
        if (signal?.aborted) abortListener();
        else signal?.addEventListener("abort", abortListener, { once: true });
      });
      try {
        await Promise.race([wait, aborted]);
      } finally {
        if (abortListener) signal?.removeEventListener("abort", abortListener);
      }

      const completed = selected.filter(
        ({ run }) => run.details.status !== "running",
      );
      const pending = selected
        .filter(({ run }) => run.details.status === "running")
        .map(({ id }) => id);
      const completedIds = new Set(completed.map(({ id }) => id));
      for (
        let index = pendingBackgroundResults.length - 1;
        index >= 0;
        index--
      ) {
        if (completedIds.has(pendingBackgroundResults[index]!.runId)) {
          pendingBackgroundResults.splice(index, 1);
        }
      }

      const perResultBudget = Math.max(
        2 * 1024,
        Math.min(
          16 * 1024,
          Math.floor(
            BACKGROUND_DELIVERY_OUTPUT_BUDGET / Math.max(1, completed.length),
          ),
        ),
      );
      const sections = completed.map(({ id, run }) => {
        const runDir = path.join(getAgentDir(), "workflows", id);
        const result = buildWorkflowResultMessage(run.details, runDir);
        const bounded = truncateHead(result, {
          maxBytes: perResultBudget,
          maxLines: DEFAULT_MAX_LINES,
        });
        return bounded.truncated
          ? `${bounded.content}\n[workflow result truncated; inspect ${runDir}]`
          : bounded.content;
      });
      sections.push(
        pending.length > 0
          ? `${pending.length} selected workflow${pending.length === 1 ? " is" : "s are"} still running: ${pending.join(", ")}.`
          : "No selected workflows are still running.",
      );

      const usage = sumUsage(
        completed.map(({ id, run }) => {
          const cumulative = sumUsage(
            run.details.agents.map((agent) => agent.usage.billing),
          );
          const delta = usageDelta(cumulative, accountedWorkflowUsage.get(id));
          accountedWorkflowUsage.set(id, structuredClone(cumulative));
          return delta;
        }),
      );
      return {
        content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
        details: {
          mode: params.mode ?? "all",
          completed: completed.map(({ id, run }) => ({
            runId: id,
            status: run.details.status,
          })),
          pending,
        },
        ...(hasUsage(usage) ? { usage } : {}),
      };
    },
  });

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: WORKFLOW_TOOL_DESCRIPTION,
    promptSnippet: WORKFLOW_PROMPT_SNIPPET,
    promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
    parameters: WorkflowParams,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      let prepared: ReturnType<typeof prepareWorkflowScript>;
      try {
        prepared = prepareWorkflowScript(params.script);
      } catch (error) {
        throw new Error(`Workflow script failed to parse: ${errorText(error)}`);
      }

      let args: unknown;
      if (params.args !== undefined) {
        try {
          args = JSON.parse(params.args);
        } catch {
          args = params.args;
        }
      }

      const meta = prepared.meta;
      const runId = `wf_${randomBytes(6).toString("hex")}`;
      const runDir = path.join(getAgentDir(), "workflows", runId);
      const background = (params.background ?? false) && ctx.hasUI;

      const details: WorkflowDetails = {
        runId,
        sessionId: ctx.sessionManager.getSessionId(),
        name: meta.name,
        description: meta.description,
        background,
        status: "running",
        startedAt: Date.now(),
        phases: [...meta.phases],
        agents: [],
      };

      writeRunFile(runDir, "script.js", params.script);
      if (params.args !== undefined)
        writeRunFile(runDir, "args.json", params.args);
      persistWorkflowJson(runDir, details);
      const persistence = createWorkflowPersistence(runDir, details);

      // Background runs survive Esc on the parent turn, but all runs are
      // aborted and settled during session shutdown.
      const controller = new RunController(background ? undefined : signal);

      // Pi workflow children use fresh in-process sessions. Claude and Codex
      // children share a workflow-scoped backend manager and are always
      // disposed when the run settles or is aborted.
      const projectTrusted = ctx.isProjectTrusted();
      const getResources = (structured: boolean) =>
        createWorkflowResources(
          ctx.cwd,
          structured ? "structured" : "plain",
          projectTrusted,
        );
      let harnessRuntime: SubagentRuntime | undefined;
      let harnessManagerPromise: Promise<SubagentManagerShape> | undefined;
      const getHarnessRuntime = () =>
        (harnessRuntime ??= createSubagentRuntime());
      const getHarnessManager = () =>
        (harnessManagerPromise ??=
          getHarnessRuntime().runPromise(SubagentManager));

      const runExternalAgent = async (options: {
        harness: Exclude<BackendName, "pi">;
        prompt: string;
        label: string;
        model?: string;
        effort?: ThinkingLevel;
        schema?: unknown;
        signal: AbortSignal;
      }) => {
        const manager = await getHarnessManager();
        const snap = await runSubagentTool(
          getHarnessRuntime(),
          manager.spawn(options.harness, {
            prompt: externalStructuredPrompt(options.prompt, options.schema),
            title: options.label,
            cwd: ctx.cwd,
            model: options.model,
            reasoningEffort: options.effort,
            parent: {
              parentCwd: ctx.cwd,
              projectTrusted,
              inheritedModel: ctx.model
                ? { provider: ctx.model.provider, id: ctx.model.id }
                : undefined,
              inheritedThinkingLevel: pi.getThinkingLevel(),
              modelRegistry: ctx.modelRegistry,
            },
          }),
        );
        try {
          await runSubagentTool(
            getHarnessRuntime(),
            manager.waitFor([snap.id]),
            {
              signal: options.signal,
              interruptMessage: `Workflow agent "${options.label}" was aborted.`,
            },
          );
        } catch (error) {
          await runSubagentTool(
            getHarnessRuntime(),
            manager.cancel([snap.id]),
          ).catch(() => {});
          throw error;
        }
        const settled = manager.view.get(snap.id);
        if (!settled)
          throw new Error("workflow agent disappeared before settlement");
        return settled;
      };

      // Throttled progress: tool-block updates when blocking. Background
      // runs are covered by the below-editor indicator and /workflows.
      let emitTimer: ReturnType<typeof setTimeout> | undefined;
      let lastEmit = 0;
      const flush = () => {
        emitTimer = undefined;
        lastEmit = Date.now();
        if (background) return;
        onUpdate?.({
          content: [{ type: "text", text: summaryLine(details) }],
          details: compactToolDetails(details),
        });
      };
      const emit = (checkpoint = true) => {
        if (checkpoint) persistence.checkpoint();
        if (emitTimer) return;
        emitTimer = setTimeout(
          flush,
          Math.max(0, EMIT_INTERVAL_MS - (Date.now() - lastEmit)),
        );
      };
      const flushNow = () => {
        if (emitTimer) clearTimeout(emitTimer);
        flush();
      };

      const phaseFn = (title: unknown) => {
        const text = String(title);
        details.currentPhase = text;
        if (!details.phases.some((p) => p.title === text))
          details.phases.push({ title: text });
        emit();
      };

      let agentCounter = 0;
      const agentFn = async (
        promptValue: unknown,
        optsValue: unknown = {},
        invocationSignal?: AbortSignal,
      ): Promise<ScriptAgentResult> => {
        const index = ++agentCounter;
        const opts: AgentCallOptions =
          optsValue && typeof optsValue === "object"
            ? (optsValue as AgentCallOptions)
            : {};
        const label =
          typeof opts.label === "string" && opts.label.trim()
            ? opts.label.trim().slice(0, 160)
            : `agent-${index}`;

        const record: AgentRecord = {
          index,
          label,
          phase:
            typeof opts.phase === "string"
              ? opts.phase.slice(0, 160)
              : details.currentPhase,
          state: "running",
          model: ctx.model?.id,
          contextWindow: ctx.model?.contextWindow,
          startedAt: Date.now(),
          preview: "",
          usage: emptyUsage(),
          transcript: [],
        };
        details.agents.push(record);
        persistence.checkpoint({ immediate: true });
        emit(false);

        const fail = (error: string): ScriptAgentResult => {
          record.state = "error";
          record.error = error;
          record.finishedAt = Date.now();
          emit();
          return { ok: false, output: "", error };
        };

        const prompt = buildWorkflowAgentPrompt(
          typeof promptValue === "string"
            ? promptValue
            : String(promptValue ?? ""),
        );
        if (!prompt.trim())
          return fail("agent() requires a non-empty prompt string");
        if (controller.signal.aborted)
          return fail("Workflow was aborted before this agent started");

        return controller
          .schedule(async (runSignal) => {
            const harnessValue =
              opts.harness === undefined ? "pi" : String(opts.harness);
            if (!WORKFLOW_HARNESSES.has(harnessValue as BackendName)) {
              return fail(
                `agent "${label}": invalid harness "${harnessValue}" (use pi|claude|codex)`,
              );
            }
            const harness = harnessValue as BackendName;

            // Effort uses one shared scale and is mapped by each harness.
            let thinkingLevel: ThinkingLevel = pi.getThinkingLevel();
            if (opts.effort !== undefined) {
              const effort = String(opts.effort);
              if (!(THINKING_LEVELS as readonly string[]).includes(effort)) {
                return fail(
                  `agent "${label}": invalid effort "${effort}" (use ${THINKING_LEVELS.join("|")})`,
                );
              }
              thinkingLevel = effort as ThinkingLevel;
            }

            const modelOpt =
              typeof opts.model === "string" ? opts.model : undefined;
            const providerOpt =
              typeof opts.provider === "string" ? opts.provider : undefined;

            if (harness !== "pi") {
              if (providerOpt) {
                return fail(
                  `agent "${label}": provider is only valid with the pi harness`,
                );
              }
              const snap: SubagentSnapshot = await runExternalAgent({
                harness,
                prompt,
                label,
                model: modelOpt,
                effort: thinkingLevel,
                schema: opts.schema,
                signal: runSignal,
              });
              const output = snap.finalText;
              let structured: unknown;
              let structuredError: string | undefined;
              if (snap.status === "done" && opts.schema !== undefined) {
                try {
                  structured = parseStructuredOutput(output, opts.schema);
                } catch (error) {
                  structuredError = errorText(error);
                }
              }
              const ok = snap.status === "done" && !structuredError;
              const outcomeError =
                snap.errorText ??
                structuredError ??
                (ok ? undefined : "Agent failed");
              const billing = snap.usage.billing;
              record.usage = {
                ...emptyUsage(),
                input: billing?.input ?? 0,
                output: billing?.output ?? 0,
                cacheRead: billing?.cacheRead ?? 0,
                cacheWrite: billing?.cacheWrite ?? 0,
                cost: billing?.cost.total ?? 0,
                contextTokens: snap.usage.tokens,
                billing,
                turns: snap.turns,
              };
              record.model = snap.meta.modelLabel ?? modelOpt;
              record.contextWindow =
                snap.usage.contextWindow ?? snap.meta.contextWindow;
              record.transcript = workflowTranscript(snap.transcript);
              record.preview = output.slice(0, PREVIEW_LENGTH);
              record.finishedAt = Date.now();
              record.state = ok ? "done" : "error";
              if (outcomeError) record.error = outcomeError;
              else delete record.error;
              emit();
              return {
                ok,
                output,
                ...(structured !== undefined ? { structured } : {}),
                ...(outcomeError !== undefined ? { error: outcomeError } : {}),
              };
            }

            // Pi defaults to the parent model and is restricted to the two
            // providers intentionally supported for in-process children.
            let model: WorkflowModel | undefined = ctx.model;
            if (modelOpt !== undefined || providerOpt !== undefined) {
              if (!modelOpt)
                return fail(
                  `agent "${label}": \`provider\` requires \`model\` as well`,
                );
              let resolved: WorkflowModel | undefined;
              if (providerOpt) {
                resolved = ctx.modelRegistry.find(providerOpt, modelOpt);
              } else {
                const slash = modelOpt.indexOf("/");
                if (slash > 0) {
                  resolved = ctx.modelRegistry.find(
                    modelOpt.slice(0, slash),
                    modelOpt.slice(slash + 1),
                  );
                }
                resolved ??= ctx.modelRegistry
                  .getAll()
                  .find(
                    (candidate) =>
                      candidate.id === modelOpt &&
                      ALLOWED_PI_WORKFLOW_PROVIDERS.has(candidate.provider),
                  );
              }
              if (!resolved) {
                const requested = providerOpt
                  ? `${providerOpt}/${modelOpt}`
                  : modelOpt;
                return fail(
                  `agent "${label}": unknown model "${requested}" (use provider/id)`,
                );
              }
              model = resolved;
            }
            if (model && !ALLOWED_PI_WORKFLOW_PROVIDERS.has(model.provider)) {
              return fail(
                `agent "${label}": Pi workflows only allow openai-codex and opencode-go models; received "${model.provider}/${model.id}"`,
              );
            }
            record.model = model?.id;
            record.contextWindow = model?.contextWindow;
            emit();

            const resources = await getResources(opts.schema !== undefined);
            const outcome = await runAgent({
              prompt,
              schema: opts.schema,
              model,
              thinkingLevel,
              cwd: ctx.cwd,
              loader: resources.loader,
              settingsManager: resources.settingsManager,
              modelRegistry: ctx.modelRegistry,
              signal: runSignal,
              onProgress: (progress) => {
                record.preview = progress.preview.slice(0, PREVIEW_LENGTH);
                record.usage = progress.usage;
                record.model = progress.model ?? record.model;
                record.contextWindow =
                  progress.contextWindow ?? record.contextWindow;
                record.transcript = progress.transcript;
                emit();
              },
            });

            record.usage = outcome.usage;
            record.model = outcome.model ?? record.model;
            record.contextWindow =
              outcome.contextWindow ?? record.contextWindow;
            record.transcript = outcome.transcript;
            record.preview = (outcome.output || record.preview).slice(
              0,
              PREVIEW_LENGTH,
            );
            record.finishedAt = Date.now();
            record.state = outcome.ok ? "done" : "error";
            if (outcome.ok) delete record.error;
            else record.error = outcome.error ?? "Agent failed";
            emit();

            return {
              ok: outcome.ok,
              output: outcome.output,
              ...(outcome.structured !== undefined
                ? { structured: outcome.structured }
                : {}),
              ...(outcome.error !== undefined ? { error: outcome.error } : {}),
            };
          }, invocationSignal)
          .catch((error) => fail(errorText(error)));
      };

      const runScript = async () => {
        let status: WorkflowDetails["status"] = "completed";
        try {
          details.result = await runWorkflowSandbox({
            source: prepared.source,
            args,
            cwd: ctx.cwd,
            signal: controller.signal,
            onAgent: agentFn,
            onPhase: phaseFn,
          });
        } catch (error) {
          details.error = errorText(error);
          status = controller.signal.aborted ? "aborted" : "failed";
          controller.abort("Workflow script failed");
        }

        const settled = await controller.settle({
          abort: status !== "completed",
        });
        if (!settled) {
          status = "failed";
          details.error = details.error
            ? `${details.error}; agent shutdown deadline exceeded`
            : "Agent shutdown deadline exceeded";
        }
        for (const record of details.agents) {
          if (record.state !== "running") continue;
          record.state = "error";
          record.error =
            record.error ?? "Agent did not settle before run cleanup";
          record.finishedAt = Date.now();
        }
        details.status = status;
        details.finishedAt = Date.now();
        try {
          persistence.flush();
        } catch (error) {
          details.status = "failed";
          details.error = `Artifact persistence failed: ${errorText(error)}`;
          throw new Error(details.error);
        } finally {
          try {
            await harnessRuntime?.dispose();
          } catch {
            // Child backends have bounded finalizers; cleanup is best-effort.
          }
          harnessRuntime = undefined;
          harnessManagerPromise = undefined;
          flushNow();
        }
      };

      // Registered for /workflows visibility and session_shutdown abort;
      // blocking runs are watchable live from the dashboard too.
      const activeRun = { details, controller } as {
        details: WorkflowDetails;
        controller: RunController;
        completion?: Promise<void>;
      };
      activeRuns.set(runId, activeRun);
      const completion = runScript();
      activeRun.completion = completion;
      if (ctx.hasUI) lastUi = ctx.ui;
      updateIndicator();

      if (background) {
        void completion
          .catch((error) => {
            details.status = "failed";
            details.finishedAt = Date.now();
            details.error = details.error ?? errorText(error);
          })
          .finally(() => {
            activeRuns.delete(runId);
            recordSettledRun(details.status);
            updateIndicator();
            try {
              if (!sessionActive) return;
              pendingBackgroundResults.push({
                runId,
                status: details.status,
                result: buildWorkflowResultMessage(details, runDir),
                usage: sumUsage(
                  details.agents.map((agent) => agent.usage.billing),
                ),
              });
              scheduleBackgroundDelivery();
            } catch {
              // Session may be shutting down.
            }
          });
        return {
          content: [
            {
              type: "text",
              text: buildBackgroundWorkflowLaunchResult({
                runId,
                name: details.name,
                runDir,
              }),
            },
          ],
          details: compactToolDetails(details),
        };
      }

      let completionError: unknown;
      try {
        await completion;
      } catch (error) {
        completionError = error;
      } finally {
        activeRuns.delete(runId);
        recordSettledRun(details.status);
        updateIndicator();
      }
      const usage = sumUsage(
        details.agents.map((agent) => agent.usage.billing),
      );
      if (completionError || details.status !== "completed") {
        // Pi marks tool failures only when execute throws. Preserve nested
        // usage through the tool_result middleware before surfacing the error.
        if (hasUsage(usage)) failedToolUsage.set(toolCallId, usage);
        if (completionError) throw completionError;
        throw new Error(buildWorkflowResultMessage(details, runDir));
      }
      return {
        content: [
          {
            type: "text",
            text: buildWorkflowResultMessage(details, runDir),
          },
        ],
        details: compactToolDetails(details),
        ...(hasUsage(usage) ? { usage } : {}),
      };
    },

    renderCall(args: Partial<WorkflowInput>, theme) {
      const meta =
        typeof args.script === "string"
          ? extractMeta(args.script)
          : { phases: [] };
      let text =
        theme.fg("toolTitle", theme.bold("workflow ")) +
        theme.fg("accent", (meta as WorkflowMeta).name ?? "(script)");
      if (args.background) text += theme.fg("dim", " (background)");
      const description = (meta as WorkflowMeta).description;
      if (description) text += `\n  ${theme.fg("dim", description)}`;
      for (const phase of meta.phases.slice(0, 8)) {
        text += `\n  ${theme.fg("dim", SQUARE)} ${theme.fg("accent", phase.title)}${
          phase.detail ? theme.fg("dim", ` — ${phase.detail}`) : ""
        }`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as WorkflowDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(
          first?.type === "text" ? first.text : "(no output)",
          0,
          0,
        );
      }

      const { done, failed } = countStates(details);
      const settled = done + failed;
      const elapsed = formatElapsed(details.startedAt, details.finishedAt);
      let header =
        `${theme.fg(statusColor(details.status), SQUARE)} ${theme.fg("toolTitle", theme.bold("workflow "))}` +
        `${theme.fg("accent", details.name ?? details.runId)} ` +
        theme.fg(
          "dim",
          `${settled}/${details.agents.length} agents · ${elapsed} · `,
        ) +
        theme.fg(statusColor(details.status), statusWord(details.status));
      if (failed) header += theme.fg("error", ` · ${failed} failed`);
      if (details.background) header += theme.fg("dim", " (background)");
      if (details.status === "running" && details.currentPhase) {
        header += theme.fg("muted", ` · ${details.currentPhase}`);
      }
      const totals = formatUsage(aggregateUsage(details.agents));

      if (!expanded) {
        let text = header;
        for (const agent of details.agents) {
          const context = agentContext(agent);
          text += `\n  ${stateSquare(agent.state, theme)} ${theme.fg("accent", agent.label)}${
            agent.phase ? theme.fg("dim", ` (${agent.phase})`) : ""
          }${theme.fg(
            "dim",
            `${context ? ` · ${context}` : ""} · ${formatElapsed(agent.startedAt, agent.finishedAt)}`,
          )}`;
        }
        if (totals) text += `\n  ${theme.fg("dim", `Total: ${totals}`)}`;
        if (details.error)
          text += `\n  ${theme.fg("error", `Error: ${details.error}`)}`;
        text += `\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
        return new Text(text, 0, 0);
      }

      const container = new Container();
      container.addChild(new Text(header, 0, 0));
      if (details.description) {
        container.addChild(
          new Text(theme.fg("dim", details.description), 0, 0),
        );
      }

      for (const group of phaseGroups(details)) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg("muted", `─── ${group.title} ───`), 0, 0),
        );
        for (const agent of group.agents) {
          const usage = formatUsage(agent.usage, agent.model);
          const context = agentContext(agent);
          let line = `${stateSquare(agent.state, theme)} ${theme.fg("accent", agent.label)} ${theme.fg(
            "dim",
            [context, formatElapsed(agent.startedAt, agent.finishedAt)]
              .filter(Boolean)
              .join(" · "),
          )}`;
          if (usage) line += ` ${theme.fg("dim", usage)}`;
          container.addChild(new Text(line, 0, 0));
          if (agent.error) {
            container.addChild(
              new Text(`  ${theme.fg("error", agent.error)}`, 0, 0),
            );
          } else if (agent.preview) {
            const preview = agent.preview.split("\n").slice(0, 2).join(" ");
            container.addChild(new Text(`  ${theme.fg("dim", preview)}`, 0, 0));
          }
        }
      }

      if (details.error) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg("error", `Error: ${details.error}`), 0, 0),
        );
      }

      if (details.result !== undefined) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── result ───"), 0, 0));
        container.addChild(
          new Markdown(
            `\`\`\`json\n${resultJson(details.result)}\n\`\`\``,
            0,
            0,
            getMarkdownTheme(),
          ),
        );
      }

      if (totals) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", `Total: ${totals}`), 0, 0));
      }
      return container;
    },
  });
}
