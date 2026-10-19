import { beforeAll, afterAll, test, expect } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDatabase, openInspectionDatabase } from '../../packages/database/src/index.js';

const exec = promisify(execFile);
let root: string;
beforeAll(async () => {
  await mkdir('.local/reports/inspection', { recursive: true });
  root = await mkdtemp(resolve('.local/reports/inspection/run-'));
  const db = await createDatabase({ dataDir: root, projectRoot: process.cwd() });
  await db.query(
    "INSERT INTO users(id,email,name,password_hash,role) VALUES('usr_inspection','fake@inspect.test','合成查看用户','SYNTHETIC_ONLY','MEMBER')",
  );
  await db.close();
});
afterAll(async () => {});
test('打开现有库并在只读事务中执行，退出后可以再次打开', async () => {
  const db = await openInspectionDatabase(root);
  try {
    expect((await db.query('SHOW transaction_read_only')).rows[0]).toEqual({
      transaction_read_only: 'on',
    });
    expect((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(1);
    await expect(openInspectionDatabase(root)).rejects.toThrow('LOCAL_DATABASE_IN_USE');
  } finally {
    await db.close();
  }
  const second = await openInspectionDatabase(root);
  await second.close();
});
test('拒绝写操作、多语句和含写入的 CTE；错误之后仍能查询', async () => {
  const db = await openInspectionDatabase(root);
  try {
    await expect(db.query('DELETE FROM users')).rejects.toThrow('仅接受一条');
    await expect(db.query('SELECT 1; DELETE FROM users;')).rejects.toThrow('仅接受一条');
    await expect(
      db.query(
        "WITH changed AS (UPDATE users SET name='被修改' RETURNING id) SELECT * FROM changed",
      ),
    ).rejects.toThrow(/read-only/i);
    expect((await db.query('SELECT name FROM users')).rows[0].name).toBe('合成查看用户');
  } finally {
    await db.close();
  }
});
test('数据库路径写错时不创建空数据库', async () => {
  const missing = resolve(root, 'does-not-exist');
  await expect(openInspectionDatabase(missing)).rejects.toThrow('数据库目录不存在');
  expect(existsSync(missing)).toBe(false);
});
test('文档中的命令可查询元数据和单条 SQL，不依赖额外数据库密码', async () => {
  const invoke = (sql: string) =>
    exec(
      process.execPath,
      ['--import', 'tsx', 'scripts/database/inspect.ts', '--data-dir', root, '--sql', sql],
      {
        cwd: process.cwd(),
        windowsHide: true,
        env: { ...process.env, DATABASE_URL: '', TEAM_AGENT_SERVER_DATA_DIR: root },
      },
    );
  expect((await invoke('SELECT count(*)::int AS n FROM users;')).stdout).toContain('返回 1 行');
  expect((await invoke('\\tables')).stdout).toContain('users');
  expect((await invoke('\\describe users')).stdout).toContain('password_hash');
  await expect(invoke('DELETE FROM users')).rejects.toThrow('仅接受一条');
});
