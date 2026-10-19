import { expect, test } from 'vitest';
import { mkdtemp, mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDatabase } from '../../packages/database/src/index.js';
import { seedBrowserHistory } from '../fixtures/history.js';
test('an existing v1 database migrates without losing messages, tasks or full document text', async () => {
  await mkdir('.local/reports/migration', { recursive: true });
  const root = await mkdtemp(resolve('.local/reports/migration/run-')),
    legacyRoot = resolve(root, 'legacy'),
    dataDir = resolve(root, 'data');
  await mkdir(resolve(legacyRoot, 'packages/database/migrations'), { recursive: true });
  for (const file of ['0001-initial.sql', '0002-history-indexes.sql', '0003-retention-markers.sql'])
    await copyFile(
      resolve('packages/database/migrations', file),
      resolve(legacyRoot, 'packages/database/migrations', file),
    );
  const legacy = await createDatabase({ dataDir, projectRoot: legacyRoot });
  try {
    await legacy.query(
      "INSERT INTO users(id,email,name,password_hash,role) VALUES('usr_migration_owner','migration@example.invalid','旧维护者','not-a-login-hash','OWNER')",
    );
    await legacy.query(
      "INSERT INTO conversations(id,title,created_by) VALUES('conv_general','项目讨论','usr_migration_owner')",
    );
    await seedBrowserHistory(legacy);
  } finally {
    await legacy.close();
  }
  const upgraded = await createDatabase({ dataDir, projectRoot: process.cwd() });
  try {
    expect((await upgraded.query('SELECT count(*)::int AS count FROM tasks'))[0].count).toBe(25);
    expect(
      (await upgraded.query('SELECT count(*)::int AS count FROM collaboration_goals'))[0].count,
    ).toBe(25);
    expect(
      (
        await upgraded.query(
          "SELECT count(*)::int AS count FROM messages WHERE conversation_id='conv_general'",
        )
      )[0].count,
    ).toBeGreaterThan(40);
    expect(
      (
        await upgraded.query(
          "SELECT content FROM source_versions WHERE source_id='src_history_00' AND version=1",
        )
      )[0].content,
    ).toContain('完整资料末尾校验标记');
    expect(
      (
        await upgraded.query(
          "SELECT state FROM collaboration_goals WHERE task_id='task_history_00'",
        )
      )[0].state,
    ).toBe('REJECTED');
    expect(
      (await upgraded.query('SELECT count(*)::int AS count FROM group_members'))[0].count,
    ).toBe(26);
  } finally {
    await upgraded.close();
  }
});
