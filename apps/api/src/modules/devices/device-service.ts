import { createPublicKey, verify as verifySignature } from 'node:crypto';
import type { Database, Row } from '@team-agent/database';
import type { Device, RepositoryBinding, User } from '@team-agent/contracts';
import { canonical, DomainError } from '@team-agent/domain';
import { audit, ids, iso, opaque, owner, sha, PermitSigner } from '../../common/security.js';

export class DeviceService {
  constructor(
    private readonly db: Database,
    private readonly signer: PermitSigner,
  ) {}
  async pairingCode(user: User): Promise<{ code: string; expires_at: string }> {
    owner(user);
    const code = opaque(),
      expires = new Date(Date.now() + 300000);
    await this.db.query('INSERT INTO pairing_codes(id,owner_id,expires_at) VALUES($1,$2,$3)', [
      sha(code),
      user.id,
      expires,
    ]);
    await audit(this.db, user.id, 'device.pairing_code', sha(code));
    return { code, expires_at: expires.toISOString() };
  }
  async pair(input: {
    code: string;
    name: string;
    public_key: string;
    runtime: string;
    adapter_version: string;
  }): Promise<{ device_id: string; server_public_key: string }> {
    let key;
    try {
      key = createPublicKey(input.public_key);
    } catch {
      throw new DomainError('INVALID_KEY', '设备公钥格式不正确', 400);
    }
    if (key.asymmetricKeyType !== 'ed25519')
      throw new DomainError('INVALID_KEY', '设备必须使用 Ed25519 公钥', 400);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM coordinator_control WHERE id=true FOR UPDATE');
      const codes = await tx.query('SELECT * FROM pairing_codes WHERE id=$1 FOR UPDATE', [
        sha(input.code),
      ]);
      if (
        !codes.length ||
        codes[0].used_at ||
        new Date(codes[0].expires_at).getTime() <= Date.now()
      )
        throw new DomainError('PAIRING_EXPIRED', '配对码已过期或已使用', 410);
      const limit = (await tx.query('SELECT max_devices FROM execution_limits WHERE id=true'))[0]
        .max_devices;
      if ((await tx.query('SELECT id FROM devices WHERE NOT revoked')).length >= limit)
        throw new DomainError('DEVICE_LIMIT', '活动设备数量已达项目配额');
      if (
        limit === 1 &&
        (
          await tx.query(
            "SELECT id FROM execution_attempts WHERE status IN ('dispatching','running','cancelling','uncertain')",
          )
        ).length
      )
        throw new DomainError('EXECUTION_UNCERTAIN', '旧执行尚未核清，不能绑定替代设备');
      const id = ids('dev');
      await tx.query(
        'INSERT INTO devices(id,owner_id,name,public_key,runtime,adapter_version) VALUES($1,$2,$3,$4,$5,$6)',
        [id, codes[0].owner_id, input.name, input.public_key, input.runtime, input.adapter_version],
      );
      await tx.query('UPDATE pairing_codes SET used_at=now() WHERE id=$1', [sha(input.code)]);
      await audit(tx, codes[0].owner_id, 'device.pair', id);
      return { device_id: id, server_public_key: this.signer.publicKey };
    });
  }
  async challenge(deviceId: string): Promise<{ challenge_id: string; nonce: string }> {
    if (
      !(await this.db.query('SELECT id FROM devices WHERE id=$1 AND NOT revoked', [deviceId]))
        .length
    )
      throw new DomainError('DEVICE_REVOKED', '设备不可用', 403);
    const id = ids('challenge'),
      nonce = opaque();
    await this.db.query(
      'INSERT INTO device_challenges(id,device_id,nonce,expires_at) VALUES($1,$2,$3,$4)',
      [id, deviceId, nonce, new Date(Date.now() + 60000)],
    );
    return { challenge_id: id, nonce };
  }
  async token(input: {
    device_id: string;
    challenge_id: string;
    signature: string;
  }): Promise<{ access_token: string; expires_at: string }> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query(
        'SELECT c.*,d.public_key,d.revoked FROM device_challenges c JOIN devices d ON d.id=c.device_id WHERE c.id=$1 AND c.device_id=$2 FOR UPDATE OF c',
        [input.challenge_id, input.device_id],
      );
      const row = rows[0];
      if (
        !row ||
        row.nonce.startsWith('{') ||
        row.revoked ||
        row.used_at ||
        new Date(row.expires_at).getTime() <= Date.now()
      )
        throw new DomainError('DEVICE_AUTH_FAILED', '设备验证失败', 401);
      let valid = false;
      try {
        valid = verifySignature(
          null,
          Buffer.from(row.nonce),
          createPublicKey(row.public_key),
          Buffer.from(input.signature, 'base64url'),
        );
      } catch {}
      if (!valid) throw new DomainError('DEVICE_AUTH_FAILED', '设备签名不正确', 401);
      const token = opaque(),
        expires = new Date(Date.now() + 900000);
      await tx.query('UPDATE device_challenges SET used_at=now() WHERE id=$1', [row.id]);
      await tx.query('INSERT INTO device_sessions(id,device_id,expires_at) VALUES($1,$2,$3)', [
        sha(token),
        row.device_id,
        expires,
      ]);
      return { access_token: token, expires_at: expires.toISOString() };
    });
  }
  async stopChallenge(deviceId: string, attemptId: string) {
    if (
      !(
        await this.db.query('SELECT id FROM execution_attempts WHERE id=$1 AND device_id=$2', [
          attemptId,
          deviceId,
        ])
      ).length
    )
      throw new DomainError('ATTEMPT_DENIED', '执行尝试不属于此设备', 403);
    const id = ids('stopchallenge'),
      nonce = canonical({ purpose: 'stop_receipt', attempt_id: attemptId, nonce: opaque() });
    await this.db.query(
      'INSERT INTO device_challenges(id,device_id,nonce,expires_at) VALUES($1,$2,$3,$4)',
      [id, deviceId, nonce, new Date(Date.now() + 60000)],
    );
    return { challenge_id: id, nonce };
  }
  async verifyStopReceipt(input: {
    device_id: string;
    attempt_id: string;
    challenge_id: string;
    signature: string;
    result: unknown;
    stop_evidence: string;
  }): Promise<string> {
    return this.db.transaction(async (tx) => {
      const row = (
        await tx.query(
          'SELECT c.*,d.public_key FROM device_challenges c JOIN devices d ON d.id=c.device_id WHERE c.id=$1 AND c.device_id=$2 FOR UPDATE OF c',
          [input.challenge_id, input.device_id],
        )
      )[0];
      if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now())
        throw new DomainError('DEVICE_AUTH_FAILED', '停止回执验证失败', 401);
      let scope: any;
      try {
        scope = JSON.parse(row.nonce);
      } catch {
        throw new DomainError('DEVICE_AUTH_FAILED', '回执用途不匹配', 401);
      }
      if (scope.purpose !== 'stop_receipt' || scope.attempt_id !== input.attempt_id)
        throw new DomainError('DEVICE_AUTH_FAILED', '回执用途不匹配', 401);
      const payload = canonical({
        nonce: row.nonce,
        attempt_id: input.attempt_id,
        result: input.result,
        stop_evidence: input.stop_evidence,
      });
      let valid = false;
      try {
        valid = verifySignature(
          null,
          Buffer.from(payload),
          createPublicKey(row.public_key),
          Buffer.from(input.signature, 'base64url'),
        );
      } catch {}
      if (!valid) throw new DomainError('DEVICE_AUTH_FAILED', '回执签名错误', 401);
      await tx.query('UPDATE device_challenges SET used_at=now() WHERE id=$1', [row.id]);
      await audit(tx, input.device_id, 'execution.stop_receipt', input.attempt_id);
      return input.device_id;
    });
  }
  async authenticate(token: string | undefined): Promise<Row> {
    if (!token) throw new DomainError('DEVICE_AUTH_REQUIRED', '需要设备身份', 401);
    const rows = await this.db.query(
      'SELECT d.* FROM device_sessions s JOIN devices d ON d.id=s.device_id WHERE s.id=$1 AND s.expires_at>now() AND NOT d.revoked',
      [sha(token)],
    );
    if (!rows.length) throw new DomainError('DEVICE_AUTH_REQUIRED', '设备授权已过期或撤销', 401);
    return rows[0];
  }
  async setRepositories(deviceId: string, repositories: RepositoryBinding[]): Promise<void> {
    await this.db.query('UPDATE devices SET repositories=$1 WHERE id=$2 AND NOT revoked', [
      JSON.stringify(repositories),
      deviceId,
    ]);
    await audit(this.db, deviceId, 'device.repositories', deviceId, {
      repositories: repositories.map((r) => ({ id: r.id, name: r.name })),
    });
  }
  async heartbeat(id: string): Promise<void> {
    await this.db.query('UPDATE devices SET last_seen=now() WHERE id=$1 AND NOT revoked', [id]);
    await this.db.query(
      "UPDATE coordinator_leadership SET lease_until=now()+interval '40 seconds' WHERE node_id=$1 AND EXISTS(SELECT 1 FROM devices WHERE id=$1 AND NOT revoked)",
      [id],
    );
  }
  async list(): Promise<Device[]> {
    return (
      await this.db.query(
        'SELECT id,name,last_seen,revoked,runtime,adapter_version,repositories FROM devices ORDER BY created_at DESC',
      )
    ).map((r) => ({
      id: r.id,
      name: r.name,
      last_seen: r.last_seen ? iso(r.last_seen) : null,
      status: r.revoked
        ? 'revoked'
        : r.last_seen && Date.now() - new Date(r.last_seen).getTime() < 30000
          ? 'online'
          : 'offline',
      runtime: r.runtime,
      adapter_version: r.adapter_version,
      repositories: r.repositories,
    }));
  }
  async revoke(user: User, id: string): Promise<void> {
    owner(user);
    await this.db.transaction(async (tx) => {
      const rows = await tx.query('UPDATE devices SET revoked=true WHERE id=$1 RETURNING id', [id]);
      if (!rows.length) throw new DomainError('NOT_FOUND', '设备不存在', 404);
      await tx.query('DELETE FROM device_sessions WHERE device_id=$1', [id]);
      await tx.query(
        "UPDATE tasks SET state='CANCEL_REQUESTED',version=version+1 WHERE attempt_id IN (SELECT id FROM execution_attempts WHERE device_id=$1 AND status IN ('dispatching','running','uncertain'))",
        [id],
      );
      await audit(tx, user.id, 'device.revoke', id);
    });
  }
}
