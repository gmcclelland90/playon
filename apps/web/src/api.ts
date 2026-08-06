import type { LlmPresetId, PublicUser, SetupStatus } from "@playon/shared";

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
  preset: LlmPresetId;
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

export type SkillSource = "platform" | "installed" | "draft" | "server" | "fixture";

export type SkillRow = {
  id: string;
  name: string;
  version: string;
  game?: string;
  description: string;
  tags: string[];
  theme?: { id: string; primaryHue?: number } | null;
  containerSupport?: string;
  dependencies?: string[];
  minRamMb?: number;
  source?: SkillSource;
  scope?: "global" | "server";
};

export type SkillDetail = {
  id: string;
  path: string;
  source: SkillSource;
  metadata: Record<string, unknown> & {
    name: string;
    version: string;
    game?: string;
    description?: string;
    tags?: string[];
    containerSupport?: string;
    dockerImage?: string;
    os?: string[];
    arch?: string[];
    minRamMb?: number;
    requiredTools?: string[];
    ports?: Array<{ name: string; protocol?: string; default?: number }>;
    dependencies?: string[];
    adminDialect?: string;
    queryDialect?: string;
    join?: { clientSetupNotes?: string; connectCommand?: string };
  };
  dependencies: Array<{ name: string; present: boolean }>;
};

export type CatalogSkillRow = {
  name: string;
  version: string;
  game?: string;
  description?: string;
  tags: string[];
  dependencies: string[];
  containerSupport?: string;
  minRamMb?: number;
  downloadUrl: string;
  sha256?: string;
  official?: boolean;
  installed: boolean;
};

export type CatalogWarning = {
  name?: string;
  index: number;
  message: string;
};

