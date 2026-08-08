import { describe, expect, it } from "vitest";
import {
  NODE_JOB_ERROR_CODES,
  NodeJobError,
  encodeNodeJobError,
  hasNodeJobErrorCode,
  parseNodeJobErrorCode,
  toNodeJobError,
} from "./errors.js";

describe("node job error codes", () => {
  it("covers the codes the protocol promises", () => {
    expect(NODE_JOB_ERROR_CODES).toContain("unsupported_job_kind");
    expect(NODE_JOB_ERROR_CODES).toContain("timeout");
    expect(NODE_JOB_ERROR_CODES).toContain("validation_failed");
  });

  it("encodes code and detail onto one wire string", () => {
    expect(encodeNodeJobError("timeout")).toBe("timeout");
    expect(encodeNodeJobError("timeout", "job abc")).toBe("timeout: job abc");
    expect(new NodeJobError("unsupported_job_kind", { kind: "fs_list" }).message).toBe(
      "unsupported_job_kind: fs_list",
    );
  });

  it("recovers codes from wire strings, including legacy messages", () => {
    expect(parseNodeJobErrorCode("unsupported_job_kind: fs_list")).toBe("unsupported_job_kind");
    expect(parseNodeJobErrorCode("node_job_timeout: abc")).toBe("timeout");
    expect(parseNodeJobErrorCode("missing_arg: path")).toBe("validation_failed");
    expect(parseNodeJobErrorCode("docker_unavailable")).toBeNull();
    expect(parseNodeJobErrorCode(undefined)).toBeNull();
  });

  it("normalizes anything thrown into a typed error", () => {
    const fromLegacy = toNodeJobError("unsupported_job_kind: fs_list", { kind: "fs_list" });
    expect(fromLegacy.code).toBe("unsupported_job_kind");
    expect(fromLegacy.message).toBe("unsupported_job_kind: fs_list");

    const unknown = toNodeJobError(new Error("docker_unavailable"), { kind: "container_start" });
    expect(unknown.code).toBe("job_failed");
    expect(unknown.message).toContain("container_start");
    expect(unknown.message).toContain("docker_unavailable");

    const typed = new NodeJobError("timeout");
    expect(toNodeJobError(typed)).toBe(typed);
  });

  it("lets callers branch without string matching", () => {
    expect(hasNodeJobErrorCode(new NodeJobError("timeout"), "timeout")).toBe(true);
    expect(hasNodeJobErrorCode(new Error("node_job_timeout: abc"), "timeout")).toBe(true);
    expect(hasNodeJobErrorCode(new Error("boom"), "timeout")).toBe(false);
  });
});
