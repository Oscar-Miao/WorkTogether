import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

/** Hold this lock before opening the writable ledger or inspecting orphaned processes. */
export function acquireInstanceLock(dataDir: string): () => void {
  mkdirSync(resolve(dataDir, 'state'), { recursive: true });
  const file = resolve(dataDir, 'state', 'bridge.lock');
  const nonce = randomUUID();
  const content = JSON.stringify({ pid: process.pid, nonce });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      try {
        writeFileSync(fd, content);
      } finally {
        closeSync(fd);
      }
      return () => {
        // Another process must never lose its lock during our shutdown.
        if (existsSync(file) && readFileSync(file, 'utf8') === content) unlinkSync(file);
      };
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      const previous = readFileSync(file, 'utf8');
      const owner = JSON.parse(previous) as { pid: number };
      if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new Error('INVALID_BRIDGE_LOCK');
      try {
        process.kill(owner.pid, 0);
        throw new Error('BRIDGE_ALREADY_RUNNING');
      } catch (probe: any) {
        // EPERM and PID reuse remain locked; only a confirmed missing process is stale.
        if (probe.code !== 'ESRCH') throw probe;
      }
      if (readFileSync(file, 'utf8') !== previous) throw new Error('BRIDGE_LOCK_CHANGED');
      unlinkSync(file);
    }
  }
  throw new Error('BRIDGE_ALREADY_RUNNING');
}
