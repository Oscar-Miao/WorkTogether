import {
  createHash,
  randomBytes,
  randomUUID,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
} from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SignJWT, jwtVerify } from 'jose';
import type { Request } from 'express';
import type { Database, SqlConnection } from '@team-agent/database';
import type { ApiConfig } from '../config/config.js';
import { canonical, DomainError } from '@team-agent/domain';
export const ids = (prefix: string) => prefix + '_' + randomUUID().replaceAll('-', '');
export const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export const opaque = () => randomBytes(32).toString('base64url');
export const iso = (value: any) => new Date(value).toISOString();
export function owner(user: { role: string }): void {
  if (user.role !== 'OWNER') throw new DomainError('FORBIDDEN', '此操作需要项目维护者权限', 403);
}
export function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DomainError('INVALID_INPUT', '请求格式不正确', 400);
  return value as Record<string, unknown>;
}
export function originCheck(req: Request, config: ApiConfig): void {
  const origin = req.get('origin');
  if (
    origin &&
    origin !== config.webOrigin &&
    origin !== 'http://' + config.host + ':' + config.port
  )
    throw new DomainError('ORIGIN_DENIED', '请求来源不允许', 403);
  if (req.get('content-type') && !req.is('application/json'))
    throw new DomainError('INVALID_CONTENT_TYPE', '请使用 JSON 请求', 415);
}
export async function audit(
  db: SqlConnection,
  actor: string,
  action: string,
  objectId: string,
  detail: unknown = {},
): Promise<void> {
  await db.query('INSERT INTO audit_logs(actor_id,action,object_id,detail) VALUES($1,$2,$3,$4)', [
    actor,
    action,
    objectId,
    JSON.stringify(detail),
  ]);
}
export async function idempotent<T>(
  db: Database,
  scope: string,
  key: string | undefined,
  body: unknown,
  work: (tx: SqlConnection) => Promise<T>,
): Promise<T> {
  if (!key || key.length < 8 || key.length > 150)
    throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', '缺少有效的 Idempotency-Key', 400);
  const hash = sha(canonical(body));
  return db.transaction(async (tx) => {
    // Reserve before side effects. A concurrent request waits for the first transaction,
    // then reads its committed result; a failed transaction removes the reservation.
    const inserted = await tx.query(
      "INSERT INTO idempotency_records(scope,key,body_hash,result) VALUES($1,$2,$3,'null'::jsonb) ON CONFLICT DO NOTHING RETURNING key",
      [scope, key, hash],
    );
    if (!inserted.length) {
      const existing = (
        await tx.query('SELECT * FROM idempotency_records WHERE scope=$1 AND key=$2 FOR UPDATE', [
          scope,
          key,
        ])
      )[0];
      if (existing.body_hash !== hash)
        throw new DomainError('IDEMPOTENCY_CONFLICT', '相同请求键不能用于不同内容');
      return existing.result as T;
    }
    const result = await work(tx);
    await tx.query('UPDATE idempotency_records SET result=$1 WHERE scope=$2 AND key=$3', [
      JSON.stringify(result),
      scope,
      key,
    ]);
    return result;
  });
}
export class PermitSigner {
  constructor(
    private readonly privateKey: ReturnType<typeof createPrivateKey>,
    public readonly publicKey: string,
  ) {}
  static async load(dataDir: string): Promise<PermitSigner> {
    const dir = resolve(dataDir, 'private');
    await mkdir(dir, { recursive: true });
    const file = resolve(dir, 'permit-key.pem');
    let pem: string;
    try {
      pem = await readFile(file, 'utf8');
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      const pair = generateKeyPairSync('ed25519');
      pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      try {
        await writeFile(file, pem, { mode: 0o600, flag: 'wx' });
      } catch (e: any) {
        if (e.code !== 'EEXIST') throw e;
        pem = await readFile(file, 'utf8');
      }
    }
    const privateKey = createPrivateKey(pem);
    return new PermitSigner(
      privateKey,
      createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString(),
    );
  }
  async verify(token: string) {
    try {
      return (
        await jwtVerify(token, createPublicKey(this.privateKey), {
          issuer: 'team-agent-api',
          audience: 'team-agent-bridge',
          algorithms: ['EdDSA'],
        })
      ).payload;
    } catch {
      throw new DomainError('CONTEXT_AUTH_REQUIRED', '上下文许可无效或已过期', 401);
    }
  }
  async sign(claims: Record<string, unknown>, expiresAt: Date): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .setIssuer('team-agent-api')
      .setAudience('team-agent-bridge')
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.privateKey);
  }
}
