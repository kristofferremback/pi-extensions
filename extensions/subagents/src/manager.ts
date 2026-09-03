/**
 * SubagentManager — owns the registry of running/finished subagents.
 *
 * Each subagent is a scoped `SubagentSession` from a `SubagentBackend` plus a
 * pump fiber that folds its normalized event stream into a mutable
 * `SubagentSnapshot`. Closing a subagent's scope kills the underlying
 * session/process and stops the pump.
 *
 * The manager also exposes a synchronous `SubagentReadModel` so the
 * imperative TUI components (which render synchronously) can read snapshots
 * and issue fire-and-forget commands without touching the Effect runtime.
 */

import type { Usage } from "@earendil-works/pi-ai";
import {
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Result,
  Scope,
  Stream,
} from "effect";
import type { SubagentBackend, SubagentSession } from "./backend.ts";
import { BackendRegistry } from "./backend.ts";
import type {
  BackendName,
  LiveToolState,
  RunOutcome,
  SpawnTask,
  SubagentEvent,
  SubagentOrigin,
  SubagentMeta,
  SubagentSnapshot,
  SubagentStatus,
  TranscriptItem,
} from "./domain.ts";
import {
  BackendUnavailableError,
  ConcurrencyLimitError,
  SendError,
  SpawnError,
} from "./domain.ts";

export const MAX_RUNNING = 4;
export const MAX_TRACKED = 64;
const STOP_TIMEOUT_MS = 5_000;
const ERROR_TEXT_MAX_LENGTH = 4_096;

function bounded(text: string) {
  return text.slice(0, ERROR_TEXT_MAX_LENGTH);
}

// --- Internal state -----------------------------------------------------------

/** Mutable snapshot; exposed to readers via the readonly SubagentSnapshot type. */
interface MutableSnapshot {
  id: string;
  origin: SubagentOrigin;
  backend: BackendName;
  title: string;
  prompt: string;
  cwd: string;
  status: SubagentStatus;
  createdAt: number;
  settledAt?: number;
  errorText?: string;
  meta: SubagentMeta;
  usage: { tokens?: number; contextWindow?: number; billing?: Usage };
  transcript: TranscriptItem[];
  liveAssistant?: { text: string; thinking: string };
  liveTools: LiveToolState[];
  queued: SubagentSnapshot["queued"];
  finalText: string;
  turns: number;
}

interface Entry {
  snapshot: MutableSnapshot;
  task: SpawnTask;
  /** Undefined while a recoverable settled session is hibernated. */
  session?: SubagentSession;
  scope?: Scope.Closeable;
  pump?: Fiber.Fiber<void>;
  /** Scope shutdown that must succeed before this native transcript is resumed. */
  hibernation?: Fiber.Fiber<boolean>;
  /** Permanent refusal after native shutdown could not be confirmed. */
  unresumableReason?: string;
  /** Complete in-flight recovery, owned so cancel/disposal can interrupt it. */
  restartFiber?: Fiber.Fiber<unknown, unknown>;
  /** Distinguishes a resumed pump from late finalization of its predecessor. */
  sessionGeneration: number;
  liveToolMap: Map<string, LiveToolState>;
  /** False for blocking run tools that collect their own result. */
  automaticDelivery: boolean;
  /** Idle restart dispatched but RunStarted not folded yet; counts as running
   * so concurrent restarts cannot race past the cap. */
  restarting?: boolean;
  /** Native late steer accepted, but its next RunStarted has not arrived yet. */
  queuedTurnPending?: boolean;
}

// --- Read model ----------------------------------------------------------------

/** Synchronous bridge for the TUI. Snapshots are live objects; do not mutate. */
export interface SubagentReadModel {
  list(): ReadonlyArray<SubagentSnapshot>;
  get(id: string): SubagentSnapshot | undefined;
  size(): number;
  /** Any-change notification (footer status, dashboard). */
  subscribe(listener: () => void): () => void;
  /** Per-subagent notification (takeover view). */
  subscribeTo(id: string, listener: () => void): () => void;
  /** Fire-and-forget: steer/continue a subagent (takeover input). */
  requestSend(id: string, text: string): void;
  /** Fire-and-forget: abort a running subagent (dashboard `x`, takeover). */
  requestAbort(id: string): void;
  /**
   * Register the settle hook. `consumed` is true when an active wait/cancel
   * or a manual blocking run owns the result, so it must not also be pushed.
   */
  setOnSettled(
    hook: ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined,
  ): void;
}

