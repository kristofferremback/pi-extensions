export const ALLOWED_PI_CHILD_PROVIDERS = [
  "openai-codex",
  "opencode-go",
  "alibaba-cloud",
] as const;

const allowedProviders = new Set<string>(ALLOWED_PI_CHILD_PROVIDERS);

export function isAllowedPiChildProvider(provider: string): boolean {
  return allowedProviders.has(provider);
}

export const ALLOWED_PI_CHILD_PROVIDERS_LABEL =
  ALLOWED_PI_CHILD_PROVIDERS.join(", ");
