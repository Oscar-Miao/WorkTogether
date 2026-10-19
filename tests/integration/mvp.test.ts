import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { createApplication } from '../../apps/api/src/application.js';
import {
  pairBridge,
  authenticate,
  apiRequest,
  type BridgeConfig,
} from '../../apps/bridge/src/config/config.js';
import { BridgeClient } from '../../apps/bridge/src/bridge-client.js';
import { createDatabase } from '../../packages/database/src/index.js';
import { PermitSigner } from '../../apps/api/src/common/security.js';
import { descriptorFingerprint } from '../../packages/domain/src/index.js';
import type { Task, TaskInput } from '@team-agent/contracts';

const exec = promisify(execFile);
type Session = { cookie: string; csrf: string };
const password = 'Test-only-' + randomUUID();
let server: Awaited<ReturnType<typeof createApplication>>;
let serverClosed = false;
let url: string, directory: string, repository: string, config: BridgeConfig;
let owner: Session, member: Session, token: string, bridge: BridgeClient | undefined;
let conversation: string, source: { id: string; version: number }, privateSource: { id: string };
const origin = 'http://127.0.0.1:5173';

async function request(
  path: string,
  body?: unknown,
  session?: Session,
  status = 201,
  key = randomUUID(),
) {
  const response = await fetch(url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }),
      ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = (await response.json()) as any;
  expect(response.status, JSON.stringify(result)).toBe(
    body === undefined && status === 201 ? 200 : status,
  );
  return { data: result.data as any, error: result.error as any, response };
}
async function login(email: string): Promise<Session> {
  const result = await request('/api/v1/auth/login', { email, password });
  return {
    cookie: result.response.headers.get('set-cookie')!.split(';')[0],
    csrf: result.data.csrf,
  };
}
function input(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    conversation_id: conversation,
    goal: '检查项目结构并列出真实代码文件',
    constraints: ['禁止修改、提交或推送代码'],
    acceptance: ['报告列出实际读取的仓库信息', '未运行测试必须说明'],
    source_refs: [],
    memory_refs: [],
    repository_binding_id: config.repository.id,
    base_commit: '',
    execution_profile: 'code_review',
    budget: { wall_time_seconds: 30, max_model_calls: 5 },
    ...overrides,
  };
}
let commit = '';
async function create(overrides: Partial<TaskInput> = {}, key = randomUUID()): Promise<Task> {
  const result = await request(
    '/api/v1/tasks',
    input({ base_commit: commit, ...overrides }),
    member,
    201,
    key,
  );
  return (await request('/api/v1/tasks/' + result.data.id, undefined, owner)).data;
}
async function approve(task: Task) {
  return request(
    '/api/v1/tasks/' + task.id + '/approve',
    { input_version: task.input_version, version: task.version, snapshot_hash: task.snapshot.hash },
    owner,
  );
}
async function until<T>(
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  timeout = 20000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const result = await read();
    if (accepts(result)) return result;
    await new Promise((r) => setTimeout(r, 25));
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for verified state');
}
const task = async (id: string) =>
  (await request('/api/v1/tasks/' + id, undefined, owner)).data as Task;