export type SkillDraftRow = {
  slug: string;
  skillName: string;
  path: string;
  version: string;
  game?: string;
  description: string;
  tags: string[];
  containerSupport: string;
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
      llmMode: string;
      toolTrace?: ToolTrace[];
      agentProgress?: {
        skill: string;
        xp: number;
        level: number;
        title: string;
      };
      celebrations?: Array<{
        serverId?: string;
        skill: string;
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
      agent: { name: string };
      skills: Array<{
        skill: string;
        xp: number;
        level: number;
        title: string;
        updatedAt: string;
      }>;
    }>("/api/agents"),
  nodes: () =>
    request<{
      localComputeEnabled?: boolean;
      wireguardTools?: boolean;
      nodes: Array<{
        id: string;
        name: string;
        os: string;
        docker: boolean;
        native?: boolean;
        steamcmd?: boolean;
        freeDiskBytes?: number | null;
        agentVersion?: string | null;
        lastSeenAt: string | number;
        status: "online" | "stale" | "offline";
        kind?: "local" | "lan" | "cloud";
        placement?: "local" | "remote" | "cloud";
        badge?: string;
        tunnelStatus?: string;
        overlayIp?: string | null;
        tunnelEndpoint?: string | null;
      }>;
    }>("/api/nodes"),
  getNodeSettings: () =>
    request<{ nodes: { localComputeEnabled: boolean } }>("/api/settings/nodes"),
  putNodeSettings: (body: { localComputeEnabled: boolean }) =>
    request<{ nodes: { localComputeEnabled: boolean } }>("/api/settings/nodes", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  addNode: (body: {
    kind: "lan" | "cloud";
    host: string;
    port?: number;
    username: string;
    password?: string;
    privateKey?: string;
    nodeId?: string;
    nodeName?: string;
    wgListenPort?: number;
  }) =>
    request<{
      node: {
        nodeId: string;
        kind: string;
        name: string;
        overlayIp?: string;
        tunnelStatus?: string;
        detail: string;
      };
    }>("/api/nodes/add", { method: "POST", body: JSON.stringify(body) }),
  createNodeBootstrapToken: (body: {
    kind: "lan" | "cloud";
    nodeId?: string;
    nodeName?: string;
    endpointHost?: string;
  }) =>
    request<{
      token: string;
      nodeId: string;
      oneLiner: string;
      expiresAt: string;
    }>("/api/nodes/bootstrap-token", { method: "POST", body: JSON.stringify(body) }),
  removeNode: (nodeId: string, force?: boolean) =>
    request<{ ok: true; detail: string }>(
      `/api/nodes/${encodeURIComponent(nodeId)}${force ? "?force=1" : ""}`,
      { method: "DELETE" },
    ),
  installDockerViaSsh: (
    nodeId: string,
    body: {
      host: string;
      port?: number;
      username: string;
      password?: string;
      privateKey?: string;
    },
  ) =>
    request<{ nodeId: string; detail: string }>(
      `/api/nodes/${encodeURIComponent(nodeId)}/install-docker`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  createInstallDockerToken: (nodeId: string) =>
    request<{
      token: string;
      nodeId: string;
      oneLiner: string;
      expiresAt: string;
      manualCommand: string;
    }>(`/api/nodes/${encodeURIComponent(nodeId)}/install-docker/token`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  updatesStatus: (force?: boolean) =>
    request<{
      currentVersion: string;
      latestVersion: string | null;
      channel: string | null;
      notesUrl: string | null;
      homeUpdateAvailable: boolean;
      checkedAt: string | null;
      manifestError: string | null;
      platform: string;
      applying: boolean;
      applyPhase: string | null;
      applyMessage: string | null;
      homeCurrentEnoughForNodes: boolean;
      nodes: Array<{
        nodeId: string;
        name: string;
        os: "linux" | "windows";
        agentVersion: string;
        status: "online" | "stale" | "offline";
        updateAvailable: boolean;
        kind: string;
      }>;
    }>(`/api/updates/status${force ? "?force=1" : ""}`),
  applyHomeUpdate: () =>
    request<{ ok: true; version: string; restarting: true }>("/api/updates/home/apply", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  updateNode: (nodeId: string) =>
    request<{ jobId: string; version: string }>(
      `/api/nodes/${encodeURIComponent(nodeId)}/update`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  getLlmSettings: () => request<{ llm: LlmPublic }>("/api/settings/llm"),
  putLlmSettings: (body: {
    preset: LlmPresetId;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  }) =>
    request<{ llm: LlmPublic }>("/api/settings/llm", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  getOllamaStatus: (baseUrl?: string) => {
    const q = baseUrl?.trim()
      ? `?baseUrl=${encodeURIComponent(baseUrl.trim())}`
      : "";
    return request<{
      ollama: {
        reachable: boolean;
        version?: string;
        models: Array<{ name: string; size?: number }>;
        dockerAvailable: boolean;
        canInstallLocal: boolean;
        isLoopback: boolean;
        manualCommand?: string;
        nativeBaseUrl: string;
        job: {
          phase: "idle" | "installing" | "pulling" | "ready" | "error";
          message?: string;
          updatedAt: string;
        };
      };
    }>(`/api/settings/llm/ollama/status${q}`);
  },
  installOllama: (baseUrl?: string) =>
    request<{
      job: {
        phase: "idle" | "installing" | "pulling" | "ready" | "error";
        message?: string;
        updatedAt: string;
      };
    }>("/api/settings/llm/ollama/install", {
      method: "POST",
      body: JSON.stringify({ baseUrl }),
    }),
  getOllamaJob: () =>
    request<{
      job: {
        phase: "idle" | "installing" | "pulling" | "ready" | "error";
        message?: string;
        updatedAt: string;
      };
    }>("/api/settings/llm/ollama/job"),
  pullOllamaModel: (body: { model: string; baseUrl?: string }) =>
    request<{
      job: {
        phase: "idle" | "installing" | "pulling" | "ready" | "error";
        message?: string;
        updatedAt: string;
      };
    }>("/api/settings/llm/ollama/pull", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listAccessTokens: () =>
    request<{
      tokens: Array<{
        id: string;
        name: string;
        autoApproveConfirms: boolean;
        createdAt: string;
        lastUsedAt: string | null;
      }>;
    }>("/api/access-tokens"),
  createAccessToken: (body: { name: string; autoApproveConfirms?: boolean }) =>
    request<{
      token: {
        id: string;
        name: string;
        autoApproveConfirms: boolean;
        createdAt: string;
        lastUsedAt: string | null;
        token: string;
      };
    }>("/api/access-tokens", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  revokeAccessToken: (id: string) =>
    request<{ ok: true }>(`/api/access-tokens/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  skills: (serverId?: string) =>
    request<{ skills: SkillRow[] }>(
      serverId ? `/api/skills?serverId=${encodeURIComponent(serverId)}` : "/api/skills",
    ),
  skillDetail: (name: string) =>
    request<{ skill: SkillDetail }>(`/api/skills/${encodeURIComponent(name)}`),
  skillDrafts: () => request<{ drafts: SkillDraftRow[] }>("/api/skills/drafts"),
  promoteSkillDraft: (slug: string) =>
    request<{ skill: { skillName: string; path: string } }>(
      `/api/skills/drafts/${encodeURIComponent(slug)}/promote`,
      { method: "POST" },
    ),
  uninstallSkill: async (name: string, force = false) => {
    const res = await fetch(
      `/api/skills/${encodeURIComponent(name)}${force ? "?force=1" : ""}`,
      { method: "DELETE", credentials: "include" },
    );
    const body = (await res.json().catch(() => ({}))) as {
      ok?: true;
      skill?: { skillName: string; path: string };
      servers?: Array<{ id: string; name: string }>;
      error?: string;
    };
    if (res.status === 409 && body.error === "skill_in_use") {
      const err = new Error("skill_in_use") as Error & {
        servers?: Array<{ id: string; name: string }>;
      };
      err.servers = body.servers ?? [];
      throw err;
    }
    if (!res.ok) {
      throw new Error(body.error?.trim() || `uninstall_failed_${res.status}`);
    }
    return body as {
      ok: true;
      skill: { skillName: string; path: string };
      servers: Array<{ id: string; name: string }>;
    };
  },
  promoteServerSkill: (body: { serverId: string; skillSlug: string; overwrite?: boolean }) =>
    request<{ skill: { skillName: string; path: string } }>("/api/skills/promote-server", {
      method: "POST",
      body: JSON.stringify(body),
    }),
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
  skillsCatalog: (q = "") =>
    request<{
      catalogUrl: string;
      skills: CatalogSkillRow[];
      warnings?: CatalogWarning[];
      updatedAt?: string;
      error?: string;
    }>(`/api/skills/catalog${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`),
  installSkillFromCatalog: (body: { name?: string; downloadUrl?: string; overwrite?: boolean }) =>
    request<{
      skill: { skillName: string; path: string; version: string };
      catalogUrl: string;
      downloadUrl: string;
      sha256: string;
      installed: string[];
      skippedDeps: string[];
    }>("/api/skills/install-from-catalog", {
      method: "POST",
      body: JSON.stringify(body),
    }),
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

