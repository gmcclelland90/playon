import type { LiveServerState, QueryDialect } from "@playon/shared";

export type QueryTarget = {
  host: string;
  /** Primary game or query port (dialect-specific). */
  port: number;
  queryPort?: number;
  gamePort?: number;
  timeoutMs?: number;
  /** Extra allowed ports for skill_module TCP/HTTP helpers. */
  allowedPorts?: number[];
};

export type Connector = {
  id: QueryDialect | string;
  query(target: QueryTarget): Promise<LiveServerState>;
};

export type SkillModuleResolve = {
  skillDir: string;
  connectorRelPath?: string;
};
