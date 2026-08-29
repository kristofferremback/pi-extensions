import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createManagedWorktree } from "./src/worktree.ts";

const execFileAsync = promisify(execFile);

const fakePi = {
  async exec(command: string, args: string[]) {
    try {
      const result = await execFileAsync(command, args);
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failed = error as Error & {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      return {
        code: typeof failed.code === "number" ? failed.code : 1,
        stdout: failed.stdout ?? "",
        stderr: failed.stderr ?? failed.message,
      };
    }
  },
};

test("managed worktree creates a retained branch from the requested base", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-managed-worktree-"));
  const repo = join(root, "repo");
  const destination = join(root, "task-tree");
  try {
    await execFileAsync("git", ["init", repo]);
    await execFileAsync("git", [
      "-C",
      repo,
      "config",
      "user.email",
      "test@example.com",
    ]);
    await execFileAsync("git", ["-C", repo, "config", "user.name", "Test"]);
    await writeFile(join(repo, "marker.txt"), "base\n");
    await execFileAsync("git", ["-C", repo, "add", "marker.txt"]);
    await execFileAsync("git", ["-C", repo, "commit", "-m", "base"]);

    const worktree = await createManagedWorktree(fakePi as never, {
      repo,
      branch: "test/managed-task",
      base: "HEAD",
      worktreePath: destination,
    });

    assert.equal(worktree.path, destination);
    assert.equal(worktree.branch, "test/managed-task");
    assert.equal(worktree.commonDir, await realpath(join(repo, ".git")));
    assert.equal(
      await readFile(join(destination, "marker.txt"), "utf8"),
      "base\n",
    );
    const branch = await execFileAsync("git", [
      "-C",
      destination,
      "branch",
      "--show-current",
    ]);
    assert.equal(branch.stdout.trim(), "test/managed-task");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
