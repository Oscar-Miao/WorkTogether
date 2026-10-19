import type { Database } from '@team-agent/database';
import type { User } from '@team-agent/contracts';
import { DomainError } from '@team-agent/domain';
import { owner, audit } from '../../common/security.js';
import { requireGroupAccess, requireTaskAccess } from '../../common/group-access.js';

/** 治理查询同样按可见群投影，维护者身份不赋予私群数据访问权。 */
export class GovernanceService {
  constructor(
    private db: Database,
    private tasks: import('../tasks/task-service.js').TaskService,
  ) {}
  async metrics(user: User) {
    owner(user);
    const groups = await this.db.query(
      "SELECT c.id FROM conversations c WHERE c.visibility='project' OR EXISTS(SELECT 1 FROM group_members m WHERE m.conversation_id=c.id AND m.user_id=$1)",
      [user.id],
    );
    const ids = groups.map((g) => g.id);
    const goals = await this.db.query(
      'SELECT state,count(*)::int AS count FROM collaboration_goals WHERE conversation_id=ANY($1::text[]) GROUP BY state',
      [ids],
    );
    const jobs = await this.db.query(
      'SELECT status,count(*)::int AS count FROM observation_jobs WHERE conversation_id=ANY($1::text[]) GROUP BY status',
      [ids],
    );
    const usage = await this.db.query(
      'SELECT layer,count(*)::int AS responses,sum(input_tokens)::text AS input_tokens,sum(output_tokens)::text AS output_tokens,sum(cost_usd)::text AS cost_usd,count(*) FILTER(WHERE input_tokens IS NULL)::int AS unknown_usage,count(*) FILTER(WHERE cost_usd IS NULL)::int AS unknown_cost FROM model_usage WHERE conversation_id=ANY($1::text[]) GROUP BY layer',
      [ids],
    );
    const uncertain = await this.db.query(
      "SELECT a.id,a.created_at FROM execution_attempts a JOIN tasks t ON t.id=a.task_id WHERE a.status='uncertain' AND t.conversation_id=ANY($1::text[])",
      [ids],
    );
    return {
      goals,
      jobs,
      usage,
      uncertain,
      scope: '仅当前项目有权查看的群',
      pricing: '缺失用量或费用保留未知，不按零成本推断',
    };
  }
  async auditLog(user: User, after: number) {
    owner(user);
    const rows = await this.db.query('SELECT * FROM audit_logs WHERE id>$1 ORDER BY id LIMIT 500', [
      after,
    ]);
    const visible = [];
    for (const row of rows) {
      const group = (
        await this.db.query(
          'SELECT conversation_id FROM tasks WHERE id=$1 UNION SELECT id AS conversation_id FROM conversations WHERE id=$1',
          [row.object_id],
        )
      )[0];
      if (group) {
        try {
          await requireGroupAccess(this.db, user, group.conversation_id);
        } catch {
          continue;
        }
      } else if (!/^(node\.|device\.|execution\.limits|leadership\.)/.test(row.action)) continue;
      visible.push({ ...row, id: Number(row.id) });
    }
    return { items: visible, next_after: rows.at(-1)?.id ? Number(rows.at(-1)!.id) : after };
  }
  async validity(user: User, id: string, state: string, reason: string) {
    const artifact = (await this.db.query('SELECT * FROM artifacts WHERE id=$1', [id]))[0];
    if (!artifact) throw new DomainError('NOT_FOUND', '成果不存在', 404);
    await requireTaskAccess(this.db, user, artifact.task_id);
    if (!artifact.published && user.role !== 'OWNER')
      throw new DomainError('FORBIDDEN', '成果尚未发布', 403);
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM coordinator_control WHERE id=true FOR UPDATE');
      await tx.query(
        'INSERT INTO artifact_validity(artifact_id,state,reason,updated_by) VALUES($1,$2,$3,$4) ON CONFLICT(artifact_id) DO UPDATE SET state=excluded.state,reason=excluded.reason,updated_by=excluded.updated_by,updated_at=now()',
        [id, state, reason, user.id],
      );
      if (state === 'stale')
        await tx.query(
          "UPDATE execution_steps SET state='invalidated' WHERE task_id=$1 AND state='completed'",
          [artifact.task_id],
        );
      if (state !== 'valid')
        await tx.query(
          "UPDATE collaboration_goals SET state='CLARIFYING',version=version+1,reason='已有成果失效或待核验，请确认当前范围后复核' WHERE task_id=$1 AND state='COMPLETED'",
          [artifact.task_id],
        );
      await audit(tx, user.id, 'artifact.validity_changed', artifact.task_id, {
        artifact_id: id,
        state,
        reason,
        verification: 'human_assessed',
      });
    });
    if (state === 'stale') {
      const dependent = await this.db.query(
        "SELECT id FROM tasks WHERE input->'dependency_artifact_refs' ? $1 AND state IN ('QUEUED','DISPATCHING','RUNNING')",
        [id],
      );
      for (const task of dependent)
        await this.tasks.cancelForPolicy(task.id, '引用的上游成果已失效');
      await this.db.query(
        "UPDATE collaboration_goals SET state='CLARIFYING',reason='分工成果已失效，请重新核验',version=version+1 WHERE id IN(SELECT p.goal_id FROM execution_plans p JOIN execution_steps s ON s.plan_id=p.id WHERE s.task_id=$1) AND state='COMPLETED'",
        [artifact.task_id],
      );
    }
    this.tasks.changes.emit('all');
    return { ok: true };
  }
}
