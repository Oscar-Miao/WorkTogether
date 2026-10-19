import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { User, ProjectScope, SessionUser } from '@team-agent/contracts';
import { DomainError } from '@team-agent/domain';
import type { Server } from 'node:http';
import { createServices, type Services } from '../../container.js';
import { audit, ids } from '../../common/security.js';

/**
 * 根目录只保存身份与项目成员关系。项目业务使用独立数据库命名空间，
 * 旧服务即使忘记追加 project_id 条件，也不会读到另一个项目的表。
 */
export class OrganizationService {
  private readonly opened = new Map<string, Promise<Services>>();
  private server?: Server;
  constructor(readonly root: Services) {}

  async initialize() {
    await this.root.db.transaction(async (tx) => {
      const owner = (
        await tx.query(
          "SELECT id FROM users WHERE role='OWNER' AND active ORDER BY created_at LIMIT 1",
        )
      )[0];
      await tx.query(
        "INSERT INTO org_workspaces(id,name,created_by) VALUES('workspace_default','共域研发空间',$1) ON CONFLICT DO NOTHING",
        [owner.id],
      );
      await tx.query(
        "INSERT INTO org_projects(id,workspace_id,name,created_by) VALUES('project_default','workspace_default','共域协作项目',$1) ON CONFLICT DO NOTHING",
        [owner.id],
      );
      await tx.query(
        "INSERT INTO org_workspace_members SELECT 'workspace_default',id,CASE role WHEN 'OWNER' THEN 'admin' ELSE 'member' END FROM users WHERE active ON CONFLICT DO NOTHING",
      );
      await tx.query(
        "INSERT INTO org_project_members SELECT 'project_default',id,CASE role WHEN 'OWNER' THEN 'admin' ELSE 'member' END FROM users WHERE active ON CONFLICT DO NOTHING",
      );
    });
    this.root.project = {
      id: 'project_default',
      name: '共域协作项目',
      workspace_id: 'workspace_default',
      workspace: '共域研发空间',
      role: 'admin',
    };
    this.root.organization = this;
  }

