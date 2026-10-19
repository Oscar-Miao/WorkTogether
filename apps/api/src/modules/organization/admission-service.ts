import type { User, TeamInvitationPreview, TeamInvitationRecord } from '@team-agent/contracts';
import type { SqlConnection } from '@team-agent/database';
import { DomainError } from '@team-agent/domain';
import { audit, ids, opaque, sha, iso, idempotent } from '../../common/security.js';
import type { OrganizationService } from './organization-service.js';
type InviteInput = { email?: string; expires_hours: number; max_uses: number };

/** 团队对应工作空间；每张邀请只授权一个项目，不自动加入私群或授予设备权限。 */
export class AdmissionService {
  constructor(private readonly organization: OrganizationService) {}
  private get db() {
    return this.organization.root.db;
  }
  async createTeam(user: User, input: { name: string; project_name: string }, key?: string) {
    return idempotent(this.db, 'team-create:' + user.id, key, input, async (tx) => {
      const workspace = ids('ws'),
        project = ids('prj');
      await tx.query('INSERT INTO org_workspaces(id,name,created_by) VALUES($1,$2,$3)', [
        workspace,
        input.name,
        user.id,
      ]);
      await tx.query("INSERT INTO org_workspace_members VALUES($1,$2,'admin')", [
        workspace,
        user.id,
      ]);
      await tx.query(
        'INSERT INTO org_projects(id,workspace_id,name,created_by) VALUES($1,$2,$3,$4)',
        [project, workspace, input.project_name, user.id],
      );
      await tx.query("INSERT INTO org_project_members VALUES($1,$2,'admin')", [project, user.id]);
      await audit(tx, user.id, 'team.created', workspace, { project_id: project });
      return { workspace_id: workspace, project_id: project };
    });
  }
  private async requireAdmin(tx: SqlConnection, user: User, project: string) {
    // 邀请与成员修改共用项目行锁；检查权限和修改必须在同一事务内。
    await tx.query('SELECT id FROM org_projects WHERE id=$1 FOR UPDATE', [project]);
    const member = (
      await tx.query('SELECT role FROM org_project_members WHERE project_id=$1 AND user_id=$2', [
        project,
        user.id,
      ])
    )[0];
    if (member?.role !== 'admin') throw new DomainError('FORBIDDEN', '需要项目维护者权限', 403);
  }
  async invite(user: User, project: string, input: InviteInput) {
    const token = opaque(),
      id = ids('oinv'),
      expires = new Date(Date.now() + input.expires_hours * 3600000);
    await this.db.transaction(async (tx) => {
      await this.requireAdmin(tx, user, project);
      const active = (
        await tx.query(
          'SELECT count(*)::int AS n FROM org_invitations WHERE project_id=$1 AND revoked_at IS NULL AND expires_at>now() AND used_count<max_uses',
          [project],
        )
      )[0].n;
      if (active >= 30)
        throw new DomainError('INVITATION_LIMIT', '有效邀请已达 30 条，请先撤销不用的邀请', 409);
      // 原始令牌仅返回一次，数据库及审计不保存可分享的秘密。
      await tx.query(
        'INSERT INTO org_invitations(id,token_hash,project_id,email,max_uses,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          id,
          sha(token),
          project,
          input.email?.toLowerCase() ?? null,
          input.max_uses,
          expires,
          user.id,
        ],
      );
      await audit(tx, user.id, 'team.invitation_created', id, { project_id: project });
    });
    return { id, token, expires_at: expires.toISOString() };
  }
  async list(user: User, project: string): Promise<TeamInvitationRecord[]> {
    if ((await this.organization.membership(user, project)).role !== 'admin')
      throw new DomainError('FORBIDDEN', '需要项目维护者权限', 403);
    const rows = await this.db.query(
      'SELECT id,email,max_uses,used_count,expires_at,revoked_at FROM org_invitations WHERE project_id=$1 ORDER BY created_at DESC LIMIT 50',
      [project],
    );
    return rows.map((r) => ({
      ...r,
      expires_at: iso(r.expires_at),
      revoked_at: r.revoked_at ? iso(r.revoked_at) : null,
    })) as TeamInvitationRecord[];
  }
  async revoke(user: User, project: string, id: string) {
    await this.db.transaction(async (tx) => {
      await this.requireAdmin(tx, user, project);
      const rows = await tx.query(
        'UPDATE org_invitations SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 AND project_id=$2 RETURNING id',
        [id, project],
      );
      if (!rows.length) throw new DomainError('INVITATION_UNAVAILABLE', '邀请不存在', 404);
      await audit(tx, user.id, 'team.invitation_revoked', id, { project_id: project });
    });
    return { ok: true };
  }
  private async validInvitation(tx: SqlConnection, token: string, lock = false) {
    const row = (
      await tx.query(
        `SELECT i.*,p.workspace_id,p.name AS project,w.name AS workspace FROM org_invitations i
       JOIN org_projects p ON p.id=i.project_id JOIN org_workspaces w ON w.id=p.workspace_id
       JOIN users u ON u.id=i.created_by AND u.active
       JOIN org_project_members m ON m.project_id=i.project_id AND m.user_id=i.created_by AND m.role='admin'
       WHERE i.token_hash=$1` + (lock ? ' FOR UPDATE OF i' : ''),
        [sha(token)],
      )
    )[0];
    if (!row || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now())
      throw new DomainError(
        'INVITATION_EXPIRED',
        '邀请不存在、已过期或已撤销，请向维护者获取新邀请',
        410,
      );
    return row;
  }
  async preview(token: string): Promise<TeamInvitationPreview> {
    const row = await this.validInvitation(this.db, token);
    if (row.used_count >= row.max_uses)
      throw new DomainError('INVITATION_EXHAUSTED', '邀请名额已用完', 410);
    // 令牌仅允许预览团队、项目和期限，不返回邮箱、成员或讨论内容。
    return {
      workspace: row.workspace,
      project: row.project,
      project_id: row.project_id,
      expires_at: iso(row.expires_at),
      remaining_uses: row.max_uses - row.used_count,
      email_required: !!row.email,
    };
  }
  async accept(user: User, token: string) {
    const result = await this.db.transaction(async (tx) => {
      const initial = await this.validInvitation(tx, token);
      await tx.query('SELECT id FROM org_projects WHERE id=$1 FOR UPDATE', [initial.project_id]);
      const row = await this.validInvitation(tx, token, true);
      if (row.email && row.email !== user.email.toLowerCase())
        throw new DomainError('INVITATION_EMAIL_MISMATCH', '请使用受邀邮箱登录后接受邀请', 403);
      const member = (
        await tx.query('SELECT role FROM org_project_members WHERE project_id=$1 AND user_id=$2', [
          row.project_id,
          user.id,
        ])
      )[0];
      if (member)
        return { project_id: row.project_id, workspace_id: row.workspace_id, already_joined: true };
      if (
        (
          await tx.query(
            'SELECT user_id FROM org_invite_acceptances WHERE invitation_id=$1 AND user_id=$2',
            [row.id, user.id],
          )
        ).length
      )
        throw new DomainError(
          'INVITATION_ALREADY_USED',
          '你已使用过此邀请，被移出后需要新的邀请',
          409,
        );
      if (row.used_count >= row.max_uses)
        throw new DomainError('INVITATION_EXHAUSTED', '邀请名额已用完', 410);
      await tx.query(
        "INSERT INTO org_workspace_members VALUES($1,$2,'member') ON CONFLICT DO NOTHING",
        [row.workspace_id, user.id],
      );
      await tx.query("INSERT INTO org_project_members VALUES($1,$2,'member')", [
        row.project_id,
        user.id,
      ]);
      await tx.query('INSERT INTO org_invite_acceptances(invitation_id,user_id) VALUES($1,$2)', [
        row.id,
        user.id,
      ]);
      await tx.query('UPDATE org_invitations SET used_count=used_count+1 WHERE id=$1', [row.id]);
      await audit(tx, user.id, 'team.invitation_accepted', row.id, { project_id: row.project_id });
      return { project_id: row.project_id, workspace_id: row.workspace_id, already_joined: false };
    });
    // 已打开的项目需要同步本地外键身份；即使首次响应丢失，重复接受也会重试同步。
    await this.organization.synchronizeMember(user.id, result.project_id);
    return result;
  }
}
