import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

/** PGlite is a single-process dev database; setup and API must never open it concurrently. */
export function acquireLocalDatabaseLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const file = resolve(dataDir, 'pglite.lock'),
    content = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      try {
        writeFileSync(fd, content);
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          if (readFileSync(file, 'utf8') === content) unlinkSync(file);
        } catch (error: any) {
          if (error.code !== 'ENOENT') throw error;
        }
      };
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      const previous = readFileSync(file, 'utf8'),
        owner = JSON.parse(previous) as { pid: number };
      if (!Number.isInteger(owner.pid) || owner.pid < 1)
        throw new Error('INVALID_LOCAL_DATABASE_LOCK');
      try {
        process.kill(owner.pid, 0);
        throw new Error('LOCAL_DATABASE_IN_USE: stop the API before running setup or maintenance');
      } catch (probe: any) {
        if (probe.code !== 'ESRCH') throw probe;
      }
      if (readFileSync(file, 'utf8') !== previous) throw new Error('LOCAL_DATABASE_LOCK_CHANGED');
      unlinkSync(file);
    }
  }
  throw new Error('LOCAL_DATABASE_IN_USE');
}
