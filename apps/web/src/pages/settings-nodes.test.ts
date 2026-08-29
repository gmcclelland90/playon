import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SETTINGS_NODE_HEADER_CLASS,
  SETTINGS_NODE_ITEM_CLASS,
  SETTINGS_NODE_NOTES_CLASS,
  nodeDockerChip,
  nodeRestartRowMessage,
  nodeUpdateInFlight,
  nodeUpdateRowMessage,
  nodeUsageChips,
} from "./settings-nodes";

describe("nodeDockerChip", () => {
  it("hides No Docker on a Windows parent when an online WSL sibling has Docker", () => {
    expect(
      nodeDockerChip({
        pendingSetup: false,
        docker: false,
        isWindows: true,
        wslSiblingOnline: true,
        wslSiblingHasDocker: true,
      }),
    ).toBeNull();
  });

  it("still warns No Docker on Windows without a WSL Docker sibling", () => {
    expect(
      nodeDockerChip({
        pendingSetup: false,
        docker: false,
        isWindows: true,
        wslSiblingOnline: false,
        wslSiblingHasDocker: false,
      }),
    ).toEqual({ label: "No Docker", tone: "warn" });
  });

  it("shows a live Docker chip when the node itself has Docker", () => {
    expect(
      nodeDockerChip({
        pendingSetup: false,
        docker: true,
        isWindows: false,
        wslSiblingOnline: false,
        wslSiblingHasDocker: false,
      }),
    ).toEqual({ label: "Docker", tone: "live" });
  });

  it("shows Docker on a Windows parent that has a Windows-container engine", () => {
    expect(
      nodeDockerChip({
        pendingSetup: false,
        docker: true,
        isWindows: true,
        wslSiblingOnline: true,
        wslSiblingHasDocker: true,
      }),
    ).toEqual({ label: "Docker", tone: "live" });
  });
});

describe("nodeUpdateRowMessage", () => {
  it("surfaces queued / running / failed on the row", () => {
    expect(
      nodeUpdateRowMessage({
        job: { jobId: "j1", status: "queued", version: "0.2.4" },
      }),
    ).toEqual({ tone: "muted", text: "Update queued to 0.2.4…" });
    expect(
      nodeUpdateRowMessage({
        job: { jobId: "j1", status: "running", progress: "Downloading…" },
      }),
    ).toEqual({ tone: "muted", text: "Downloading…" });
    expect(
      nodeUpdateRowMessage({
        job: { jobId: "j1", status: "failed", error: "update_sha256_mismatch" },
      }),
    ).toEqual({ tone: "error", text: "update_sha256_mismatch" });
  });

  it("tells the operator to retry when a tracked job vanished after Home restart", () => {
    expect(
      nodeUpdateRowMessage({ job: null, expectedJobId: "lost-1", updateAvailable: true }),
    ).toEqual({
      tone: "error",
      text: "Queue lost — press Update again.",
    });
    expect(
      nodeUpdateRowMessage({ job: null, expectedJobId: "lost-1", updateAvailable: false }),
    ).toBeNull();
  });

  it("treats queued and running as in-flight", () => {
    expect(nodeUpdateInFlight({ jobId: "j", status: "queued" })).toBe(true);
    expect(nodeUpdateInFlight({ jobId: "j", status: "failed" })).toBe(false);
  });
});

describe("nodeRestartRowMessage", () => {
  it("explains the heartbeat path so operators skip Task Scheduler", () => {
    expect(nodeRestartRowMessage(false)).toBeNull();
    expect(nodeRestartRowMessage(true)).toEqual({
      tone: "muted",
      text: "Restart requested — the agent will exit on its next heartbeat.",
    });
  });
});

describe("nodeUsageChips", () => {
  it("adds CPU / RAM / disk chips when a heartbeat sent them", () => {
    expect(
      nodeUsageChips({
        cpuPercent: 12,
        memUsedBytes: 4 * 1024 ** 3,
        memTotalBytes: 16 * 1024 ** 3,
        freeDiskBytes: 20 * 1024 ** 3,
      }).map((c) => c.label),
    ).toEqual(["CPU 12%", "4.0 GiB / 16.0 GiB", "20.0 GiB free"]);
  });
});

describe("settings node row layout CSS", () => {
  it("keeps helper copy below a nowrap header, not as a flex sibling of actions", () => {
    const css = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "styles.css"),
      "utf8",
    );
    const itemBlock = css.slice(css.indexOf(`.${SETTINGS_NODE_ITEM_CLASS}`));
    expect(itemBlock).toMatch(/flex-direction:\s*column/);
    const headerBlock = css.slice(css.indexOf(`.${SETTINGS_NODE_HEADER_CLASS}`));
    expect(headerBlock).toMatch(/flex-wrap:\s*nowrap/);
    expect(css).toContain(`.${SETTINGS_NODE_NOTES_CLASS}`);
  });
});
