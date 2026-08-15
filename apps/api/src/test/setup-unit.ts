import { vi } from "vitest";
import { unitRuntimeDockerStubs } from "./unit-runtime-mocks.js";

/** Skip live TCP/UDP probes on the CI host; tests set portsBoundOverride when they need bind evidence. */
process.env.PLAYON_SKIP_HOST_PORT_PROBE = "1";

/**
 * Unit tests use FakeDocker / mocked runtimes — they must not depend on a real
 * Docker socket or engine inspect. After Phase 0, createFromSkill throws
 * no_eligible_node when Local lacks docker; Windows CI has no Windows-container
 * engine, so refineDockerCapability would strip the probe mock and break
 * otherwise-valid tests. Placement tests that need "no docker" inject their own
 * HostCapabilityProbe on PlacementService.
 */
vi.mock("@playon/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@playon/runtime")>();
  return {
    ...actual,
    ...unitRuntimeDockerStubs(actual),
  };
});
