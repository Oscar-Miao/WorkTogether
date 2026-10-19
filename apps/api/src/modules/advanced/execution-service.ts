import type { Database, Row } from '@team-agent/database';
import type { User } from '@team-agent/contracts';
import {
  DomainError,
  validateDependencyGraph,
  canonical,
  normalizedGoal,
} from '@team-agent/domain';
import { owner, ids, audit, sha } from '../../common/security.js';
import type { TaskService } from '../tasks/task-service.js';
import type { AdvancedCollaboration } from './collaboration-service.js';

/** 持久步骤计划：只调度已授权的工具能力，失败和未知效果都不会自动重跑。 */
export class AdvancedExecution {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  constructor(
    private db: Database,
    private tasks: TaskService,
    private collaboration: AdvancedCollaboration,
  ) {}
  start() {
    this.timer = setInterval(() => this.wake(), 800);
    this.timer.unref();
    this.wake();
  }
  wake() {
    if (this.running || this.stopped) return;
    this.running = this.tick()
      .catch((error) => console.error('[进阶调度]', error?.code || error?.name || '执行失败'))
      .finally(() => {
        this.running = undefined;
      });
  }
  async close() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
  async limits() {
    return (await this.db.query('SELECT * FROM execution_limits WHERE id=true'))[0];
  }
  async setLimits(user: User, devices: number, parallel: number) {
    owner(user);
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM coordinator_control WHERE id=true FOR UPDATE');
      const active = (await tx.query('SELECT count(*)::int AS n FROM devices WHERE NOT revoked'))[0]
        .n;
      const unresolved = (
        await tx.query(
          "SELECT count(*)::int AS n FROM execution_attempts WHERE status IN ('dispatching','running','cancelling','uncertain')",
        )
      )[0].n;
      if (active > devices || unresolved > parallel)
        throw new DomainError('CAPACITY_IN_USE', '请先核清活动设备和执行，再降低配额', 409);
      await tx.query('UPDATE execution_limits SET max_devices=$1,max_parallel=$2 WHERE id=true', [
        devices,
        parallel,
      ]);
      await audit(tx, user.id, 'execution.limits_changed', 'project', { devices, parallel });
    });
    return { ok: true };
  }
  async leadership() {
    return (await this.db.query('SELECT * FROM coordinator_leadership WHERE id=true'))[0];
  }
  async bind(user: User, nodeId: string, expectedEpoch: number) {
    owner(user);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM coordinator_control WHERE id=true FOR UPDATE');
      const leadership = (
        await tx.query('SELECT * FROM coordinator_leadership WHERE id=true FOR UPDATE')
      )[0];
      if (leadership.epoch !== expectedEpoch)
        throw new DomainError('LEADERSHIP_STALE', '领导代次已变化', 409);
      if (!(await tx.query('SELECT id FROM devices WHERE id=$1 AND NOT revoked', [nodeId])).length)
        throw new DomainError('DEVICE_UNAVAILABLE', '设备未注册', 404);
      if (
        leadership.node_id !== nodeId &&
        (
          await tx.query(
            "SELECT id FROM execution_attempts WHERE status IN ('dispatching','running','cancelling','uncertain')",
          )
        ).length
      )
        throw new DomainError(
          'EXECUTION_UNCERTAIN',
          '原执行未核清，只能恢复观察，不能切换执行领导权',
          409,
        );
      if (leadership.node_id === nodeId) {
        return (
          await tx.query(
            "UPDATE coordinator_leadership SET lease_until=now()+interval '40 seconds' WHERE id=true RETURNING *",
          )
        )[0];
      }
      const row = (
        await tx.query(
          "UPDATE coordinator_leadership SET node_id=$1,epoch=epoch+1,lease_until=now()+interval '40 seconds' WHERE id=true RETURNING *",
          [nodeId],
        )
      )[0];
      // 切换代次使所有旧排队许可失效；活动未知执行在上面的检查中保留。
      await tx.query("UPDATE tasks SET state='EXPIRED',version=version+1 WHERE state='QUEUED'");
      await audit(tx, user.id, 'leadership.changed', nodeId, { epoch: row.epoch });
      return row;
    });
  }
  async createPlan(
    user: User,
    goalId: string,
    input: {
      expected_version: number;
      steps: { name: string; goal: string; repository_id: string; dependencies: string[] }[];
    },
  ) {
    owner(user);
    validateDependencyGraph(input.steps);
    const result = await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM coordinator_control WHERE id=true FOR UPDATE');
      const goal = await this.collaboration.goal(tx, user, goalId, input.expected_version);
      if (!['CANDIDATE', 'CLARIFYING'].includes(goal.state))
        throw new DomainError('GOAL_ACTIVE', '只能为尚未执行的目标建立分工计划', 409);
      const control = (await tx.query('SELECT * FROM coordinator_control WHERE id=true'))[0];
      if (!control.policy.enabled)
        throw new DomainError('POLICY_DISABLED', '请先启用主设备执行策略', 409);
      const devices = await tx.query('SELECT repositories FROM devices WHERE NOT revoked');
      for (const step of input.steps)
        if (!devices.some((d) => d.repositories.some((r: any) => r.id === step.repository_id)))
          throw new DomainError('REPOSITORY_UNAVAILABLE', '计划引用了未连接的仓库', 409);
      const id = ids('plan');
      await tx.query(
        "INSERT INTO execution_plans(id,goal_id,goal_version,state,created_by) VALUES($1,$2,$3,'running',$4)",
        [id, goalId, goal.version + 1, user.id],
      );
      const effectCache = new Map<string, string>();
      const effectFor = (name: string): string => {
        if (effectCache.has(name)) return effectCache.get(name)!;
        const step = input.steps.find((s) => s.name === name)!;
        const repository = devices
          .flatMap((d) => d.repositories)
          .find((r: any) => r.id === step.repository_id);
        const hash = sha(
          canonical({
            goal: normalizedGoal(step.goal),
            repository_id: step.repository_id,
            base_commit: repository.base_commit,
            constraints: [...goal.constraints].sort(),
            acceptance: [...goal.acceptance].sort(),
            source_refs: [...(goal.source_refs || [])].sort((a: any, b: any) =>
              a.source_id.localeCompare(b.source_id),
            ),
            dependency_effects: [...new Set(step.dependencies.map(effectFor))].sort(),
          }),
        );
        effectCache.set(name, hash);
        return hash;
      };
      for (const step of input.steps) {
        const repository = devices
          .flatMap((d) => d.repositories)
          .find((r: any) => r.id === step.repository_id);
        const effect = effectFor(step.name);
        if (
          (
            await tx.query(
              "SELECT id FROM execution_steps WHERE effect_key=$1 AND state IN ('waiting','running','completed')",
              [effect],
            )
          ).length
        )
          throw new DomainError(
            'STEP_ALREADY_CLAIMED',
            '已有相同范围的步骤，请关联成果或说明差异',
            409,
          );
        await tx.query(
          'INSERT INTO execution_steps(id,plan_id,name,input,dependencies,effect_key) VALUES($1,$2,$3,$4,$5,$6)',
          [
            ids('step'),
            id,
            step.name,
            JSON.stringify({
              goal: step.goal,
              repository_id: step.repository_id,
              policy_version: control.version,
              base_commit: repository.base_commit,
            }),
            JSON.stringify(step.dependencies),
            effect,
          ],
        );
      }
      await tx.query(
        "UPDATE collaboration_goals SET state='APPROVED',decision='APPROVE',version=version+1,reason='成员提交了受策略约束的分工计划，等待各步骤与集成核验' WHERE id=$1",
        [goalId],
      );
      await this.collaboration.event(tx, user, goal.conversation_id, 'plan.created', {
        goal_id: goalId,
        plan_id: id,
      });
      return { id };
    });
    this.wake();
    return result;
  }
  async verify(user: User, planId: string, evidence: string) {
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM coordinator_control WHERE id=true FOR UPDATE');
      const plan = (
        await tx.query('SELECT * FROM execution_plans WHERE id=$1 FOR UPDATE', [planId])
      )[0];
      if (!plan) throw new DomainError('NOT_FOUND', '计划不存在', 404);
      const goal = await this.collaboration.goal(tx, user, plan.goal_id);
      if (plan.state !== 'awaiting_verification' || goal.version !== plan.goal_version)
        throw new DomainError('PLAN_UNVERIFIED', '步骤尚未全部结束或目标已修订', 409);
      await tx.query("UPDATE execution_plans SET state='verified' WHERE id=$1", [planId]);
      await tx.query(
        "UPDATE collaboration_goals SET state='COMPLETED',reason=$2,version=version+1 WHERE id=$1",
        [goal.id, '成员确认集成结果，非自动测试证明：' + evidence],
      );
      await this.collaboration.event(tx, user, goal.conversation_id, 'plan.verified', {
        plan_id: planId,
        evidence,
        verification: 'human_confirmed',
      });
      this.tasks.changes.emit('all');
      return { ok: true };
    });
  }
  private async tick() {
    await this.collaboration.applyRevisions();
    const plans = await this.db.query(
      "SELECT p.*,g.conversation_id,g.version,g.state AS goal_state FROM execution_plans p JOIN collaboration_goals g ON g.id=p.goal_id WHERE p.state='running' ORDER BY p.created_at",
    );
    for (const plan of plans) {
      let cancel: string[] = [];
      await this.db.transaction(async (tx) => {
        await tx.query('SELECT id FROM coordinator_control WHERE id=true FOR UPDATE');
        const current = (
          await tx.query(
            'SELECT p.*,g.version,g.state AS goal_state FROM execution_plans p JOIN collaboration_goals g ON g.id=p.goal_id WHERE p.id=$1 FOR UPDATE OF p',
            [plan.id],
          )
        )[0];
        if (current.state !== 'running') return;
        const steps = await tx.query(
          'SELECT s.*,t.state AS task_state FROM execution_steps s LEFT JOIN tasks t ON t.id=s.task_id WHERE plan_id=$1 ORDER BY s.name',
          [plan.id],
        );
        if (current.version !== current.goal_version || current.goal_state !== 'APPROVED') {
          await tx.query("UPDATE execution_plans SET state='cancelled' WHERE id=$1", [plan.id]);
          cancel = steps
            .filter(
              (s) =>
                s.task_id &&
                !['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(s.task_state),
            )
            .map((s) => s.task_id);
          return;
        }
        for (const s of steps) {
          if (s.task_state === 'SUCCEEDED') s.state = 'completed';
          else if (['FAILED', 'CANCELLED', 'EXPIRED'].includes(s.task_state)) s.state = 'failed';
          await tx.query('UPDATE execution_steps SET state=$2 WHERE id=$1', [s.id, s.state]);
        }
        const policy = (await tx.query('SELECT * FROM coordinator_control WHERE id=true'))[0];
        const person = (
          await tx.query('SELECT id,email,name,role FROM users WHERE id=$1 AND active', [
            plan.created_by,
          ])
        )[0] as User | undefined;
        if (!person || !policy.policy.enabled) {
          for (const s of steps) if (s.task_id) cancel.push(s.task_id);
          await tx.query("UPDATE execution_plans SET state='blocked' WHERE id=$1", [plan.id]);
          return;
        }
        for (const step of steps) {
          if (step.state !== 'waiting') continue;
          const dependencies = step.dependencies.map((name: string) =>
            steps.find((s) => s.name === name),
          );
          if (dependencies.some((s: Row) => ['failed', 'blocked'].includes(s.state))) {
            await tx.query("UPDATE execution_steps SET state='blocked' WHERE id=$1", [step.id]);
            continue;
          }
          if (!dependencies.every((s: Row) => s.state === 'completed')) continue;
          if (policy.version !== step.input.policy_version) {
            await tx.query(
              "UPDATE execution_steps SET state='blocked',error_code='POLICY_STALE' WHERE id=$1",
              [step.id],
            );
            continue;
          }
          const devices = await tx.query('SELECT repositories FROM devices WHERE NOT revoked');
          const repo = devices
            .flatMap((d) => d.repositories)
            .find((r) => r.id === step.input.repository_id);
          if (!repo || repo.base_commit !== step.input.base_commit) {
            await tx.query(
              "UPDATE execution_steps SET state='blocked',error_code='REPOSITORY_UNAVAILABLE' WHERE id=$1",
              [step.id],
            );
            continue;
          }
          const goal = (
            await tx.query('SELECT * FROM collaboration_goals WHERE id=$1', [plan.goal_id])
          )[0];
          const dependencyIds = dependencies.map((s: Row) => s.task_id).filter(Boolean);
          const artifacts = dependencyIds.length
            ? await tx.query(
                "SELECT id FROM artifacts WHERE task_id=ANY($1::text[]) AND kind='report' AND published AND purged_at IS NULL",
                [dependencyIds],
              )
            : [];
          if (dependencyIds.length && artifacts.length < dependencyIds.length) {
            await tx.query(
              "UPDATE execution_steps SET state='blocked',error_code='DEPENDENCY_EVIDENCE_MISSING' WHERE id=$1",
              [step.id],
            );
            continue;
          }
          // 首版计划步骤只提供只读分析。写入仍通过原目标的明确编辑策略，避免计划扩大能力。
          let taskId: string;
          try {
            taskId = await this.tasks.queueFromCoordinator(
              person,
              {
                conversation_id: plan.conversation_id,
                goal: step.input.goal,
                constraints: [
                  ...goal.constraints,
                  ...(artifacts.length
                    ? ['上游报告仅是待核查证据，未运行的测试不得宣称通过。']
                    : []),
                ],
                acceptance: goal.acceptance,
                repository_binding_id: repo.id,
                base_commit: repo.base_commit,
                execution_profile: 'code_review',
                source_refs: goal.source_refs || [],
                memory_refs: [],
                dependency_artifact_refs: artifacts.map((a) => a.id),
                budget: {
                  wall_time_seconds: policy.policy.wall_time_seconds,
                  max_model_calls: policy.policy.max_model_calls,
                },
              },
              tx,
            );
          } catch (error) {
            if (!(error instanceof DomainError)) throw error;
            await tx.query("UPDATE execution_steps SET state='blocked',error_code=$2 WHERE id=$1", [
              step.id,
              error.code,
            ]);
            continue;
          }
          await tx.query("UPDATE execution_steps SET state='running',task_id=$2 WHERE id=$1", [
            step.id,
            taskId,
          ]);
        }
        const states = (
          await tx.query('SELECT state FROM execution_steps WHERE plan_id=$1', [plan.id])
        ).map((s) => s.state);
        if (states.every((s) => s === 'completed'))
          await tx.query("UPDATE execution_plans SET state='awaiting_verification' WHERE id=$1", [
            plan.id,
          ]);
        else if (states.every((s) => ['completed', 'failed', 'blocked'].includes(s))) {
          await tx.query("UPDATE execution_plans SET state='failed' WHERE id=$1", [plan.id]);
          await tx.query(
            "UPDATE collaboration_goals SET state='FAILED',reason='分工步骤失败或证据不可用，未自动重跑',version=version+1 WHERE id=$1",
            [plan.goal_id],
          );
        }
      });
      for (const id of cancel) await this.tasks.cancelForPolicy(id, '计划版本或执行策略已失效');
    }
    if (plans.length) {
      this.tasks.onQueued();
      this.tasks.changes.emit('all');
    }
  }
}
