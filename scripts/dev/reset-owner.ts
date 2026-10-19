import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDatabase } from '@team-agent/database';
import { readConfig } from '../../apps/api/src/config/config.js';
import { protectPrivatePath } from '../../apps/api/src/common/private-storage.js';
import { AuthService } from '../../apps/api/src/modules/auth/auth-service.js';

const config = readConfig();
await protectPrivatePath(config.dataDir);
const db = await createDatabase({
  url: config.databaseUrl,
  dataDir: config.dataDir,
  projectRoot: config.projectRoot,
});
try {
  const password = 'Ta!' + randomBytes(24).toString('base64url');
  await new AuthService(db, config).resetOwnerFromLocalOperator(password);
  const path = resolve(config.dataDir, 'private', 'owner-recovery.json');
  await protectPrivatePath(resolve(config.dataDir, 'private'));
  await writeFile(path, JSON.stringify({ email: config.ownerEmail, password }, null, 2), {
    mode: 0o600,
  });
  await protectPrivatePath(path, false);
  // Never print the password, including in normal terminal history or CI logs.
  console.log('Owner 密码已由本机运维重置，所有 Owner 会话已撤销。凭据保存在：' + path);
} finally {
  await db.close();
}
