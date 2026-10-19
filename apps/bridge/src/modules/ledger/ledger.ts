import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  ExecutionDescriptor,
  ExecutionEvent,
  ExecutionResult,
  RuntimeEvent,
} from '@team-agent/contracts';
export interface LedgerAttempt {
  id: string;
  task_id: string;
  descriptor_hash: string;
  status: 'reserved' | 'running' | 'uncertain' | 'stopped';
  pid: number | null;
  started_at: string;
  result: ExecutionResult | null;
  finish_ack: boolean;
  stop_evidence: string | null;
}
/** 本机执行与事件的持久账本；服务端重投或网络重连不能绕过这里重复执行。 */
export class Ledger {
  private readonly db: DatabaseSync;
  constructor(dataDir: string, options: { readOnly?: boolean } = {}) {
    if (!options.readOnly) mkdirSync(resolve(dataDir, 'state'), { recursive: true });
    this.db = new DatabaseSync(resolve(dataDir, 'state', 'ledger.sqlite'), {
      readOnly: options.readOnly,
    });
    if (options.readOnly) return;
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,descriptor_hash TEXT NOT NULL,status TEXT NOT NULL,pid INTEGER,started_at TEXT NOT NULL,result TEXT,finish_ack INTEGER NOT NULL DEFAULT 0,stop_evidence TEXT); CREATE UNIQUE INDEX IF NOT EXISTS one_live_attempt ON attempts((1)) WHERE status IN ('reserved','running','uncertain'); CREATE TABLE IF NOT EXISTS events(attempt_id TEXT NOT NULL,seq INTEGER NOT NULL,type TEXT NOT NULL,visibility TEXT NOT NULL,payload TEXT NOT NULL,occurred_at TEXT NOT NULL,acked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(attempt_id,seq));",
    );
  }
  recover(): void {
    // 只有持有单实例锁才能恢复；重启后无法确认旧进程状态，先标记 uncertain。
    this.db
      .prepare("UPDATE attempts SET status='uncertain' WHERE status IN ('reserved','running')")
      .run();
  }
  get(id: string): LedgerAttempt | undefined {
    const row = this.db.prepare('SELECT * FROM attempts WHERE id=?').get(id) as any;
    return row
      ? { ...row, result: row.result ? JSON.parse(row.result) : null, finish_ack: !!row.finish_ack }
      : undefined;
  }
  list(): LedgerAttempt[] {
    return (this.db.prepare('SELECT id FROM attempts ORDER BY started_at').all() as any[]).map(
      (r) => this.get(r.id)!,
    );
  }
  reserve(descriptor: ExecutionDescriptor, hash: string): boolean {
    const existing = this.get(descriptor.attempt_id);
    if (existing) {
      if (existing.descriptor_hash !== hash) throw new Error('ATTEMPT_DESCRIPTOR_CONFLICT');
      return false;
    }
    const live = this.db
      .prepare("SELECT id FROM attempts WHERE status IN ('reserved','running','uncertain')")
      .get();
    if (live) throw new Error('LOCAL_RESOURCE_BUSY');
    // 必须先持久化再启动进程；两者之间崩溃只代表状态待核查，不能再次启动。
    this.db
      .prepare(
        'INSERT INTO attempts(id,task_id,descriptor_hash,status,started_at) VALUES(?,?,?,?,?)',
      )
      .run(descriptor.attempt_id, descriptor.task_id, hash, 'reserved', new Date().toISOString());
    return true;
  }
  rejectBeforeSpawn(descriptor: ExecutionDescriptor, hash: string, result: ExecutionResult): void {
    const existing = this.get(descriptor.attempt_id);
    if (existing) throw new Error('ATTEMPT_ALREADY_RECORDED');
    // 首次收到且已验签的任务可在启动前拒绝，无需占用活动执行槽位。
    this.db
      .prepare(
        "INSERT INTO attempts(id,task_id,descriptor_hash,status,started_at,result,stop_evidence) VALUES(?,?,?,'stopped',?,?,?)",
      )
      .run(
        descriptor.attempt_id,
        descriptor.task_id,
        hash,
        new Date().toISOString(),
        JSON.stringify(result),
        'authenticated dispatch rejected before any managed operation was started',
      );
  }
  running(id: string, pid?: number): void {
    this.db.prepare("UPDATE attempts SET status='running',pid=? WHERE id=?").run(pid || null, id);
  }
  uncertain(id: string): void {
    this.db.prepare("UPDATE attempts SET status='uncertain' WHERE id=?").run(id);
  }
  stopped(id: string, result: ExecutionResult, evidence: string): void {
    this.db
      .prepare("UPDATE attempts SET status='stopped',result=?,stop_evidence=? WHERE id=?")
      .run(JSON.stringify(result), evidence, id);
  }
  finishAck(id: string): void {
    this.db.prepare('UPDATE attempts SET finish_ack=1 WHERE id=?').run(id);
  }
  append(id: string, event: RuntimeEvent): ExecutionEvent {
    const total = this.db
      .prepare('SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) AS n FROM events')
      .get() as { n: number };
    // 已确认但未清理的载荷仍占磁盘；按 UTF-8 字节计量，并预留停止证据空间。
    const payload = JSON.stringify(event.payload);
    if (total.n + Buffer.byteLength(payload) > 96 * 1024 * 1024) throw new Error('SPOOL_LIMIT');
    const next = this.db
      .prepare('SELECT coalesce(max(seq),0)+1 AS n FROM events WHERE attempt_id=?')
      .get(id) as { n: number };
    const result: ExecutionEvent = { ...event, seq: next.n, occurred_at: new Date().toISOString() };
    this.db
      .prepare(
        'INSERT INTO events(attempt_id,seq,type,visibility,payload,occurred_at) VALUES(?,?,?,?,?,?)',
      )
      .run(id, result.seq, event.type, event.visibility, payload, result.occurred_at);
    return result;
  }
  pending(id: string): ExecutionEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE attempt_id=? AND acked=0 ORDER BY seq LIMIT 40')
      .all(id) as any[];
    const result: ExecutionEvent[] = [];
    let bytes = 0;
    for (const row of rows) {
      const event = {
        seq: row.seq,
        type: row.type,
        visibility: row.visibility,
        payload: JSON.parse(row.payload),
        occurred_at: row.occurred_at,
      };
      const size = Buffer.byteLength(JSON.stringify(event));
      if (result.length && bytes + size > 128 * 1024) break;
      result.push(event);
      bytes += size;
    }
    return result;
  }
  acknowledge(id: string, seq: number): void {
    this.db.prepare('UPDATE events SET acked=1 WHERE attempt_id=? AND seq<=?').run(id, seq);
  }
  close(): void {
    this.db.close();
  }
}
