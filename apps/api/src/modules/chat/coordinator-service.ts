import type { Database, SqlConnection, Row } from '@team-agent/database';
import type { User, Goal, GoalDetail, NodePolicy, TaskInput } from '@team-agent/contracts';
import {
  canonical,
  normalizedGoal,
  goalSimilarity,
  DomainError,
  mentionSafeText,
} from '@team-agent/domain';
import { ids, sha, iso, audit, owner } from '../../common/security.js';
import { requireGroupAccess } from '../../common/group-access.js';
import type { TaskService } from '../tasks/task-service.js';
import { CoordinatorModel, type Observation } from '@team-agent/agent-runtime';

export class CoordinatorService {
  readonly model = new CoordinatorModel();
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private abort = new AbortController();
  constructor(
    private db: Database,
    private tasks: TaskService,
  ) {}
  async start() {
    // 当前只支持一个主 API 实例；重启后重取未完成观察作业，不适用于多副本抢占。
    await this.db.query("UPDATE observation_jobs SET status='pending' WHERE status='processing'");
    this.timer = setInterval(() => this.wake(), 800);
    this.timer.unref();
    this.wake();
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
    await this.running;
  }
  wake() {
    // 定时器与消息通知可能同时触发，共用 running 避免同一实例重复取作业。
    if (this.running || this.abort.signal.aborted) return;
    this.running = this.tick()
      .catch(() => {})
      .finally(() => {
        this.running = undefined;
      });
  }
  async policy() {
    const r = (await this.db.query('SELECT * FROM coordinator_control WHERE id=true'))[0];
    return { policy: r.policy as NodePolicy, version: r.version as number };
  }
  /** 策略更新需版本匹配；更新后撤销旧任务许可，不能扩大既有执行权限。 */
  async setPolicy(user: User, input: NodePolicy & { expected_version: number }) {
    owner(user);
    const result = await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM coordinator_control WHERE id=true FOR UPDATE');
      if (input.enabled) {
        const devices = await tx.query('SELECT * FROM devices WHERE NOT revoked');
        const repo = devices
          .flatMap((d) => d.repositories)
          .find((r) => r.id === input.repository_id);
        if (!repo)
          throw new DomainError('REPOSITORY_UNAVAILABLE', '请先连接主设备并选择已绑定仓库');
        if (
          input.allow_edit &&
          (!repo.capabilities.includes('file_edit') || !repo.write_prefixes?.length)
        )
          throw new DomainError('WRITE_SCOPE_DENIED', '设备没有报告允许修改的目录', 403);
      }
      const { expected_version, ...policy } = input;
      const rows = await tx.query(
        'UPDATE coordinator_control SET policy=$1,version=version+1 WHERE id=true AND version=$2 RETURNING version',
        [JSON.stringify(policy), expected_version],
      );
      if (!rows.length) throw new DomainError('POLICY_STALE', '策略已被修改，请刷新');
      await audit(tx, user.id, 'node.policy', input.repository_id, {
        ...policy,
        version: rows[0].version,
      });
      return { policy, version: rows[0].version };
    });
    await this.tasks.revokeCoordinatorExecutions();
    return result;
  }
  private async record(
    tx: SqlConnection,
    id: string,
    actor: string,
    kind: string,
    detail: unknown = {},
  ) {
    await tx.query('INSERT INTO goal_events(goal_id,actor_id,kind,detail) VALUES($1,$2,$3,$4)', [
      id,
      actor,
      kind,
      JSON.stringify(detail),
    ]);
  }
  /** 标题相近不等于同一工作；去重键还绑定范围、验收、约束和代码基线。 */
  private key(title: string, scope: unknown, constraints: string[], acceptance: string[]) {
    return sha(
      canonical({
        title: normalizedGoal(title),
        scope,
        constraints: [...constraints].sort(),
        acceptance: [...acceptance].sort(),
      }),
    );
  }
  private async sync() {
    await this.db.query(
      "UPDATE collaboration_goals g SET state='CLARIFYING',reason='引用资料或原执行输入已变化，请补充当前版本并重新复核',version=g.version+1,updated_at=now() FROM tasks t WHERE t.id=g.task_id AND g.state='APPROVED' AND t.state='PENDING_APPROVAL'",
    );
    await this.db.query(
      "UPDATE collaboration_goals g SET state=CASE t.state WHEN 'SUCCEEDED' THEN 'COMPLETED' WHEN 'CANCELLED' THEN 'STOPPED' WHEN 'FAILED' THEN 'FAILED' WHEN 'EXPIRED' THEN 'FAILED' ELSE g.state END, updated_at=t.updated_at FROM tasks t WHERE t.id=g.task_id AND g.state IN ('APPROVED','STOPPING') AND t.state IN ('SUCCEEDED','CANCELLED','FAILED','EXPIRED')",
    );
  }
  async goals(user: User, groupId: string): Promise<Goal[]> {
    await requireGroupAccess(this.db, user, groupId);
    await this.sync();
    const rows = await this.db.query(
      'SELECT g.*,u.name AS assignee_name,t.state AS task_state FROM collaboration_goals g LEFT JOIN users u ON u.id=g.claimed_by LEFT JOIN tasks t ON t.id=g.task_id WHERE g.conversation_id=$1 ORDER BY g.created_at DESC,g.id LIMIT 100',
      [groupId],
    );
    return Promise.all(rows.map((r) => this.project(user, r)));
  }
  private async project(user: User, row: Row): Promise<Goal> {
    const result = {
      ...row,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    } as Goal;
    // 私群信息不能出现在隐藏 DOM 或事件载荷中；投影时连目标 ID 也必须移除。
    if (row.related_goal_id) {
      const related = (
        await this.db.query(
          "SELECT g.id,g.title FROM collaboration_goals g JOIN conversations c ON c.id=g.conversation_id WHERE g.id=$1 AND (c.visibility='project' OR EXISTS(SELECT 1 FROM group_members m WHERE m.conversation_id=c.id AND m.user_id=$2))",
          [row.related_goal_id, user.id],
        )
      )[0];
      if (related) result.related = related as Goal['related'];
      else {
        result.related_goal_id = null;
        result.restricted_relation = true;
        result.reason =
          '存在已登记的相关工作，详细依据受权限限制；请补充差异或联系相关负责者协调。';
      }
    }
    // 规范键和原始范围仅用于服务端协调，不作为其他私群可见的依据返回。
    delete (result as any).canonical_key;
    delete (result as any).scope;
    return result;
  }
  private async row(user: User, id: string, tx: SqlConnection = this.db) {
    const r = (await tx.query('SELECT * FROM collaboration_goals WHERE id=$1', [id]))[0];
    if (!r) throw new DomainError('NOT_FOUND', '协作目标不存在', 404);
    await requireGroupAccess(tx, user, r.conversation_id);
    return r;
  }
  async detail(user: User, id: string): Promise<GoalDetail> {
    const r = await this.row(user, id);
    await this.sync();
    const events = await this.db.query(
      'SELECT id,kind,detail,created_at FROM goal_events WHERE goal_id=$1 ORDER BY id DESC LIMIT 100',
      [id],
    );
    return {
      goal: await this.project(
        user,
        (
          await this.db.query(
            'SELECT g.*,u.name AS assignee_name,t.state AS task_state FROM collaboration_goals g LEFT JOIN users u ON u.id=g.claimed_by LEFT JOIN tasks t ON t.id=g.task_id WHERE g.id=$1',
            [id],
          )
        )[0],
      ),
      events: events.map((e) => ({
        ...e,
        id: Number(e.id),
        created_at: iso(e.created_at),
      })) as GoalDetail['events'],
      task: r.task_id ? await this.tasks.get(user, r.task_id) : null,
    };
  }
  async claim(user: User, id: string, version: number) {
    await this.sync();
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM coordinator_control WHERE id=true FOR UPDATE');
      const row = await this.row(user, id, tx);
      if (row.version !== version) throw new DomainError('GOAL_STALE', '目标已变化，请刷新');
      if (!['CANDIDATE', 'CLARIFYING'].includes(row.state))
        throw new DomainError('CLAIM_CONFLICT', '该目标不能认领');
      const duplicate = (
        await tx.query(
          "SELECT id FROM collaboration_goals WHERE canonical_key=$1 AND id<>$2 AND state IN ('CLAIMED','APPROVED','COMPLETED','STOPPING')",
          [row.canonical_key, id],
        )
      )[0];
      if (duplicate) throw new DomainError('CLAIM_CONFLICT', '已有相关工作在推进，请先明确分工');
      await tx.query(
        "UPDATE collaboration_goals SET state='CLAIMED',claimed_by=$1,decision=NULL,reason='成员已确认人工认领，Agent 不再重复执行此范围',version=version+1,updated_at=now() WHERE id=$2",
        [user.id, id],
      );
      await this.record(tx, id, user.id, 'work.claimed');
    });
    this.tasks.changes.emit('all');
    return { ok: true };
  }
  async complete(user: User, id: string, version: number, evidence: string) {
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM coordinator_control WHERE id=true FOR UPDATE');
      const row = await this.row(user, id, tx);
      if (row.version !== version || row.state !== 'CLAIMED' || row.claimed_by !== user.id)
        throw new DomainError('CLAIM_CONFLICT', '只能完成自己当前认领的目标');
      await tx.query(
        "UPDATE collaboration_goals SET state='COMPLETED',reason=$1,version=version+1,updated_at=now() WHERE id=$2",
        ['成员自报完成，待团队核验：' + evidence, id],
      );
      await this.record(tx, id, user.id, 'work.completed', {
        evidence,
        verification: 'self_reported',
      });
    });
    this.tasks.changes.emit('all');
    return { ok: true };
  }
  async review(
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
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM coordinator_control WHERE id=true FOR UPDATE');
      const row = await this.row(user, id, tx);
      if (row.version !== input.expected_version)
        throw new DomainError('GOAL_STALE', '目标已变化，请刷新');
      if (!['REJECTED', 'CANDIDATE', 'CLARIFYING', 'FAILED', 'STOPPED'].includes(row.state))
        throw new DomainError('GOAL_ACTIVE', '请先停止或完成人工／Agent 的有效占用');
      await tx.query(
        "UPDATE collaboration_goals SET title=$1,constraints=$2,acceptance=$3,state='CANDIDATE',decision=NULL,related_goal_id=NULL,task_id=NULL,reason='成员已补充差异，等待重新判断',version=version+1,updated_at=now() WHERE id=$4",
        [input.title, JSON.stringify(input.constraints), JSON.stringify(input.acceptance), id],
      );
      await this.record(tx, id, user.id, 'goal.reviewed', {
        reason: input.reason,
        previous_version: row.version,
      });
      await tx.query(
        'INSERT INTO observation_jobs(id,conversation_id,actor_id,payload) VALUES($1,$2,$3,$4)',
        [
          ids('job'),
          row.conversation_id,
          user.id,
          JSON.stringify({
            explicit: true,
            goal_id: id,
            version: row.version + 1,
            observation: {
              title: input.title,
              constraints: input.constraints,
              acceptance: input.acceptance,
              intent: 'request',
              question: null,
            },
          }),
        ],
      );
    });
    this.wake();
    return { ok: true };
  }
  async stop(user: User, id: string, reason: string, key: string) {
    const taskId = await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM coordinator_control WHERE id=true FOR UPDATE');
      const row = await this.row(user, id, tx);
      if (['COMPLETED', 'FAILED', 'REJECTED', 'STOPPED'].includes(row.state)) return null;
      await tx.query(
        "UPDATE collaboration_goals SET state=$1,decision='STOP',reason=$2,version=version+1,updated_at=now() WHERE id=$3",
        [row.task_id ? 'STOPPING' : 'STOPPED', reason, id],
      );
      await this.record(tx, id, user.id, 'execution.stop_requested', { reason });
      return row.task_id as string | null;
    });
    if (taskId) await this.tasks.cancel(user, taskId, reason, key);
    this.tasks.changes.emit('all');
    return { ok: true };
  }
  async retry(user: User, id: string) {
    await requireGroupAccess(this.db, user, id);
    await this.db.query(
      "UPDATE observation_jobs SET status='pending',error_code=NULL WHERE conversation_id=$1 AND status='error'",
      [id],
    );
    this.wake();
    return { ok: true };
  }
  private async tick() {
    await this.sync();
    const job = await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM coordinator_control WHERE id=true FOR UPDATE');
      if (
        (await tx.query("SELECT id FROM observation_jobs WHERE status='processing' LIMIT 1")).length
      )
        return;
      const row = (
        await tx.query(
          "SELECT * FROM observation_jobs WHERE status='pending' ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",
        )
      )[0];
      if (row)
        await tx.query(
          "UPDATE observation_jobs SET status='processing',updated_at=now() WHERE id=$1",
          [row.id],
        );
      return row;
    });
    if (!job) return;
    try {
      await this.process(job);
    } catch (error) {
      await this.db.query(
        "UPDATE observation_jobs SET status='error',error_code=$1,updated_at=now() WHERE id=$2",
        [error instanceof DomainError ? error.code : 'OBSERVATION_FAILED', job.id],
      );
    }
    this.tasks.changes.emit('all');
  }
  private async process(job: Row) {
    const user = (
      await this.db.query('SELECT id,email,name,role FROM users WHERE id=$1 AND active', [
        job.actor_id,
      ])
    )[0] as User | undefined;
    if (!user) throw new DomainError('ACTOR_REMOVED', '发起成员已失效');
    await requireGroupAccess(this.db, user, job.conversation_id);
    const message = job.message_id
      ? (await this.db.query('SELECT * FROM messages WHERE id=$1', [job.message_id]))[0]
      : null;
    const group = await requireGroupAccess(this.db, user, job.conversation_id);
    if (
      group.archived_at ||
      (!job.payload.explicit &&
        (!group.agent_policy.observe || group.agent_policy.mode === 'passive'))
    ) {
      await this.db.transaction((tx) => this.finishJob(tx, job, message));
      return;
    }
    const safe = mentionSafeText(message?.body || '');
    if (job.payload.explicit) {
      const stopText = /^\s*@AI\s+(?:停止|叫停)[：:\s]+(.+?)\s*$/i.exec(safe);
      if (stopText) {
        const candidates = await this.db.query(
          'SELECT * FROM collaboration_goals WHERE conversation_id=$1',
          [job.conversation_id],
        );
        const targets = candidates.filter(
          (g) => g.id === stopText[1] || normalizedGoal(g.title) === normalizedGoal(stopText[1]),
        );
        if (targets.length === 1) {
          await this.stop(user, targets[0].id, '成员在群内明确要求停止原目标', job.id);
          await this.db.transaction((tx) => this.finishJob(tx, job, message));
          return;
        }
      }
    }
    let engine: 'rules' | 'model' = 'rules';
    let modelWork: Row[] = [];
    let observation: Observation = job.payload.observation || {
      title: safe.replace(/^\s*@AI\s*/i, '').replace(/^(我来做|我负责|我来处理)[：:\s]*/, ''),
      intent: job.payload.explicit
        ? 'request'
        : /^\s*(我来做|我负责|我来处理)/.test(safe)
          ? 'candidate'
          : 'none',
      constraints: [],
      acceptance: [],
      question: null,
    };
    if (!job.payload.observation && this.model.configured) {
      const recent = await this.db.query(
        'SELECT u.name AS author_name,left(m.body,2500) AS body FROM messages m JOIN users u ON u.id=m.author_id WHERE conversation_id=$1 AND seq<=$2 ORDER BY seq DESC LIMIT 20',
        [job.conversation_id, message?.seq ?? 0],
      );
      const work = await this.db.query(
        "SELECT g.id,g.title,g.constraints,g.acceptance,g.version,g.scope,g.state FROM collaboration_goals g JOIN conversations c ON c.id=g.conversation_id WHERE g.state IN ('CLAIMED','APPROVED','COMPLETED','STOPPING') AND (c.visibility='project' OR EXISTS(SELECT 1 FROM group_members m WHERE m.conversation_id=c.id AND m.user_id=$1)) ORDER BY g.updated_at DESC LIMIT 50",
        [user.id],
      );
      let size = 0;
      modelWork = work.filter((g) => {
        size += JSON.stringify(g).length;
        return size <= 20000;
      });
      observation = await this.model.observe(
        recent.reverse() as any,
        AbortSignal.any([this.abort.signal, AbortSignal.timeout(25000)]),
        modelWork,
        async (usage) => {
          await this.db.query(
            "INSERT INTO model_usage(conversation_id,layer,model,input_tokens,output_tokens) VALUES($1,'observation',$2,$3,$4)",
            [
              job.conversation_id,
              process.env.COORDINATOR_MODEL || 'unknown',
              usage.input_tokens,
              usage.output_tokens,
            ],
          );
        },
      );
      engine = 'model';
    }
    // 模型可以建议目标，但只有已落盘的明确用户触发才代表委托执行。
    const explicit = !!job.payload.explicit;
    await this.db.transaction(async (tx) => {
      const control = (
        await tx.query('SELECT * FROM coordinator_control WHERE id=true FOR UPDATE')
      )[0];
      await requireGroupAccess(tx, user, job.conversation_id);
      const old = job.payload.goal_id ? await this.row(user, job.payload.goal_id, tx) : null;
      if (old && (old.version !== job.payload.version || old.state !== 'CANDIDATE')) {
        await tx.query("UPDATE observation_jobs SET status='done' WHERE id=$1", [job.id]);
        return;
      }
      if (observation.intent === 'none' && !explicit) {
        await this.finishJob(tx, job, message);
        return;
      }
      const policy = control.policy as NodePolicy;
      const devices = await tx.query('SELECT * FROM devices WHERE NOT revoked');
      const device = devices.find((d) =>
        d.repositories.some((r: any) => r.id === policy.repository_id),
      );
      const repo = device?.repositories.find((r: any) => r.id === policy.repository_id);
      const edit = /修改|实现|编写|新增|删除|重构|开发|修复|创建|写入|替换|重命名/.test(
        observation.title,
      );
      const clearlyReadOnly = /分析|检查|审查|梳理|列出|风险|读取|汇总/.test(observation.title);
      const profile = edit ? 'code_edit' : 'code_review';
      const scope = {
        repository_id: repo?.id || 'unbound',
        base_commit: repo?.base_commit || 'unbound',
        profile,
        source_refs: [...(job.payload.source_refs || old?.source_refs || [])].sort((a, b) =>
          a.source_id.localeCompare(b.source_id),
        ),
      };
      const acceptance = observation.acceptance.length
        ? observation.acceptance
        : ['产出与目标对应的可核查报告，未执行的检查需明确说明'];
      const constraints = observation.constraints;
      const title = observation.title.trim().slice(0, 2000) || '待澄清的协作目标';
      let canonicalKey = this.key(title, scope, constraints, acceptance);
      const occupied = await tx.query(
        "SELECT g.* FROM collaboration_goals g LEFT JOIN tasks t ON t.id=g.task_id WHERE g.id<>$1 AND g.state IN ('CLAIMED','APPROVED','COMPLETED','STOPPING') AND (g.task_id IS NULL OR t.state NOT IN ('FAILED','CANCELLED','EXPIRED')) ORDER BY g.created_at LIMIT 1000",
        [old?.id || ''],
      );
      let exact = (
        await tx.query(
          "SELECT g.* FROM collaboration_goals g LEFT JOIN tasks t ON t.id=g.task_id WHERE g.canonical_key=$1 AND g.id<>$2 AND g.state IN ('CLAIMED','APPROVED','COMPLETED','STOPPING') AND (g.task_id IS NULL OR t.state NOT IN ('FAILED','CANCELLED','EXPIRED')) LIMIT 1",
          [canonicalKey, old?.id || ''],
        )
      )[0];
      const hint = observation.match;
      const modelCandidate =
        hint && modelWork.some((g) => g.id === hint.goal_id)
          ? occupied.find(
              (g) =>
                g.id === hint.goal_id &&
                modelWork.some((m) => m.id === g.id && m.version === g.version),
            )
          : undefined;
      // 即使模型认为语义相同，也不能抹去范围、验收或约束中的明确差异。
      if (
        !exact &&
        modelCandidate &&
        hint?.relation === 'same' &&
        !hint.differences.length &&
        canonical(modelCandidate.scope) === canonical(scope) &&
        canonical([...modelCandidate.constraints].sort()) === canonical([...constraints].sort()) &&
        canonical([...modelCandidate.acceptance].sort()) === canonical([...acceptance].sort())
      ) {
        exact = modelCandidate;
        canonicalKey = modelCandidate.canonical_key;
      }
      const similar =
        (modelCandidate && hint?.relation !== 'different' ? modelCandidate : undefined) ||
        occupied.find(
          (g) =>
            normalizedGoal(g.title) === normalizedGoal(title) ||
            goalSimilarity(g.title, title) > 0.58,
        );
      const reviewedDifference = !!(
        old &&
        similar &&
        job.payload.observation &&
        (canonical(similar.scope) !== canonical(scope) ||
          canonical([...similar.constraints].sort()) !== canonical([...constraints].sort()) ||
          canonical([...similar.acceptance].sort()) !== canonical([...acceptance].sort()))
      );
      let state = 'CANDIDATE',
        decision: string | null = null,
        related: string | null = null,
        reason = '从讨论识别的目标候选，等待成员确认认领或委托 Agent',
        taskId: string | null = null;
      if (explicit) {
        if (exact) {
          state = 'REJECTED';
          decision = 'REJECT';
          related = exact.id;
          reason = '已有有效人工认领、Agent 执行或已完成成果，本次不重复启动。';
        } else if (similar && !reviewedDifference) {
          state = 'CLARIFYING';
          related = similar.id;
          reason = '存在相近工作，请补充验收或范围差异；相似度只用于提示，不直接拒绝。';
        } else if (title.length < 4 || observation.question) {
          state = 'CLARIFYING';
          reason = observation.question || '请补充具体目标及验收方式。';
        } else if (!policy.enabled || !repo) {
          state = 'CLARIFYING';
          reason = '目标已记录。主设备尚未配置自动执行策略，请维护者连接设备并配置后在此复核。';
        } else if (!edit && !clearlyReadOnly) {
          state = 'CLARIFYING';
          reason = '请明确这是只读分析还是代码修改，并补充可核查的验收条件。';
        } else if (edit && (!policy.allow_edit || !observation.acceptance.length)) {
          state = 'CLARIFYING';
          reason = '此目标涉及代码修改，请明确验收，并由维护者预设允许修改的能力与目录。';
        } else {
          const input: TaskInput = {
            conversation_id: job.conversation_id,
            conversation_cutoff_seq: message?.seq,
            goal: title,
            constraints,
            acceptance,
            source_refs: job.payload.source_refs || old?.source_refs || [],
            memory_refs: [],
            repository_binding_id: repo.id,
            base_commit: repo.base_commit,
            execution_profile: profile,
            budget: {
              wall_time_seconds: policy.wall_time_seconds,
              max_model_calls: policy.max_model_calls,
            },
          };
          taskId = await this.tasks.queueFromCoordinator(user, input, tx);
          state = 'APPROVED';
          decision = 'APPROVE';
          reason = '已比对项目已登记工作，按主设备预设策略批准；执行器将串行领取，离线时保留排队。';
        }
      }
      const id = old?.id || ids('goal');
      if (old)
        await tx.query(
          'UPDATE collaboration_goals SET title=$1,constraints=$2,acceptance=$3,canonical_key=$4,scope=$5,state=$6,decision=$7,reason=$8,related_goal_id=$9,task_id=$10,engine=$11,updated_at=now() WHERE id=$12',
          [
            title,
            JSON.stringify(constraints),
            JSON.stringify(acceptance),
            canonicalKey,
            JSON.stringify(scope),
            state,
            decision,
            reason,
            related,
            taskId,
            engine,
            id,
          ],
        );
      else
        await tx.query(
          'INSERT INTO collaboration_goals(id,conversation_id,message_id,title,constraints,acceptance,canonical_key,scope,state,decision,reason,related_goal_id,task_id,engine) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
          [
            id,
            job.conversation_id,
            job.message_id,
            title,
            JSON.stringify(constraints),
            JSON.stringify(acceptance),
            canonicalKey,
            JSON.stringify(scope),
            state,
            decision,
            reason,
            related,
            taskId,
            engine,
          ],
        );
      await tx.query('UPDATE collaboration_goals SET source_refs=$1 WHERE id=$2', [
        JSON.stringify(job.payload.source_refs || old?.source_refs || []),
        id,
      ]);
      await this.record(tx, id, 'node:coordinator', explicit ? 'goal.decided' : 'goal.observed', {
        decision,
        state,
        engine,
        policy_version: control.version,
      });
      await this.finishJob(tx, job, message);
    });
    this.tasks.onQueued();
  }
  /** 观察水位只能推进到连续完成的位置，不能越过失败或待处理消息。 */
  private async finishJob(tx: SqlConnection, job: Row, message: Row | null) {
    await tx.query(
      "UPDATE observation_jobs SET status='done',updated_at=now(),error_code=NULL WHERE id=$1",
      [job.id],
    );
    if (message)
      await tx.query(
        "UPDATE conversations SET observed_seq=greatest(observed_seq,coalesce((SELECT min(m.seq)-1 FROM observation_jobs j JOIN messages m ON m.id=j.message_id WHERE j.conversation_id=$1 AND j.status<>'done'),(SELECT coalesce(max(seq),0) FROM messages WHERE conversation_id=$1))) WHERE id=$1",
        [job.conversation_id],
      );
  }
}
