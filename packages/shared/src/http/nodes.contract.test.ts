import { describe, expect, it } from "vitest";
import { NodeHeartbeatSchema } from "../api.js";
import {
  AddNodeRequestSchema,
  InstallDockerRequestSchema,
  ManageNodeServerRequestSchema,
  NodeBootstrapTokenRequestSchema,
} from "./nodes.js";

describe("node route request contracts", () => {
  it("requires a reachable SSH target to add a node", () => {
    const result = AddNodeRequestSchema.safeParse({ kind: "lan", username: "ops" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["host"]);

    expect(
      AddNodeRequestSchema.parse({
        kind: "cloud",
        host: "203.0.113.9",
        port: 22,
        username: "ops",
        privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
      }).port,
    ).toBe(22);
  });

  it("rejects a non-positive SSH port", () => {
    expect(
      AddNodeRequestSchema.safeParse({ kind: "lan", host: "h", username: "u", port: 0 }).success,
    ).toBe(false);
  });

  it("only needs the node kind for a bootstrap token", () => {
    expect(NodeBootstrapTokenRequestSchema.parse({ kind: "lan" })).toEqual({ kind: "lan" });
    expect(NodeBootstrapTokenRequestSchema.safeParse({ kind: "home" }).success).toBe(false);
  });

  it("requires the source path when adopting an install from a node", () => {
    const result = ManageNodeServerRequestSchema.safeParse({ serverName: "Survival" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["sourcePath"]);

    expect(
      ManageNodeServerRequestSchema.parse({
        sourcePath: "/srv/minecraft",
        hintIds: ["paper"],
      }).hintIds,
    ).toEqual(["paper"]);
  });

  it("takes the node id from the path, not the install-docker body", () => {
    const parsed = InstallDockerRequestSchema.parse({ host: "10.0.0.4", username: "ops" });
    expect(parsed).toEqual({ host: "10.0.0.4", username: "ops" });
    expect(InstallDockerRequestSchema.safeParse({ username: "ops" }).success).toBe(false);
  });

  it("accepts an optional read-only container inventory on heartbeat", () => {
    const parsed = NodeHeartbeatSchema.parse({
      nodeId: "playon-win-1",
      name: "playon-win-1",
      os: "windows",
      docker: true,
      containers: [
        {
          name: "lab-sbox",
          image: "har0x/sbox-server:public",
          status: "running",
          ports: [{ host: 27150, container: 27150, protocol: "udp" }],
        },
      ],
    });
    expect(parsed.containers?.[0]?.name).toBe("lab-sbox");
    expect(
      NodeHeartbeatSchema.parse({
        nodeId: "n1",
        name: "n1",
        os: "linux",
        docker: true,
      }).containers,
    ).toBeUndefined();
  });
});
