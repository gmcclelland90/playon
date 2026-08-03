import type { AppConfig } from "./config.js";
import type { Db } from "./db/client.js";
import { AgentProgressService } from "./services/agent-progress.js";
import { ServerArchiveService } from "./services/archive-tools.js";
import { ConfirmService } from "./services/confirm.js";
import { EventHub } from "./services/event-hub.js";
import { ServerFsService } from "./services/fs-tools.js";
import { HealthService } from "./services/health.js";
import { ImportLocalService } from "./services/import-local.js";
import { ImportSftpService } from "./services/import-sftp.js";
import { MigrateService } from "./services/migrate.js";
import { NetToolsService } from "./services/net-tools.js";
import { OffNodeBackupService } from "./services/offnode-backup.js";
import { PanelService } from "./services/panel.js";
import { PlacementService } from "./services/placement.js";
import { PlayerPanel } from "./services/player-panel.js";
import { ServerQueryService } from "./services/server-query.js";
import { ServerService } from "./services/servers.js";
import { SkillDraftService } from "./services/skill-drafts.js";
import { SkillPackageService } from "./services/skill-packages.js";
import { SnapshotService } from "./services/snapshots.js";

/** Shared in-process service graph for HTTP, agents, and schedulers. */
export type ControlPlane = {
  db: Db;
  config: AppConfig;
  eventHub: EventHub;
  confirm: ConfirmService;
  servers: ServerService;
  snapshots: SnapshotService;
  panel: PanelService;
  playerPanel: PlayerPanel;
  net: NetToolsService;
  queries: ServerQueryService;
  health: HealthService;
  placement: PlacementService;
  migrate: MigrateService;
  offNode: OffNodeBackupService;
  importLocal: ImportLocalService;
  importSftp: ImportSftpService;
  agentProgress: AgentProgressService;
  serverFs: ServerFsService;
  archives: ServerArchiveService;
  drafts: SkillDraftService;
  skillPackages: SkillPackageService;
};

export function createControlPlane(db: Db, config: AppConfig): ControlPlane {
  const eventHub = new EventHub();
  const confirm = new ConfirmService(eventHub);
  const servers = new ServerService(db, config, eventHub);
  const snapshots = new SnapshotService(db, config, servers);
  const panel = new PanelService(db, eventHub);
  const net = new NetToolsService(servers);
  const queries = new ServerQueryService(servers, config);
  const playerPanel = new PlayerPanel(servers, panel, queries, config);
  const health = new HealthService(servers, net, config, queries);
  const placement = new PlacementService(db, config, net);
  const migrate = new MigrateService(db, servers, snapshots, placement, eventHub);
  const offNode = new OffNodeBackupService(db, config, snapshots);
  const importLocal = new ImportLocalService(db, config, servers, snapshots);
  const importSftp = new ImportSftpService(db, config, servers, snapshots);
  const agentProgress = new AgentProgressService(db);
  const serverFs = new ServerFsService(servers);
  const archives = new ServerArchiveService(servers);
  const drafts = new SkillDraftService(config);
  const skillPackages = new SkillPackageService(config);

  return {
    db,
    config,
    eventHub,
    confirm,
    servers,
    snapshots,
    panel,
    playerPanel,
    net,
    queries,
    health,
    placement,
    migrate,
    offNode,
    importLocal,
    importSftp,
    agentProgress,
    serverFs,
    archives,
    drafts,
    skillPackages,
  };
}