  async membership(user: User, projectId: string): Promise<ProjectScope> {
    // 兼容旧项目的成员语义：有效根账号仍属于迁移后的默认项目。
    if (projectId === 'project_default')
      return { ...this.root.project!, role: user.role === 'OWNER' ? 'admin' : 'member' };
    const row = (
      await this.root.db.query(
        'SELECT p.id,p.name,p.workspace_id,w.name AS workspace,m.role FROM org_projects p JOIN org_workspaces w ON w.id=p.workspace_id JOIN org_project_members m ON m.project_id=p.id WHERE p.id=$1 AND m.user_id=$2',
        [projectId, user.id],
      )
    )[0];
    if (!row) throw new DomainError('PROJECT_UNAVAILABLE', '项目不存在或尚未加入', 404);
    return row as ProjectScope;
  }
  async list(user: User) {
    const rows = await this.root.db.query(
      "SELECT p.id,p.name,p.workspace_id,w.name AS workspace,coalesce(m.role,'member') AS role FROM org_projects p JOIN org_workspaces w ON w.id=p.workspace_id LEFT JOIN org_project_members m ON m.project_id=p.id AND m.user_id=$1 WHERE m.user_id IS NOT NULL OR p.id='project_default' ORDER BY w.created_at,p.created_at,p.id",
      [user.id],
    );
    return rows.map((r) =>
      r.id === 'project_default' ? { ...r, role: user.role === 'OWNER' ? 'admin' : 'member' } : r,
    );
  }
  async workspaces(user: User) {
    return this.root.db.query(
      'SELECT w.id,w.name,m.role FROM org_workspaces w JOIN org_workspace_members m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.created_at',
      [user.id],
    );
  }
  async createWorkspace(user: User, name: string) {
    const id = ids('ws');
    await this.root.db.transaction(async (tx) => {
      await tx.query('INSERT INTO org_workspaces(id,name,created_by) VALUES($1,$2,$3)', [
        id,
        name,
        user.id,
      ]);
      await tx.query("INSERT INTO org_workspace_members VALUES($1,$2,'admin')", [id, user.id]);
      await audit(tx, user.id, 'workspace.created', id);
    });
    return { id };
  }
  async createProject(user: User, workspaceId: string, name: string) {
    const id = ids('prj');
    await this.root.db.transaction(async (tx) => {
      const member = (
        await tx.query(
          'SELECT role FROM org_workspace_members WHERE workspace_id=$1 AND user_id=$2',
          [workspaceId, user.id],
        )
      )[0];
      if (!member || member.role !== 'admin')
        throw new DomainError('FORBIDDEN', '需要空间管理员权限', 403);
      await tx.query(
        'INSERT INTO org_projects(id,workspace_id,name,created_by) VALUES($1,$2,$3,$4)',
        [id, workspaceId, name, user.id],
      );
      await tx.query("INSERT INTO org_project_members VALUES($1,$2,'admin')", [id, user.id]);
      await audit(tx, user.id, 'project.created', id);
    });
    return { id };
  }
  async members(user: User, projectId: string) {
    if ((await this.membership(user, projectId)).role !== 'admin')
      throw new DomainError('FORBIDDEN', '需要项目维护者权限', 403);
    if (projectId === 'project_default')
      return this.root.db.query(
        "SELECT id,email,name,CASE role WHEN 'OWNER' THEN 'admin' ELSE 'member' END AS role FROM users WHERE active ORDER BY created_at",
      );
    return this.root.db.query(
      'SELECT u.id,u.email,u.name,m.role FROM org_project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=$1 AND u.active ORDER BY u.created_at',
      [projectId],
    );
  }
  async addMember(user: User, projectId: string, email: string, role: string) {
    const scope = await this.membership(user, projectId);
    if (scope.role !== 'admin') throw new DomainError('FORBIDDEN', '需要项目维护者权限', 403);
    const target = (
      await this.root.db.query('SELECT id FROM users WHERE email=$1 AND active', [
        email.toLowerCase(),
      ])
    )[0];
    if (!target)
      throw new DomainError('ACCOUNT_REQUIRED', '请先通过团队邀请建立账号，再加入项目', 404);
    await this.root.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM org_projects WHERE id=$1 FOR UPDATE', [projectId]);
      const previous = (
        await tx.query('SELECT role FROM org_project_members WHERE project_id=$1 AND user_id=$2', [
          projectId,
          target.id,
        ])
      )[0];
      if (
        previous?.role === 'admin' &&
        role !== 'admin' &&
        (
          await tx.query(
            "SELECT count(*)::int AS n FROM org_project_members WHERE project_id=$1 AND role='admin'",
            [projectId],
          )
        )[0].n <= 1
      )
        throw new DomainError('LAST_ADMIN', '不能移除项目最后一位维护者', 409);
      await tx.query(
        "INSERT INTO org_workspace_members VALUES($1,$2,'member') ON CONFLICT DO NOTHING",
        [scope.workspace_id, target.id],
      );
      await tx.query(
        'INSERT INTO org_project_members VALUES($1,$2,$3) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role',
        [projectId, target.id, role],
      );
      await audit(tx, user.id, 'project.member_added', projectId, { user_id: target.id, role });
    });
    const opened = this.opened.get(projectId);
    if (opened) await this.syncUser(await opened, target.id, role);
    return { ok: true };
  }
  async removeMember(user: User, projectId: string, targetId: string) {
    if (projectId === 'project_default')
      throw new DomainError('LEGACY_MEMBERSHIP', '默认项目请使用团队成员撤销入口', 409);
    const scope = await this.membership(user, projectId);
    if (scope.role !== 'admin' || user.id === targetId)
      throw new DomainError('FORBIDDEN', '不能撤销自己，需要项目维护者权限', 403);
    await this.root.db.transaction(async (tx) => {
      await tx.query('DELETE FROM org_project_members WHERE project_id=$1 AND user_id=$2', [
        projectId,
        targetId,
      ]);
      await audit(tx, user.id, 'project.member_removed', projectId, { user_id: targetId });
    });
    const existing = this.opened.get(projectId);
    if (!existing) return { ok: true };
    const service = await existing;
    await service.db.query('UPDATE users SET active=false WHERE id=$1', [targetId]);
    await service.db.query('DELETE FROM group_members WHERE user_id=$1', [targetId]);
    const tasks = await service.db.query(
      "SELECT id FROM tasks WHERE creator_id=$1 AND state IN ('QUEUED','DISPATCHING','RUNNING')",
      [targetId],
    );
    for (const task of tasks) await service.tasks.cancelForPolicy(task.id, '项目成员权限已撤销');
    service.tasks.changes.emit('all');
    return { ok: true };
  }
  /** 根账号撤销时，停止所有已打开项目中的活动工作；未打开的项目在恢复时重新同步成员。 */
  async revokeEverywhere(userId: string) {
    await this.root.db.query('DELETE FROM org_project_members WHERE user_id=$1', [userId]);
    await this.root.db.query('DELETE FROM org_workspace_members WHERE user_id=$1', [userId]);
    for (const work of this.opened.values()) {
      const service = await work;
      await service.db.query('UPDATE users SET active=false WHERE id=$1', [userId]);
      await service.db.query('DELETE FROM group_members WHERE user_id=$1', [userId]);
      const tasks = await service.db.query(
        "SELECT id FROM tasks WHERE creator_id=$1 AND state IN ('QUEUED','RUNNING','DISPATCHING','RECONCILING')",
        [userId],
      );
      for (const task of tasks) await service.tasks.cancelForPolicy(task.id, '团队身份权限已撤销');
      service.tasks.changes.emit('all');
    }
  }
  private async syncUser(service: Services, userId: string, role: string) {
    const person = (
      await this.root.db.query('SELECT id,email,name FROM users WHERE id=$1 AND active', [userId])
    )[0];
    if (!person) throw new DomainError('AUTH_REQUIRED', '账号已失效', 401);
    await service.db.query(
      'INSERT INTO users(id,email,name,password_hash,role) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name,role=excluded.role,active=true',
      [
        person.id,
        person.email,
        person.name,
        'PROJECT_IDENTITY_ONLY',
        role === 'admin' ? 'OWNER' : 'MEMBER',
      ],
    );
    return person;
  }
  async open(projectId: string): Promise<Services> {
    if (projectId === 'project_default') return this.root;
    if (!/^prj_[a-zA-Z0-9]+$/.test(projectId))
      throw new DomainError('PROJECT_UNAVAILABLE', '项目不存在', 404);
    const existing = this.opened.get(projectId);
    if (existing) return existing;
    // 本地开发避免无限创建 PGlite 实例；企业容量由 PostgreSQL 与实际配额验收。
    if (this.opened.size >= 16)
      throw new DomainError('PROJECT_CAPACITY', '本实例已打开 16 个项目，请配置分片后扩容', 429);
    const work = this.createProjectServices(projectId);
    this.opened.set(projectId, work);
    try {
      return await work;
    } catch (error) {
      this.opened.delete(projectId);
      throw error;
    }
  }
  private async createProjectServices(projectId: string) {
    const project = (
      await this.root.db.query(
        'SELECT p.*,w.name AS workspace FROM org_projects p JOIN org_workspaces w ON w.id=p.workspace_id WHERE p.id=$1',
        [projectId],
      )
    )[0];
    if (!project) throw new DomainError('PROJECT_UNAVAILABLE', '项目不存在', 404);
    const members = await this.root.db.query(
      'SELECT u.id,u.email,u.name,m.role FROM org_project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=$1 AND u.active',
      [projectId],
    );
    const services = await createServices(
      {
        ...this.root.config,
        dataDir: resolve(this.root.config.dataDir, 'projects', projectId),
        databaseSchema: 'scope_' + projectId,
        ownerPassword: randomBytes(32).toString('hex'),
      },
      {
        initialUsers: members.map((m) => ({
          ...m,
          role: m.role === 'admin' ? 'OWNER' : 'MEMBER',
        })) as User[],
        authenticate: async (req, mutation): Promise<SessionUser> => {
          const user = await this.root.auth.current(req, mutation);
          const scope = await this.membership(user, projectId);
          return { ...user, role: scope.role === 'admin' ? 'OWNER' : 'MEMBER' };
        },
      },
    );
    services.organization = this;
    services.project = {
      id: projectId,
      name: project.name,
      workspace_id: project.workspace_id,
      workspace: project.workspace,
      role: 'member',
    };
    if (this.server) services.gateway.attach(this.server, '/p/' + projectId);
    return services;
  }
  attach(server: Server) {
    this.server = server;
  }
  async close() {
    for (const work of this.opened.values()) {
      const s = await work;
      await s.coordinator.close();
      await s.execution.close();
      s.gateway.close();
      await s.maintenance.stop();
      await s.db.close();
    }
  }
}
