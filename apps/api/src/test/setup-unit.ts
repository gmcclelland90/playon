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
 *
 * `probeHostCapabilities` alone is not enough on Windows: `refineDockerCapability`
 * inspects the live engine and clears `docker` unless OSType is windows. That is
 * how verify (windows-latest) went 78× `no_eligible_node` / `docker_required`
 * while ubuntu stayed green (run 31856580627). Main can pass or fail the same
 * file depending on whether the runner's Docker pipe looks like a Windows engine.
 */
vi.mock("@playon/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@playon/runtime")>();
  return {
    ...actual,
    ...unitRuntimeDockerStubs(actual),
  };
});
