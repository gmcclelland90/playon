import type { PublicUser, SetupStatus } from "@playon/shared";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const detail = body.error?.trim();
    throw new Error(detail || `request_failed_${res.status}`);
  }
  return res.json() as Promise<T>;
}

export type LlmPublic = {
  provider: "openai_compatible" | "ollama";
  baseUrl?: string;
  model?: string;
  hasApiKey: boolean;
};

export type ServerRow = {
  id: string;
  name: string;
  game: string | null;
  nodeId?: string | null;
  status: string;
  runtimeMode: string;
  dataPath: string;
};

export type PlacementPlan = {
  skillName: string;
  recommendedNodeId: string | null;
  candidates: Array<{
    nodeId: string;
    name: string;
    os: string;
    docker: boolean;
    freeDiskBytes: number | null;
    status: "online" | "stale" | "offline";
    eligible: boolean;
    score: number;
    reasons: string[];
  }>;
};

export type ServerDetail = {
  server: ServerRow;
  runtime: {
    kind: "docker" | "native";
    containerName?: string;
    containerStatus?: string;
    imageHint?: string;
    join?: { address: string; port: number };
    logs?: string[];
  };
};


export type PanelBlockRow = {
  id: string;
  serverId: string | null;
  type: string;
  title: string;
  body: Record<string, unknown>;
  sortOrder: number;
  updatedAt: string;
};

export type SkillRow = {
  id: string;
  name: string;
  version: string;
  game?: string;
  description: string;
  tags: string[];
  scope?: "global" | "server";
};

