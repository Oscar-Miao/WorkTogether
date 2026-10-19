import { PGlite } from '@electric-sql/pglite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { acquireLocalDatabaseLock } from './local-lock.js';

/** 本机维护查看器：不运行迁移、不创建新库，必须与 API 使用同一个独占锁。 */
export async function openInspectionDatabase(dataDir: string) {
  const directory = resolve(dataDir, 'postgres');
  if (!existsSync(resolve(directory, 'PG_VERSION')))
    throw new Error('数据库目录不存在，请确认 data-dir 指向服务数据根目录，而不是 postgres 子目录');
  const release = acquireLocalDatabaseLock(dataDir);
  let client: PGlite;
  try {
    client = new PGlite(directory);
    await client.waitReady;
    await client.exec("SET statement_timeout='5s'");
  } catch (error) {
    release();
    throw error;
  }
  return {
    async query(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/;\s*$/, '');
      if (!/^(SELECT|WITH|SHOW|EXPLAIN)\b/i.test(statement) || statement.includes(';'))
        throw new Error('查看器仅接受一条 SELECT / WITH / SHOW / EXPLAIN 查询，不允许修改数据');
      await client.exec('BEGIN READ ONLY');
      try {
        // 在用户查询前建立只读事务，WITH 中夹带写入也由数据库拒绝。
        await client.query('SELECT 1');
        return await client.query<Record<string, unknown>>(statement, params);
      } finally {
        await client.exec('ROLLBACK');
      }
    },
    async close() {
      try {
        await client.close();
      } finally {
        release();
      }
    },
  };
}
