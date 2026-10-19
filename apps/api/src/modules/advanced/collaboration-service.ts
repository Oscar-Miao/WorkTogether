import type { Database, SqlConnection, Row } from '@team-agent/database';
import type { User } from '@team-agent/contracts';
import { DomainError, validateDependencyGraph } from '@team-agent/domain';
import { ids, audit, owner, iso } from '../../common/security.js';
import { requireGroupAccess } from '../../common/group-access.js';
import type { TaskService } from '../tasks/task-service.js';

/** 进阶协作事实：关系、交接、分叉与修订。模型不能直接改变这些权威记录。 */
export class AdvancedCollaboration {
  constructor(
    readonly db: Database,
    readonly tasks: TaskService,
  ) {}
  private async lock(tx: SqlConnection) {
    await tx.query('SELECT id FROM coordinator_control WHERE id=true FOR UPDATE');
  }
  async event(tx: SqlConnection, user: User, group: string, kind: string, payload: unknown) {
    await tx.query('INSERT INTO domain_outbox(conversation_id,kind,payload) VALUES($1,$2,$3)', [
      group,
      kind,
      JSON.stringify(payload),
    ]);
    await audit(tx, user.id, kind, group, payload);
  }
  async goal(tx: SqlConnection, user: User, id: string, version?: number) {
    const row = (await tx.query('SELECT * FROM collaboration_goals WHERE id=$1', [id]))[0];
    if (!row) throw new DomainError('NOT_FOUND', '目标不存在', 404);
    const group = await requireGroupAccess(tx, user, row.conversation_id);
    if (version !== undefined && row.version !== version)
      throw new DomainError('GOAL_STALE', '目标已变化，请刷新', 409);
    return { ...row, group } as Row;
  }
  async groupAction(
    user: User,
    id: string,
    input: {
      action: string;
      cutoff_seq?: number;
      title?: string;
      reason?: string;
      user_id?: string;
    },
  ) {
    let cancel: string[] = [];
    const result = await this.db.transaction(async (tx) => {
      await this.lock(tx);
      const group = await requireGroupAccess(tx, user, id);
      const manager = group.manager_id || group.created_by;
      if (['archive', 'restore', 'remove_member'].includes(input.action) && manager !== user.id)
        throw new DomainError('FORBIDDEN', '需要群创建者权限', 403);
      if (input.action === 'transfer_manager') {
        const active = (await tx.query('SELECT active FROM users WHERE id=$1', [manager]))[0]
          ?.active;
        if (manager !== user.id && active)
          throw new DomainError('FORBIDDEN', '只有当前群管理者可以移交', 403);
        if (!input.user_id) throw new DomainError('MEMBER_REQUIRED', '请选择接手成员', 400);
        await requireGroupAccess(tx, { id: input.user_id } as User, id);
        if (
          !(await tx.query('SELECT id FROM users WHERE id=$1 AND active', [input.user_id])).length
        )
          throw new DomainError('MEMBER_REQUIRED', '接手成员不可用', 400);
        await tx.query('UPDATE conversations SET manager_id=$2 WHERE id=$1', [id, input.user_id]);
        await this.event(tx, user, id, 'group.manager_transferred', { user_id: input.user_id });
        return { id };
      }
      if (input.action === 'archive' || input.action === 'restore') {
        await tx.query(
          'UPDATE conversations SET archived_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$1',
          [id, input.action === 'archive'],
        );
        if (input.action === 'archive')
          cancel = (
            await tx.query(
              "SELECT id FROM tasks WHERE conversation_id=$1 AND state IN ('QUEUED','RUNNING','DISPATCHING')",
              [id],
            )
          ).map((t) => t.id);
        await this.event(tx, user, id, 'group.' + input.action, {});
        return { id };
      }
      if (input.action === 'leave' || input.action === 'remove_member') {
        const target = input.action === 'leave' ? user.id : input.user_id;
        if (group.visibility === 'project' || manager === target)
          throw new DomainError(
            'GROUP_MEMBERSHIP',
            '默认群不可退出；当前管理者需先移交群管理',
            409,
          );
        await tx.query(
          'WITH RECURSIVE descendants(id) AS (SELECT $1::text UNION SELECT f.conversation_id FROM conversation_forks f JOIN descendants d ON f.parent_id=d.id) DELETE FROM group_members WHERE conversation_id IN(SELECT id FROM descendants) AND user_id=$2',
          [id, target],
        );
        // 撤权后先停止使用旧群快照的活动任务，不能继续沿用旧许可。
        cancel = (
          await tx.query(
            "WITH RECURSIVE descendants(id) AS (SELECT $1::text UNION SELECT f.conversation_id FROM conversation_forks f JOIN descendants d ON f.parent_id=d.id) SELECT id FROM tasks WHERE conversation_id IN(SELECT id FROM descendants) AND state IN ('QUEUED','RUNNING','DISPATCHING','RECONCILING')",
            [id],
          )
        ).map((t) => t.id);
        await this.event(tx, user, id, 'group.member_removed', { user_id: target });
        return { id };
      }
      if (input.action !== 'fork') throw new DomainError('INVALID_ACTION', '不支持的群操作', 400);
      const last = (
        await tx.query(
          'SELECT coalesce(max(seq),0)::int AS seq FROM messages WHERE conversation_id=$1',
          [id],
        )
      )[0].seq;
      const cutoff = input.cutoff_seq ?? last;
      if (cutoff < 0 || cutoff > last || !Number.isInteger(cutoff))
        throw new DomainError('INVALID_CUTOFF', '分叉点不存在', 400);
      const fork = ids('conv');
      // 分叉默认私有，并复制分叉当时的成员集合；不会把原群全部内容公开。
      await tx.query(
        "INSERT INTO conversations(id,title,description,visibility,created_by) VALUES($1,$2,$3,'private',$4)",
        [fork, input.title || group.title + ' · 分叉', input.reason || '分叉讨论', user.id],
      );
      await tx.query(
        "INSERT INTO group_members(conversation_id,user_id) SELECT $1,u.id FROM project_users u WHERE u.active AND ($3='project' OR EXISTS(SELECT 1 FROM group_members m WHERE m.conversation_id=$2 AND m.user_id=u.id))",
        [fork, id, group.visibility],
      );
      const messages = await tx.query(
        'SELECT * FROM messages WHERE conversation_id=$1 AND seq<=$2 ORDER BY seq',
        [id, cutoff],
      );
      for (const message of messages)
        await tx.query(
          'INSERT INTO messages(id,conversation_id,seq,author_id,body,client_message_id,mentions,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            ids('msg'),
            fork,
            message.seq,
            message.author_id,
            message.body,
            'fork:' + message.id,
            JSON.stringify(message.mentions),
            message.created_at,
          ],
        );
      await tx.query('INSERT INTO conversation_forks VALUES($1,$2,$3,$4,$5)', [
        fork,
        id,
        cutoff,
        input.reason || '分叉讨论',
        user.id,
      ]);
      await tx.query('UPDATE conversations SET observed_seq=$2 WHERE id=$1', [fork, cutoff]);
      await this.event(tx, user, fork, 'group.forked', { parent_id: id, cutoff_seq: cutoff });
      return { id: fork };
    });
    for (const task of cancel)
      await this.tasks.cancelForPolicy(task, '群归档或成员撤权，停止旧上下文执行');
    this.tasks.changes.emit('all');
    return result;
  }
  async policy(user: User, id: string, policy: unknown) {
    await this.db.transaction(async (tx) => {
      await this.lock(tx);
      const group = await requireGroupAccess(tx, user, id);
      if ((group.manager_id || group.created_by) !== user.id)
        throw new DomainError('FORBIDDEN', '需要群创建者权限', 403);
      await tx.query('UPDATE conversations SET agent_policy=$2 WHERE id=$1', [
        id,
        JSON.stringify(policy),
      ]);
      await this.event(tx, user, id, 'group.policy_changed', policy);
    });
    this.tasks.changes.emit('all');
    return { ok: true };
  }
  async read(user: User, id: string, seq: number) {
    await requireGroupAccess(this.db, user, id);
    const max = (
      await this.db.query(
        'SELECT coalesce(max(seq),0)::int AS n FROM messages WHERE conversation_id=$1',
        [id],
      )
    )[0].n;
    if (seq > max) throw new DomainError('INVALID_OFFSET', '已读水位超过消息范围', 400);
    await this.db.query(
      'INSERT INTO group_read_watermarks VALUES($1,$2,$3) ON CONFLICT(conversation_id,user_id) DO UPDATE SET seq=greatest(group_read_watermarks.seq,excluded.seq)',
      [id, user.id, seq],
    );
    return { ok: true };
  }
  async relation(
    user: User,
    id: string,
    input: {
      target_id: string;
      kind: string;
      evidence: string;
      expected_version: number;
      target_version: number;
    },
  ) {
    const result = await this.db.transaction(async (tx) => {
      await this.lock(tx);
      const source = await this.goal(tx, user, id, input.expected_version);
      await this.goal(tx, user, input.target_id, input.target_version);
      if (source.group.archived_at)
        throw new DomainError('GROUP_ARCHIVED', '归档群不可修改协作关系', 409);
      if (input.kind === 'depends_on') {
        if (
          source.task_id &&
          (
            await tx.query(
              "SELECT id FROM tasks WHERE id=$1 AND state IN ('DISPATCHING','RUNNING','CANCEL_REQUESTED','RECONCILING')",
              [source.task_id],
            )
          ).length
        )
          throw new DomainError('GOAL_ACTIVE', '请先停止活动目标，再变更依赖', 409);
        const rows = await tx.query(
          "SELECT source_id,target_id FROM goal_relations WHERE kind='depends_on'",
        );
        const names = new Set<string>([
          id,
          input.target_id,
          ...rows.flatMap((r) => [r.source_id, r.target_id]),
        ]);
        validateDependencyGraph(
          [...names].map((name) => ({
            name,
            dependencies: [
              ...rows.filter((r) => r.source_id === name).map((r) => r.target_id),
              ...(name === id ? [input.target_id] : []),
            ],
          })),
        );
      }
      const relationId = ids('rel');
      await tx.query(
        'INSERT INTO goal_relations(id,source_id,target_id,kind,evidence,created_by) VALUES($1,$2,$3,$4,$5,$6)',
        [relationId, id, input.target_id, input.kind, input.evidence, user.id],
      );
      await this.event(tx, user, source.conversation_id, 'goal.related', {
        goal_id: id,
        relation_id: relationId,
        kind: input.kind,
      });
      return { id: relationId };
    });
    this.tasks.changes.emit('all');
    return result;
  }
  async detail(user: User, id: string) {
    const goal = await this.goal(this.db, user, id);
    const relations = await this.db.query(
      'SELECT r.*,g.title,g.state,g.conversation_id FROM goal_relations r JOIN collaboration_goals g ON g.id=r.target_id WHERE r.source_id=$1 ORDER BY r.created_at',
      [id],
    );
    const visible: Row[] = [];
    for (const r of relations) {
      try {
        await requireGroupAccess(this.db, user, r.conversation_id);
        visible.push(r);
      } catch {
        /* 不返回另一私群的 ID、标题或原文。 */
      }
    }
    const handoffs = await this.db.query(
      'SELECT h.*,u.name AS to_name FROM work_handoffs h JOIN users u ON u.id=h.to_user WHERE goal_id=$1 ORDER BY created_at DESC',
      [id],
    );
    const revisions = await this.db.query(
      'SELECT id,previous_version,reason,state,created_at FROM goal_revisions WHERE goal_id=$1 ORDER BY created_at DESC',
      [id],
    );
    const plans = await this.db.query(
      'SELECT * FROM execution_plans WHERE goal_id=$1 ORDER BY created_at DESC',
      [id],
    );
    const planIds = plans.map((p) => p.id);
    const steps = planIds.length
      ? await this.db.query(
          'SELECT s.*,t.state AS task_state FROM execution_steps s LEFT JOIN tasks t ON t.id=s.task_id WHERE plan_id=ANY($1::text[]) ORDER BY s.name',
          [planIds],
        )
      : [];
    for (const step of steps)
      if (step.task_id) step.task = await this.tasks.get(user, step.task_id);
    return {
      relations: visible,
      restricted_relations: relations.length - visible.length,
      handoffs,
      revisions,
      plans,
      steps,
      version: goal.version,
    };
  }
  async handoff(
    user: User,
    id: string,
    input: { to_user: string; note: string; expected_version: number },
  ) {
    return this.db.transaction(async (tx) => {
      await this.lock(tx);
      const row = await this.goal(tx, user, id, input.expected_version);
      if (row.state !== 'CLAIMED' || row.claimed_by !== user.id)
        throw new DomainError('CLAIM_CONFLICT', '只能交接自己当前认领的工作', 409);
      const group = await requireGroupAccess(
        tx,
        { ...user, id: input.to_user },
        row.conversation_id,
      );
      void group;
      if (
        input.to_user === user.id ||
        !(await tx.query('SELECT id FROM users WHERE id=$1 AND active', [input.to_user])).length
      )
        throw new DomainError('HANDOFF_TARGET', '接手成员不可用', 400);
      const key = ids('handoff');
      await tx.query(
        'INSERT INTO work_handoffs(id,goal_id,from_user,to_user,goal_version,note) VALUES($1,$2,$3,$4,$5,$6)',
        [key, id, user.id, input.to_user, row.version, input.note],
      );
      await this.event(tx, user, row.conversation_id, 'claim.handoff_proposed', {
        goal_id: id,
        handoff_id: key,
      });
      return { id: key };
    });
  }
  async resolveHandoff(user: User, id: string, accept: boolean) {
    const result = await this.db.transaction(async (tx) => {
      await this.lock(tx);
      const h = (await tx.query('SELECT * FROM work_handoffs WHERE id=$1 FOR UPDATE', [id]))[0];
      if (!h || h.to_user !== user.id || h.state !== 'pending')
        throw new DomainError('HANDOFF_UNAVAILABLE', '没有待你确认的交接', 404);
      const goal = await this.goal(tx, user, h.goal_id, h.goal_version);
      if (goal.state !== 'CLAIMED' || goal.claimed_by !== h.from_user)
        throw new DomainError('CLAIM_CONFLICT', '原认领已改变', 409);
      if (accept)
        await tx.query(
          "UPDATE collaboration_goals SET claimed_by=$1,version=version+1,reason='接手者已确认交接',updated_at=now() WHERE id=$2",
          [user.id, h.goal_id],
        );
      await tx.query('UPDATE work_handoffs SET state=$2,resolved_at=now() WHERE id=$1', [
        id,
        accept ? 'accepted' : 'rejected',
      ]);
      await this.event(tx, user, goal.conversation_id, 'claim.handoff_resolved', {
        handoff_id: id,
        accepted: accept,
      });
      return { ok: true };
    });
    this.tasks.changes.emit('all');
    return result;
  }
  async revision(
    user: User,
    id: string,
    input: {
      title: string;
      constraints: string[];
      acceptance: string[];
      reason: string;
      expected_version: number;
    },
  ) {
    const revision = await this.db.transaction(async (tx) => {
      await this.lock(tx);
      const row = await this.goal(tx, user, id, input.expected_version);
      if (row.group.archived_at) throw new DomainError('GROUP_ARCHIVED', '请先恢复群聊', 409);
      const key = ids('rev');
      await tx.query(
        'INSERT INTO goal_revisions(id,goal_id,previous_version,snapshot,proposal,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [key, id, row.version, JSON.stringify(row), JSON.stringify(input), input.reason, user.id],
      );
      await tx.query(
        "UPDATE collaboration_goals SET state='STOPPING',decision='STOP',reason='目标修订已提交，等待旧执行终结',version=version+1 WHERE id=$1",
        [id],
      );
      await this.event(tx, user, row.conversation_id, 'goal.revision_requested', {
        goal_id: id,
        revision_id: key,
      });
      return { id: key, task_id: row.task_id };
    });
    if (revision.task_id)
      await this.tasks.cancelForPolicy(revision.task_id, '目标版本已修订，停止旧输入执行');
    // 下游已经执行的工作也要停止；结果失效与历史执行成功是两种不同事实。
    const downstream = await this.db.query(
      "WITH RECURSIVE affected(id) AS (SELECT source_id FROM goal_relations WHERE target_id=$1 AND kind='depends_on' UNION SELECT r.source_id FROM goal_relations r JOIN affected a ON r.target_id=a.id WHERE r.kind='depends_on') SELECT g.id,g.task_id FROM affected a JOIN collaboration_goals g ON g.id=a.id",
      [id],
    );
    for (const row of downstream) {
      if (row.task_id)
        await this.tasks.cancelForPolicy(row.task_id, '上游目标修订，需要重新核对依赖');
      await this.db.query(
        "UPDATE collaboration_goals SET state='CLARIFYING',reason='上游发生修订，请重新确认依赖与验收',version=version+1 WHERE id=$1",
        [row.id],
      );
    }
    this.tasks.changes.emit('all');
    return { id: revision.id };
  }
  async applyRevisions() {
    await this.db.transaction(async (tx) => {
      await this.lock(tx);
      const rows = await tx.query(
        "SELECT r.*,g.task_id,g.version,g.state AS goal_state,g.conversation_id FROM goal_revisions r JOIN collaboration_goals g ON g.id=r.goal_id WHERE r.state='pending' FOR UPDATE OF r",
      );
      for (const row of rows) {
        if (
          row.version !== row.previous_version + 1 ||
          !['STOPPING', 'STOPPED', 'COMPLETED', 'FAILED'].includes(row.goal_state)
        )
          continue;
        if (
          row.task_id &&
          (
            await tx.query(
              "SELECT id FROM tasks WHERE id=$1 AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED','EXPIRED')",
              [row.task_id],
            )
          ).length
        )
          continue;
        const p = row.proposal;
        await tx.query(
          "UPDATE collaboration_goals SET title=$2,constraints=$3,acceptance=$4,state='CANDIDATE',decision=NULL,task_id=NULL,claimed_by=NULL,related_goal_id=NULL,reason='旧执行已终结，按新版本重新判断',version=version+1 WHERE id=$1",
          [row.goal_id, p.title, JSON.stringify(p.constraints), JSON.stringify(p.acceptance)],
        );
        await tx.query("UPDATE goal_revisions SET state='applied' WHERE id=$1", [row.id]);
        await tx.query(
          "UPDATE work_handoffs SET state='expired',resolved_at=now() WHERE goal_id=$1 AND state='pending'",
          [row.goal_id],
        );
        await tx.query(
          'INSERT INTO observation_jobs(id,conversation_id,actor_id,payload) VALUES($1,$2,$3,$4)',
          [
            ids('job'),
            row.conversation_id,
            row.created_by,
            JSON.stringify({
              explicit: true,
              goal_id: row.goal_id,
              version: row.version + 1,
              observation: {
                title: p.title,
                constraints: p.constraints,
                acceptance: p.acceptance,
                intent: 'request',
                question: null,
              },
            }),
          ],
        );
        await tx.query(
          "INSERT INTO domain_outbox(conversation_id,kind,payload) VALUES($1,'goal.revised',$2)",
          [row.conversation_id, JSON.stringify({ goal_id: row.goal_id })],
        );
      }
    });
  }
  async merge(
    user: User,
    id: string,
    target: string,
    version: number,
    targetVersion: number,
    reason: string,
  ) {
    return this.db.transaction(async (tx) => {
      await this.lock(tx);
      const source = await this.goal(tx, user, id, version);
      await this.goal(tx, user, target, targetVersion);
      if (id === target) throw new DomainError('MERGE_SAME', '不能合并自身', 400);
      const key = ids('merge');
      await tx.query(
        'INSERT INTO merge_proposals(id,source_id,target_id,source_version,target_version,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [key, id, target, version, targetVersion, reason, user.id],
      );
      await this.event(tx, user, source.conversation_id, 'goal.merge_proposed', {
        proposal_id: key,
      });
      return { id: key, state: 'proposed' };
    });
  }
  async coverage(user: User) {
    const rows = await this.db.query(
      "SELECT c.id,c.title,c.observed_seq,c.agent_policy,c.archived_at,coalesce((SELECT max(seq) FROM messages WHERE conversation_id=c.id),0)::int AS latest_seq FROM conversations c WHERE c.visibility='project' OR EXISTS(SELECT 1 FROM group_members m WHERE m.conversation_id=c.id AND m.user_id=$1)",
      [user.id],
    );
    return rows.map((r) => ({
      ...r,
      lag: Math.max(0, r.latest_seq - r.observed_seq),
      covered: r.agent_policy.observe && !r.archived_at,
    }));
  }
  async search(user: User, q: string) {
    const groups = await this.db.query(
      "SELECT c.id,c.title FROM conversations c WHERE strpos(lower(c.title),lower($2))>0 AND (c.visibility='project' OR EXISTS(SELECT 1 FROM group_members m WHERE m.conversation_id=c.id AND m.user_id=$1)) ORDER BY c.created_at DESC LIMIT 30",
      [user.id, q],
    );
    const goals = await this.db.query(
      "SELECT g.id,g.title,g.conversation_id,g.state FROM collaboration_goals g JOIN conversations c ON c.id=g.conversation_id WHERE strpos(lower(g.title),lower($2))>0 AND (c.visibility='project' OR EXISTS(SELECT 1 FROM group_members m WHERE m.conversation_id=c.id AND m.user_id=$1)) ORDER BY g.updated_at DESC LIMIT 50",
      [user.id, q],
    );
    return { groups, goals };
  }
  async events(user: User, after: number) {
    return this.db.query(
      "SELECT o.* FROM domain_outbox o JOIN conversations c ON c.id=o.conversation_id WHERE o.id>$2 AND (c.visibility='project' OR EXISTS(SELECT 1 FROM group_members m WHERE m.conversation_id=c.id AND m.user_id=$1)) ORDER BY o.id LIMIT 100",
      [user.id, after],
    );
  }
  async evaluate(
    user: User,
    input: {
      conversation_id: string;
      kind: string;
      synthetic: boolean;
      expected: string;
      actual: string;
      note: string;
    },
  ) {
    owner(user);
    await requireGroupAccess(this.db, user, input.conversation_id);
    const id = ids('eval');
    await this.db.query(
      'INSERT INTO evaluation_cases(id,conversation_id,kind,synthetic,expected,actual,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        id,
        input.conversation_id,
        input.kind,
        input.synthetic,
        input.expected,
        input.actual,
        input.note,
        user.id,
      ],
    );
    return { id };
  }
  async evaluations(user: User) {
    owner(user);
    return this.db.query(
      "SELECT e.* FROM evaluation_cases e JOIN conversations c ON c.id=e.conversation_id WHERE c.visibility='project' OR EXISTS(SELECT 1 FROM group_members m WHERE m.conversation_id=c.id AND m.user_id=$1) ORDER BY e.created_at DESC LIMIT 200",
      [user.id],
    );
  }
}
