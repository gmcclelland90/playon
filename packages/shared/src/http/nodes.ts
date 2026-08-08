import { z } from "zod";

/**
 * Request contracts for the node-management routes. They live here rather than
 * inline in `app.ts` so the control plane and web client validate the same
 * shape, and so a schema failure renders as the shared 400 envelope.
 */

const nonEmpty = z.string().min(1);
const optionalName = nonEmpty.optional();
const port = z.number().int().positive().optional();

/** `password` / `privateKey` are credentials: never log or echo a parsed body. */
const sshCredentials = {
  host: nonEmpty,
  port,
  username: nonEmpty,
  password: optionalName,
  privateKey: optionalName,
};

export const AddNodeRequestSchema = z.object({
  kind: z.enum(["lan", "cloud"]),
  ...sshCredentials,
  nodeId: optionalName,
  nodeName: optionalName,
  wgListenPort: port,
});

export type AddNodeRequest = z.infer<typeof AddNodeRequestSchema>;

/** Bootstrap tokens are for hosts we cannot reach over SSH, so no credentials. */
export const NodeBootstrapTokenRequestSchema = z.object({
  kind: z.enum(["lan", "cloud"]),
  nodeId: optionalName,
  nodeName: optionalName,
  endpointHost: optionalName,
});

export type NodeBootstrapTokenRequest = z.infer<typeof NodeBootstrapTokenRequestSchema>;

/** Adopting an existing install already on the node; the node id is in the path. */
export const ManageNodeServerRequestSchema = z.object({
  sourcePath: nonEmpty,
  serverName: optionalName,
  skillName: optionalName,
  game: optionalName,
  hintIds: z.array(nonEmpty).optional(),
});

export type ManageNodeServerRequest = z.infer<typeof ManageNodeServerRequestSchema>;

export const InstallDockerRequestSchema = z.object(sshCredentials);

export type InstallDockerRequest = z.infer<typeof InstallDockerRequestSchema>;
