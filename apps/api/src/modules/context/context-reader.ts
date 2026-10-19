import type { Database } from '@team-agent/database';
import type { ContextSnapshot } from '@team-agent/contracts';
import { DomainError } from '@team-agent/domain';
import { PermitSigner, audit, sha } from '../../common/security.js';

/** 回读许可只绑定一次活动执行，不赋予设备读取整个项目的权限。 */
export class ContextReader {
  constructor(
    private readonly db: Database,
    private readonly signer: PermitSigner,
  ) {}

  async read(token: string | undefined, attemptId: string, sourceId: string, offset = 0) {
    if (!token) throw new DomainError('CONTEXT_AUTH_REQUIRED', '缺少上下文回读许可', 401);
    const claims = await this.signer.verify(token);
    if (claims.scope !== 'context.read' || claims.attempt_id !== attemptId) {
      throw new DomainError('CONTEXT_SCOPE_DENIED', '许可不属于此次执行', 403);
    }
    if (!Number.isInteger(offset) || offset < 0)
      throw new DomainError('INVALID_OFFSET', '偏移量无效', 400);
    const rows = await this.db.query(
      'SELECT a.descriptor,a.lease_until,t.state,u.active,d.revoked FROM execution_attempts a JOIN tasks t ON t.id=a.task_id JOIN users u ON u.id=t.creator_id JOIN devices d ON d.id=a.device_id WHERE a.id=$1 AND a.device_id=$2',
      [attemptId, claims.device_id],
    );
    const row = rows[0];
    if (
      !row ||
      row.revoked ||
      !row.active ||
      !['RUNNING', 'DISPATCHING'].includes(row.state) ||
      new Date(row.lease_until).getTime() <= Date.now()
    ) {
      throw new DomainError('CONTEXT_LEASE_REVOKED', '任务已停止或授权已撤销', 403);
    }
    const snapshot: ContextSnapshot = row.descriptor.snapshot;
    if (claims.snapshot_hash !== snapshot.hash)
      throw new DomainError('CONTEXT_SCOPE_DENIED', '快照不匹配', 403);
    const evidence = snapshot.evidence.find((item) => item.id === sourceId);
    let content: string, version: number, kind: string;
    if (evidence) {
      if (evidence.kind === 'source') {
        const source = (
          await this.db.query(
            "SELECT v.content FROM source_versions v JOIN sources s ON s.id=v.source_id WHERE s.id=$1 AND v.version=$2 AND s.visibility='shared'",
            [sourceId, evidence.version],
          )
        )[0];
        if (!source || sha(source.content) !== evidence.hash)
          throw new DomainError('CONTEXT_SOURCE_UNAVAILABLE', '原始资料不可用', 404);
        content = source.content;
      } else if (evidence.kind === 'artifact') {
        const artifact = (
          await this.db.query(
            "SELECT a.content FROM artifacts a JOIN tasks t ON t.id=a.task_id LEFT JOIN artifact_validity v ON v.artifact_id=a.id WHERE a.id=$1 AND t.conversation_id=$2 AND a.published AND a.purged_at IS NULL AND coalesce(v.state,'unverified')<>'stale'",
            [sourceId, snapshot.conversation_id],
          )
        )[0];
        if (!artifact || sha(artifact.content) !== evidence.hash)
          throw new DomainError('CONTEXT_SOURCE_UNAVAILABLE', '依赖成果已失效', 404);
        content = artifact.content;
      } else {
        const memory = (
          await this.db.query(
            "SELECT source_refs FROM memories WHERE id=$1 AND version=$2 AND status='confirmed'",
            [sourceId, evidence.version],
          )
        )[0];
        if (!memory) throw new DomainError('CONTEXT_SOURCE_UNAVAILABLE', '项目结论已失效', 404);
        for (const ref of memory.source_refs) {
          if (
            !(
              await this.db.query("SELECT id FROM sources WHERE id=$1 AND visibility='shared'", [
                ref.source_id,
              ])
            ).length
          )
            throw new DomainError('CONTEXT_SCOPE_DENIED', '结论来源已不可见', 403);
        }
        content = evidence.content;
      }
      kind = evidence.kind;
      version = evidence.version;
    } else {
      // 被压缩省略的历史消息也必须属于获准会话，并处在冻结的截止序号之前。
      const message = (
        await this.db.query(
          'SELECT body,seq FROM messages WHERE id=$1 AND conversation_id=$2 AND seq<=$3',
          [sourceId, snapshot.conversation_id, snapshot.cutoff_seq],
        )
      )[0];
      if (!message) throw new DomainError('CONTEXT_SCOPE_DENIED', '资料未获此次任务授权', 403);
      content = message.body;
      version = message.seq;
      kind = 'message';
    }
    await audit(this.db, String(claims.device_id), 'context.read', sourceId, {
      attempt_id: attemptId,
      version,
      offset,
    });
    return {
      source_id: sourceId,
      version,
      kind,
      content: content.slice(offset, offset + 16000),
      offset,
      next_offset: offset + 16000 < content.length ? offset + 16000 : null,
      content_hash: sha(content),
    };
  }
}
