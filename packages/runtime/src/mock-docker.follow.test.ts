import { afterEach, describe, expect, it, vi } from "vitest";
import { MockDockerAdapter } from "./mock-docker.js";

describe("MockDockerAdapter.followLogs", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("replays tail and streams new lines until abort", async () => {
    const docker = new MockDockerAdapter();
    const created = await docker.create({ name: "game", image: "playon/mock:test" });
    await docker.start(created.id);

    const lines: string[] = [];
    const follow = await docker.followLogs(created.id, (line) => lines.push(line), { tail: 10 });
    expect(lines).toContain("started");

    docker.emitLog(created.id, "player joined");
    expect(lines.at(-1)).toBe("player joined");

    follow.abort();
    docker.emitLog(created.id, "after abort");
    expect(lines).not.toContain("after abort");

    await docker.stop(created.id);
  });
});
