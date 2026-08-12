import { z } from "zod";
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

export const NET_NODE_JOB_CONTRACTS = {
  net_udp_listen: defineNodeJob("net_udp_listen", NetUdpListenArgsSchema, NetUdpListenResultSchema),
} as const satisfies NodeJobContractMap;

export type NetUdpListenArgs = z.infer<typeof NetUdpListenArgsSchema>;
export type NetUdpListenResult = z.infer<typeof NetUdpListenResultSchema>;
