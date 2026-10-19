import { seedBrowserHistory } from './history.js';
import { createApplication } from '../../apps/api/src/application.js';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// A separate database and synthetic credentials keep browser tests out of the user's workspace.
await mkdir(resolve('.local/reports/e2e'), { recursive: true });
const root = await mkdtemp(resolve('.local/reports/e2e/run-'));
const app = await createApplication({
  dataDir: resolve(root, 'server'),
  databaseUrl: undefined,
  production: false,
  port: 3002,
  webOrigin: 'http://127.0.0.1:4173',
  ownerEmail: 'browser@test.local',
  ownerPassword: 'Browser-test-only-password-2026',
});
await seedBrowserHistory(app.services.db);
await app.app.listen(3002, '127.0.0.1');
const web = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts', '--port', '4173'],
  {
    cwd: process.cwd(),
    env: { ...process.env, VITE_API_TARGET: 'http://127.0.0.1:3002' },
    stdio: 'inherit',
    windowsHide: true,
  },
);
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  web.kill();
  await app.close();
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
web.on('exit', () => void stop());