// --- Service --------------------------------------------------------------------

export interface CancelResult {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentStatus;
  readonly cancelled: boolean;
}

export interface SubagentManagerShape {
  spawn(
    backend: BackendName,
    task: SpawnTask,
  ): Effect.Effect<
    SubagentSnapshot,
    SpawnError | ConcurrencyLimitError | BackendUnavailableError
  >;
  /**
   * Wait until all listed subagents are settled. Unknown ids are treated as
   * settled (the tool layer validates ids first). While waiting, settles for
   * these ids are marked "consumed". Interruption (tool abort) releases the
   * interest and leaves the subagents running.
   */
  waitFor(
    ids: ReadonlyArray<string>,
    onPending?: (pending: string[]) => void,
  ): Effect.Effect<void>;
  /** Wait until at least one listed running child settles. */
  waitForNext(
    ids: ReadonlyArray<string>,
    onPending?: (pending: string[]) => void,
  ): Effect.Effect<{ settled: string[]; pending: string[] }>;
  /** Cancel running subagents; resolves when they have settled. */
  cancel(
    ids: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<CancelResult>>;
  send(id: string, text: string): Effect.Effect<void, SendError>;
  get(id: string): Effect.Effect<SubagentSnapshot | undefined>;
  readonly list: Effect.Effect<ReadonlyArray<SubagentSnapshot>>;
  readonly disposeAll: Effect.Effect<void>;
  readonly view: SubagentReadModel;
}

export class SubagentManager extends Context.Service<
  SubagentManager,
  SubagentManagerShape
>()("subagents/SubagentManager") {}

// --- Implementation --------------------------------------------------------------

const makeManager = Effect.gen(function* () {
  const registry = yield* BackendRegistry;
  // Detached forker for sync contexts (read-model commands, pruning) that
  // preserves the manager's services instead of using the global runtime.
  const runDetached = Effect.runForkWith(yield* Effect.context());

  const entries = new Map<string, Entry>();
  const waitInterest = new Map<string, number>();
  const listeners = new Set<() => void>();
  /** One-shot nextChange waiters, swapped out before invocation so waiters
   * re-registering during notification are not visited in the same sweep. */
  let changeWaiters: Array<() => void> = [];
  const idListeners = new Map<string, Set<() => void>>();
  const cleanups = new Set<Fiber.Fiber<unknown>>();
  let modelCounter = 0;
  let btwCounter = 0;
  let reserved = 0;
  let disposed = false;
  let onSettled:
    ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined;

  const notify = (id?: string) => {
    const waiters = changeWaiters;
    changeWaiters = [];
    for (const waiter of waiters) waiter();
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A failed status/render listener must not corrupt lifecycle state.
      }
    }
    if (id) {
      for (const listener of idListeners.get(id) ?? []) {
        try {
          listener();
        } catch {
          // Same.
        }
      }
    }
  };

  /** Resolves on the next state change. Interruption unregisters the waiter. */
  const nextChange = Effect.callback<void>((resume) => {
    const waiter = () => resume(Effect.void);
    changeWaiters.push(waiter);
    return Effect.sync(() => {
      const index = changeWaiters.indexOf(waiter);
      if (index >= 0) changeWaiters.splice(index, 1);
    });
  });

  const isActive = (entry: Entry) =>
    entry.snapshot.status === "running" || entry.restarting === true;

  const runningCount = () => [...entries.values()].filter(isActive).length;

