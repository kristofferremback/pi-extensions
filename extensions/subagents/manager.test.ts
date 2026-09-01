/**
 * End-to-end smoke tests: manager behavior through a real ManagedRuntime,
 * exactly as the tool handlers drive it. The registry is test-only: scripted
 * stub sessions registered under the claude/codex names (the production
 * backends launch real processes and have their own live test files), plus
 * the real pi backend for its cheap registry precondition.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { BackendRegistry, type SubagentBackend } from "./src/backend.ts";
import { piBackend } from "./src/backends/pi.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import type { BackendName, ParentContext, SpawnTask } from "./src/domain.ts";
import {
  SubagentManager,
  SubagentManagerLive,
  type SubagentManagerShape,
} from "./src/manager.ts";
import { runTool } from "./src/runtime.ts";

const TestRegistryLive = Layer.sync(BackendRegistry, () => {
  const backends: SubagentBackend[] = [
    piBackend,
    makeStubBackend({
      backend: "claude",
      defaultModelLabel: "claude/sonnet",
      contextWindow: 200_000,
      toolName: "Bash",
      cadenceMs: 40,
    }),
    makeStubBackend({
      backend: "codex",
      defaultModelLabel: "codex/gpt-5-codex",
      contextWindow: 272_000,
      toolName: "shell",
      cadenceMs: 30,
    }),
  ];
  return new Map<BackendName, SubagentBackend>(
    backends.map((backend) => [backend.name, backend]),
  );
});

const createRuntimeWithBackends = (backends: SubagentBackend[]) =>
  ManagedRuntime.make(
    SubagentManagerLive.pipe(
      Layer.provide(
        Layer.succeed(
          BackendRegistry,
          new Map<BackendName, SubagentBackend>(
            backends.map((backend) => [backend.name, backend]),
          ),
        ),
      ),
    ),
  );

const createTestRuntime = () =>
  ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(TestRegistryLive)),
  );

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return { prompt, title: "test", cwd: process.cwd(), parent };
}

async function withManager(
  run: (
    manager: SubagentManagerShape,
    runtime: ReturnType<typeof createTestRuntime>,
  ) => Promise<void>,
) {
  const runtime = createTestRuntime();
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

test("stub subagent completes and delivers a final result", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Say hello to the tests")),
    );
    assert.equal(snap.status, "running");
    assert.equal(snap.backend, "claude");
    assert.ok(snap.meta.sessionFilePath);

    await runTool(runtime, manager.waitFor([snap.id]));
    const done = manager.view.get(snap.id);
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.match(
      done.finalText,
      /\[stub:claude\] completed: Say hello to the tests/,
    );
    assert.ok(done.turns >= 2);
    assert.ok(done.transcript.some((item) => item.kind === "toolResult"));
    // The waitFor marked the settle as consumed.
    assert.deepEqual(settled, [{ id: snap.id, consumed: true }]);
  });
});

test("FAIL: prompts settle as errors; unconsumed settles are delivered", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("FAIL: blow up please")),
    );
    // Poll without wait-interest so the settle is delivered unconsumed.
    while (manager.view.get(snap.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const failed = manager.view.get(snap.id);
    assert.equal(failed?.status, "error");
    assert.match(failed?.errorText ?? "", /task failed/);
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
  });
});

test("cancel interrupts a running stub subagent", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Long running task")),
    );
    const report = await runTool(runtime, manager.cancel([snap.id]));
    assert.deepEqual(report, [
      { id: snap.id, title: "test", status: "error", cancelled: true },
    ]);
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
  });
});

test("spawn origin propagates to ids, snapshots, and settlement", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; origin: string }> = [];
    manager.view.setOnSettled((snap) =>
      settled.push({ id: snap.id, origin: snap.origin }),
    );

    const model = await runTool(
      runtime,
      manager.spawn("codex", task("model task")),
    );
    const btw = await runTool(
      runtime,
      manager.spawn("claude", { ...task("side question"), origin: "btw" }),
    );

    assert.match(model.id, /^sa-/);
    assert.equal(model.origin, "model");
    assert.match(btw.id, /^btw-/);
    assert.equal(btw.origin, "btw");

    await runTool(runtime, manager.cancel([model.id, btw.id]));
    assert.deepEqual(
      settled.sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: btw.id, origin: "btw" },
        { id: model.id, origin: "model" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});

test("the global concurrency cap includes by-the-way sessions", async () => {
  await withManager(async (manager, runtime) => {
    const tasks: SpawnTask[] = [
      { ...task("side question"), origin: "btw" },
      task("Task 2"),
      task("Task 3"),
      task("Task 4"),
    ];
    const spawns = await runTool(
      runtime,
      Effect.forEach(tasks, (spawnTask) => manager.spawn("codex", spawnTask), {
        concurrency: "unbounded",
      }),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(
        runtime,
        manager.spawn("codex", {
          ...task("another side question"),
          origin: "btw",
        }),
      ),
      /Max 4 subagents/,
    );
  });
});

test("the concurrency cap rejects a fifth running subagent", async () => {
  await withManager(async (manager, runtime) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("codex", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(runtime, manager.spawn("codex", task("Task 5"))),
      /Max 4 subagents/,
    );
  });
});

test("pi spawn fails fast without the parent model registry", async () => {
  await withManager(async (manager, runtime) => {
    await assert.rejects(
      runTool(runtime, manager.spawn("pi", task("needs a registry"))),
      /model registry/,
    );
    // The failed spawn must release its concurrency reservation.
    const snap = await runTool(runtime, manager.spawn("codex", task("ok")));
    assert.equal(snap.backend, "codex");
  });
});

test("idle restarts respect the concurrency cap", async () => {
  await withManager(async (manager, runtime) => {
    // Settle one subagent, then fill all four slots with running ones.
    const settled = await runTool(
      runtime,
      manager.spawn("claude", task("early finisher")),
    );
    await runTool(runtime, manager.waitFor([settled.id]));
    await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("codex", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    // Restarting the settled one would be a fifth concurrent run.
    await assert.rejects(
      runTool(runtime, manager.send(settled.id, "go again")),
      /Max 4 subagents/,
    );
    assert.equal(manager.view.get(settled.id)?.status, "done");
  });
});

test("waitForNext yields after one settlement and reports remaining ids", async () => {
  await withManager(async (manager, runtime) => {
    const slow = await runTool(
      runtime,
      manager.spawn("claude", task("slower task")),
    );
    const fast = await runTool(
      runtime,
      manager.spawn("codex", task("faster task")),
    );

    const outcome = await runTool(
      runtime,
      manager.waitForNext([slow.id, fast.id]),
    );
    assert.ok(outcome.settled.length >= 1);
    assert.equal(outcome.settled.length + outcome.pending.length, 2);
    for (const id of outcome.settled) {
      assert.notEqual(manager.view.get(id)?.status, "running");
    }
    for (const id of outcome.pending) {
      assert.equal(manager.view.get(id)?.status, "running");
    }
    if (outcome.pending.length > 0) {
      await runTool(runtime, manager.cancel(outcome.pending));
    }
  });
});

test("manual-delivery tasks are consumed even without active wait interest", async () => {
  await withManager(async (manager, runtime) => {
    const settlements: boolean[] = [];
    manager.view.setOnSettled((_snap, consumed) => settlements.push(consumed));
    const snap = await runTool(
      runtime,
      manager.spawn("codex", {
        ...task("blocking run"),
        delivery: "manual",
      }),
    );
    while (manager.view.get(snap.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(settlements, [true]);

    await runTool(
      runtime,
      manager.send(snap.id, "restart manually collected child"),
    );
    while (manager.view.get(snap.id)?.status !== "running") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    while (manager.view.get(snap.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(settlements, [true, false]);
  });
});

test("send steers an idle subagent into another turn", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("First turn")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterFirst = manager.view.get(snap.id);
    assert.equal(afterFirst?.status, "done");

    await runTool(runtime, manager.send(snap.id, "Second turn"));
    // The fresh run flips the status back to running...
    while (manager.view.get(snap.id)?.status !== "running") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterSecond = manager.view.get(snap.id);
    assert.equal(afterSecond?.status, "done");
    assert.match(afterSecond?.finalText ?? "", /Second turn/);
  });
});

test("a recoverable backend hibernates after settle and resumes by native session id", async () => {
  const billingUsage = {
    input: 100,
    output: 20,
    cacheRead: 10,
    cacheWrite: 5,
    totalTokens: 135,
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2, total: 3.3 },
  };
  const base = makeStubBackend({
    backend: "claude",
    defaultModelLabel: "claude/sonnet",
    contextWindow: 200_000,
    toolName: "Bash",
    cadenceMs: 1,
    billingUsage,
  });
  const resumedIds: Array<string | undefined> = [];
  const priorBilling: Array<typeof billingUsage | undefined> = [];
  const closedAtSpawn: number[] = [];
  let closedSessions = 0;
  let firstCloseStarted = false;
  let releaseFirstClose = () => {};
  const firstCloseGate = new Promise<void>((resolve) => {
    releaseFirstClose = resolve;
  });
  const backend: SubagentBackend = {
    ...base,
    capabilities: { ...base.capabilities, resumeFromSessionId: true },
    spawn: (spawnTask) =>
      Effect.gen(function* () {
        resumedIds.push(spawnTask.resumeNativeSessionId);
        priorBilling.push(spawnTask.priorBillingUsage);
        closedAtSpawn.push(closedSessions);
        const session = yield* base.spawn(spawnTask);
        return {
          ...session,
          shutdown: Effect.promise(async () => {
            if (closedSessions === 0) {
              firstCloseStarted = true;
              await firstCloseGate;
            }
            closedSessions++;
            return true;
          }),
        };
      }),
  };

  const runtime = createRuntimeWithBackends([backend]);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("First turn")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    const nativeSessionId = manager.view.get(snap.id)?.meta.nativeSessionId;
    assert.ok(nativeSessionId);

    assert.equal(manager.view.get(snap.id)?.status, "done");

    // Resume immediately. The manager must still await the detached scope
    // shutdown before a new process reads the same native transcript.
    const resumed = runTool(runtime, manager.send(snap.id, "Second turn"));
    while (!firstCloseStarted) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(resumedIds, [undefined]);
    releaseFirstClose();
    await resumed;
    while (manager.view.get(snap.id)?.status !== "running") {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await runTool(runtime, manager.waitFor([snap.id]));
    while (closedSessions < 2) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.deepEqual(resumedIds, [undefined, nativeSessionId]);
    assert.deepEqual(priorBilling, [undefined, billingUsage]);
    assert.deepEqual(closedAtSpawn, [0, 1]);
    assert.equal(
      manager.view.get(snap.id)?.meta.nativeSessionId,
      nativeSessionId,
    );
    assert.match(manager.view.get(snap.id)?.finalText ?? "", /Second turn/);
  } finally {
    releaseFirstClose();
    await runtime.dispose();
  }
});

test("cancel interrupts a restart waiting for native shutdown", async () => {
  const base = makeStubBackend({
    backend: "claude",
    defaultModelLabel: "claude/sonnet",
    contextWindow: 200_000,
    toolName: "Bash",
    cadenceMs: 1,
  });
  let spawnCount = 0;
  let shutdownStarted = false;
  let releaseShutdown = () => {};
  const shutdownGate = new Promise<void>((resolve) => {
    releaseShutdown = resolve;
  });
  const backend: SubagentBackend = {
    ...base,
    capabilities: { ...base.capabilities, resumeFromSessionId: true },
    spawn: (spawnTask) =>
      Effect.gen(function* () {
        spawnCount++;
        const session = yield* base.spawn(spawnTask);
        if (spawnCount !== 1) return session;
        return {
          ...session,
          shutdown: Effect.gen(function* () {
            shutdownStarted = true;
            yield* Effect.promise(() => shutdownGate);
            return yield* session.shutdown!;
          }),
        };
      }),
  };

  const runtime = createRuntimeWithBackends([backend]);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("First turn")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    while (!shutdownStarted) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const sendOutcome = runTool(
      runtime,
      manager.send(snap.id, "Must be cancelled"),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    const report = await runTool(runtime, manager.cancel([snap.id]));
    assert.equal(report[0]?.cancelled, true);
    assert.equal(manager.view.get(snap.id)?.status, "error");
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
    assert.ok(await sendOutcome);
    assert.equal(spawnCount, 1);
  } finally {
    releaseShutdown();
    await runtime.dispose();
  }
});

test("an unconfirmed native shutdown refuses to resume the session", async () => {
  const base = makeStubBackend({
    backend: "claude",
    defaultModelLabel: "claude/sonnet",
    contextWindow: 200_000,
    toolName: "Bash",
    cadenceMs: 1,
  });
  let spawnCount = 0;
  let shutdownStarted = false;
  let releaseShutdown = () => {};
  const shutdownGate = new Promise<void>((resolve) => {
    releaseShutdown = resolve;
  });
  const backend: SubagentBackend = {
    ...base,
    capabilities: { ...base.capabilities, resumeFromSessionId: true },
    spawn: (spawnTask) =>
      Effect.gen(function* () {
        spawnCount++;
        const session = yield* base.spawn(spawnTask);
        return spawnCount === 1
          ? {
              ...session,
              shutdown: Effect.gen(function* () {
                shutdownStarted = true;
                yield* Effect.promise(() => shutdownGate);
                return false;
              }),
            }
          : session;
      }),
  };

  const runtime = createRuntimeWithBackends([backend]);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("First turn")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    while (!shutdownStarted) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const refused = runTool(runtime, manager.send(snap.id, "Must not run"));
    const waiting = runTool(runtime, manager.waitFor([snap.id]));
    releaseShutdown();
    await assert.rejects(refused, /did not shut down cleanly/);
    await Promise.race([
      waiting,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("waitFor stayed stuck")), 1_000),
      ),
    ]);
    await assert.rejects(
      runTool(runtime, manager.send(snap.id, "Must still not run")),
      /did not shut down cleanly/,
    );
    assert.equal(spawnCount, 1);
    assert.equal(manager.view.get(snap.id)?.status, "done");
  } finally {
    releaseShutdown();
    await runtime.dispose();
  }
});

test("dispose interrupts an in-flight native session resume", async () => {
  const base = makeStubBackend({
    backend: "claude",
    defaultModelLabel: "claude/sonnet",
    contextWindow: 200_000,
    toolName: "Bash",
    cadenceMs: 1,
  });
  let spawnCount = 0;
  let resumeSpawnStarted = false;
  let releaseResumeSpawn = () => {};
  const resumeSpawnGate = new Promise<void>((resolve) => {
    releaseResumeSpawn = resolve;
  });
  const backend: SubagentBackend = {
    ...base,
    capabilities: { ...base.capabilities, resumeFromSessionId: true },
    spawn: (spawnTask) =>
      Effect.gen(function* () {
        spawnCount++;
        if (spawnCount === 2) {
          resumeSpawnStarted = true;
          yield* Effect.promise(() => resumeSpawnGate);
        }
        return yield* base.spawn(spawnTask);
      }),
  };

  const runtime = createRuntimeWithBackends([backend]);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("First turn")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));

    const resumeOutcome = runTool(
      runtime,
      manager.send(snap.id, "Must not run"),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    while (!resumeSpawnStarted) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await runTool(runtime, manager.disposeAll);
    assert.equal(manager.view.size(), 0);
    assert.ok(await resumeOutcome);
    assert.equal(spawnCount, 2);
  } finally {
    releaseResumeSpawn();
    await runtime.dispose();
  }
});

test("cancel stops a queued native turn waiting to emit RunStarted", async () => {
  let firstNativeSettled = false;
  let secondTurnWaiting = false;
  let releaseFirstSettle = () => {};
  let releaseSecondTurn = () => {};
  const firstSettleGate = new Promise<void>((resolve) => {
    releaseFirstSettle = resolve;
  });
  const secondTurnGate = new Promise<void>((resolve) => {
    releaseSecondTurn = resolve;
  });
  let settleCount = 0;
  const base = makeStubBackend({
    backend: "claude",
    defaultModelLabel: "claude/sonnet",
    contextWindow: 200_000,
    toolName: "Bash",
    cadenceMs: 1,
    beforeTurn: async (turn) => {
      if (turn === 1) {
        secondTurnWaiting = true;
        await secondTurnGate;
      }
    },
    beforeSettled: async () => {
      settleCount++;
      if (settleCount === 1) {
        firstNativeSettled = true;
        await firstSettleGate;
      }
    },
  });
  const backend: SubagentBackend = {
    ...base,
    capabilities: { ...base.capabilities, resumeFromSessionId: true },
  };

  const runtime = createRuntimeWithBackends([backend]);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("First turn")),
    );
    await runTool(runtime, manager.send(snap.id, "Queued second turn"));
    while (!firstNativeSettled) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    releaseFirstSettle();
    while (
      !secondTurnWaiting ||
      !manager.view.get(snap.id)?.finalText.includes("First turn")
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(manager.view.get(snap.id)?.status, "running");

    const report = await runTool(runtime, manager.cancel([snap.id]));
    assert.equal(report[0]?.cancelled, true);
    assert.equal(manager.view.get(snap.id)?.status, "error");
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
    assert.equal(manager.view.get(snap.id)?.finalText, "");
  } finally {
    releaseFirstSettle();
    releaseSecondTurn();
    await runtime.dispose();
  }
});

test("a send accepted in the native settlement gap survives hibernation", async () => {
  let nativeSettled = false;
  let secondTurnWaiting = false;
  let secondNativeSettled = false;
  let releaseFirstSettle = () => {};
  let releaseSecondTurn = () => {};
  let releaseSecondSettle = () => {};
  const firstSettleGate = new Promise<void>((resolve) => {
    releaseFirstSettle = resolve;
  });
  const secondTurnGate = new Promise<void>((resolve) => {
    releaseSecondTurn = resolve;
  });
  const secondSettleGate = new Promise<void>((resolve) => {
    releaseSecondSettle = resolve;
  });
  let settleCount = 0;
  const base = makeStubBackend({
    backend: "claude",
    defaultModelLabel: "claude/sonnet",
    contextWindow: 200_000,
    toolName: "Bash",
    cadenceMs: 1,
    beforeTurn: async (turn) => {
      if (turn === 1) {
        secondTurnWaiting = true;
        await secondTurnGate;
      }
    },
    beforeSettled: async () => {
      settleCount++;
      if (settleCount === 1) {
        nativeSettled = true;
        await firstSettleGate;
      } else if (settleCount === 2) {
        secondNativeSettled = true;
        await secondSettleGate;
      }
    },
  });
  let closedSessions = 0;
  const backend: SubagentBackend = {
    ...base,
    capabilities: { ...base.capabilities, resumeFromSessionId: true },
    spawn: (spawnTask) =>
      Effect.gen(function* () {
        const session = yield* base.spawn(spawnTask);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closedSessions++;
          }),
        );
        return session;
      }),
  };

  const runtime = createRuntimeWithBackends([backend]);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("First turn")),
    );
    while (!nativeSettled) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(manager.view.get(snap.id)?.status, "running");

    await runTool(runtime, manager.send(snap.id, "Settlement-gap turn"));
    let waitFinished = false;
    const waiting = runTool(runtime, manager.waitFor([snap.id])).then(() => {
      waitFinished = true;
    });
    releaseFirstSettle();
    while (
      !secondTurnWaiting ||
      !manager.view.get(snap.id)?.finalText.includes("First turn")
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(manager.view.get(snap.id)?.status, "running");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(waitFinished, false);
    releaseSecondTurn();
    while (!secondNativeSettled) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(waitFinished, false);
    releaseSecondSettle();
    await waiting;

    const settleDeadline = Date.now() + 5_000;
    while (
      !manager.view.get(snap.id)?.finalText.includes("Settlement-gap turn") &&
      Date.now() < settleDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.match(
      manager.view.get(snap.id)?.finalText ?? "",
      /Settlement-gap turn/,
    );
    while (closedSessions < 1 && Date.now() < settleDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(closedSessions, 1);
    assert.equal(manager.view.get(snap.id)?.status, "done");
  } finally {
    releaseFirstSettle();
    releaseSecondTurn();
    releaseSecondSettle();
    await runtime.dispose();
  }
});