beforeAll(async () => {
  await mkdir(resolve('.local/reports/integration'), { recursive: true });
  directory = await mkdtemp(resolve('.local/reports/integration/run-'));
  repository = resolve(directory, 'fixture-repo');
  await mkdir(resolve(repository, 'src'), { recursive: true });
  await writeFile(
    resolve(repository, 'src/calculator.ts'),
    'export const add = (a: number, b: number) => a + b;\n',
  );
  await writeFile(resolve(repository, 'README.md'), '# Synthetic test repository\n');
  await exec('git', ['init', '-b', 'main', repository], { windowsHide: true });
  await exec('git', ['-C', repository, 'add', '.'], { windowsHide: true });
  await exec(
    'git',
    [
      '-C',
      repository,
      '-c',
      'user.name=Test Fixture',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'fixture',
    ],
    { windowsHide: true },
  );
  commit = (await exec('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
  server = await createApplication({
    dataDir: resolve(directory, 'server'),
    databaseUrl: undefined,
    ownerEmail: 'owner@test.local',
    ownerPassword: password,
    production: false,
    webOrigin: origin,
  });
  await server.app.listen(0, '127.0.0.1');
  url = 'http://127.0.0.1:' + server.app.getHttpServer().address().port;
  owner = await login('owner@test.local');
  const invite = (await request('/api/v1/invitations', { email: 'member@test.local' }, owner)).data;
  await request('/api/v1/invitations/accept', { token: invite.token, name: '测试成员', password });
  await request(
    '/api/v1/invitations/accept',
    { token: invite.token, name: '重复成员', password },
    undefined,
    410,
  );
  member = await login('member@test.local');
  conversation = (await request('/api/v1/conversations', { title: '真实链路测试' }, member)).data
    .id;
  source = (
    await request(
      '/api/v1/sources',
      { name: '验收规范', content: '未运行测试必须明确披露。', visibility: 'shared' },
      owner,
    )
  ).data;
  privateSource = (
    await request(
      '/api/v1/sources',
      { name: 'Owner 私有资料', content: 'synthetic-private-secret', visibility: 'owner' },
      owner,
    )
  ).data;
  const code = (await request('/api/v1/pairing-codes', {}, owner)).data.code;
  config = await pairBridge({
    dataDir: resolve(directory, 'bridge'),
    api: url,
    code,
    repo: repository,
    runtime: 'inspection',
    allowedWritePrefixes: [],
  });
  token = (await authenticate(config)).access_token;
  await apiRequest(
    url,
    '/bridge/v1/repositories',
    {
      repositories: [
        {
          id: config.repository.id,
          name: 'fixture',
          base_commit: commit,
          branch: 'main',
          capabilities: ['file_read', 'file_search'],
        },
      ],
    },
    token,
  );
}, 60000);

afterAll(async () => {
  if (bridge) await bridge.close();
  if (server && !serverClosed) await server.close();
});

describe('MVP authority and actual execution', () => {
  it('blocks unauthenticated access, CSRF omission and Member administration', async () => {
    await request('/api/v1/bootstrap', undefined, undefined, 401);
    await request('/api/v1/conversations', { title: 'invalid' }, { ...member, csrf: '' }, 403);
    await request('/api/v1/pairing-codes', {}, member, 403);
    await request('/api/v1/invitations', { email: 'x@test.local' }, member, 403);
    const sources = (await request('/api/v1/sources', undefined, member)).data;
    expect(sources.some((x: any) => x.id === privateSource.id)).toBe(false);
    expect(
      (await server.services.db.query("SELECT id FROM audit_logs WHERE action='request.denied'"))
        .length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('persists a message once and does not turn plain @AI text into a task', async () => {
    const before = (await request('/api/v1/tasks', undefined, member)).data.length;
    const body = { body: '@AI 这里只是讨论，不授权执行。', client_message_id: randomUUID() };
    const a = (await request('/api/v1/conversations/' + conversation + '/messages', body, member))
      .data;
    const b = (await request('/api/v1/conversations/' + conversation + '/messages', body, member))
      .data;
    expect(a.id).toBe(b.id);
    expect((await request('/api/v1/tasks', undefined, member)).data.length).toBe(before);
  });

  it('serializes concurrent idempotent submissions and rejects key reuse for different input', async () => {
    const key = randomUUID(),
      body = input({ base_commit: commit });
    const [a, b] = await Promise.all([
      request('/api/v1/tasks', body, member, 201, key),
      request('/api/v1/tasks', body, member, 201, key),
    ]);
    expect(a.data.id).toBe(b.data.id);
    await request('/api/v1/tasks', { ...body, goal: 'different task' }, member, 409, key);
  });

  it('enforces approval role and refuses private context or unsupported write capability', async () => {
    const t = await create();
    await request(
      '/api/v1/tasks/' + t.id + '/approve',
      { input_version: t.input_version, version: t.version, snapshot_hash: t.snapshot.hash },
      member,
      403,
    );
    await request(
      '/api/v1/tasks',
      input({ base_commit: commit, source_refs: [{ source_id: privateSource.id, version: 1 }] }),
      member,
      409,
    );
    await request(
      '/api/v1/tasks',
      input({ base_commit: commit, execution_profile: 'code_edit' }),
      member,
      409,
    );
  });

  it('invalidates stale source approvals and keeps the old source version immutable', async () => {
    const t = await create({ source_refs: [{ source_id: source.id, version: source.version }] });
    await approve(t);
    await request(
      '/api/v1/sources/' + source.id + '/versions',
      { content: '新版验收：先审阅证据。', version: source.version },
      owner,
    );
    const updated = await task(t.id);
    expect(updated.state).toBe('PENDING_APPROVAL');
    expect(updated.approval).toBeNull();
    await request(
      '/api/v1/tasks/' + t.id + '/approve',
      {
        input_version: updated.input_version,
        version: updated.version,
        snapshot_hash: updated.snapshot.hash,
      },
      owner,
      409,
    );
    expect(
      (
        await server.services.db.query(
          'SELECT content FROM source_versions WHERE source_id=$1 AND version=1',
          [source.id],
        )
      )[0].content,
    ).toBe('未运行测试必须明确披露。');
    source.version = 2;
  });

  it('requires confirmed memory and restricts original-context readback to its attempt', async () => {
    const memory = (
      await request(
        '/api/v1/memories',
        {
          title: '核查规则',
          content: '成果需要人工核查。',
          source_refs: [{ source_id: source.id, version: source.version }],
        },
        member,
      )
    ).data;
    await request('/api/v1/memories/' + memory.id + '/confirm', {}, member, 403);
    await request('/api/v1/memories/' + memory.id + '/confirm', {}, owner);
    const t = await create({
      source_refs: [{ source_id: source.id, version: source.version }],
      memory_refs: [{ memory_id: memory.id, version: 1 }],
    });
    await approve(t);
    const dispatch = await server.services.tasks.claim(config.deviceId);
    expect(dispatch?.descriptor.task_id).toBe(t.id);
    const attempt = dispatch!.descriptor.attempt_id;
    await server.services.tasks.started(config.deviceId, attempt);
    const lease = await server.services.tasks.lease(config.deviceId, attempt);
    const path = '/bridge/v1/attempts/' + attempt + '/context/';
    const result = await apiRequest<any>(url, path + source.id, undefined, lease.context_permit);
    expect(result.content).toBe('新版验收：先审阅证据。');
    await expect(
      apiRequest(url, path + privateSource.id, undefined, lease.context_permit),
    ).rejects.toThrow('CONTEXT_SCOPE_DENIED');
    await expect(
      apiRequest(url, path + source.id, undefined, dispatch!.start_permit),
    ).rejects.toThrow('CONTEXT_SCOPE_DENIED');
    await request('/api/v1/tasks/' + t.id + '/cancel', {}, owner);
    await expect(
      apiRequest(url, path + source.id, undefined, lease.context_permit),
    ).rejects.toThrow('CONTEXT_LEASE_REVOKED');
    await apiRequest(
      url,
      '/bridge/v1/attempts/' + attempt + '/finish',
      {
        result: {
          status: 'cancelled',
          report: 'Synthetic protocol test; no local process launched.',
          diff: '',
          verification: 'not_run',
        },
        stop_evidence: 'protocol fixture never launched an operating-system process',
      },
      token,
    );
  });

  it('persists an authenticated pre-spawn refusal and safely replays it', async () => {
    const t = await create();
    await approve(t);
    const dispatch = await server.services.tasks.claim(config.deviceId);
    expect(dispatch).toBeTruthy();
    const refused = new BridgeClient(
      { ...config, repository: { ...config.repository, id: 'repo_wrong_local_binding' } },
      resolve(directory, 'refused-bridge'),
    );
    try {
      (refused as any).token = token;
      await (refused as any).execute(dispatch);
      await (refused as any).execute(dispatch);
      const attempts = refused.ledger.list();
      expect(attempts).toHaveLength(1);
      expect(attempts[0].status).toBe('stopped');
      expect(attempts[0].pid).toBeNull();
      expect(attempts[0].result?.error_code).toBe('DISPATCH_REJECTED');
      expect(attempts[0].finish_ack).toBe(true);
      expect((await task(t.id)).state).toBe('FAILED');
      // No worktree preparation was invoked for the rejected binding.
      await expect(
        readFile(
          resolve(directory, 'refused-bridge/worktrees', t.id, attempts[0].id, 'src/calculator.ts'),
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await refused.close();
    }
  });

  it('executes via outbound WebSocket and actual worktree, then publishes explicitly', async () => {
    bridge = new BridgeClient(config, resolve(directory, 'bridge'));
    await bridge.start();
    await until(
      () => server.services.devices.list(),
      (devices) => devices.some((d) => d.status === 'online'),
    );
    const t = await create();
    await approve(t);
    const running = await until(
      () => task(t.id),
      (value) => value.state === 'RUNNING',
    );
    const descriptor = (
      await server.services.db.query('SELECT descriptor FROM execution_attempts WHERE id=$1', [
        running.attempt_id,
      ])
    )[0].descriptor;
    const hash = createHash('sha256').update(descriptorFingerprint(descriptor)).digest('hex');
    const signer = await PermitSigner.load(resolve(directory, 'server'));
    const permit = await signer.sign(
      {
        task_id: t.id,
        attempt_id: running.attempt_id,
        device_id: config.deviceId,
        input_version: descriptor.input_version,
        descriptor_hash: hash,
      },
      new Date(Date.now() + 60000),
    );
    // Replay over the real transport, including the race while the first invocation is active.
    for (let replay = 0; replay < 10; replay++)
      (server.services.gateway as any).send(config.deviceId, {
        type: 'dispatch',
        protocol_version: '1',
        descriptor,
        descriptor_hash: hash,
        start_permit: permit,
      });
    const finished = await until(
      () => task(t.id),
      (value) => ['SUCCEEDED', 'FAILED'].includes(value.state),
    );
    expect(finished.state, finished.error_code || '').toBe('SUCCEEDED');
    expect(finished.artifacts[0].content).toContain('未调用 AI 模型');
    const attempts = bridge.ledger.list().filter((a) => a.task_id === t.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe('stopped');
    expect(
      await readFile(
        resolve(directory, 'bridge/worktrees', t.id, attempts[0].id, 'src/calculator.ts'),
        'utf8',
      ),
    ).toContain('export const add');
    expect((await request('/api/v1/tasks/' + t.id, undefined, member)).data.artifacts).toHaveLength(
      0,
    );
    await request(
      '/api/v1/tasks/' + t.id + '/artifacts/' + finished.artifacts[0].id + '/publish',
      {},
      member,
      403,
    );
    await request(
      '/api/v1/tasks/' + t.id + '/artifacts/' + finished.artifacts[0].id + '/publish',
      {},
      owner,
    );
    expect((await request('/api/v1/tasks/' + t.id, undefined, member)).data.artifacts).toHaveLength(
      1,
    );
  });

  it('confirms cancellation without rolling back or inventing successful tests', async () => {
    const t = await create();
    await approve(t);
    await until(
      () => task(t.id),
      (value) => value.state === 'RUNNING',
    );
    await request('/api/v1/tasks/' + t.id + '/cancel', {}, owner);
    const finished = await until(
      () => task(t.id),
      (value) => ['CANCELLED', 'FAILED', 'SUCCEEDED'].includes(value.state),
    );
    expect(finished.state).toBe('CANCELLED');
    expect(bridge!.ledger.list().find((a) => a.task_id === t.id)?.stop_evidence).toBeTruthy();
  });

  it('runs two approved tasks serially instead of sharing a writable checkout', async () => {
    const a = await create(),
      b = await create();
    await Promise.all([approve(a), approve(b)]);
    await until(
      () => Promise.all([task(a.id), task(b.id)]),
      (values) => values.every((v) => v.state === 'SUCCEEDED'),
    );
    const attempts = await server.services.db.query(
      'SELECT started_at,stopped_at FROM execution_attempts WHERE task_id IN ($1,$2) ORDER BY started_at',
      [a.id, b.id],
    );
    expect(attempts).toHaveLength(2);
    expect(new Date(attempts[1].started_at).getTime()).toBeGreaterThanOrEqual(
      new Date(attempts[0].stopped_at).getTime(),
    );
  });

  it('accepts only a signed stop receipt after device revocation', async () => {
    const t = await create();
    await approve(t);
    await until(
      () => task(t.id),
      (value) => value.state === 'RUNNING',
    );
    await request('/api/v1/devices/' + config.deviceId + '/revoke', {}, owner);
    await expect(
      apiRequest(url, '/bridge/v1/repositories', { repositories: [] }, token),
    ).rejects.toThrow('DEVICE_AUTH_REQUIRED');
    const finished = await until(
      () => task(t.id),
      (value) => ['SUCCEEDED', 'CANCELLED', 'FAILED'].includes(value.state),
    );
    expect(finished.state).not.toBe('RECONCILING');
    const receipts = await server.services.db.query(
      "SELECT id FROM audit_logs WHERE action='execution.stop_receipt' AND object_id=$1",
      [finished.attempt_id],
    );
    expect(receipts.length).toBeGreaterThan(0);
  });

  it('revokes a removed member project access immediately while preserving their account', async () => {
    const users = (await request('/api/v1/members', undefined, owner)).data;
    await request(
      '/api/v1/members/' + users.find((u: any) => u.role === 'MEMBER').id + '/remove',
      {},
      owner,
    );
    await request('/api/v1/bootstrap', undefined, member, 404);
    expect((await request('/api/v1/me', undefined, member)).data.role).toBe('MEMBER');
  });

  it('protects the active local database and recovers Owner credentials through audited maintenance', async () => {
    await expect(
      createDatabase({ dataDir: resolve(directory, 'server'), projectRoot: resolve('.') }),
    ).rejects.toThrow('LOCAL_DATABASE_IN_USE');
    await bridge!.close();
    bridge = undefined;
    await server.close();
    serverClosed = true;
    await exec(process.execPath, ['--import', 'tsx', 'scripts/dev/reset-owner.ts'], {
      cwd: resolve('.'),
      windowsHide: true,
      env: {
        ...process.env,
        DATABASE_URL: '',
        TEAM_AGENT_SERVER_DATA_DIR: resolve(directory, 'server'),
        OWNER_EMAIL: 'owner@test.local',
      },
    });
    const recovered = JSON.parse(
      await readFile(resolve(directory, 'server/private/owner-recovery.json'), 'utf8'),
    );
    server = await createApplication({
      dataDir: resolve(directory, 'server'),
      databaseUrl: undefined,
      production: false,
      ownerEmail: 'owner@test.local',
      ownerPassword: password,
      webOrigin: origin,
    });
    serverClosed = false;
    await server.app.listen(0, '127.0.0.1');
    url = 'http://127.0.0.1:' + server.app.getHttpServer().address().port;
    await request('/api/v1/bootstrap', undefined, owner, 401);
    await request('/api/v1/auth/login', { email: 'owner@test.local', password }, undefined, 401);
    const loginResult = await request('/api/v1/auth/login', {
      email: recovered.email,
      password: recovered.password,
    });
    expect(loginResult.data.role).toBe('OWNER');
    expect(
      (
        await server.services.db.query(
          "SELECT id FROM audit_logs WHERE action='owner.password_reset'",
        )
      ).length,
    ).toBe(1);
    expect((await server.services.db.query('SELECT id FROM tasks')).length).toBeGreaterThan(0);
  });
});
