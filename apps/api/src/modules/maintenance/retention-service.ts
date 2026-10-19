import type { Database, SqlConnection, Row } from '@team-agent/database';
import type { User } from '@team-agent/contracts';
import { canonical, DomainError, terminalStates } from '@team-agent/domain';
import { audit, idempotent, owner, sha } from '../../common/security.js';
import { requireTaskAccess } from '../../common/group-access.js';
const DAY = 86400000;
const UNRESOLVED = "('dispatching','running','cancelling','uncertain')";
const TERMINAL = "('SUCCEEDED','FAILED','CANCELLED','REJECTED','EXPIRED')";

/** Default-off until an operator explicitly enables application of the documented retention policy. */
export class RetentionService {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<Record<string, number>>;
  constructor(
    private readonly db: Database,
    private readonly changed: () => void,
    readonly enabled = false,
  ) {}
  start() {
    if (!this.enabled) return;
    this.timer = setInterval(
      () => void this.run().catch(() => console.error('[maintenance] retention failed')),
      3600000,
    );
    this.timer.unref();
    void this.run().catch(() => console.error('[maintenance] retention failed'));
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => {});
  }
  private requireEnabled() {
    if (!this.enabled)
      throw new DomainError(
        'RETENTION_NOT_ENABLED',
        '清理执行尚未启用；当前仅可预览和标记保留',
        409,
      );
  }
  private async locked(tx: SqlConnection, id: string, skip = false): Promise<Row> {
    const task = (
      await tx.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE' + (skip ? ' SKIP LOCKED' : ''), [
        id,
      ])
    )[0];
    if (!task) throw new DomainError('NOT_FOUND', '任务不存在或正在维护', 404);
    return task;
  }
  private async safe(tx: SqlConnection, task: Row) {
    if (!terminalStates.has(task.state) || task.retention_hold)
      throw new DomainError('RETENTION_PROTECTED', '活动、待核查或已标记保留的任务不能清理');
    if (
      (
        await tx.query(
          'SELECT id FROM execution_attempts WHERE task_id=$1 AND status IN ' + UNRESOLVED,
          [task.id],
        )
      ).length
    )
      throw new DomainError('STOP_UNCONFIRMED', '存在未确认停止的执行，暂停清理');
  }
  async preview(user: User, id: string) {
    owner(user);
    await requireTaskAccess(this.db, user, id);
    return this.db.transaction(async (tx) => {
      const task = await this.locked(tx, id);
      const logs = (
        await tx.query(
          "SELECT count(*)::int AS count,coalesce(sum(octet_length(payload::text)),0)::text AS bytes FROM execution_events WHERE task_id=$1 AND visibility='owner' AND purged_at IS NULL",
          [id],
        )
      )[0];
      const artifacts = await tx.query(
        'SELECT id,title,kind,octet_length(content)::int AS bytes FROM artifacts WHERE task_id=$1 AND NOT published AND purged_at IS NULL ORDER BY id',
        [id],
      );
      const unresolved =
        (
          await tx.query(
            'SELECT id FROM execution_attempts WHERE task_id=$1 AND status IN ' + UNRESOLVED,
            [id],
          )
        ).length > 0;
      return {
        task_id: id,
        version: task.version,
        state: task.state,
        enabled: this.enabled,
        retention_hold: task.retention_hold,
        retention_hold_reason: task.retention_hold_reason,
        can_clean:
          this.enabled && terminalStates.has(task.state) && !task.retention_hold && !unresolved,
        raw_events: logs.count,
        raw_event_bytes: Number(logs.bytes),
        private_artifacts: artifacts,
        scope: '仅云端原始日志与未共享成果正文；共享成果、输入快照、来源和本机 worktree 保留',
      };
    });
  }
  async hold(
    user: User,
    id: string,
    input: { version: number; hold: boolean; reason: string },
    key: string | undefined,
  ) {
    owner(user);
    await requireTaskAccess(this.db, user, id);
    const result = await idempotent(
      this.db,
      'retention-hold:' + user.id + ':' + id,
      key,
      input,
      async (tx) => {
        const task = await this.locked(tx, id);
        if (task.version !== input.version)
          throw new DomainError('VERSION_CONFLICT', '任务已变化，请刷新后重试');
        await tx.query(
          'UPDATE tasks SET retention_hold=$1,retention_hold_reason=$2,version=version+1,updated_at=now() WHERE id=$3',
          [input.hold, input.hold ? input.reason : null, id],
        );
        await audit(tx, user.id, input.hold ? 'retention.hold' : 'retention.release', id, {
          reason: input.reason,
        });
        return { ok: true };
      },
    );
    this.changed();
    return result;
  }
  private async purgeBodies(tx: SqlConnection, task: Row, now: Date, early: boolean) {
    const logCutoff = new Date(now.getTime() - 30 * DAY),
      metadataCutoff = new Date(now.getTime() - 180 * DAY);
    const logs = await tx.query(
      'SELECT id,payload FROM execution_events WHERE task_id=$1 AND purged_at IS NULL AND ' +
        (early
          ? "visibility='owner'"
          : "((visibility='owner' AND occurred_at<$2) OR (visibility='shared' AND occurred_at<$3))") +
        ' ORDER BY id LIMIT 1000 FOR UPDATE',
      early ? [task.id] : [task.id, logCutoff, metadataCutoff],
    );
    for (const log of logs)
      await tx.query('UPDATE execution_events SET payload=$1,purged_at=$2 WHERE id=$3', [
        JSON.stringify({
          purged: true,
          message: '正文已清理，证据不可回读',
          content_hash: sha(canonical(log.payload)),
        }),
        now,
        log.id,
      ]);
    const artifacts = await tx.query(
      'SELECT id,content FROM artifacts WHERE task_id=$1 AND NOT published AND purged_at IS NULL' +
        (early ? '' : ' AND created_at<$2') +
        ' ORDER BY id FOR UPDATE',
      early ? [task.id] : [task.id, logCutoff],
    );
    for (const artifact of artifacts)
      await tx.query(
        "UPDATE artifacts SET content_hash=coalesce(content_hash,$1),content_bytes=coalesce(content_bytes,$2),content='',purged_at=$3 WHERE id=$4 AND NOT published AND purged_at IS NULL",
        [sha(artifact.content), Buffer.byteLength(artifact.content), now, artifact.id],
      );
    let approvals = 0;
    if (!early && task.approval && new Date(task.updated_at).getTime() < metadataCutoff.getTime()) {
      await tx.query(
        'UPDATE tasks SET approval_digest=$1,approval=NULL,approval_purged_at=$2 WHERE id=$3',
        [sha(canonical(task.approval)), now, task.id],
      );
      approvals = 1;
    }
    if (logs.length || artifacts.length || approvals)
      await tx.query(
        'UPDATE tasks SET content_revision=content_revision+1,version=version+1 WHERE id=$1',
        [task.id],
      );
    return { events: logs.length, artifacts: artifacts.length, approvals };
  }
  async clean(
    user: User,
    id: string,
    input: { version: number; reason: string },
    key: string | undefined,
  ) {
    owner(user);
    await requireTaskAccess(this.db, user, id);
    this.requireEnabled();
    const result = await idempotent(
      this.db,
      'retention-clean:' + user.id + ':' + id,
      key,
      input,
      async (tx) => {
        const task = await this.locked(tx, id);
        if (task.version !== input.version)
          throw new DomainError('VERSION_CONFLICT', '任务已变化，请重新预览');
        await this.safe(tx, task);
        const counts = await this.purgeBodies(tx, task, new Date(), true);
        await audit(tx, user.id, 'retention.clean', id, { ...counts, reason: input.reason });
        return counts;
      },
    );
    this.changed();
    return result;
  }
  run(): Promise<Record<string, number>> {
    this.requireEnabled();
    if (this.running) return this.running;
    this.running = this.sweep().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async sweep(): Promise<Record<string, number>> {
    const now = new Date(),
      logCutoff = new Date(now.getTime() - 30 * DAY),
      metadataCutoff = new Date(now.getTime() - 180 * DAY);
    const totals = {
      events: 0,
      artifacts: 0,
      approvals: 0,
      expired_tasks: 0,
      expired_records: 0,
      audit: 0,
    };
    totals.expired_tasks = await this.db.transaction(async (tx) => {
      const rows = await tx.query(
        "SELECT id FROM tasks WHERE state='QUEUED' AND (approval->>'expires_at')::timestamptz<=$1 FOR UPDATE SKIP LOCKED",
        [now],
      );
      for (const row of rows) {
        await tx.query(
          "UPDATE tasks SET state='EXPIRED',version=version+1,updated_at=$1 WHERE id=$2",
          [now, row.id],
        );
        await tx.query(
          "INSERT INTO execution_events(task_id,type,visibility,payload) VALUES($1,'task.expired','shared','{}')",
          [row.id],
        );
      }
      return rows.length;
    });
    const candidates = await this.db.query(
      'SELECT t.id FROM tasks t WHERE t.state IN ' +
        TERMINAL +
        ' AND NOT t.retention_hold AND NOT EXISTS(SELECT 1 FROM execution_attempts a WHERE a.task_id=t.id AND a.status IN ' +
        UNRESOLVED +
        ") AND (EXISTS(SELECT 1 FROM execution_events e WHERE e.task_id=t.id AND e.purged_at IS NULL AND ((e.visibility='owner' AND e.occurred_at<$1) OR e.occurred_at<$2)) OR EXISTS(SELECT 1 FROM artifacts f WHERE f.task_id=t.id AND NOT f.published AND f.purged_at IS NULL AND f.created_at<$1) OR (t.approval IS NOT NULL AND t.updated_at<$2)) ORDER BY t.created_at LIMIT 20",
      [logCutoff, metadataCutoff],
    );
    for (const candidate of candidates) {
      try {
        const counts = await this.db.transaction(async (tx) => {
          const task = await this.locked(tx, candidate.id, true);
          await this.safe(tx, task);
          const removed = await this.purgeBodies(tx, task, now, false);
          if (Object.values(removed).some(Boolean))
            await audit(tx, 'maintenance', 'retention.expire', task.id, removed);
          return removed;
        });
        totals.events += counts.events;
        totals.artifacts += counts.artifacts;
        totals.approvals += counts.approvals;
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
      }
    }
    await this.db.transaction(async (tx) => {
      for (const table of [
        'sessions',
        'device_sessions',
        'device_challenges',
        'invitations',
        'pairing_codes',
      ]) {
        totals.expired_records += (
          await tx.query('DELETE FROM ' + table + ' WHERE expires_at<$1 RETURNING id', [now])
        ).length;
      }
      totals.expired_records += (
        await tx.query('DELETE FROM idempotency_records WHERE created_at<$1 RETURNING key', [
          new Date(now.getTime() - DAY),
        ])
      ).length;
      totals.audit = (
        await tx.query(
          'DELETE FROM audit_logs l WHERE l.created_at<$1 AND NOT EXISTS(SELECT 1 FROM tasks t WHERE (t.retention_hold OR t.state NOT IN ' +
            TERMINAL +
            ' OR EXISTS(SELECT 1 FROM execution_attempts live WHERE live.task_id=t.id AND live.status IN ' +
            UNRESOLVED +
            ')) AND (l.object_id=t.id OR l.object_id IN (SELECT id FROM execution_attempts WHERE task_id=t.id) OR l.object_id IN (SELECT id FROM artifacts WHERE task_id=t.id))) RETURNING id',
          [metadataCutoff],
        )
      ).length;
    });
    if (Object.values(totals).some(Boolean)) this.changed();
    return totals;
  }
}
