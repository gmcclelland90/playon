import { z } from "zod";
import { isLoopbackJoinHost } from "../join-path-probe.js";
import { UDP_LISTEN_PROBES } from "../udp-listen.js";
import { defineNodeJob, type NodeJobContractMap } from "./contract.js";

/**
 * Host network probes that must run on the node (Home TCP connect cannot see
 * a Windows UDP bind). Args are strict; results stay lenient about extras.
 */

export const NetUdpListenArgsSchema = z
  .object({
    port: z.number().int().min(1).max(65535),
  })
  .strict();

export const NetUdpListenResultSchema = z.object({
  port: z.number().int().min(1).max(65535),
  listening: z.boolean(),
  probe: z.enum(UDP_LISTEN_PROBES),
});

/**
 * TCP connect on the node itself (typically 127.0.0.1). Used by the #843
 * join-path loopback leg so Home soak Paper cannot fake “localhost open”.
 * Non-loopback hosts are rejected — this is not a remote scanner.
 */
export const NetTcpConnectArgsSchema = z
  .object({
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().min(1).max(65535),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (!isLoopbackJoinHost(val.host)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "net_tcp_connect_host_must_be_loopback",
        path: ["host"],
      });
    }
  });

export const NetTcpConnectResultSchema = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  state: z.enum(["open", "closed"]),
});

/**
 * Long-lived TCP/UDP proxy on the node (Windows parent LAN IP → 127.0.0.1).
 * WSL localhostForwarding already owns 127.0.0.1; bind the advertised join_host
 * so LAN clients can reach the sibling without netsh portproxy.
 */
export const NetPortPublishArgsSchema = z
  .object({
    action: z.enum(["ensure", "release", "release_server"]),
    serverId: z.string().min(1),
    listenHost: z.string().min(1).optional(),
    listenPort: z.number().int().min(1).max(65535).optional(),
    protocol: z.enum(["tcp", "udp"]).optional(),
    targetHost: z.string().min(1).default("127.0.0.1"),
    targetPort: z.number().int().min(1).max(65535).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.action === "release_server") return;
    if (val.listenPort == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "net_port_publish_listen_port_required",
        path: ["listenPort"],
      });
    }
    if (!val.protocol) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "net_port_publish_protocol_required",
        path: ["protocol"],
      });
    }
    if (val.action === "ensure" && !val.listenHost?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "net_port_publish_listen_host_required",
        path: ["listenHost"],
      });
    }
  });

export const NetPortPublishResultSchema = z.object({
  ok: z.boolean(),
  listening: z.boolean(),
  action: z.enum(["ensure", "release", "release_server"]),
  serverId: z.string(),
  listenHost: z.string().optional(),
  listenPort: z.number().int().optional(),
  protocol: z.enum(["tcp", "udp"]).optional(),
  targetHost: z.string().optional(),
  targetPort: z.number().int().optional(),
  error: z.string().optional(),
});

export const NET_NODE_JOB_CONTRACTS = {
  net_udp_listen: defineNodeJob("net_udp_listen", NetUdpListenArgsSchema, NetUdpListenResultSchema),
  net_tcp_connect: defineNodeJob(
    "net_tcp_connect",
    NetTcpConnectArgsSchema,
    NetTcpConnectResultSchema,
  ),
  net_port_publish: defineNodeJob(
    "net_port_publish",
    NetPortPublishArgsSchema,
    NetPortPublishResultSchema,
  ),
} as const satisfies NodeJobContractMap;

export type NetUdpListenArgs = z.infer<typeof NetUdpListenArgsSchema>;
export type NetUdpListenResult = z.infer<typeof NetUdpListenResultSchema>;
export type NetTcpConnectArgs = z.infer<typeof NetTcpConnectArgsSchema>;
export type NetTcpConnectResult = z.infer<typeof NetTcpConnectResultSchema>;
export type NetPortPublishArgs = z.infer<typeof NetPortPublishArgsSchema>;
export type NetPortPublishResult = z.infer<typeof NetPortPublishResultSchema>;
