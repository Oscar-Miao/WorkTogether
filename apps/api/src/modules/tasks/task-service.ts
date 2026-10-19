import { EventEmitter } from 'node:events';
import type { Database, SqlConnection, Row } from '@team-agent/database';
import type {
  Approval,
  Artifact,
  Dispatch,
  ExecutionDescriptor,
  ExecutionEvent,
  ExecutionResult,
  Task,
  TaskEvent,
  TaskInput,
  TaskState,
  User,
} from '@team-agent/contracts';
import {
  assertTransition,
  approvalFingerprint,
  canonical,
  descriptorFingerprint,
  DomainError,
  terminalStates,
} from '@team-agent/domain';
import { audit, idempotent, ids, iso, owner, sha, PermitSigner } from '../../common/security.js';
import { requireGroupAccess, requireTaskAccess } from '../../common/group-access.js';
import { ContextBuilder } from '../context/context-builder.js';

export class TaskService {
  readonly changes = new EventEmitter();
  onQueued = () => {};
  onCancel: (deviceId: string, attemptId: string, reason: string) => void = () => {};
  constructor(
    private readonly db: Database,
    private readonly context: ContextBuilder,
    private readonly signer: PermitSigner,
  ) {}
  private async event(
    tx: SqlConnection,
    taskId: string,
    type: string,
    payload: unknown = {},
    visibility = 'shared',
  ): Promise<void> {
    await tx.query(
      'INSERT INTO execution_events(task_id,type,visibility,payload) VALUES($1,$2,$3,$4)',
      [taskId, type, visibility, JSON.stringify(payload)],
    );
  }
  private changed(id: string): void {
    this.changes.emit(id);
    this.changes.emit('all');
  }
  private async row(id: string, tx: SqlConnection = this.db, lock = false): Promise<Row> {
    const rows = await tx.query(
      'SELECT t.*,u.name AS creator_name FROM tasks t JOIN users u ON u.id=t.creator_id WHERE t.id=$1' +
        (lock ? ' FOR UPDATE OF t' : ''),
      [id],
    );
    if (!rows.length) throw new DomainError('NOT_FOUND', '任务不存在', 404);
    return rows[0];
  }
  private async binding(
    id: string,
    tx: SqlConnection = this.db,
  ): Promise<{ device: Row; repo: any }> {
    const devices = await tx.query('SELECT * FROM devices WHERE NOT revoked');
    const device = devices.find((d) => d.repositories.some((r: any) => r.id === id));
    const repo = device?.repositories.find((r: any) => r.id === id);
    if (!device || !repo)
      throw new DomainError('REPOSITORY_UNAVAILABLE', '请先由 Owner 连接设备并绑定代码仓库');
    return { device, repo };
  }
  private freezeWriteScope(input: TaskInput, repo: any): TaskInput {
    if (input.execution_profile !== 'code_edit') return { ...input, allowed_write_prefixes: [] };
    const allowed: string[] = repo.write_prefixes || [];
    const requested = input.allowed_write_prefixes ?? allowed;
    if (
      !requested.length ||
      !requested.every((path) =>
        allowed.some((prefix) => path === prefix || path.startsWith(prefix + '/')),
      )
    )
      throw new DomainError('WRITE_SCOPE_DENIED', '修改目录不属于本机报告的允许范围', 403);
    return { ...input, allowed_write_prefixes: [...requested] };
  }
  async list(user: User): Promise<Task[]> {
    const ids = await this.db.query(
      "SELECT id FROM tasks WHERE EXISTS(SELECT 1 FROM conversations c WHERE c.id=tasks.conversation_id AND (c.visibility='project' OR EXISTS(SELECT 1 FROM group_members m WHERE m.conversation_id=c.id AND m.user_id=$1))) ORDER BY created_at DESC LIMIT 100",
      [user.id],
    );
    return Promise.all(ids.map((r) => this.get(user, r.id)));
  }
  async get(user: User, id: string): Promise<Task> {
    await requireTaskAccess(this.db, user, id);
    const row = await this.row(id);
    const artifacts = await this.db.query(
      "SELECT * FROM artifacts WHERE task_id=$1 AND ($2='OWNER' OR published) ORDER BY created_at",
      [id, user.role],
    );
    return {
      ...row,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
      artifacts: artifacts.map((a) => ({ ...a, created_at: iso(a.created_at) })),
    } as Task;
  }
  async create(user: User, input: TaskInput, key: string | undefined): Promise<{ id: string }> {
    await requireGroupAccess(this.db, user, input.conversation_id);
    const result = await idempotent(this.db, 'tasks:' + user.id, key, input, async (tx) => {
      const count = await tx.query(
        "SELECT count(*)::int AS n FROM tasks WHERE state IN ('QUEUED','DISPATCHING')",
      );
      if (count[0].n >= 20) throw new DomainError('QUEUE_LIMIT', '队列已满，请稍后提交', 429);
      const { repo } = await this.binding(input.repository_binding_id, tx);
      if (input.execution_profile === 'code_edit' && !repo.capabilities.includes('file_edit'))
        throw new DomainError('CAPABILITY_UNSUPPORTED', '当前执行环境仅支持只读分析');
      input = this.freezeWriteScope(input, repo);
      await this.context.verifySources(input, tx);
      const snapshot = await this.context.build(user, input, tx);
      input = { ...input, conversation_cutoff_seq: snapshot.cutoff_seq };
      const id = ids('task');
      await tx.query(
        "INSERT INTO tasks(id,conversation_id,creator_id,state,input,snapshot) VALUES($1,$2,$3,'PENDING_APPROVAL',$4,$5)",
        [id, input.conversation_id, user.id, JSON.stringify(input), JSON.stringify(snapshot)],
      );
      await this.event(tx, id, 'task.submitted', { goal: input.goal });
      await audit(tx, user.id, 'task.create', id, { snapshot_hash: snapshot.hash });
      return { id };
    });
    this.changed(result.id);
    return result;
  }
  /** Called only by the coordinator inside the project admission transaction. */
  async queueFromCoordinator(user: User, input: TaskInput, tx: SqlConnection): Promise<string> {
    const count = (
      await tx.query(
        "SELECT count(*)::int AS count FROM tasks WHERE state IN ('QUEUED','DISPATCHING')",
      )
    )[0].count;
    if (count >= 20) throw new DomainError('QUEUE_LIMIT', '执行队列已满，请稍后重试', 429);
    await requireGroupAccess(tx, user, input.conversation_id);
    const { repo, device } = await this.binding(input.repository_binding_id, tx);
    if (input.execution_profile === 'code_edit' && !repo.capabilities.includes('file_edit'))
      throw new DomainError('CAPABILITY_UNSUPPORTED', '执行器不支持修改');
    input = this.freezeWriteScope(input, repo);
    await this.context.verifySources(input, tx);
    const snapshot = await this.context.build(user, input, tx);
    input = { ...input, conversation_cutoff_seq: snapshot.cutoff_seq };
    const id = ids('task');
    const policy = (await tx.query('SELECT version FROM coordinator_control WHERE id=true'))[0];
    const approval: Approval = {
      policy_version: policy.version,
      id: ids('permit'),
      approver_id: 'node:coordinator',
      input_version: 1,
      snapshot_hash: snapshot.hash,
      descriptor_hash: sha(approvalFingerprint(input, snapshot.hash, device.id)),
      expires_at: new Date(Date.now() + 1800000).toISOString(),
    };
    await tx.query(
      "INSERT INTO tasks(id,conversation_id,creator_id,state,input,snapshot,approval) VALUES($1,$2,$3,'QUEUED',$4,$5,$6)",
      [
        id,
        input.conversation_id,
        user.id,
        JSON.stringify(input),
        JSON.stringify(snapshot),
        JSON.stringify(approval),
      ],
    );
    await this.event(tx, id, 'task.coordinator_approved', { snapshot_hash: snapshot.hash });
    await audit(tx, 'node:coordinator', 'task.auto_permit', id);
    return id;
  }
  async revise(
    user: User,
    id: string,
    input: TaskInput,
    key: string | undefined,
  ): Promise<{ id: string }> {
    await requireTaskAccess(this.db, user, id);
    await requireGroupAccess(this.db, user, input.conversation_id);
    const old = await this.row(id);
    if (user.role !== 'OWNER' && old.creator_id !== user.id)
      throw new DomainError('FORBIDDEN', '只能修订自己创建的任务', 403);
    if (!['PENDING_APPROVAL', 'QUEUED', 'REJECTED', 'EXPIRED'].includes(old.state)) {
      if (terminalStates.has(old.state)) return this.create(user, input, key);
      throw new DomainError('EXECUTION_ACTIVE', '请先结束或核查当前执行，再创建修订任务');
    }
    const result = await idempotent(
      this.db,
      'revise:' + id + ':' + user.id,
      key,
      input,
      async (tx) => {
        const row = await this.row(id, tx, true);
        if (!['PENDING_APPROVAL', 'QUEUED', 'REJECTED', 'EXPIRED'].includes(row.state))
          throw new DomainError('EXECUTION_ACTIVE', '任务已启动，不能原位修订');
        await this.context.verifySources(input, tx);
        const { repo } = await this.binding(input.repository_binding_id, tx);
        if (input.execution_profile === 'code_edit' && !repo.capabilities.includes('file_edit'))
          throw new DomainError('CAPABILITY_UNSUPPORTED', '环境不支持文件修改');
        input = this.freezeWriteScope(input, repo);
        const snapshot = await this.context.build(user, input, tx);
        await tx.query(
          "UPDATE tasks SET input=$1,snapshot=$2,input_version=input_version+1,version=version+1,state='PENDING_APPROVAL',approval=NULL,updated_at=now() WHERE id=$3",
          [JSON.stringify(input), JSON.stringify(snapshot), id],
        );
        await this.event(tx, id, 'task.revised', { input_version: row.input_version + 1 });
        await audit(tx, user.id, 'task.revise', id);
        return { id };
      },
    );
    this.changed(id);
    return result;
  }
  async approve(
    user: User,
    id: string,
    input: { input_version: number; version: number; snapshot_hash: string },
    key: string | undefined,
  ): Promise<{ approval_id: string }> {
    owner(user);
    await requireTaskAccess(this.db, user, id);
    const result = await idempotent(
      this.db,
      'approve:' + id + ':' + user.id,
      key,
      input,
      async (tx) => {
        // Serialize admissions on the single Owner, before locking individual tasks.
        await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
        const count = await tx.query(
          "SELECT count(*)::int AS n FROM tasks WHERE state IN ('QUEUED','DISPATCHING')",
        );
        if (count[0].n >= 20) throw new DomainError('QUEUE_LIMIT', '队列已满，请稍后批准', 429);
        const row = await this.row(id, tx, true);
        if (
          row.state !== 'PENDING_APPROVAL' ||
          row.version !== input.version ||
          row.input_version !== input.input_version ||
          row.snapshot.hash !== input.snapshot_hash
        )
          throw new DomainError('APPROVAL_STALE', '任务输入或状态已经变化，请重新查看');
        await this.context.verifySources(row.input, tx);
        const { device } = await this.binding(row.input.repository_binding_id, tx);
        const approval: Approval = {
          id: ids('ap'),
          approver_id: user.id,
          input_version: row.input_version,
          snapshot_hash: row.snapshot.hash,
          descriptor_hash: sha(approvalFingerprint(row.input, row.snapshot.hash, device.id)),
          expires_at: new Date(Date.now() + 1800000).toISOString(),
        };
        await tx.query(
          "UPDATE tasks SET state='QUEUED',approval=$1,version=version+1,updated_at=now() WHERE id=$2",
          [JSON.stringify(approval), id],
        );
        await this.event(tx, id, 'task.queued', { approval_id: approval.id });
        await audit(tx, user.id, 'task.approve', id, {
          input_version: row.input_version,
          snapshot_hash: row.snapshot.hash,
        });
        return { approval_id: approval.id };
      },
    );
    this.changed(id);
    this.onQueued();
    return result;
  }
  async revokeCoordinatorExecutions(): Promise<void> {
    const targets = await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM coordinator_control WHERE id=true FOR UPDATE');
      await tx.query(
        "UPDATE tasks SET state='EXPIRED',version=version+1,updated_at=now() WHERE state='QUEUED' AND approval->>'approver_id'='node:coordinator' AND (approval->>'policy_version')::int<>(SELECT version FROM coordinator_control WHERE id=true)",
      );
      const rows = await tx.query(
        "SELECT t.id,t.attempt_id,a.device_id FROM tasks t JOIN execution_attempts a ON a.id=t.attempt_id WHERE t.approval->>'approver_id'='node:coordinator' AND (t.approval->>'policy_version')::int<>(SELECT version FROM coordinator_control WHERE id=true) AND t.state IN ('DISPATCHING','RUNNING','CANCEL_REQUESTED') FOR UPDATE OF t",
      );
      for (const r of rows) {
        await tx.query(
          "UPDATE tasks SET state='CANCEL_REQUESTED',version=version+1,updated_at=now() WHERE id=$1",
          [r.id],
        );
        await tx.query("UPDATE execution_attempts SET status='cancelling' WHERE id=$1", [
          r.attempt_id,
        ]);
        await this.event(tx, r.id, 'execution.policy_stop');
      }
      return rows;
    });
    for (const row of targets)
      this.onCancel(row.device_id, row.attempt_id, '主设备策略变更，停止旧许可');
    this.changes.emit('all');
  }
  async expireQueued(): Promise<void> {
    // Approval expiry is execution control; it must also run when retention is disabled/offline.
    const ids = await this.db.transaction(async (tx) => {
      const rows = await tx.query(
        "SELECT id FROM tasks WHERE state='QUEUED' AND (approval->>'expires_at')::timestamptz<=now() FOR UPDATE SKIP LOCKED",
      );
      for (const row of rows) {
        await tx.query(
          "UPDATE tasks SET state='EXPIRED',version=version+1,updated_at=now() WHERE id=$1",
          [row.id],
        );
        await this.event(tx, row.id, 'task.expired');
      }
      return rows.map((row) => row.id as string);
    });
    for (const id of ids) this.changed(id);
  }
  async reject(user: User, id: string, reason: string): Promise<void> {
    owner(user);
    await requireTaskAccess(this.db, user, id);
    await this.db.transaction(async (tx) => {
      const row = await this.row(id, tx, true);
      assertTransition(row.state, 'REJECTED');
      await tx.query(
        "UPDATE tasks SET state='REJECTED',version=version+1,updated_at=now() WHERE id=$1",
        [id],
      );
      await this.event(tx, id, 'task.rejected', { reason });
      await audit(tx, user.id, 'task.reject', id);
    });
    this.changed(id);
  }
  async requestCancel(user: User, id: string, reason: string): Promise<void> {
    await requireTaskAccess(this.db, user, id);
    await this.row(id);
    await this.event(
      this.db,
      id,
      'task.cancel_requested',
      { requester: user.name, reason },
      'owner',
    );
    this.changed(id);
  }
  async cancel(
    user: User,
    id: string,
    reason = 'Owner 请求停止',
    key?: string,
  ): Promise<TaskState> {
    await requireTaskAccess(this.db, user, id);
    if (user.role !== 'OWNER') {
      const task = await this.row(id);
      const group = await requireGroupAccess(this.db, user, task.conversation_id);
      // Legacy approval tasks keep their original controls; coordinated goals allow member stop.
      if (
        !(await this.db.query('SELECT id FROM collaboration_goals WHERE task_id=$1', [id])).length
      )
        owner(user);
      void group;
    }
    return this.cancelRecorded(user, id, reason, key);
  }
  /** 仅由服务端撤权、归档和修订调用；服务身份单独审计，不冒充人类维护者。 */
  async cancelForPolicy(id: string, reason: string): Promise<TaskState> {
    // 内部策略不携带浏览器的幂等键，使用独立请求键；任务行锁保护停止状态流转。
    return this.cancelRecorded(
      { id: 'service:policy', name: '系统策略' },
      id,
      reason,
      ids('policy'),
    );
  }
  private async cancelRecorded(
    user: Pick<User, 'id' | 'name'>,
    id: string,
    reason: string,
    key?: string,
  ): Promise<TaskState> {
    let target: { deviceId: string; attemptId: string } | undefined;
    const result = await idempotent(
      this.db,
      'cancel:' + id + ':' + user.id,
      key,
      { reason },
      async (tx) => {
        const row = await this.row(id, tx, true);
        if (terminalStates.has(row.state)) return row.state as TaskState;
        const immediate = ['DRAFT', 'PENDING_APPROVAL', 'QUEUED'].includes(row.state);
        const state: TaskState = immediate ? 'CANCELLED' : 'CANCEL_REQUESTED';
        if (row.state !== 'CANCEL_REQUESTED') assertTransition(row.state, state);
        await tx.query('UPDATE tasks SET state=$1,version=version+1,updated_at=now() WHERE id=$2', [
          state,
          id,
        ]);
        if (row.attempt_id) {
          const a = (
            await tx.query('UPDATE execution_attempts SET status=$1 WHERE id=$2 RETURNING *', [
              'cancelling',
              row.attempt_id,
            ])
          )[0];
          target = { deviceId: a.device_id, attemptId: a.id };
        }
        await this.event(tx, id, immediate ? 'execution.cancelled' : 'execution.cancelling', {
          reason,
        });
        await audit(tx, user.id, 'task.cancel', id);
        return state;
      },
    );
    if (target) this.onCancel(target.deviceId, target.attemptId, reason);
    this.changed(id);
    return result;
  }
  async claim(deviceId: string): Promise<Dispatch | undefined> {
    return this.db.transaction(async (tx) => {
      // 项目级认领短事务串行，模型与文件操作仍在事务外并行执行。
      await tx.query('SELECT id FROM coordinator_control WHERE id=true FOR UPDATE');
      const limit = (await tx.query('SELECT max_parallel FROM execution_limits WHERE id=true'))[0]
        .max_parallel;
      const unresolved = await tx.query(
        "SELECT device_id FROM execution_attempts WHERE status IN ('dispatching','running','cancelling','uncertain')",
      );
      if (unresolved.length >= limit || unresolved.some((a) => a.device_id === deviceId)) return;
      const leadership = (await tx.query('SELECT * FROM coordinator_leadership WHERE id=true'))[0];
      if (leadership.node_id && new Date(leadership.lease_until || 0).getTime() <= Date.now())
        return;
      const device = (
        await tx.query('SELECT * FROM devices WHERE id=$1 AND NOT revoked', [deviceId])
      )[0];
      if (!device) return;
      const rows = await tx.query(
        "SELECT t.* FROM tasks t JOIN conversations c ON c.id=t.conversation_id JOIN project_users u ON u.id=t.creator_id WHERE t.state='QUEUED' AND u.active AND c.archived_at IS NULL AND t.input->>'repository_binding_id'=ANY($1::text[]) AND NOT EXISTS(SELECT 1 FROM collaboration_goals g JOIN goal_relations r ON r.source_id=g.id AND r.kind='depends_on' JOIN collaboration_goals parent ON parent.id=r.target_id WHERE g.task_id=t.id AND parent.state<>'COMPLETED') ORDER BY t.created_at LIMIT 20 FOR UPDATE OF t SKIP LOCKED",
        [device.repositories.map((r: any) => r.id)],
      );
      if (!rows.length) return;
      const resources = await tx.query(
        "SELECT c.mode FROM execution_resource_claims c JOIN execution_attempts a ON a.id=c.attempt_id WHERE a.status IN ('dispatching','running','cancelling','uncertain') AND c.resource_key='project-code'",
      );
      const task = rows.find((row) =>
        row.input.execution_profile === 'code_edit'
          ? resources.length === 0
          : !resources.some((r) => r.mode === 'write'),
      );
      if (!task) return;
      if (task.approval?.approver_id === 'node:coordinator') {
        const control = (await tx.query('SELECT * FROM coordinator_control WHERE id=true'))[0];
        if (!control.policy.enabled || control.version !== task.approval.policy_version) {
          await tx.query(
            "UPDATE tasks SET state='EXPIRED',version=version+1,updated_at=now() WHERE id=$1",
            [task.id],
          );
          await this.event(tx, task.id, 'execution.policy_revoked');
          return;
        }
      }
      if (new Date(task.approval?.expires_at || 0).getTime() <= Date.now()) {
        await tx.query("UPDATE tasks SET state='EXPIRED',version=version+1 WHERE id=$1", [task.id]);
        await this.event(tx, task.id, 'task.expired');
        this.changed(task.id);
        return;
      }
      const repo = device.repositories.find((r: any) => r.id === task.input.repository_binding_id);
      if (!repo) return;
      if (
        task.approval.descriptor_hash !==
        sha(approvalFingerprint(task.input, task.snapshot.hash, deviceId))
      )
        throw new DomainError('APPROVAL_STALE', '审批内容不再匹配');
      try {
        await this.context.verifySources(task.input, tx);
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'APPROVAL_STALE') throw error;
        await tx.query(
          "UPDATE tasks SET state='PENDING_APPROVAL',approval=NULL,version=version+1 WHERE id=$1",
          [task.id],
        );
        await this.event(tx, task.id, 'task.approval_invalidated', {
          reason: '引用资料或结论已变化',
        });
        this.changed(task.id);
        return;
      }
      const attemptId = ids('attempt');
      const descriptor: ExecutionDescriptor = {
        leadership_epoch: leadership.epoch,
        allowed_write_prefixes: task.input.allowed_write_prefixes || [],
        task_id: task.id,
        attempt_id: attemptId,
        device_id: deviceId,
        input_version: task.input_version,
        repository_binding_id: repo.id,
        base_commit: task.input.base_commit,
        execution_profile: task.input.execution_profile,
        capabilities:
          task.input.execution_profile === 'code_edit'
            ? ['file_read', 'file_search', 'file_edit']
            : ['file_read', 'file_search'],
        snapshot: task.snapshot,
        budget: task.input.budget,
        result_audience: task.conversation_id,
      };
      const fingerprint = sha(descriptorFingerprint(descriptor));
      await tx.query(
        "INSERT INTO execution_attempts(id,task_id,device_id,status,descriptor) VALUES($1,$2,$3,'dispatching',$4)",
        [attemptId, task.id, deviceId, JSON.stringify(descriptor)],
      );
      await tx.query('INSERT INTO execution_resource_claims VALUES($1,$2,$3,$4)', [
        attemptId,
        'project-code',
        task.input.execution_profile === 'code_edit' ? 'write' : 'read',
        leadership.epoch,
      ]);
      await tx.query(
        "UPDATE tasks SET state='DISPATCHING',attempt_id=$1,version=version+1,updated_at=now() WHERE id=$2",
        [attemptId, task.id],
      );
      await this.event(tx, task.id, 'execution.dispatching');
      const permit = await this.signer.sign(
        {
          task_id: task.id,
          attempt_id: attemptId,
          device_id: deviceId,
          input_version: task.input_version,
          descriptor_hash: fingerprint,
          leadership_epoch: leadership.epoch,
        },
        new Date(task.approval.expires_at),
      );
      this.changed(task.id);
      return {
        type: 'dispatch',
        protocol_version: '1',
        descriptor,
        descriptor_hash: fingerprint,
        start_permit: permit,
      };
    });
  }
  async attempt(
    deviceId: string,
    id: string,
    tx: SqlConnection = this.db,
    lock = false,
  ): Promise<Row> {
    const rows = await tx.query(
      'SELECT a.*,t.state AS task_state,t.approval AS task_approval,t.input AS task_input,t.creator_id,(u.active AND EXISTS(SELECT 1 FROM project_users pu WHERE pu.id=u.id)) AS creator_active FROM execution_attempts a JOIN tasks t ON t.id=a.task_id JOIN users u ON u.id=t.creator_id WHERE a.id=$1 AND a.device_id=$2' +
        (lock ? ' FOR UPDATE OF a' : ''),
      [id, deviceId],
    );
    if (!rows.length) throw new DomainError('ATTEMPT_DENIED', '执行尝试不属于此设备', 403);
    return rows[0];
  }
  async started(deviceId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const a = await this.attempt(deviceId, id, tx, true);
      if (!['DISPATCHING', 'RUNNING'].includes(a.task_state) || a.status === 'running') return;
      await tx.query(
        "UPDATE execution_attempts SET status='running',started_at=coalesce(started_at,now()),lease_until=$1 WHERE id=$2",
        [new Date(Date.now() + 60000), id],
      );
      await tx.query(
        "UPDATE tasks SET state='RUNNING',version=version+1,updated_at=now() WHERE id=$1",
        [a.task_id],
      );
      await this.event(tx, a.task_id, 'execution.started');
    });
    this.changes.emit('all');
  }
  async lease(
    deviceId: string,
    id: string,
  ): Promise<{ valid_until: string; context_permit: string }> {
    const a = await this.attempt(deviceId, id);
    const leadership = (
      await this.db.query('SELECT * FROM coordinator_leadership WHERE id=true')
    )[0];
    if (
      (a.descriptor.leadership_epoch || 1) !== leadership.epoch ||
      (leadership.node_id && new Date(leadership.lease_until || 0).getTime() <= Date.now())
    )
      throw new DomainError('LEASE_REVOKED', '主节点代次或租约已失效', 403);
    if (a.task_approval?.approver_id === 'node:coordinator') {
      const control = (await this.db.query('SELECT * FROM coordinator_control WHERE id=true'))[0];
      if (!control.policy.enabled || control.version !== a.task_approval.policy_version)
        throw new DomainError('LEASE_REVOKED', '主设备策略已变更', 403);
    }
    try {
      const group = await requireGroupAccess(
        this.db,
        { id: a.creator_id } as User,
        a.descriptor.snapshot.conversation_id,
      );
      if (group.archived_at) throw new Error('GROUP_ARCHIVED');
      await this.context.verifySources(a.task_input, this.db);
    } catch {
      throw new DomainError('LEASE_REVOKED', '群权限、依赖成果或上下文来源已失效', 403);
    }
    const d = (await this.db.query('SELECT revoked FROM devices WHERE id=$1', [deviceId]))[0];
    if (d?.revoked || !a.creator_active || !['RUNNING', 'DISPATCHING'].includes(a.task_state))
      throw new DomainError('LEASE_REVOKED', '运行授权已撤销', 403);
    if (
      a.started_at &&
      Date.now() - new Date(a.started_at).getTime() > a.descriptor.budget.wall_time_seconds * 1000
    )
      throw new DomainError('TASK_TIMEOUT', '任务已达到时间预算', 403);
    const until = new Date(Date.now() + 60000);
    await this.db.query('UPDATE execution_attempts SET lease_until=$1 WHERE id=$2', [until, id]);
    return {
      valid_until: until.toISOString(),
      context_permit: await this.signer.sign(
        {
          scope: 'context.read',
          device_id: deviceId,
          attempt_id: id,
          snapshot_hash: a.descriptor.snapshot.hash,
        },
        until,
      ),
    };
  }
  async ingest(deviceId: string, id: string, events: ExecutionEvent[]): Promise<number> {
    const last = await this.db.transaction(async (tx) => {
      const a = await this.attempt(deviceId, id, tx, true);
      let seq = a.last_seq;
      for (const event of events) {
        if (event.seq <= seq) continue;
        if (event.seq !== seq + 1) break; // ACK only the continuous durable prefix, never the highest received number.
        if (event.type === 'model.usage') {
          const number = (v: unknown) =>
            typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
          await tx.query(
            "INSERT INTO model_usage(conversation_id,task_id,layer,model,input_tokens,output_tokens,cost_usd) SELECT conversation_id,id,'execution',$2,$3,$4,$5 FROM tasks WHERE id=$1",
            [
              a.task_id,
              String(event.payload.model || 'unknown').slice(0, 100),
              number(event.payload.input_tokens),
              number(event.payload.output_tokens),
              number(event.payload.cost_usd),
            ],
          );
        }
        const ownerOnly = !['phase.changed', 'execution.progress'].includes(event.type);
        const phases = ['准备独立工作目录', '只读仓库检查', 'Pi 正在分析任务', '执行中'];
        const payload = ownerOnly
          ? event.payload
          : {
              phase: phases.includes(String(event.payload.phase)) ? event.payload.phase : '执行中',
            };
        await tx.query(
          'INSERT INTO execution_events(task_id,attempt_id,seq,type,visibility,payload,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
          [
            a.task_id,
            id,
            event.seq,
            event.type,
            ownerOnly ? 'owner' : 'shared',
            JSON.stringify(payload),
            new Date(event.occurred_at),
          ],
        );
        seq = event.seq;
      }
      await tx.query('UPDATE execution_attempts SET last_seq=$1 WHERE id=$2', [seq, id]);
      return seq;
    });
    this.changes.emit('all');
    return last;
  }
  async finish(
    deviceId: string,
    id: string,
    result: ExecutionResult,
    stopEvidence: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const a = await this.attempt(deviceId, id, tx, true);
      if (['succeeded', 'failed', 'cancelled'].includes(a.status)) return;
      if (!stopEvidence.trim()) throw new DomainError('STOP_UNCONFIRMED', '尚未确认进程停止');
      const task = await this.row(a.task_id, tx, true);
      const state: TaskState =
        result.status === 'succeeded'
          ? 'SUCCEEDED'
          : result.status === 'cancelled'
            ? 'CANCELLED'
            : 'FAILED';
      assertTransition(task.state, state);
      await tx.query(
        'UPDATE execution_attempts SET status=$1,stopped_at=now(),stop_evidence=$2 WHERE id=$3',
        [result.status, stopEvidence, id],
      );
      await tx.query(
        'UPDATE tasks SET state=$1,error_code=$2,version=version+1,updated_at=now() WHERE id=$3',
        [state, result.error_code || null, a.task_id],
      );
      for (const artifact of [
        { kind: 'report', title: '执行报告', content: result.report },
        { kind: 'diff', title: '文件差异', content: result.diff },
      ]) {
        if (!artifact.content) continue;
        await tx.query(
          'INSERT INTO artifacts(id,task_id,attempt_id,kind,title,content,published) VALUES($1,$2,$3,$4,$5,$6,(EXISTS(SELECT 1 FROM collaboration_goals WHERE task_id=$2) OR EXISTS(SELECT 1 FROM execution_steps WHERE task_id=$2)))',
          [ids('art'), a.task_id, id, artifact.kind, artifact.title, artifact.content],
        );
      }
      await this.event(tx, a.task_id, 'execution.finished', {
        state,
        verification: result.verification,
        error_code: result.error_code || null,
      });
      await audit(tx, deviceId, 'execution.finish', a.task_id, {
        attempt_id: id,
        state,
        stop_evidence: stopEvidence,
      });
    });
    this.changes.emit('all');
    this.onQueued();
  }
  async uncertain(deviceId: string, id: string, reason: string): Promise<void> {
    const a = await this.attempt(deviceId, id);
    if (terminalStates.has(a.task_state)) return;
    await this.db.transaction(async (tx) => {
      await tx.query("UPDATE execution_attempts SET status='uncertain' WHERE id=$1", [id]);
      await tx.query(
        "UPDATE tasks SET state='RECONCILING',version=version+1,updated_at=now() WHERE id=$1",
        [a.task_id],
      );
      await this.event(tx, a.task_id, 'execution.reconciling', { reason });
    });
    this.changes.emit('all');
  }
  async restore(deviceId: string, active: { attempt_id: string; status: string }[]): Promise<void> {
    const rows = await this.db.query(
      "SELECT id FROM execution_attempts WHERE device_id=$1 AND status IN ('dispatching','running','cancelling','uncertain')",
      [deviceId],
    );
    for (const row of rows) {
      const item = active.find((a) => a.attempt_id === row.id);
      if (item?.status === 'running') {
        const a = await this.attempt(deviceId, row.id);
        if (a.task_state === 'CANCEL_REQUESTED') {
          this.onCancel(deviceId, row.id, 'Owner 已请求取消');
          continue;
        }
        await this.db.query("UPDATE execution_attempts SET status='running' WHERE id=$1", [row.id]);
        await this.db.query("UPDATE tasks SET state='RUNNING',version=version+1 WHERE id=$1", [
          a.task_id,
        ]);
      } else await this.uncertain(deviceId, row.id, '连接恢复后需要核对原进程，禁止自动重跑');
    }
  }
  async markDeviceOffline(deviceId: string): Promise<void> {
    const attempts = await this.db.query(
      "SELECT id FROM execution_attempts WHERE device_id=$1 AND status IN ('dispatching','running','cancelling')",
      [deviceId],
    );
    for (const attempt of attempts)
      await this.uncertain(deviceId, attempt.id, '设备心跳超时；尚未确认本机停止，保留执行槽位');
  }
  async recoverOnStartup(): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(
        "UPDATE tasks SET state='RECONCILING',version=version+1 WHERE state IN ('DISPATCHING','RUNNING','CANCEL_REQUESTED')",
      );
      await tx.query(
        "UPDATE execution_attempts SET status='uncertain' WHERE status IN ('dispatching','running','cancelling')",
      );
    });
  }
  async events(user: User, id: string, after = 0): Promise<TaskEvent[]> {
    await requireTaskAccess(this.db, user, id);
    await this.row(id);
    return (
      await this.db.query(
        "SELECT * FROM execution_events WHERE task_id=$1 AND id>$2 AND ($3='OWNER' OR visibility='shared') ORDER BY id LIMIT 200",
        [id, after, user.role],
      )
    ).map((r) => ({ ...r, id: Number(r.id), occurred_at: iso(r.occurred_at) })) as TaskEvent[];
  }
  async publish(
    user: User,
    id: string,
    artifactId: string,
    key: string | undefined,
  ): Promise<{ id: string }> {
    owner(user);
    await requireTaskAccess(this.db, user, id);
    const result = await idempotent(
      this.db,
      'publish:' + artifactId,
      key,
      { id, artifactId },
      async (tx) => {
        // Use the same parent-before-artifact lock order as retention.
        const row = await this.row(id, tx, true);
        if (!terminalStates.has(row.state))
          throw new DomainError('TASK_ACTIVE', '请等待执行终结并核查后再发布');
        const artifacts = await tx.query(
          'UPDATE artifacts SET published=true WHERE id=$1 AND task_id=$2 AND purged_at IS NULL RETURNING id',
          [artifactId, id],
        );
        if (!artifacts.length)
          throw new DomainError('ARTIFACT_UNAVAILABLE', '成果不存在或正文已清理', 404);
        await this.event(tx, id, 'artifact.published', { artifact_id: artifactId });
        await audit(tx, user.id, 'artifact.publish', artifactId);
        return { id: artifactId };
      },
    );
    this.changed(id);
    return result;
  }
  async reconcile(user: User, id: string): Promise<void> {
    owner(user);
    await requireTaskAccess(this.db, user, id);
    const task = await this.row(id);
    if (task.state !== 'RECONCILING') throw new DomainError('NOT_RECONCILING', '任务不在核查状态');
    const a = (
      await this.db.query('SELECT * FROM execution_attempts WHERE id=$1', [task.attempt_id])
    )[0];
    if (!a?.stopped_at || !a.stop_evidence)
      throw new DomainError(
        'STOP_UNCONFIRMED',
        '尚无本机停止证据，请先在 Bridge 核查进程；不能直接释放执行槽位',
      );
  }
}
