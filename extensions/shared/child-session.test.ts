import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createChildResources } from "./child-session.ts";

test("in-process children do not load parent-session extensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-child-resources-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  try {
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "transport.ts"),
      "export default function () { throw new Error('must not load') }\n",
    );

    const { loader } = await createChildResources({
      cwd,
      agentDir,
      projectTrusted: true,
    });

    assert.equal(loader.getExtensions().extensions.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
