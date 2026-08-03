import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

export const nodes = sqliteTable("nodes", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  os: text("os").notNull(),
  docker: integer("docker", { mode: "boolean" }).notNull().default(false),
  native: integer("native", { mode: "boolean" }).notNull().default(true),
  steamcmd: integer("steamcmd", { mode: "boolean" }).notNull().default(false),
  freeDiskBytes: integer("free_disk_bytes"),
  agentVersion: text("agent_version"),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
});

export const servers = sqliteTable("servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  game: text("game"),
  nodeId: text("node_id").references(() => nodes.id),
  runtimeMode: text("runtime_mode").notNull().default("docker"),
  status: text("status").notNull().default("stopped"),
  dataPath: text("data_path").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  /** Bound after install; null during unbound install chat until create/import succeeds. */
  serverId: text("server_id").references(() => servers.id),
  title: text("title"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const toolInvocations = sqliteTable("tool_invocations", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").references(() => conversations.id),
  userId: text("user_id").references(() => users.id),
  toolName: text("tool_name").notNull(),
  argsJson: text("args_json").notNull().default("{}"),
  resultJson: text("result_json"),
  status: text("status").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const panelBlocks = sqliteTable("panel_blocks", {
  id: text("id").primaryKey(),
  serverId: text("server_id"),
  type: text("type").notNull(),
  title: text("title").notNull(),
  bodyJson: text("body_json").notNull().default("{}"),
  sortOrder: integer("sort_order").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const snapshots = sqliteTable("snapshots", {
  id: text("id").primaryKey(),
  serverId: text("server_id")
    .notNull()
    .references(() => servers.id),
  label: text("label").notNull(),
  path: text("path").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const secrets = sqliteTable("secrets", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  ciphertext: text("ciphertext").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
});

export const agentProgress = sqliteTable("agent_progress", {
  persona: text("persona").primaryKey(),
  xp: integer("xp").notNull().default(0),
  level: integer("level").notNull().default(1),
  title: text("title").notNull().default("Rookie"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
