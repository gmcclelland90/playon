import type { HostCapabilities } from "@playon/runtime";

/**
 * Shared stubs for `@playon/runtime` in api unit tests.
 *
 * `probeHostCapabilities` alone is not enough: `PlacementService` wraps it in
 * `refineDockerCapability`, which talks to the real Docker Engine on Windows
 * and sets `docker: false` unless OSType is windows. Windows CI has no
 * Windows-container engine, so createFromSkill then throws
 * `no_eligible_node: … docker_required`.
 *
 * Placement tests that need "no docker" inject their own HostCapabilityProbe.
 */
export function unitRuntimeDockerStubs(actual: typeof import("@playon/runtime")) {
  return {
    probeHostCapabilities: (dataRoot: string, env?: NodeJS.ProcessEnv): HostCapabilities => {
      const real = actual.probeHostCapabilities(dataRoot, env);
      return { ...real, docker: true };
    },
    refineDockerCapability: async (caps: HostCapabilities): Promise<HostCapabilities> => caps,
  };
}
