import type {
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";

/**
 * Pi 0.80.10 moved child-session creation from ModelRegistry to ModelRuntime,
 * while ExtensionContext still exposes only the compatibility registry. Keep
 * the version-specific bridge in one place until Pi exposes the runtime on the
 * extension context or accepts ModelRegistry again.
 */
export function modelRuntimeFromRegistry(registry: ModelRegistry) {
  const runtime = (registry as unknown as { runtime?: ModelRuntime }).runtime;
  if (!runtime) {
    throw new Error(
      "Unable to access Pi's model runtime for a child session. This Pi version is incompatible with the subagent extension.",
    );
  }
  return runtime;
}
