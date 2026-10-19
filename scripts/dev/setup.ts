import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDatabase } from '@team-agent/database';
import { readConfig } from '../../apps/api/src/config/config.js';
import { protectPrivatePath } from '../../apps/api/src/common/private-storage.js';
import { AuthService } from '../../apps/api/src/modules/auth/auth-service.js';

const root = resolve(process.cwd());
if (!existsSync(resolve(root, 'pnpm-workspace.yaml')))
  throw new Error('请在 demo 工程根执行 pnpm run setup');
const envFile = resolve(root, '.env.local');
let generated: { email: string; password: string } | undefined;
if (!existsSync(envFile)) {
  if (existsSync(resolve(root, '.local/server/postgres/PG_VERSION')))
    throw new Error(
      '已有本地数据库但缺少配置；请按恢复手册恢复 .env.local，避免生成错误的 Owner 凭据',
    );
  generated = {
    email: 'owner@team.local',
    password: 'Ta!' + randomBytes(18).toString('base64url'),
  };
  await writeFile(
    envFile,
    [
      'API_HOST=127.0.0.1',
      'API_PORT=3001',
      'WEB_ORIGIN=http://127.0.0.1:5173',
      'TEAM_AGENT_SERVER_DATA_DIR=.local/server',
      'TEAM_AGENT_BRIDGE_DATA_DIR=.local/bridge/default',
      'OWNER_EMAIL=' + generated.email,
      'OWNER_PASSWORD=' + generated.password,
      'NODE_ENV=development',
      'PI_PROVIDER=anthropic',
      'PI_MODEL=',
      '',
    ].join('\n'),
    { flag: 'wx', mode: 0o600 },
  );
}
await protectPrivatePath(envFile, false);
const config = readConfig();
await protectPrivatePath(config.dataDir);
const db = await createDatabase({
  url: config.databaseUrl,
  dataDir: config.dataDir,
  projectRoot: root,
});
try {
  await new AuthService(db, config).bootstrapOwner();
  if (generated) {
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(
      resolve(config.dataDir, 'bootstrap-owner.json'),
      JSON.stringify(generated, null, 2),
      { mode: 0o600 },
    );
    console.log('已生成本机 Owner 凭据：.local/server/bootstrap-owner.json（不提交版本库）');
  }
  console.log('初始化完成。运行 pnpm dev，打开 http://127.0.0.1:5173');
} finally {
  await db.close();
}
