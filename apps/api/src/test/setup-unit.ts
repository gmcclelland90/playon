import { vi } from "vitest";

/**
 * Unit tests use FakeDocker / mocked runtimes — they must not depend on a real
 * Docker socket. After Phase 0, createFromSkill throws no_eligible_node when
 * Local lacks docker; Windows CI runners have no engine, which broke dozens of
 * otherwise-valid tests. Placement tests that need "no docker" inject their own
 * HostCapabilityProbe on PlacementService.
 */
vi.mock("@playon/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@playon/runtime")>();
  return {
    ...actual,
    probeHostCapabilities: (dataRoot: string, env?: NodeJS.ProcessEnv) => {
      const real = actual.probeHostCapabilities(dataRoot, env);
      return { ...real, docker: true };
    },
  };
});
