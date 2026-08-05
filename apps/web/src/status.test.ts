import { describe, expect, it } from "vitest";
import { runtimeErrorHint, statusHint, statusLabel } from "./status";

describe("status helpers", () => {
  it("labels docker_unavailable", () => {
    expect(statusLabel("docker_unavailable")).toBe("Docker missing");
    expect(statusHint("docker_unavailable")).toMatch(/Install Docker/);
  });

  it("maps docker error messages", () => {
    expect(runtimeErrorHint("docker_unavailable")).toMatch(/Settings → Nodes/);
    expect(runtimeErrorHint("Error: no_container_image: skill x")).toMatch(/container image/);
    expect(runtimeErrorHint("something else")).toBeNull();
  });
});
