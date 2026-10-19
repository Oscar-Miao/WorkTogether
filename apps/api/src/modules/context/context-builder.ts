import type { SqlConnection } from '@team-agent/database';
import type { ContextSnapshot, TaskInput, User } from '@team-agent/contracts';
import { canonical, compactMessages, DomainError, renderContext } from '@team-agent/domain';
import { ids, sha } from '../../common/security.js';
import { CollaborationService } from '../conversations/collaboration-service.js';

export class ContextBuilder {
  constructor(private readonly collaboration: CollaborationService) {}
  async build(user: User, input: TaskInput, tx: SqlConnection): Promise<ContextSnapshot> {
    const latest = (
      await tx.query(
        'SELECT coalesce(max(seq),0)::int AS seq FROM messages WHERE conversation_id=$1',
        [input.conversation_id],
      )
    )[0].seq;
    const cutoff = input.conversation_cutoff_seq ?? latest;
    if (cutoff > latest) throw new DomainError('INVALID_CUTOFF', '会话截止点不存在', 400);
    const size = (
      await tx.query(
        'SELECT count(*)::int AS count,coalesce(sum(octet_length(body)),0)::text AS bytes FROM messages WHERE conversation_id=$1 AND seq<=$2',
        [input.conversation_id, cutoff],
      )
    )[0];
    // 加载正文前先限制组装规模；超限明确报错，不能静默丢掉早期约束。
    if (size.count > 10000 || Number(size.bytes) > 8 * 1024 * 1024)
      throw new DomainError(
        'CONTEXT_TOO_LARGE',
        '会话历史超过首版整理上限，请新建会话并显式引用已确认结论',
        413,
      );
    const messages = await this.collaboration.messages(input.conversation_id, tx, cutoff);
    const evidence: ContextSnapshot['evidence'] = [];
    for (const ref of input.source_refs) {
      const source = await this.collaboration.source(user, ref.source_id, ref.version, tx);
      if (source.visibility !== 'shared')
        throw new DomainError('PRIVATE_SOURCE', '共享任务不能隐式使用 Owner 私有资料', 403);
      evidence.push({
        id: source.id,
        kind: 'source',
        version: source.version,
        content: source.content.slice(0, 4000),
        is_excerpt: source.content.length > 4000,
        hash: source.content_hash,
      });
    }
    for (const id of input.dependency_artifact_refs || []) {
      const artifact = await this.artifact(input, id, tx);
      evidence.push({
        id,
        kind: 'artifact',
        version: 1,
        content: artifact.content.slice(0, 4000),
        is_excerpt: artifact.content.length > 4000,
        hash: sha(artifact.content),
      });
    }
    for (const ref of input.memory_refs) {
      const memory = (
        await tx.query("SELECT * FROM memories WHERE id=$1 AND version=$2 AND status='confirmed'", [
          ref.memory_id,
          ref.version,
        ])
      )[0];
      if (!memory) throw new DomainError('MEMORY_UNAVAILABLE', '只能引用已确认且仍有效的项目结论');
      for (const dependency of memory.source_refs) {
        const source = await this.collaboration.source(
          user,
          dependency.source_id,
          dependency.version,
          tx,
        );
        if (source.visibility !== 'shared')
          throw new DomainError('PRIVATE_SOURCE', '结论来源不能扩大分享范围', 403);
      }
      evidence.push({
        id: memory.id,
        kind: 'memory',
        version: memory.version,
        content: memory.content,
        hash: sha(memory.content),
      });
    }
    const base = {
      id: ids('ctx'),
      conversation_id: input.conversation_id,
      cutoff_seq: cutoff,
      goal: input.goal,
      constraints: input.constraints,
      acceptance: input.acceptance,
      evidence,
      ...compactMessages(messages),
    };
    const modelInput = renderContext(base);
    // 目标约束或资料超限时明确失败，避免截断后仍按不完整要求执行。
    if (Buffer.byteLength(modelInput, 'utf8') > 96000)
      throw new DomainError('CONTEXT_TOO_LARGE', '初版上下文超过预算，请减少引用或拆分任务', 413);
    return {
      ...base,
      model_input: modelInput,
      hash: sha(canonical({ ...base, model_input: modelInput })),
    };
  }
  /** 依赖成果只流入原群，且必须来自已成功、已发布、未清理的真实执行。 */
  private async artifact(input: TaskInput, id: string, tx: SqlConnection) {
    const row = (
      await tx.query(
        "SELECT a.content FROM artifacts a JOIN tasks t ON t.id=a.task_id LEFT JOIN artifact_validity v ON v.artifact_id=a.id WHERE a.id=$1 AND t.conversation_id=$2 AND t.state='SUCCEEDED' AND a.published AND a.purged_at IS NULL AND coalesce(v.state,'unverified')<>'stale'",
        [id, input.conversation_id],
      )
    )[0];
    if (!row) throw new DomainError('APPROVAL_STALE', '依赖成果不可用、已失效或不属于当前群', 409);
    return row;
  }
  async verifySources(input: TaskInput, tx: SqlConnection): Promise<void> {
    for (const id of input.dependency_artifact_refs || []) await this.artifact(input, id, tx);
    for (const ref of input.source_refs) {
      const rows = await tx.query(
        "SELECT current_version FROM sources WHERE id=$1 AND visibility='shared'",
        [ref.source_id],
      );
      if (!rows.length || rows[0].current_version !== ref.version)
        throw new DomainError('APPROVAL_STALE', '引用资料已改版，请修订任务后重新审批');
    }
    for (const ref of input.memory_refs) {
      const rows = await tx.query(
        "SELECT * FROM memories WHERE id=$1 AND version=$2 AND status='confirmed'",
        [ref.memory_id, ref.version],
      );
      if (!rows.length) throw new DomainError('APPROVAL_STALE', '引用的项目结论已变化');
      for (const dependency of rows[0].source_refs) {
        const sources = await tx.query(
          "SELECT current_version FROM sources WHERE id=$1 AND visibility='shared'",
          [dependency.source_id],
        );
        if (!sources.length || sources[0].current_version !== dependency.version)
          throw new DomainError('APPROVAL_STALE', '结论证据已变化，请核查后再执行');
      }
    }
  }
}
