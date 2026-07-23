import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ManagedWorktreeOptions {
  repo: string;
  branch: string;
  base?: string;
  worktreePath?: string;
  signal?: AbortSignal;
}

function commandError(command: string, stderr: string, stdout: string) {
  const detail = (stderr || stdout).trim();
  return new Error(`${command} failed${detail ? `: ${detail}` : ""}`);
}

function slug(value: string) {
  return (
    value
      .replace(/^refs\/heads\//, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "task"
  );
}

export async function resolveGitCommonDir(
  pi: Pick<ExtensionAPI, "exec">,
  repo: string,
  signal?: AbortSignal,
) {
  const result = await pi.exec(
    "git",
    ["-C", repo, "rev-parse", "--git-common-dir"],
    { signal, timeout: 10_000 },
  );
  if (result.code !== 0) {
    throw commandError(
      "git rev-parse --git-common-dir",
      result.stderr,
      result.stdout,
    );
  }
  const value = path.resolve(repo, result.stdout.trim());
  try {
    return await realpath(value);
  } catch {
    return value;
  }
}

/** Create and retain an isolated git worktree for one autonomous child task. */
export async function createManagedWorktree(
  pi: Pick<ExtensionAPI, "exec">,
  options: ManagedWorktreeOptions,
) {
  const rootResult = await pi.exec(
    "git",
    ["-C", options.repo, "rev-parse", "--show-toplevel"],
    { signal: options.signal, timeout: 10_000 },
  );
  if (rootResult.code !== 0) {
    throw commandError("git rev-parse", rootResult.stderr, rootResult.stdout);
  }
  const repoRoot = rootResult.stdout.trim();
  const commonDir = await resolveGitCommonDir(pi, repoRoot, options.signal);

  const branchCheck = await pi.exec(
    "git",
    ["check-ref-format", "--branch", options.branch],
    { signal: options.signal, timeout: 10_000 },
  );
  if (branchCheck.code !== 0) {
    throw commandError(
      "git check-ref-format",
      branchCheck.stderr,
      branchCheck.stdout,
    );
  }

  const destination = options.worktreePath
    ? path.resolve(repoRoot, options.worktreePath)
    : path.join(
        path.dirname(repoRoot),
        `${path.basename(repoRoot)}.${slug(options.branch)}-${randomBytes(3).toString("hex")}`,
      );
  const base = options.base?.trim() || "HEAD";
  const add = await pi.exec(
    "git",
    [
      "-C",
      repoRoot,
      "worktree",
      "add",
      "-b",
      options.branch,
      destination,
      base,
    ],
    { signal: options.signal, timeout: 120_000 },
  );
  if (add.code !== 0) {
    throw commandError("git worktree add", add.stderr, add.stdout);
  }
  return {
    repoRoot,
    commonDir,
    branch: options.branch,
    base,
    path: destination,
  };
}
