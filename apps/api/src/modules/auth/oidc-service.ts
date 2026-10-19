import { createHash } from 'node:crypto';
import { createLocalJWKSet, jwtVerify } from 'jose';
import type { Request, Response } from 'express';
import type { Database } from '@team-agent/database';
import { DomainError } from '@team-agent/domain';
import type { ApiConfig } from '../../config/config.js';
import { opaque, sha, audit } from '../../common/security.js';
import type { AuthService } from './auth-service.js';

/** OIDC 只证明根账号身份，不授予项目成员关系、私群访问或设备能力。 */
export class OidcService {
  private readonly issuer = process.env.OIDC_ISSUER || '';
  private readonly clientId = process.env.OIDC_CLIENT_ID || '';
  private readonly clientSecret = process.env.OIDC_CLIENT_SECRET || '';
  readonly enabled = !!(this.issuer && this.clientId);
  constructor(
    private db: Database,
    private auth: AuthService,
    private config: ApiConfig,
  ) {}
  private checkedUrl(value: string) {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        !this.config.production &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      )
    )
      throw new DomainError('OIDC_TLS_REQUIRED', '组织身份端点必须使用 HTTPS', 503);
    return url;
  }
  private async json(url: string) {
    const response = await fetch(this.checkedUrl(url), { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new DomainError('OIDC_UNAVAILABLE', '组织身份服务暂不可用', 503);
    return response.json();
  }
  private async discovery() {
    if (!this.enabled) throw new DomainError('OIDC_DISABLED', '未配置组织身份登录', 404);
    const doc = await this.json(
      this.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration',
    );
    if (doc.issuer !== this.issuer)
      throw new DomainError('OIDC_ISSUER_MISMATCH', '组织身份发行者不匹配', 503);
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'])
      this.checkedUrl(doc[key]);
    return doc;
  }
  private redirectUri() {
    return this.config.webOrigin + '/api/v3/auth/oidc/callback';
  }
  async start(res: Response) {
    const metadata = await this.discovery();
    const state = opaque(),
      nonce = opaque(),
      verifier = opaque();
    await this.db.query(
      "INSERT INTO oidc_login_states VALUES($1,$2,$3,now()+interval '5 minutes',NULL)",
      [sha(state), nonce, verifier],
    );
    // Cookie 将 state 绑定发起登录的浏览器，数据库保存的 state 则只存哈希。
    res.cookie('ta_oidc_state', state, {
      httpOnly: true,
      secure: this.config.production,
      sameSite: 'lax',
      maxAge: 300000,
      path: '/api/v3/auth/oidc',
    });
    const url = this.checkedUrl(metadata.authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri(),
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }))
      url.searchParams.set(key, value);
    res.redirect(302, url.toString());
  }
  async callback(req: Request, res: Response, state: string, code: string) {
    if (req.cookies?.ta_oidc_state !== state)
      throw new DomainError('OIDC_STATE_DENIED', '登录验证已失效，请重新开始', 403);
    const saved = await this.db.transaction(async (tx) => {
      const row = (
        await tx.query('SELECT * FROM oidc_login_states WHERE state_hash=$1 FOR UPDATE', [
          sha(state),
        ])
      )[0];
      if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now())
        throw new DomainError('OIDC_STATE_DENIED', '登录已过期或已使用', 403);
      await tx.query('UPDATE oidc_login_states SET used_at=now() WHERE state_hash=$1', [
        sha(state),
      ]);
      return row;
    });
    const metadata = await this.discovery();
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.clientId,
      redirect_uri: this.redirectUri(),
      code_verifier: saved.verifier,
    });
    const tokenHeaders: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (this.clientSecret) {
      const methods = metadata.token_endpoint_auth_methods_supported || ['client_secret_basic'];
      if (methods.includes('client_secret_basic'))
        tokenHeaders.Authorization =
          'Basic ' +
          Buffer.from(
            encodeURIComponent(this.clientId) + ':' + encodeURIComponent(this.clientSecret),
          ).toString('base64');
      else if (methods.includes('client_secret_post')) form.set('client_secret', this.clientSecret);
      else
        throw new DomainError(
          'OIDC_CLIENT_AUTH_UNSUPPORTED',
          '身份提供商未声明支持的客户端认证方式',
          503,
        );
    }
    const response = await fetch(this.checkedUrl(metadata.token_endpoint), {
      method: 'POST',
      headers: tokenHeaders,
      body: form,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new DomainError('OIDC_CODE_DENIED', '组织身份验证失败，请重新登录', 403);
    const tokens = (await response.json()) as any;
    const keys = await this.json(metadata.jwks_uri);
    let claims;
    try {
      claims = (
        await jwtVerify(tokens.id_token, createLocalJWKSet(keys), {
          issuer: this.issuer,
          audience: this.clientId,
          algorithms: ['RS256', 'ES256'],
          requiredClaims: ['exp', 'iat', 'sub', 'nonce'],
          maxTokenAge: '10m',
          clockTolerance: 5,
        })
      ).payload;
    } catch {
      throw new DomainError('OIDC_TOKEN_DENIED', '身份令牌无效', 403);
    }
    if (
      (claims.azp !== undefined && claims.azp !== this.clientId) ||
      (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== this.clientId)
    )
      throw new DomainError('OIDC_AUDIENCE_DENIED', '身份令牌授权客户端不匹配', 403);
    if (claims.nonce !== saved.nonce || typeof claims.sub !== 'string')
      throw new DomainError('OIDC_NONCE_DENIED', '登录请求与身份令牌不匹配', 403);
    let identity = (
      await this.db.query('SELECT user_id FROM oidc_identities WHERE issuer=$1 AND subject=$2', [
        this.issuer,
        claims.sub,
      ])
    )[0];
    if (!identity) {
      if (claims.email_verified !== true || typeof claims.email !== 'string')
        throw new DomainError('OIDC_ACCOUNT_REQUIRED', '需要已验证的团队账号', 403);
      const user = (
        await this.db.query('SELECT id FROM users WHERE email=$1 AND active', [
          claims.email.toLowerCase(),
        ])
      )[0];
      if (!user)
        throw new DomainError(
          'OIDC_ACCOUNT_REQUIRED',
          '请先由团队邀请建立账号，再使用组织登录',
          403,
        );
      await this.db.query(
        'INSERT INTO oidc_identities VALUES($1,$2,$3,now()) ON CONFLICT DO NOTHING',
        [this.issuer, claims.sub, user.id],
      );
      identity = (
        await this.db.query('SELECT user_id FROM oidc_identities WHERE issuer=$1 AND subject=$2', [
          this.issuer,
          claims.sub,
        ])
      )[0];
    }
    await this.auth.establishVerifiedSession(req, res, identity.user_id);
    await audit(this.db, identity.user_id, 'identity.oidc_login', identity.user_id, {
      issuer: this.issuer,
    });
    res.clearCookie('ta_oidc_state', { path: '/api/v3/auth/oidc' });
    res.redirect(302, this.config.webOrigin);
  }
}
