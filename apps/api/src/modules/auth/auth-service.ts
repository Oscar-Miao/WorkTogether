import { hash, verify, Algorithm } from '@node-rs/argon2';
import { identityRateLimit } from './identity-rate-limit.js';
import type { Request, Response } from 'express';
import type { Database, SqlConnection } from '@team-agent/database';
import type { SessionUser, User } from '@team-agent/contracts';
import { INTERNAL_PASSWORD_MIN, PRODUCTION_PASSWORD_MIN } from '@team-agent/contracts';
import { DomainError } from '@team-agent/domain';
import type { ApiConfig } from '../../config/config.js';
import { audit, ids, opaque, sha, originCheck } from '../../common/security.js';

export class AuthService {
  private readonly memberLimit = Number(process.env.TEAM_AGENT_MEMBER_LIMIT || 10);
  private readonly attempts = new Map<string, { count: number; until: number }>();
  constructor(
    private readonly db: Database,
    private readonly config: ApiConfig,
    private readonly delegatedCurrent?: (req: Request, mutation: boolean) => Promise<SessionUser>,
  ) {
    if (!Number.isInteger(this.memberLimit) || this.memberLimit < 1 || this.memberLimit > 500)
      throw new Error('TEAM_AGENT_MEMBER_LIMIT 必须是 1～500 的整数');
  }
  /** 内测降低长度要求；切到 production 后统一恢复注册、邀请及改密的门槛。 */
  get passwordMinLength(): number {
    return this.config.production ? PRODUCTION_PASSWORD_MIN : INTERNAL_PASSWORD_MIN;
  }
  private async hashPassword(password: string): Promise<string> {
    if (password.length < this.passwordMinLength || password.length > 200)
      throw new DomainError(
        'PASSWORD_LENGTH_INVALID',
        '密码长度需要在 ' + this.passwordMinLength + '～200 位之间',
        400,
      );
    // 改变门槛不改变存储算法；短内测密码仍使用独立随机盐及 Argon2id。
    return hash(password, {
      algorithm: Algorithm.Argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
  }
  async bootstrapOwner(): Promise<void> {
    const existing = await this.db.query("SELECT id FROM users WHERE role='OWNER' AND active");
    if (existing.length) return;
    if (
      !this.config.ownerPassword ||
      this.config.ownerPassword.length < this.passwordMinLength ||
      this.config.ownerPassword.includes('replace-with')
    )
      throw new Error(
        '请先运行 pnpm run setup，或配置至少 ' + this.passwordMinLength + ' 位 OWNER_PASSWORD',
      );
    const passwordHash = await this.hashPassword(this.config.ownerPassword);
    const id = ids('usr');
    await this.db.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO users(id,email,name,password_hash,role) VALUES($1,$2,$3,$4,'OWNER')",
        [id, this.config.ownerEmail.toLowerCase(), '项目维护者', passwordHash],
      );
      await tx.query('INSERT INTO conversations(id,title,created_by) VALUES($1,$2,$3)', [
        'conv_general',
        '项目讨论',
        id,
      ]);
      await audit(tx, id, 'owner.bootstrap', id);
    });
  }
  /** 注册只建立个人身份；团队和项目资格必须通过后续创建或邀请获得。 */
  async register(
    req: Request,
    res: Response,
    input: { email: string; name: string; password: string },
  ) {
    originCheck(req, this.config);
    if (!this.config.registrationEnabled)
      throw new DomainError('REGISTRATION_DISABLED', '当前部署已关闭自主注册，请联系维护者', 403);
    await identityRateLimit(this.db, 'register', req.ip || 'unknown', 10);
    const passwordHash = await this.hashPassword(input.password);
    const id = ids('usr');
    await this.db.transaction(async (tx) => {
      // 与兼容邀请开户共用单行锁，避免不同请求同时突破全站账号配额。
      await tx.query('SELECT id FROM identity_settings WHERE id=true FOR UPDATE');
      if (
        (await tx.query('SELECT count(*)::int AS n FROM users WHERE active'))[0].n >=
        this.memberLimit
      )
        throw new DomainError('MEMBER_LIMIT', '当前部署的账号数量已达上限，请联系维护者', 409);
      if (
        (await tx.query('SELECT id FROM users WHERE email=$1', [input.email.toLowerCase()])).length
      )
        throw new DomainError('ACCOUNT_EXISTS', '该邮箱已有账号，请直接登录', 409);
      await tx.query(
        "INSERT INTO users(id,email,name,password_hash,role) VALUES($1,$2,$3,$4,'MEMBER')",
        [id, input.email.toLowerCase(), input.name, passwordHash],
      );
      await audit(tx, id, 'account.registered', id);
    });
    return this.establishVerifiedSession(req, res, id);
  }
  /** 仅供本机维护，不通过 HTTP 暴露密码恢复能力。 */
  async resetOwnerFromLocalOperator(password: string): Promise<void> {
    const passwordHash = await this.hashPassword(password);
    await this.db.transaction(async (tx) => {
      const user = (
        await tx.query(
          "SELECT id FROM users WHERE role='OWNER' AND active AND email=$1 FOR UPDATE",
          [this.config.ownerEmail.toLowerCase()],
        )
      )[0];
      if (!user) throw new DomainError('OWNER_NOT_FOUND', '配置邮箱与有效 Owner 不匹配', 404);
      await tx.query('UPDATE users SET password_hash=$1 WHERE id=$2', [passwordHash, user.id]);
      await tx.query('DELETE FROM sessions WHERE user_id=$1', [user.id]);
      await audit(tx, 'local-operator', 'owner.password_reset', user.id);
    });
  }
  async login(
    req: Request,
    res: Response,
    email: string,
    password: string,
  ): Promise<User & { csrf: string }> {
    const user = await this.verifyPassword(req, email, password);
    return this.establishVerifiedSession(req, res, user.id);
  }
  /** 登录和登录页改密共用凭据校验及失败限流；只提供邮箱不能修改密码。 */
  private async verifyPassword(req: Request, email: string, password: string) {
    originCheck(req, this.config);
    const key = req.ip || 'unknown';
    const now = Date.now();
    const limit = this.attempts.get(key);
    if (limit && limit.until > now && limit.count >= 10)
      throw new DomainError('RATE_LIMITED', '尝试次数过多，请稍后再试', 429);
    const rows = await this.db.query('SELECT * FROM users WHERE email=$1 AND active', [
      email.toLowerCase(),
    ]);
    const valid = rows.length && (await verify(rows[0].password_hash, password).catch(() => false));
    if (!valid) {
      this.attempts.set(key, {
        count: limit && limit.until > now ? limit.count + 1 : 1,
        until: now + 300000,
      });
      throw new DomainError('INVALID_CREDENTIALS', '邮箱或密码不正确', 401);
    }
    this.attempts.delete(key);
    return rows[0];
  }
  async changePassword(
    req: Request,
    res: Response,
    input: { email: string; current_password: string; new_password: string },
  ) {
    const user = await this.verifyPassword(req, input.email, input.current_password);
    const passwordHash = await this.hashPassword(input.new_password);
    await this.db.transaction(async (tx) => {
      const current = (
        await tx.query('SELECT password_hash,active FROM users WHERE id=$1 FOR UPDATE', [user.id])
      )[0];
      // 旧密码验证后可能有另一个改密请求先提交；只能有一个请求使用原凭据成功修改。
      if (!current?.active || current.password_hash !== user.password_hash)
        throw new DomainError('PASSWORD_CHANGED', '密码已被修改，请使用当前密码重新提交', 409);
      await tx.query('UPDATE users SET password_hash=$1 WHERE id=$2', [passwordHash, user.id]);
      await tx.query('DELETE FROM sessions WHERE user_id=$1', [user.id]);
      await audit(tx, user.id, 'account.password_changed', user.id);
    });
    res.clearCookie('ta_session', { path: '/' });
    return { ok: true, relogin_required: true };
  }
  /** 仅供已完成密码或 OIDC 验证的服务端适配器使用，不暴露按 user_id 登录的 HTTP 接口。 */
  async establishVerifiedSession(
    req: Request,
    res: Response,
    userId: string,
  ): Promise<User & { csrf: string }> {
    const rows = await this.db.query('SELECT * FROM users WHERE id=$1 AND active', [userId]);
    if (!rows.length) throw new DomainError('AUTH_REQUIRED', '账号已失效', 401);
    const now = Date.now();
    const token = opaque(),
      csrf = opaque();
    await this.db.query('INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES($1,$2,$3,$4)', [
      sha(token),
      rows[0].id,
      csrf,
      new Date(now + 8 * 3600000),
    ]);
    res.cookie('ta_session', token, {
      httpOnly: true,
      secure: this.config.production,
      sameSite: 'strict',
      maxAge: 8 * 3600000,
      path: '/',
    });
    await audit(this.db, rows[0].id, 'session.login', rows[0].id);
    return { ...this.user(rows[0]), csrf };
  }
  async current(req: Request, mutation = false): Promise<SessionUser> {
    if (this.delegatedCurrent) return this.delegatedCurrent(req, mutation);
    const token = req.cookies?.ta_session;
    if (typeof token !== 'string') throw new DomainError('AUTH_REQUIRED', '请先登录', 401);
    const rows = await this.db.query(
      'SELECT u.*,s.id AS session_id,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.expires_at>now() AND u.active',
      [sha(token)],
    );
    if (!rows.length) throw new DomainError('AUTH_REQUIRED', '登录已过期，请重新登录', 401);
    if (mutation) {
      originCheck(req, this.config);
      if (req.get('x-csrf-token') !== rows[0].csrf)
        throw new DomainError('CSRF_DENIED', '请求验证已失效，请刷新页面', 403);
    }
    return { ...this.user(rows[0]), csrf: rows[0].csrf, session_id: rows[0].session_id };
  }
  async logout(req: Request, res: Response): Promise<void> {
    const user = await this.current(req, true);
    await this.db.query('DELETE FROM sessions WHERE id=$1', [user.session_id]);
    res.clearCookie('ta_session', { path: '/' });
  }
  async invite(user: User, email: string): Promise<{ token: string; expires_at: string }> {
    if (user.role !== 'OWNER')
      throw new DomainError('FORBIDDEN', '只有团队维护者可以邀请成员', 403);
    const token = opaque(),
      expires = new Date(Date.now() + 86400000);
    const count = await this.db.query('SELECT count(*)::int AS n FROM users WHERE active');
    if (count[0].n >= this.memberLimit)
      throw new DomainError('MEMBER_LIMIT', '团队成员数量已达到配置上限');
    await this.db.query(
      'INSERT INTO invitations(id,email,expires_at,created_by) VALUES($1,$2,$3,$4)',
      [sha(token), email.toLowerCase(), expires, user.id],
    );
    await audit(this.db, user.id, 'invitation.create', sha(token), { email });
    return { token, expires_at: expires.toISOString() };
  }
  async accept(token: string, name: string, password: string): Promise<void> {
    const passwordHash = await this.hashPassword(password);
    await this.db.transaction(async (tx) => {
      const rows = await tx.query('SELECT * FROM invitations WHERE id=$1 FOR UPDATE', [sha(token)]);
      if (!rows.length || rows[0].used_at || new Date(rows[0].expires_at).getTime() < Date.now())
        throw new DomainError('INVITATION_EXPIRED', '邀请已过期或已经使用', 410);
      await tx.query('SELECT id FROM identity_settings WHERE id=true FOR UPDATE'); // 与自主注册共用账号配额锁。
      const count = await tx.query('SELECT count(*)::int AS n FROM users WHERE active');
      if (count[0].n >= this.memberLimit) throw new DomainError('MEMBER_LIMIT', '成员数量已达上限');
      if ((await tx.query('SELECT id FROM users WHERE email=$1', [rows[0].email])).length)
        throw new DomainError('ACCOUNT_EXISTS', '该邮箱已经有账户');
      const id = ids('usr');
      await tx.query(
        "INSERT INTO users(id,email,name,password_hash,role) VALUES($1,$2,$3,$4,'MEMBER')",
        [id, rows[0].email, name, passwordHash],
      );
      // 兼容邀请明确加入默认团队；其他项目仍需单独授权，不自动继承。
      await tx.query(
        "INSERT INTO org_workspace_members(workspace_id,user_id,role) SELECT id,$1,'member' FROM org_workspaces WHERE id='workspace_default' ON CONFLICT DO NOTHING",
        [id],
      );
      await tx.query(
        "INSERT INTO org_project_members(project_id,user_id,role) SELECT id,$1,'member' FROM org_projects WHERE id='project_default' ON CONFLICT DO NOTHING",
        [id],
      );
      await tx.query('UPDATE invitations SET used_at=now() WHERE id=$1', [sha(token)]);
      await audit(tx, id, 'invitation.accept', id);
    });
  }
  private user(row: any): User {
    return { id: row.id, email: row.email, name: row.name, role: row.role };
  }
}
