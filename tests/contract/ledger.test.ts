import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ledger } from '../../apps/bridge/src/modules/ledger/ledger.js';
import { acquireInstanceLock } from '../../apps/bridge/src/modules/ledger/instance-lock.js';
import type { ExecutionDescriptor } from '@team-agent/contracts';

describe('durable bridge identity and replay', () => {
  it('reserves once, keeps inspection read-only, requires explicit restart recovery and replays output', () => {
    mkdirSync(resolve('.local/reports/ledger'), { recursive: true });
    const dir = mkdtempSync(resolve('.local/reports/ledger/run-'));
    const release = acquireInstanceLock(dir);
    expect(() => acquireInstanceLock(dir)).toThrow('BRIDGE_ALREADY_RUNNING');
    const ledger = new Ledger(dir);
    const descriptor = { attempt_id: 'attempt_test', task_id: 'task_test' } as ExecutionDescriptor;
    expect(ledger.reserve(descriptor, 'hash-a')).toBe(true);
    expect(ledger.reserve(descriptor, 'hash-a')).toBe(false);
    expect(() => ledger.reserve(descriptor, 'hash-b')).toThrow('ATTEMPT_DESCRIPTOR_CONFLICT');
    ledger.running(descriptor.attempt_id, 123);
    const inspection = new Ledger(dir, { readOnly: true });
    expect(inspection.get(descriptor.attempt_id)?.status).toBe('running');
    inspection.close();
    expect(ledger.get(descriptor.attempt_id)?.status).toBe('running');
    ledger.append(descriptor.attempt_id, {
      type: 'output.delta',
      visibility: 'owner',
      payload: { text: '真实输出分片：中文🧩' },
    });
    ledger.close();
    release();
    const releaseRestart = acquireInstanceLock(dir),
      restarted = new Ledger(dir);
    restarted.recover();
    expect(restarted.get(descriptor.attempt_id)?.status).toBe('uncertain');
    expect(() =>
      restarted.reserve({ ...descriptor, attempt_id: 'attempt_other' }, 'other'),
    ).toThrow('LOCAL_RESOURCE_BUSY');
    expect(restarted.pending(descriptor.attempt_id)[0].payload.text).toBe('真实输出分片：中文🧩');
    restarted.acknowledge(descriptor.attempt_id, 1);
    expect(restarted.pending(descriptor.attempt_id)).toEqual([]);
    restarted.stopped(
      descriptor.attempt_id,
      { status: 'failed', report: 'operator verified stop', diff: '', verification: 'not_run' },
      'explicit test stop evidence',
    );
    expect(restarted.reserve({ ...descriptor, attempt_id: 'attempt_next' }, 'next')).toBe(true);
    restarted.close();
    releaseRestart();
  });
});