export type ConversationRow = {
  id: string;
  serverId: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ToolTrace = {
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
};

export const api = {
  setupStatus: () => request<SetupStatus>("/api/setup"),
  bootstrapOwner: (body: { username: string; password: string; displayName?: string }) =>
    request<{ user: PublicUser }>("/api/setup/owner", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  login: (body: { username: string; password: string }) =>
    request<{ user: PublicUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  me: () => request<{ user: PublicUser }>("/api/auth/me"),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  chat: (message: string, opts: { conversationId?: string; serverId?: string } = {}) =>
    request<{
      conversationId: string;
      serverId?: string;
      reply: string;
      persona: string;
      llmMode: string;
      toolTrace?: ToolTrace[];
      agentProgress?: {
        persona: string;
        xp: number;
        level: number;
        title: string;
      };
      celebrations?: Array<{
        serverId?: string;
        persona: string;
        reason: string;
        xpGained: number;
        level: number;
        title: string;
        leveledUp: boolean;
      }>;
    }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        message,
        conversationId: opts.conversationId,
        serverId: opts.serverId,
      }),
    }),
  serverConversations: (serverId: string) =>
    request<{ conversations: ConversationRow[] }>(
      `/api/servers/${encodeURIComponent(serverId)}/conversations`,
    ),
  createServerConversation: (serverId: string, title?: string) =>
    request<{ conversation: ConversationRow }>(
      `/api/servers/${encodeURIComponent(serverId)}/conversations`,
      {
        method: "POST",
        body: JSON.stringify(title ? { title } : {}),
      },
    ),
  agents: () =>
    request<{
      agents: Array<{
        persona: string;
        xp: number;
        level: number;
        title: string;
        updatedAt: string;
      }>;
    }>("/api/agents"),
  nodes: () =>
    request<{
      nodes: Array<{
        id: string;
        name: string;
        os: string;
        docker: boolean;
        freeDiskBytes?: number | null;
        agentVersion?: string | null;
        lastSeenAt: string | number;
        status: "online" | "stale" | "offline";
      }>;
    }>("/api/nodes"),
  getLlmSettings: () => request<{ llm: LlmPublic }>("/api/settings/llm"),
  putLlmSettings: (body: {
    provider: LlmPublic["provider"];
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  }) =>
    request<{ llm: LlmPublic }>("/api/settings/llm", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  skills: (serverId?: string) =>
    request<{ skills: SkillRow[] }>(
      serverId ? `/api/skills?serverId=${encodeURIComponent(serverId)}` : "/api/skills",
    ),
  snapshots: (serverId?: string) =>
    request<{
      snapshots: Array<{ id: string; serverId: string; label: string; createdAt: string }>;
    }>(serverId ? `/api/snapshots?serverId=${encodeURIComponent(serverId)}` : "/api/snapshots"),
  createSnapshot: (body: { serverId: string; label?: string }) =>
    request<{
      snapshot: { id: string; serverId: string; label: string; createdAt: string };
    }>("/api/snapshots", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  restoreSnapshot: (id: string) =>
    request<{ server: ServerRow }>(`/api/snapshots/${encodeURIComponent(id)}/restore`, {
      method: "POST",
    }),
  activity: (limit = 40) =>
    request<{
      activity: Array<{
        id: string;
        conversationId: string | null;
        userId: string | null;
        toolName: string;
        args: unknown;
        result: unknown;
        status: string;
        createdAt: string;
      }>;
    }>(`/api/activity?limit=${limit}`),
  serverHealth: (id: string, remediate = false) =>
    request<{
      serverId: string;
      status: string;
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; detail?: string; onFail?: string }>;
      escalations: string[];
    }>(`/api/servers/${encodeURIComponent(id)}/health${remediate ? "?remediate=1" : ""}`),
  exportSkill: async (name: string) => {
    const res = await fetch(`/api/skills/${encodeURIComponent(name)}/export`, {
      credentials: "include",
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error?.trim() || `export_failed_${res.status}`);
    }
    const blob = await res.blob();
    const disposition = res.headers.get("content-disposition") ?? "";
    const match = /filename="([^"]+)"/.exec(disposition);
    const filename = match?.[1] ?? `${name}.skill.zip`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
  importSkill: async (file: File, overwrite = false) => {
    const body = new FormData();
    body.append("file", file);
    if (overwrite) body.append("overwrite", "true");
    const res = await fetch("/api/skills/import", {
      method: "POST",
      credentials: "include",
      body,
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(json.error?.trim() || `import_failed_${res.status}`);
    }
    return res.json() as Promise<{ skill: { skillName: string; path: string; version: string } }>;
  },
  servers: () =>
    request<{ servers: ServerRow[]; advertiseHost?: string; runtimeMode?: string }>("/api/servers"),
  serverDetail: (id: string) => request<ServerDetail>(`/api/servers/${encodeURIComponent(id)}`),
  createServer: (body: { skillName: string; serverName?: string; nodeId?: string }) =>
    request<{ server: ServerRow }>("/api/servers", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  importServerLocal: (body: {
    sourcePath: string;
    serverName?: string;
    skillName?: string;
    game?: string;
    nodeId?: string;
  }) =>
    request<{
      import: {
        server: ServerRow;
        skillName: string;
        skillSource: string;
        draftSlug?: string;
        baselineSnapshotId: string;
        copiedBytes?: number;
        detectedHints?: string[];
        followUp: string[];
        remoteHost?: string;
        remotePath?: string;
      };
    }>("/api/servers/import", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  importServerSftp: (body: {
    host: string;
    port?: number;
    username: string;
    password?: string;
    privateKey?: string;
    remotePath: string;
    serverName?: string;
    skillName?: string;
    game?: string;
    nodeId?: string;
  }) =>
    request<{
      import: {
        server: ServerRow;
        skillName: string;
        skillSource: string;
        draftSlug?: string;
        baselineSnapshotId: string;
        copiedBytes?: number;
        detectedHints?: string[];
        followUp: string[];
        remoteHost?: string;
        remotePath?: string;
      };
    }>("/api/servers/import/sftp", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  placement: (skillName: string) =>
    request<{ placement: PlacementPlan }>(
      `/api/placement?skillName=${encodeURIComponent(skillName)}`,
    ),
  startServer: (id: string) =>
    request<{ server: ServerRow; runtime?: ServerDetail["runtime"] }>(`/api/servers/${id}/start`, {
      method: "POST",
    }),
  stopServer: (id: string) =>
    request<{ server: ServerRow }>(`/api/servers/${id}/stop`, { method: "POST" }),
  deleteServer: (id: string) =>
    request<{ ok: true; removed: { id: string; name: string } }>(`/api/servers/${id}`, {
      method: "DELETE",
    }),
  restartServer: (id: string) =>
    request<{ server: ServerRow; runtime?: ServerDetail["runtime"] }>(`/api/servers/${id}/restart`, {
      method: "POST",
    }),
  relocateServer: (id: string, targetNodeId: string) =>
    request<{
      relocate: {
        server: ServerRow;
        fromNodeId: string | null;
        toNodeId: string;
        snapshotId: string;
        restarted: boolean;
        note: string;
      };
    }>(`/api/servers/${encodeURIComponent(id)}/relocate`, {
      method: "POST",
      body: JSON.stringify({ targetNodeId }),
    }),
  backupTarget: () =>
    request<{ target: { rootPath: string } | null }>("/api/backups/target"),
  setBackupTarget: (rootPath: string) =>
    request<{ target: { rootPath: string } }>("/api/backups/target", {
      method: "PUT",
      body: JSON.stringify({ rootPath }),
    }),
  offnodeBackups: (serverId?: string) =>
    request<{
      backups: Array<{
        id: string;
        serverId: string;
        label: string;
        sourceSnapshotId: string;
        exportedAt: string;
      }>;
    }>(
      serverId
        ? `/api/backups/offnode?serverId=${encodeURIComponent(serverId)}`
        : "/api/backups/offnode",
    ),
  createOffnodeBackup: (body: { serverId?: string; snapshotId?: string; label?: string }) =>
    request<{
      backup: {
        id: string;
        serverId: string;
        label: string;
        sourceSnapshotId: string;
        exportedAt: string;
      };
    }>("/api/backups/offnode", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  restoreOffnodeBackup: (id: string, serverId?: string) =>
    request<{ restore: { snapshotId: string; serverId: string } }>(
      `/api/backups/offnode/${encodeURIComponent(id)}/restore`,
      {
        method: "POST",
        body: JSON.stringify(serverId ? { serverId } : {}),
      },
    ),


  panel: async (serverId?: string, etag?: string) => {
    const path = serverId
      ? `/api/panel?serverId=${encodeURIComponent(serverId)}`
      : "/api/panel";
    const res = await fetch(path, {
      credentials: "include",
      headers: {
        "content-type": "application/json",
        ...(etag ? { "If-None-Match": etag } : {}),
      },
    });
    if (res.status === 304) {
      return { notModified: true as const, etag: etag ?? res.headers.get("ETag") };
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error?.trim() || `request_failed_${res.status}`);
    }
    const data = (await res.json()) as {
      blocks: PanelBlockRow[];
      theme?: {
        id: string;
        primaryHue?: number;
        game?: string;
        skillName?: string;
      };
    };
    return {
      notModified: false as const,
      etag: res.headers.get("ETag"),
      blocks: data.blocks,
      theme: data.theme ?? { id: "default" },
    };
  },
  panelInput: (body: { type: "readiness" | "vote"; payload: Record<string, unknown>; serverId?: string }) =>
    request<{ ok: boolean }>("/api/panel/input", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  conversations: () =>
    request<{
      conversations: Array<{ id: string; title: string | null; createdAt: string }>;
    }>("/api/conversations"),
  conversationMessages: (id: string) =>
    request<{
      conversation?: { id: string; serverId: string | null; title: string | null };
      messages: Array<{
        id: string;
        role: string;
        content: string;
        createdAt: string;
      }>;
    }>(`/api/conversations/${encodeURIComponent(id)}/messages`),
  confirm: (requestId: string, approved: boolean) =>
    request<{ ok: boolean; requestId: string; approved: boolean }>("/api/confirm", {
      method: "POST",
      body: JSON.stringify({ requestId, approved }),
    }),
  createUser: (body: {
    username: string;
    password: string;
    displayName?: string;
    role: "admin" | "operator";
  }) =>
    request<{ user: PublicUser }>("/api/users", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

