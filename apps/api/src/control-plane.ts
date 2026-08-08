import type { AppConfig } from "./config.js";
import type { Db } from "./db/client.js";
import { AgentProgressService } from "./services/agent-progress.js";
import { AgentTurn } from "./services/agent-turn.js";
import { ServerArchiveService } from "./services/archive-tools.js";
import { AddNodeService } from "./services/cloud/add-node.js";
import { LanGateway } from "./services/cloud/gateway.js";
import { InstallDockerService } from "./services/cloud/install-docker.js";
import { TunnelService } from "./services/cloud/tunnel.js";
import { ConfirmService } from "./services/confirm.js";
import { EventHub } from "./services/event-hub.js";
import { ServerFsService } from "./services/fs-tools.js";
import { HealthService } from "./services/health.js";
import { ImportLocalService } from "./services/import-local.js";
import { ManageSuggestService } from "./services/manage-suggest.js";
import { ImportSftpService } from "./services/import-sftp.js";
import { MigrateService } from "./services/migrate.js";
import { NetToolsService } from "./services/net-tools.js";
import { OffNodeBackupService } from "./services/offnode-backup.js";
import { PanelService } from "./services/panel.js";
import { PlacementService } from "./services/placement.js";
import { PlayerPanel } from "./services/player-panel.js";
import { ServerAdoptionService } from "./services/server-adoption.js";
import { ServerQueryService } from "./services/server-query.js";
import { ServerService } from "./services/servers.js";
import { SkillDraftService } from "./services/skill-drafts.js";
import { SkillPackageService } from "./services/skill-packages.js";
import { SnapshotService } from "./services/snapshots.js";
import { UpdateService } from "./services/updates.js";
import { WatcherEngine } from "./services/watcher-engine.js";
import { WatcherService } from "./services/watchers.js";

/** Shared in-process service graph for HTTP, agents, and schedulers. */
export type ControlPlane = {
  db: Db;
  config: AppConfig;
  eventHub: EventHub;
  confirm: ConfirmService;
  servers: ServerService;
  snapshots: SnapshotService;
  adoption: ServerAdoptionService;
  panel: PanelService;
  playerPanel: PlayerPanel;
  net: NetToolsService;
  queries: ServerQueryService;
  health: HealthService;
  placement: PlacementService;
  migrate: MigrateService;
  offNode: OffNodeBackupService;
  importLocal: ImportLocalService;
  manageSuggest: ManageSuggestService;
  importSftp: ImportSftpService;
  agentProgress: AgentProgressService;
  agentTurn: AgentTurn;
  serverFs: ServerFsService;
  archives: ServerArchiveService;
  drafts: SkillDraftService;
  skillPackages: SkillPackageService;
  tunnel: TunnelService;
  gateway: LanGateway;
  addNode: AddNodeService;
  installDocker: InstallDockerService;
  updates: UpdateService;
  watchers: WatcherService;
  watcherEngine: WatcherEngine;
};

export function createControlPlane(db: Db, config: AppConfig): ControlPlane {
  const eventHub = new EventHub();
  const confirm = new ConfirmService(eventHub);
  const tunnel = new TunnelService(db, config);
  const gateway = new LanGateway(config);
  const addNode = new AddNodeService(db, config, tunnel);
  const installDocker = new InstallDockerService(db, config);
  const servers = new ServerService(db, config, eventHub, gateway);
  const snapshots = new SnapshotService(db, config, servers);
  const adoption = new ServerAdoptionService(db, config, servers, snapshots);
  servers.bindAdoption(adoption);
  const panel = new PanelService(db, eventHub);
  const net = new NetToolsService(servers);
  const queries = new ServerQueryService(servers, config);
  const playerPanel = new PlayerPanel(servers, panel, queries, config);
  const health = new HealthService(servers, net, config, queries);
  const placement = new PlacementService(db, config, net);
  const migrate = new MigrateService(db, servers, snapshots, placement, eventHub);
  const offNode = new OffNodeBackupService(db, config, snapshots);
  const importLocal = new ImportLocalService(config, adoption);
  const manageSuggest = new ManageSuggestService(db, config, importLocal, servers, adoption);
  const importSftp = new ImportSftpService(config, importLocal);
  const agentProgress = new AgentProgressService(db);
  const serverFs = new ServerFsService(servers);
  const archives = new ServerArchiveService(servers);
  const drafts = new SkillDraftService(config);
  const skillPackages = new SkillPackageService(config);
  const updates = new UpdateService(db, config, eventHub);
  const watchers = new WatcherService(db);

  const plane: ControlPlane = {
    db,
    config,
    eventHub,
    confirm,
    servers,
    snapshots,
    adoption,
    panel,
    playerPanel,
    net,
    queries,
    health,
    placement,
    migrate,
    offNode,
    importLocal,
    manageSuggest,
    importSftp,
    agentProgress,
    agentTurn: null as unknown as AgentTurn,
    serverFs,
    archives,
    drafts,
    skillPackages,
    tunnel,
    gateway,
    addNode,
    installDocker,
    updates,
    watchers,
    watcherEngine: null as unknown as WatcherEngine,
  };
  plane.agentTurn = new AgentTurn(plane);
  plane.watcherEngine = new WatcherEngine(plane);
  return plane;
}
