import assert from "node:assert/strict";
import test from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import {
  addUsage,
  emptyUsage,
  hasUsage,
  usageDelta,
  usageFromMessages,
} from "./usage.ts";

const sample = (input: number, output: number, cost: number): Usage => ({
  input,
  output,
  cacheRead: 10,
  cacheWrite: 2,
  reasoning: 3,
  totalTokens: input + output + 12,
  cost: {
    input: cost / 2,
    output: cost / 2,
    cacheRead: 0,
    cacheWrite: 0,
    total: cost,
  },
});

test("usage helpers aggregate assistant/tool usage and preserve cost", () => {
  const first = sample(20, 5, 0.2);
  const second = sample(30, 7, 0.3);
  const total = usageFromMessages([
    { role: "user" },
    { role: "assistant", usage: first },
    { role: "toolResult", usage: second },
  ]);
  assert.equal(total.input, 50);
  assert.equal(total.output, 12);
  assert.equal(total.reasoning, 6);
  assert.equal(total.cost.total, 0.5);
  assert.ok(hasUsage(total));
});

test("usageDelta returns only newly unaccounted cumulative usage", () => {
  const previous = sample(20, 5, 0.2);
  const cumulative = addUsage(structuredClone(previous), sample(30, 7, 0.3));
  const delta = usageDelta(cumulative, previous);
  assert.equal(delta.input, 30);
  assert.equal(delta.output, 7);
  assert.equal(delta.cost.total, 0.3);
  assert.equal(hasUsage(emptyUsage()), false);
});
