import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
const root = process.cwd();
if (!existsSync(resolve(root, '.env.local'))) throw new Error('请先运行 pnpm run setup');
const children = [
  spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/main.ts'], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  }),
  spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts'],
    { cwd: root, stdio: 'inherit', windowsHide: true },
  ),
];
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {}
    } else child.kill('SIGTERM');
  }
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
children.forEach((child) =>
  child.on('exit', (code) => {
    if (!stopping) {
      console.error('开发进程退出，状态码：' + code);
      stop();
      process.exitCode = code || 0;
    }
  }),
);
