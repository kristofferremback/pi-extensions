import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { Effect } from "effect";
import { SubagentManager } from "./src/manager.ts";
import { claudeBackend } from "./src/backends/claude.ts";
import type { ParentContext, SpawnTask } from "./src/domain.ts";
import { createSubagentRuntime, runTool } from "./src/runtime.ts";

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return {
    prompt,
    title: "live Claude test",
    cwd: process.cwd(),
    model: "haiku",
    reasoningEffort: "off",
    parent,
  };
}

async function claudeAvailable() {
  return Effect.runPromise(claudeBackend.available);
}

function directClaudeChildren(): number[] {
  if (process.platform === "win32") return [];
  return execFileSync("ps", ["-eo", "pid=,ppid=,args="], {
    encoding: "utf8",
  })
    .split("\n")
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      return Number(match?.[2]) === process.pid &&
        match?.[3].includes("claude") &&
        match[3].includes("--output-format stream-json")
        ? [Number(match[1])]
        : [];
    });
}

async function waitForClaudeChildrenAtMost(count: number, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  while (directClaudeChildren().length > count && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(directClaudeChildren().length, count);
}

/** Rejecting deadline so a hung wait still reaches finally() and disposes. */
function deadline<A>(operation: Promise<A>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Live Claude test exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

test(
  "Claude backend hibernates after completion and resumes the same session",
  { timeout: 120_000 },
  async (t) => {
    if (!(await claudeAvailable())) {
      t.skip("Claude Code executable is unavailable");
      return;
    }

    const runtime = createSubagentRuntime();
    const baselineChildPids = directClaudeChildren();
    const baselineChildren = baselineChildPids.length;
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const started = await runTool(
        runtime,
        manager.spawn("claude", task("Reply with exactly: hello claude")),
      );
      const processDeadline = Date.now() + 10_000;
      let firstChild: number | undefined;
      if (process.platform !== "win32") {
        firstChild = directClaudeChildren().find(
          (pid) => !baselineChildPids.includes(pid),
        );
        while (firstChild === undefined && Date.now() < processDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          firstChild = directClaudeChildren().find(
            (pid) => !baselineChildPids.includes(pid),
          );
        }
        assert.ok(firstChild);
      }
      await deadline(runTool(runtime, manager.waitFor([started.id])), 45_000);

      const first = manager.view.get(started.id);
      assert.equal(first?.status, "done");
      assert.match(first?.finalText ?? "", /hello claude/i);
      assert.ok(first?.meta.nativeSessionId);
      assert.ok(first?.meta.sessionFilePath?.endsWith(".jsonl"));
      const nativeSessionId = first.meta.nativeSessionId;

      await runTool(
        runtime,
        manager.send(started.id, "Reply with exactly: resumed claude"),
      );
      if (firstChild !== undefined) {
        assert.equal(directClaudeChildren().includes(firstChild), false);
      }
      const restartDeadline = Date.now() + 10_000;
      while (
        manager.view.get(started.id)?.status !== "running" &&
        Date.now() < restartDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(manager.view.get(started.id)?.status, "running");
      await deadline(runTool(runtime, manager.waitFor([started.id])), 45_000);

      const resumed = manager.view.get(started.id);
      assert.equal(resumed?.status, "done");
      assert.match(resumed?.finalText ?? "", /resumed claude/i);
      assert.equal(resumed?.meta.nativeSessionId, nativeSessionId);
      await waitForClaudeChildrenAtMost(baselineChildren, 10_000);
    } finally {
      await runtime.dispose();
    }
  },
);

test(
  "Claude backend interrupt settles a live run as aborted",
  { timeout: 60_000 },
  async (t) => {
    if (!(await claudeAvailable())) {
      t.skip("Claude Code executable is unavailable");
      return;
    }

    const runtime = createSubagentRuntime();
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const started = await runTool(
        runtime,
        manager.spawn(
          "claude",
          task(
            "Write a detailed 10,000-word essay about the history of computing.",
          ),
        ),
      );

      // Wait for streamed output so cancellation definitely lands mid-run and
      // exercises the SDK's normal interrupt receipt/result path.
      const streamDeadline = Date.now() + 15_000;
      while (
        manager.view.get(started.id)?.status === "running" &&
        !manager.view.get(started.id)?.liveAssistant?.text &&
        Date.now() < streamDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(manager.view.get(started.id)?.status, "running");
      assert.ok(manager.view.get(started.id)?.liveAssistant?.text);

      const report = await deadline(
        runTool(runtime, manager.cancel([started.id])),
        20_000,
      );

      assert.equal(report[0]?.cancelled, true);
      assert.equal(manager.view.get(started.id)?.status, "error");
      assert.equal(manager.view.get(started.id)?.errorText, "Run was aborted");
    } finally {
      await runtime.dispose();
    }
  },
);
