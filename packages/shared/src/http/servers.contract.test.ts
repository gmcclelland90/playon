import { describe, expect, it } from "vitest";
import {
  ImportLocalServerRequestSchema,
  ImportSftpServerRequestSchema,
  RelocateServerRequestSchema,
} from "./servers.js";

describe("mutating server route request contracts", () => {
  it("accepts a minimal local import and drops unknown keys", () => {
    const parsed = ImportLocalServerRequestSchema.parse({
      sourcePath: "/srv/legacy",
      extra: "ignored",
    });
    expect(parsed).toEqual({ sourcePath: "/srv/legacy" });
  });

  it("rejects a local import without a source path", () => {
    const result = ImportLocalServerRequestSchema.safeParse({ serverName: "No source" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("sourcePath");
  });

  it("requires host, username and remote path for an SFTP import", () => {
    const result = ImportSftpServerRequestSchema.safeParse({ host: "h", remotePath: "/x" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["username"]);

    const ok = ImportSftpServerRequestSchema.parse({
      host: "box.lan",
      port: 2222,
      username: "lan",
      privateKey: "key",
      remotePath: "/home/lan/server",
    });
    expect(ok.port).toBe(2222);
  });

  it("requires a target node to relocate", () => {
    expect(RelocateServerRequestSchema.safeParse({}).success).toBe(false);
    expect(RelocateServerRequestSchema.safeParse({ targetNodeId: "" }).success).toBe(false);
    expect(RelocateServerRequestSchema.parse({ targetNodeId: "node-a" })).toEqual({
      targetNodeId: "node-a",
    });
  });
});
