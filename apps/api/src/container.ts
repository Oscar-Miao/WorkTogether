import { createDatabase, type Database } from '@team-agent/database';
import { readConfig, type ApiConfig } from './config/config.js';
import { protectPrivatePath } from './common/private-storage.js';
import { PermitSigner } from './common/security.js';
import { AuthService } from './modules/auth/auth-service.js';
import { CollaborationService } from './modules/conversations/collaboration-service.js';
import { ContextBuilder } from './modules/context/context-builder.js';
import { TaskService } from './modules/tasks/task-service.js';
import { DeviceService } from './modules/devices/device-service.js';
import { BridgeGateway } from './modules/devices/bridge-gateway.js';
import { ContextReader } from './modules/context/context-reader.js';
import { HistoryService } from './modules/history/history-service.js';
import { RetentionService } from './modules/maintenance/retention-service.js';
import { GroupService } from './modules/chat/group-service.js';
import { CoordinatorService } from './modules/chat/coordinator-service.js';
import type { User, SessionUser, ProjectScope } from '@team-agent/contracts';
import type { Request } from 'express';
import type { OrganizationService } from './modules/organization/organization-service.js';
import { AdvancedCollaboration } from './modules/advanced/collaboration-service.js';
import { OidcService } from './modules/auth/oidc-service.js';
import { GovernanceService } from './modules/advanced/governance-service.js';
import { AdvancedExecution } from './modules/advanced/execution-service.js';
export interface Services {
  organization?: OrganizationService;
  project?: ProjectScope;
  advanced: AdvancedCollaboration;
  oidc?: OidcService;
  governance: GovernanceService;
  execution: AdvancedExecution;
  groups: GroupService;
  coordinator: CoordinatorService;
  maintenance: RetentionService;
  history: HistoryService;
  config: ApiConfig;
  db: Database;
  auth: AuthService;
  collaboration: CollaborationService;
  tasks: TaskService;
  devices: DeviceService;
  gateway: BridgeGateway;
  contextReader: ContextReader;
}
export async function createServices(
  overrides: Partial<ApiConfig> = {},
  extensions: {
    initialUsers?: User[];
    authenticate?: (req: Request, mutation: boolean) => Promise<SessionUser>;
  } = {},
): Promise<Services> {
  const config = readConfig(overrides);
  await protectPrivatePath(config.dataDir);
  const db = await createDatabase({
    url: config.databaseUrl,
    dataDir: config.dataDir,
    projectRoot: config.projectRoot,
    schema: config.databaseSchema,
  });
  try {
    const signer = await PermitSigner.load(config.dataDir);
    const auth = new AuthService(db, config, extensions.authenticate);
    if (extensions.initialUsers) {
      // 根目录是项目成员关系的权威；恢复项目时先撤销已移除成员，再同步当前成员。
      await db.query('UPDATE users SET active=false');
      for (const user of extensions.initialUsers)
        await db.query(
          'INSERT INTO users(id,email,name,password_hash,role) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,role=excluded.role,active=true',
          [user.id, user.email, user.name, 'PROJECT_IDENTITY_ONLY', user.role],
        );
      await db.query(
        'DELETE FROM group_members WHERE user_id IN(SELECT id FROM users WHERE NOT active)',
      );
    } else await auth.bootstrapOwner();
    const collaboration = new CollaborationService(db);
    const tasks = new TaskService(db, new ContextBuilder(collaboration), signer);
    const devices = new DeviceService(db, signer);
    const gateway = new BridgeGateway(devices, tasks);
    await tasks.recoverOnStartup();
    const coordinator = new CoordinatorService(db, tasks);
    const groups = new GroupService(db, coordinator);
    await coordinator.start();
    const advanced = new AdvancedCollaboration(db, tasks);
    const execution = new AdvancedExecution(db, tasks, advanced);
    execution.start();
    const maintenance = new RetentionService(
      db,
      () => tasks.changes.emit('all'),
      config.retentionEnabled,
    );
    maintenance.start();
    return {
      config,
      governance: new GovernanceService(db, tasks),
      advanced,
      execution,
      coordinator,
      groups,
      maintenance,
      db,
      auth,
      collaboration,
      tasks,
      devices,
      gateway,
      contextReader: new ContextReader(db, signer),
      history: new HistoryService(db),
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}
