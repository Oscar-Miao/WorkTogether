import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const probe = createServer();
await new Promise((done) => probe.listen(0, '127.0.0.1', done));
const port = probe.address().port;
await new Promise((done) => probe.close(done));
await mkdir(resolve('.local/reports/build-smoke'), { recursive: true });
const dataDir = await mkdtemp(resolve('.local/reports/build-smoke/run-'));
const password = 'Synthetic-smoke-' + randomUUID(),
  origin = 'http://127.0.0.1:' + port;
const child = spawn(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    "process.env.DATABASE_URL='';await import('./apps/api/dist/main.js')",
  ],
  {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      COORDINATOR_ENABLED: 'false',
      OIDC_ISSUER: '',
      OIDC_CLIENT_ID: '',
      DATABASE_URL: '',
      API_HOST: '127.0.0.1',
      API_PORT: String(port),
      WEB_ORIGIN: origin,
      TEAM_AGENT_SERVER_DATA_DIR: dataDir,
      OWNER_EMAIL: 'smoke@example.invalid',
      OWNER_PASSWORD: password,
    },
  },
);
let diagnostic = '';
child.stderr.on('data', (chunk) => {
  diagnostic = (diagnostic + chunk.toString()).slice(-3000);
});
child.stdout.resume();
try {
  const deadline = Date.now() + 30000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Packaged API exited: ' + diagnostic);
    try {
      const response = await fetch(origin + '/api/v1/health');
      const body = await response.json();
      if (response.ok && body.data?.status === 'ok' && body.request_id) {
        healthy = true;
        break;
      }
    } catch {}
    await new Promise((done) => setTimeout(done, 150));
  }
  if (!healthy) throw new Error('Packaged API did not become healthy: ' + diagnostic);
  const page = await fetch(origin);
  if (!page.ok || !(await page.text()).includes('id="root"'))
    throw new Error('Built Web not served');
  const login = await fetch(origin + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ email: 'smoke@example.invalid', password }),
  });
  if (!login.ok) throw new Error('Packaged login failed: ' + login.status);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  const bootstrap = await fetch(origin + '/api/v1/bootstrap', { headers: { Cookie: cookie } });
  const result = await bootstrap.json();
  if (!bootstrap.ok || result.data?.user?.role !== 'OWNER' || !result.request_id)
    throw new Error('Packaged bootstrap failed');
  const chat = await fetch(origin + '/api/v2/bootstrap', { headers: { Cookie: cookie } });
  const chatResult = await chat.json();
  if (
    !chat.ok ||
    !Array.isArray(chatResult.data?.groups) ||
    chatResult.data?.policy?.enabled !== false
  )
    throw new Error('Packaged v2 chat bootstrap failed');
  // 通过正式产物创建新项目，避免只验证默认项目而遗漏动态服务工厂与迁移。
  async function post(path, body) {
    const response = await fetch(origin + path, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'X-CSRF-Token': chatResult.data.user.csrf,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) throw new Error('打包进阶请求失败：' + path + ' ' + JSON.stringify(value));
    return value.data;
  }
  const workspace = await post('/api/v3/workspaces', { name: '打包验证空间' });
  const project = await post('/api/v3/workspaces/' + workspace.id + '/projects', {
    name: '打包验证项目',
  });
  const prefix = '/p/' + project.id;
  const projectBootstrap = await fetch(origin + prefix + '/api/v2/bootstrap', {
    headers: { Cookie: cookie },
  });
  const projectResult = await projectBootstrap.json();
  if (
    !projectBootstrap.ok ||
    projectResult.data?.project?.id !== project.id ||
    projectResult.data.groups.length !== 0
  )
    throw new Error('打包项目隔离验证失败');
  const group = await post(prefix + '/api/v2/groups', { title: '打包新群', visibility: 'private' });
  const feed = await fetch(origin + prefix + '/api/v2/groups/' + group.id + '/feed', {
    headers: { Cookie: cookie },
  });
  if (!feed.ok) throw new Error('打包新群不可访问');
  const rootBootstrap = await fetch(origin + '/api/v2/bootstrap', { headers: { Cookie: cookie } });
  if ((await rootBootstrap.json()).data.groups.some((g) => g.id === group.id))
    throw new Error('打包项目群聊发生范围泄漏');
  console.log(
    '正式 API/Web、根身份、动态项目命名空间、新群与默认项目隔离验证通过（独立 PGlite）。',
  );
} finally {
  if (child.exitCode === null) {
    if (process.platform === 'win32')
      await exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(
        () => {},
      );
    else child.kill('SIGTERM');
    await new Promise((done) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        done();
        return;
      }
      child.once('exit', done);
      setTimeout(done, 5000).unref();
    });
  }
}