  const addInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) waitInterest.set(id, (waitInterest.get(id) ?? 0) + 1);
  };
  const releaseInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) {
      const count = (waitInterest.get(id) ?? 1) - 1;
      if (count <= 0) waitInterest.delete(id);
      else waitInterest.set(id, count);
    }
  };

  const closeScope = (scope: Scope.Closeable) =>
    Scope.close(scope, Exit.void).pipe(Effect.ignore);

  const closeEntryScope = (entry: Entry) =>
    entry.scope ? closeScope(entry.scope) : Effect.void;

  const trackCleanup = <A>(effect: Effect.Effect<A>) => {
    const fiber = runDetached(effect);
    cleanups.add(fiber);
    fiber.addObserver(() => cleanups.delete(fiber));
    return fiber;
  };

  const hibernateEntry = (entry: Entry) => {
    const backend = registry.get(entry.snapshot.backend);
    const session = entry.session;
    if (
      !backend?.capabilities.resumeFromSessionId ||
      !entry.snapshot.meta.nativeSessionId ||
      !entry.scope ||
      !session?.shutdown ||
      !session.prepareHibernate
    ) {
      return;
    }

    const readiness = session.prepareHibernate();
    if (readiness === "busy") {
      // The native backend accepted a turn after its prior result but before
      // the manager folded that settlement. Reserve the slot until RunStarted.
      entry.restarting = true;
      entry.queuedTurnPending = true;
      return;
    }

    const scope = entry.scope;
    entry.session = undefined;
    entry.scope = undefined;
    entry.pump = undefined;
    entry.hibernation = trackCleanup(
      session.shutdown.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            // Native shutdown owns the process deadline. Scope cleanup may
            // contain unrelated finalizers, so never interrupt it halfway.
            trackCleanup(closeScope(scope));
          }),
        ),
      ),
    );
  };

  const pruneSettled = () => {
    if (entries.size <= MAX_TRACKED) return;
    const candidates = [...entries.values()]
      .filter(
        (e) =>
          e.snapshot.status !== "running" &&
          !e.restarting &&
          !waitInterest.has(e.snapshot.id),
      )
      .sort(
        (a, b) =>
          (a.snapshot.settledAt ?? a.snapshot.createdAt) -
          (b.snapshot.settledAt ?? b.snapshot.createdAt),
      );
    for (const entry of candidates) {
      if (entries.size <= MAX_TRACKED) break;
      entries.delete(entry.snapshot.id);
      trackCleanup(closeEntryScope(entry));
    }
  };

  const settle = (entry: Entry, outcome: RunOutcome) => {
    const s = entry.snapshot;
    entry.restarting = false;
    entry.queuedTurnPending = false;
    if (s.status !== "running") return;
    s.settledAt = Date.now();
    switch (outcome._tag) {
      case "Completed":
        s.status = "done";
        s.errorText = undefined;
        s.finalText = outcome.finalText;
        break;
      case "Failed":
        s.status = "error";
        s.errorText = bounded(outcome.errorText);
        // Never let a failed run report the previous run's successful output.
        s.finalText = outcome.partialText ?? "";
        break;
      case "Interrupted":
        s.status = "error";
        s.errorText = "Run was aborted";
        s.finalText = outcome.partialText ?? "";
        break;
    }
    s.liveAssistant = undefined;
    entry.liveToolMap.clear();
    s.liveTools = [];
    const hasQueuedTurn = s.queued.length > 0;
    entry.restarting = hasQueuedTurn;
    entry.queuedTurnPending = hasQueuedTurn;
    if (!hasQueuedTurn) s.queued = [];
    // A late steer belongs to this native streaming-input session. Its next
    // RunStarted follows the current settlement, so closing here would drop it.
    // Reserve hidden native restarts before waking manager waiters.
    if (!hasQueuedTurn) hibernateEntry(entry);
    const consumed =
      !entry.automaticDelivery || (waitInterest.get(s.id) ?? 0) > 0;
    // Manual collection applies only to the initial blocking run. If the user
    // later restarts this child through takeover, that settlement is pushed.
    entry.automaticDelivery = true;
    try {
      // The hook snapshots this completed run before a queued successor flips
      // the public status back to running.
      if (!disposed) onSettled?.(s, consumed);
    } catch {
      // The parent session may be unavailable; settlement stays final.
    }
    if (entry.restarting) {
      s.status = "running";
      s.settledAt = undefined;
      s.errorText = undefined;
    }
    notify(s.id);
    pruneSettled();
  };

  const foldEvent = (entry: Entry, event: SubagentEvent) => {
    const s = entry.snapshot;
    switch (event._tag) {
      case "RunStarted":
        entry.restarting = false;
        entry.queuedTurnPending = false;
        s.status = "running";
        s.settledAt = undefined;
        s.errorText = undefined;
        break;
      case "RunSettled":
        settle(entry, event.outcome);
        return; // settle() already notified
      case "UserMessage":
        s.transcript.push({ kind: "user", text: event.text });
        break;
      case "AssistantDelta": {
        const live = s.liveAssistant ?? { text: "", thinking: "" };
        s.liveAssistant =
          event.kind === "text"
            ? { ...live, text: live.text + event.delta }
            : { ...live, thinking: live.thinking + event.delta };
        break;
      }
      case "AssistantMessage":
        s.transcript.push({ kind: "assistant", parts: event.parts });
        s.liveAssistant = undefined;
        s.turns++;
        break;
      case "ToolStart":
        entry.liveToolMap.set(event.toolId, {
          toolId: event.toolId,
          name: event.name,
          argsPreview: event.argsPreview,
        });
        s.liveTools = [...entry.liveToolMap.values()];
        break;
      case "ToolUpdate": {
        const current = entry.liveToolMap.get(event.toolId);
        if (current) {
          entry.liveToolMap.set(event.toolId, {
            ...current,
            outputPreview: event.outputPreview ?? current.outputPreview,
          });
          s.liveTools = [...entry.liveToolMap.values()];
        }
        break;
      }
      case "ToolEnd":
        entry.liveToolMap.delete(event.toolId);
        s.liveTools = [...entry.liveToolMap.values()];
        s.transcript.push({
          kind: "toolResult",
          toolId: event.toolId,
          name: event.name,
          isError: event.isError,
          outputPreview: event.outputPreview,
        });
        break;
      case "QueueChanged":
        s.queued = event.queued;
        break;
      case "UsageChanged":
        s.usage = {
          tokens: event.tokens ?? s.usage.tokens,
          contextWindow: event.contextWindow ?? s.usage.contextWindow,
          billing: event.billing ?? s.usage.billing,
        };
        break;
      case "MetaChanged":
        s.meta = { ...s.meta, ...event.meta };
        break;
      case "BackendError":
        s.errorText = bounded(event.message);
        break;
    }
    notify(s.id);
  };

  const attachSession = (
    entry: Entry,
    session: SubagentSession,
    scope: Scope.Closeable,
  ) =>
    Effect.gen(function* () {
      entry.session = session;
      entry.scope = scope;
      const generation = ++entry.sessionGeneration;
      const pump = Stream.runForEach(session.events, (event) =>
        Effect.sync(() => foldEvent(entry, event)),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (entry.sessionGeneration !== generation) return;
            const queuedTurnFailed = entry.queuedTurnPending === true;
            if (queuedTurnFailed) {
              // The backend ended after settling one turn but before starting
              // its queued successor. Turn that stranded reservation into an
              // honest failed run and release the recoverable session.
              entry.snapshot.queued = [];
              entry.snapshot.status = "running";
            }
            if (
              queuedTurnFailed ||
              (entry.snapshot.status === "running" && entry.session !== undefined)
            ) {
              settle(entry, {
                _tag: "Failed",
                errorText: "Backend event stream ended unexpectedly",
              });
            }
          }),
        ),
      );
      entry.pump = yield* Scope.provide(Effect.forkScoped(pump), scope);
    });

  const spawn = (backendName: BackendName, task: SpawnTask) =>
    Effect.gen(function* () {
      // Reserve synchronously (before the first yield inside doSpawn) so
      // parallel tool calls cannot race past the global cap.
      yield* Effect.suspend(
        (): Effect.Effect<void, SpawnError | ConcurrencyLimitError> => {
          if (disposed) {
            return new SpawnError({
              message: "Subagent manager is shutting down.",
            });
          }
          if (runningCount() + reserved >= MAX_RUNNING) {
            return new ConcurrencyLimitError({
              message: `Max ${MAX_RUNNING} subagents can run concurrently. Wait for one to finish before spawning another.`,
            });
          }
          reserved++;
          return Effect.void;
        },
      );

      const doSpawn = Effect.gen(function* () {
        const backend: SubagentBackend | undefined = registry.get(backendName);
        if (!backend) {
          return yield* new BackendUnavailableError({
            message: `Unknown backend "${backendName}".`,
          });
        }
        const available = yield* backend.available;
        if (!available) {
          return yield* new BackendUnavailableError({
            message: `Backend "${backendName}" is not available on this machine (binary/SDK/credentials missing).`,
          });
        }

        const scope = yield* Scope.make();
        const session = yield* Scope.provide(backend.spawn(task), scope).pipe(
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
        if (disposed) {
          yield* Scope.close(scope, Exit.void);
          return yield* new SpawnError({
            message: "Subagent manager shut down while spawning.",
          });
        }

        const origin = task.origin ?? "model";
        const id =
          origin === "btw" ? `btw-${++btwCounter}` : `sa-${++modelCounter}`;
        const meta = yield* session.meta;
        const entry: Entry = {
          snapshot: {
            id,
            origin,
            backend: backendName,
            title: task.title,
            prompt: task.prompt,
            cwd: task.cwd,
            status: "running",
            createdAt: Date.now(),
            meta,
            usage: { contextWindow: meta.contextWindow },
            transcript: [],
            liveTools: [],
            queued: [],
            finalText: "",
            turns: 0,
          },
          task,
          sessionGeneration: 0,
          liveToolMap: new Map(),
          automaticDelivery: task.delivery !== "manual",
        };
        entries.set(id, entry);
        yield* attachSession(entry, session, scope);

        notify(id);
        return entry.snapshot as SubagentSnapshot;
      });

      return yield* doSpawn.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            reserved--;
            notify();
          }),
        ),
      );
    });

  const waitFor = (
    ids: ReadonlyArray<string>,
    onPending?: (pending: string[]) => void,
  ) =>
    Effect.suspend(() => {
      const unique = [...new Set(ids)];
      addInterest(unique);
      const loop = Effect.gen(function* () {
        while (true) {
          const pending = unique.filter((id) => {
            const entry = entries.get(id);
            return entry ? isActive(entry) : false;
          });
          if (pending.length === 0) return;
          onPending?.(pending);
          yield* nextChange;
        }
      });
      return loop.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseInterest(unique);
            pruneSettled();
          }),
        ),
      );
    });

  const waitForNext = (
    ids: ReadonlyArray<string>,
    onPending?: (pending: string[]) => void,
  ) =>
    Effect.suspend(() => {
      const unique = [...new Set(ids)];
      const initiallySettled = unique.filter((id) => {
        const entry = entries.get(id);
        return !entry || !isActive(entry);
      });
      if (initiallySettled.length > 0) {
        return Effect.succeed({
          settled: initiallySettled,
          pending: unique.filter((id) => {
            const entry = entries.get(id);
            return entry ? isActive(entry) : false;
          }),
        });
      }

      addInterest(unique);
      const loop = Effect.gen(function* () {
        while (true) {
          const pending = unique.filter((id) => {
            const entry = entries.get(id);
            return entry ? isActive(entry) : false;
          });
          const settled = unique.filter((id) => !pending.includes(id));
          if (settled.length > 0) return { settled, pending };
          onPending?.(pending);
          yield* nextChange;
        }
      });
      return loop.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseInterest(unique);
            pruneSettled();
          }),
        ),
      );
    });

  /** Interrupt one running entry, force-closing its scope after 5s. */
  const abortEntry = (entry: Entry) =>
    Effect.gen(function* () {
      if (!isActive(entry)) return;
      if (!entry.session) {
        if (entry.restartFiber) {
          yield* Fiber.interrupt(entry.restartFiber).pipe(Effect.ignore);
        }
        entry.snapshot.status = "running";
        yield* Effect.sync(() => settle(entry, { _tag: "Interrupted" }));
        return;
      }
      if (entry.snapshot.status !== "running") {
        entry.snapshot.status = "running";
        notify(entry.snapshot.id);
      }
      const graceful = yield* entry.session.interrupt.pipe(
        Effect.timeout(STOP_TIMEOUT_MS),
        Effect.result,
      );
      if (Result.isFailure(graceful)) {
        // Settle before closing the scope so the pump's stream-ended
        // fallback ("Backend event stream ended unexpectedly") cannot win
        // the race and report the wrong terminal reason.
        yield* Effect.sync(() => {
          settle(entry, { _tag: "Interrupted" });
          entry.snapshot.errorText =
            "Abort deadline exceeded; session was force-disposed";
          notify(entry.snapshot.id);
        });
        // Bound the close like disposeAll does: a stuck backend finalizer
        // must not hang cancel after the run is already settled.
        yield* closeEntryScope(entry).pipe(
          Effect.timeout(STOP_TIMEOUT_MS),
          Effect.ignore,
        );
      }
    });

  const cancel = (ids: ReadonlyArray<string>) =>
    Effect.suspend(() => {
      const unique = [...new Set(ids)];
      const running = unique
        .map((id) => entries.get(id))
        .filter((entry): entry is Entry => Boolean(entry && isActive(entry)));
      const runningIds = running.map((entry) => entry.snapshot.id);
      // Mark consumed before interrupting so cancellation does not also
      // enqueue duplicate automatic result messages into the parent.
      addInterest(runningIds);
      const work = Effect.gen(function* () {
        yield* Effect.forEach(running, abortEntry, {
          concurrency: "unbounded",
        });
        while (running.some(isActive)) {
          yield* nextChange;
        }
      });
      return work.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseInterest(runningIds);
            pruneSettled();
          }),
        ),
        Effect.map((): ReadonlyArray<CancelResult> =>
          unique.map((id) => {
            const snapshot = entries.get(id)?.snapshot;
            return {
              id,
              title: snapshot?.title ?? "?",
              status: snapshot?.status ?? "error",
              cancelled: runningIds.includes(id),
            };
          }),
        ),
      );
    });

  const resumeEntry = (entry: Entry, text: string) =>
    Effect.gen(function* () {
      const backend = registry.get(entry.snapshot.backend);
      const nativeSessionId = entry.snapshot.meta.nativeSessionId;
      if (entry.unresumableReason) {
        return yield* new SendError({ message: entry.unresumableReason });
      }
      if (!backend?.capabilities.resumeFromSessionId || !nativeSessionId) {
        return yield* new SendError({
          message: `Subagent "${entry.snapshot.id}" cannot resume because its backend session is no longer live.`,
        });
      }

      if (entry.hibernation) {
        const stopped = yield* Fiber.join(entry.hibernation);
        entry.hibernation = undefined;
        if (!stopped) {
          entry.unresumableReason = `Subagent "${entry.snapshot.id}" did not shut down cleanly; refusing to resume the same native session.`;
          return yield* new SendError({ message: entry.unresumableReason });
        }
      }
      if (disposed || entries.get(entry.snapshot.id) !== entry) {
        return yield* new SendError({
          message: `Subagent "${entry.snapshot.id}" is no longer tracked.`,
        });
      }

      const scope = yield* Scope.make();
      // Publish ownership before acquisition yields. Disposal can now close the
      // scope and interrupt the acquisition instead of losing an untracked child.
      entry.scope = scope;
      const spawnFiber = yield* Effect.forkChild(
        Scope.provide(
          backend.spawn({
            ...entry.task,
            prompt: text,
            resumeNativeSessionId: nativeSessionId,
            priorBillingUsage: entry.snapshot.usage.billing,
          }),
          scope,
        ).pipe(
          Effect.mapError(
            (error) => new SendError({ message: bounded(error.message) }),
          ),
          Effect.onError(() => closeScope(scope)),
        ),
      );
      const session = yield* Fiber.join(spawnFiber).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            if (entry.scope === scope) entry.scope = undefined;
          }),
        ),
      );
      if (disposed || entries.get(entry.snapshot.id) !== entry) {
        yield* closeScope(scope);
        return yield* new SendError({
          message: "Subagent manager shut down while resuming the session.",
        });
      }
      yield* attachSession(entry, session, scope);
    });

  const send = (id: string, text: string) =>
    Effect.suspend((): Effect.Effect<void, SendError> => {
      const entry = entries.get(id);
      if (!entry || disposed) {
        return new SendError({
          message: `Subagent "${id}" is no longer tracked.`,
        });
      }
      // Restarting a settled subagent occupies a running slot again, so it
      // must respect the same cap as spawn. Steering an already-running one
      // does not consume additional capacity.
      if (entry.snapshot.status !== "running") {
        if (entry.restarting) {
          return new SendError({
            message: `Subagent "${id}" is already restarting.`,
          });
        }
        if (runningCount() + reserved >= MAX_RUNNING) {
          return new SendError({
            message: `Max ${MAX_RUNNING} subagents can run concurrently; restarting "${id}" would exceed that.`,
          });
        }
        // Occupy the slot and publish active status synchronously. RunStarted
        // confirms it; a failed restart restores this terminal snapshot.
        const prior = {
          status: entry.snapshot.status,
          settledAt: entry.snapshot.settledAt,
          errorText: entry.snapshot.errorText,
        };
        entry.restarting = true;
        entry.snapshot.status = "running";
        entry.snapshot.settledAt = undefined;
        entry.snapshot.errorText = undefined;
        notify(entry.snapshot.id);
        const restart = entry.session
          ? entry.session.send(text)
          : Effect.gen(function* () {
              const fiber = yield* Effect.forkChild(resumeEntry(entry, text));
              entry.restartFiber = fiber;
              return yield* Fiber.join(fiber).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    if (entry.restartFiber === fiber) {
                      entry.restartFiber = undefined;
                    }
                  }),
                ),
              );
            });
        return restart.pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              if (entry.restarting) {
                entry.restarting = false;
                entry.snapshot.status = prior.status;
                entry.snapshot.settledAt = prior.settledAt;
                entry.snapshot.errorText = prior.errorText;
              }
              notify(entry.snapshot.id);
            }),
          ),
        );
      }
      return entry.session
        ? entry.session.send(text)
        : new SendError({
            message: `Subagent "${id}" has no live backend session.`,
          });
    });

  const disposeAll = Effect.gen(function* () {
    disposed = true;
    const all = [...entries.values()];
    entries.clear();
    yield* Effect.forEach(
      all,
      (entry) =>
        entry.restartFiber
          ? Fiber.interrupt(entry.restartFiber).pipe(Effect.ignore)
          : Effect.void,
      { concurrency: "unbounded" },
    );
    yield* Effect.forEach(
      all,
      (entry) =>
        closeEntryScope(entry).pipe(
          Effect.timeout(STOP_TIMEOUT_MS),
          Effect.ignore,
        ),
      { concurrency: "unbounded" },
    );
    // Hibernation and pruning cleanups are detached; bound them like everything
    // else so a stuck backend finalizer cannot block runtime shutdown.
    yield* Effect.forEach(
      [...cleanups],
      (fiber) =>
        Fiber.await(fiber).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore),
      { concurrency: "unbounded" },
    ).pipe(Effect.ignore);
    yield* Effect.sync(() => notify());
  });

  const view: SubagentReadModel = {
    list: () => [...entries.values()].map((entry) => entry.snapshot),
    get: (id) => entries.get(id)?.snapshot,
    size: () => entries.size,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeTo: (id, listener) => {
      let set = idListeners.get(id);
      if (!set) {
        set = new Set();
        idListeners.set(id, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) idListeners.delete(id);
      };
    },
    requestSend: (id, text) => {
      runDetached(send(id, text).pipe(Effect.ignore));
    },
    requestAbort: (id) => {
      const entry = entries.get(id);
      if (!entry) return;
      // UI-initiated aborts are not "consumed": the failed result still
      // flows back to the parent as a follow-up message, matching v1.
      runDetached(abortEntry(entry).pipe(Effect.ignore));
    },
    setOnSettled: (hook) => {
      onSettled = hook;
    },
  };

  // Safety net: disposing the ManagedRuntime tears everything down even if
  // the extension forgot to call disposeAll explicitly.
  yield* Effect.addFinalizer(() => disposeAll);

  return SubagentManager.of({
    spawn,
    waitFor,
    waitForNext,
    cancel,
    send,
    get: (id) => Effect.sync(() => entries.get(id)?.snapshot),
    list: Effect.sync(() => [...entries.values()].map((e) => e.snapshot)),
    disposeAll,
    view,
  });
});

export const SubagentManagerLive: Layer.Layer<
  SubagentManager,
  never,
  BackendRegistry
> = Layer.effect(SubagentManager, makeManager);
