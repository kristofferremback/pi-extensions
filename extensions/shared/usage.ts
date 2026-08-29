import type { Usage } from "@earendil-works/pi-ai";

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

export function addUsage(target: Usage, value: Usage | undefined): Usage {
  if (!value) return target;
  target.input += value.input || 0;
  target.output += value.output || 0;
  target.cacheRead += value.cacheRead || 0;
  target.cacheWrite += value.cacheWrite || 0;
  target.totalTokens += value.totalTokens || 0;
  if (value.cacheWrite1h !== undefined) {
    target.cacheWrite1h = (target.cacheWrite1h ?? 0) + value.cacheWrite1h;
  }
  if (value.reasoning !== undefined) {
    target.reasoning = (target.reasoning ?? 0) + value.reasoning;
  }
  target.cost.input += value.cost?.input || 0;
  target.cost.output += value.cost?.output || 0;
  target.cost.cacheRead += value.cost?.cacheRead || 0;
  target.cost.cacheWrite += value.cost?.cacheWrite || 0;
  target.cost.total += value.cost?.total || 0;
  return target;
}

export function sumUsage(values: Iterable<Usage | undefined>): Usage {
  const total = emptyUsage();
  for (const value of values) addUsage(total, value);
  return total;
}

export function usageFromMessages(
  messages: ReadonlyArray<{ role: string; usage?: Usage }>,
): Usage {
  return sumUsage(
    messages.map((message) =>
      message.role === "assistant" || message.role === "toolResult"
        ? message.usage
        : undefined,
    ),
  );
}

export function usageDelta(total: Usage, previous?: Usage): Usage {
  if (!previous) return structuredClone(total);
  const delta = emptyUsage();
  const subtract = (next: number | undefined, prior: number | undefined) =>
    Math.max(0, (next ?? 0) - (prior ?? 0));
  delta.input = subtract(total.input, previous.input);
  delta.output = subtract(total.output, previous.output);
  delta.cacheRead = subtract(total.cacheRead, previous.cacheRead);
  delta.cacheWrite = subtract(total.cacheWrite, previous.cacheWrite);
  delta.totalTokens = subtract(total.totalTokens, previous.totalTokens);
  if (total.cacheWrite1h !== undefined || previous.cacheWrite1h !== undefined) {
    delta.cacheWrite1h = subtract(total.cacheWrite1h, previous.cacheWrite1h);
  }
  if (total.reasoning !== undefined || previous.reasoning !== undefined) {
    delta.reasoning = subtract(total.reasoning, previous.reasoning);
  }
  delta.cost.input = subtract(total.cost?.input, previous.cost?.input);
  delta.cost.output = subtract(total.cost?.output, previous.cost?.output);
  delta.cost.cacheRead = subtract(
    total.cost?.cacheRead,
    previous.cost?.cacheRead,
  );
  delta.cost.cacheWrite = subtract(
    total.cost?.cacheWrite,
    previous.cost?.cacheWrite,
  );
  delta.cost.total = subtract(total.cost?.total, previous.cost?.total);
  return delta;
}

export function hasUsage(usage: Usage | undefined): usage is Usage {
  return Boolean(
    usage &&
    (usage.input ||
      usage.output ||
      usage.cacheRead ||
      usage.cacheWrite ||
      usage.totalTokens ||
      usage.cost?.total),
  );
}
