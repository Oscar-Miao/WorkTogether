import { beforeAll, afterAll, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApplication } from '../../apps/api/src/application.js';
import { pairBridge, readBridgeConfig } from '../../apps/bridge/src/config/config.js';
import { BridgeClient } from '../../apps/bridge/src/bridge-client.js';

const exec = promisify(execFile),
  password = 'Advanced-' + randomUUID(),
  origin = 'http://127.0.0.1:5173';
let server: Awaited<ReturnType<typeof createApplication>>,
  url: string,
  root: string,
  project: string,
  otherProject: string,
  group: string,
  memberId: string;
type Session = { cookie: string; csrf: string };
let admin: Session, member: Session;
const bridges: BridgeClient[] = [];
async function request(
  path: string,
  body?: unknown,
  session = admin,
  status = body === undefined ? 200 : 201,
) {
  const response = await fetch(url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: origin,
      ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}),
      ...(body === undefined
        ? {}
        : { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = (await response.json()) as any;
  expect(response.status, JSON.stringify(value)).toBe(status);
  return { ...value, response };
}
const scoped = (
  path: string,
  body?: unknown,
  session = admin,
  status = body === undefined ? 200 : 201,
) => request('/p/' + project + path, body, session, status);
async function login(email: string) {
  const r = await request('/api/v1/auth/login', { email, password }, undefined as any);
  return { cookie: r.response.headers.get('set-cookie')!.split(';')[0], csrf: r.data.csrf };
}
async function until<T>(read: () => Promise<T>, accept: (v: T) => boolean) {
  const end = Date.now() + 25000;
  do {
    const v = await read();
    if (accept(v)) return v;
    await new Promise((r) => setTimeout(r, 75));
  } while (Date.now() < end);
  throw new Error('进阶场景没有得到可核查状态');
}
const feed = async () => (await scoped('/api/v2/groups/' + group + '/feed')).data;
async function candidate(title: string) {
  await scoped('/api/v2/groups/' + group + '/messages', {
    body: '我来做 ' + title,
    client_message_id: randomUUID(),
  });
  return until(
    async () => (await feed()).goals.find((g: any) => g.title === title),
    (g: any) => g?.state === 'CANDIDATE',
  );
}
beforeAll(async () => {
  vi.stubEnv('COORDINATOR_ENABLED', 'false');
  await mkdir('.local/reports/advanced-integration', { recursive: true });
  root = await mkdtemp(resolve('.local/reports/advanced-integration/run-'));
  server = await createApplication({
    dataDir: resolve(root, 'server'),
    databaseUrl: undefined,
    ownerEmail: 'advanced@team.test',
    ownerPassword: password,
    production: false,
    webOrigin: origin,
  });
  await server.app.listen(0, '127.0.0.1');
  url = 'http://127.0.0.1:' + server.app.getHttpServer().address().port;
  admin = await login('advanced@team.test');
  const invite = (await request('/api/v1/invitations', { email: 'member@advanced.test' })).data;
  await request(
    '/api/v1/invitations/accept',
    { token: invite.token, name: '林可', password },
    undefined as any,
  );
  member = await login('member@advanced.test');
  memberId = (await request('/api/v2/bootstrap', undefined, member)).data.user.id;
});
afterAll(async () => {
  for (const b of bridges) await b.close();
  await server?.close();
  vi.unstubAllEnvs();
});
test('两个空间四个项目独立，成员不能读取其他项目的群和资料', async () => {
  const first = (await request('/api/v3/workspaces', { name: '研发空间' })).data.id;
  const second = (await request('/api/v3/workspaces', { name: '交付空间' })).data.id;
  project = (await request('/api/v3/workspaces/' + first + '/projects', { name: '客户端' })).data
    .id;
  await request('/api/v3/workspaces/' + first + '/projects', { name: '服务端' });
  otherProject = (await request('/api/v3/workspaces/' + second + '/projects', { name: '交付一组' }))
    .data.id;
  await request('/api/v3/workspaces/' + second + '/projects', { name: '交付二组' });
  expect((await request('/api/v3/projects')).data).toHaveLength(5);
  await request(
    '/api/v3/projects/' + project + '/members',
    { email: 'advanced@team.test', role: 'member' },
    admin,
    409,
  );
  await request('/api/v3/projects/' + project + '/members', {
    email: 'member@advanced.test',
    role: 'member',
  });
  const source = (
    await scoped('/api/v1/sources', {
      name: '客户端私域资料',
      content: 'PROJECT_A_ONLY',
      visibility: 'shared',
    })
  ).data;
  expect((await scoped('/api/v2/bootstrap', undefined, member)).data.project.name).toBe('客户端');
  await request('/p/' + otherProject + '/api/v2/bootstrap', undefined, member, 404);
  await request('/api/v1/sources/' + source.id + '?version=1', undefined, admin, 404);
  const other = await request('/p/' + otherProject + '/api/v2/bootstrap');
  expect(other.data.sources).toHaveLength(0);
  const privateGroup = (
    await scoped('/api/v2/groups', { title: '成员私群', visibility: 'private' }, member)
  ).data.id;
  await scoped('/api/v2/groups/' + privateGroup + '/feed', undefined, admin, 404);
  const privateWorkspace = (await request('/api/v3/workspaces', { name: '成员独立空间' }, member))
    .data.id;
  const privateProject = (
    await request(
      '/api/v3/workspaces/' + privateWorkspace + '/projects',
      { name: '仅成员管理的项目' },
      member,
    )
  ).data.id;
  await request('/p/' + privateProject + '/api/v2/bootstrap', undefined, admin, 404);
  expect(
    (await request('/p/' + privateProject + '/api/v2/bootstrap', undefined, member)).data.user.role,
  ).toBe('OWNER');
  expect(JSON.stringify((await request('/api/v2/governance/audit')).data)).not.toContain(
    privateProject,
  );
  group = (await scoped('/api/v2/groups', { title: '协作深化组', visibility: 'public' })).data.id;
  await scoped('/api/v2/groups/' + group + '/join', {}, member);
});
test('分叉保留截止点，归档可读不可写，退出后派生群同步撤权', async () => {
  await scoped('/api/v2/groups/' + group + '/messages', {
    body: '已确认方案一',
    client_message_id: randomUUID(),
  });
  const cutoff = (await feed()).messages.at(-1).seq;
  const fork = (
    await scoped('/api/v2/groups/' + group + '/forks', {
      title: '方案二讨论',
      cutoff_seq: cutoff,
      reason: '保留祖先讨论后探索不同方案',
    })
  ).data.id;
  await scoped('/api/v2/groups/' + group + '/messages', {
    body: '原群后续消息不可自动进入分叉',
    client_message_id: randomUUID(),
  });
  expect(
    JSON.stringify((await scoped('/api/v2/groups/' + fork + '/feed')).data.messages),
  ).not.toContain('后续消息不可');
  await scoped('/api/v2/groups/' + fork + '/lifecycle', { action: 'archive' });
  await scoped(
    '/api/v2/groups/' + fork + '/messages',
    { body: '不能写入归档群', client_message_id: randomUUID() },
    admin,
    409,
  );
  await scoped('/api/v2/groups/' + fork + '/lifecycle', { action: 'restore' });
  await scoped('/api/v2/groups/' + group + '/lifecycle', { action: 'leave' }, member);
  await scoped('/api/v2/groups/' + fork + '/feed', undefined, member, 404);
  await scoped('/api/v2/groups/' + group + '/join', {}, member);
});
test('人工交接由接手者确认，版本与重复确认受保护', async () => {
  const g = await candidate('梳理接口契约');
  await scoped('/api/v2/goals/' + g.id + '/claim', { version: g.version });
  const current = (await scoped('/api/v2/goals/' + g.id)).data.goal;
  const handoff = (
    await scoped('/api/v2/goals/' + g.id + '/handoffs', {
      to_user: memberId,
      note: '已整理登录接口，请继续核对支付接口',
      expected_version: current.version,
    })
  ).data.id;
  await scoped('/api/v2/handoffs/' + handoff + '/resolve', { accept: true }, member);
  expect((await scoped('/api/v2/goals/' + g.id, undefined, member)).data.goal.claimed_by).toBe(
    memberId,
  );
  await scoped('/api/v2/handoffs/' + handoff + '/resolve', { accept: true }, member, 404);
});
test('目标依赖拒绝环路，修订保留历史并重新判断', async () => {
  const a = await candidate('分析客户端错误处理'),
    b = await candidate('分析服务端重试策略');
  await scoped('/api/v2/goals/' + a.id + '/relations', {
    target_id: b.id,
    kind: 'depends_on',
    evidence: '先确认服务端重试契约，再分析客户端行为',
    expected_version: a.version,
    target_version: b.version,
  });
  await scoped(
    '/api/v2/goals/' + b.id + '/relations',
    {
      target_id: a.id,
      kind: 'depends_on',
      evidence: '反向依赖会形成循环',
      expected_version: b.version,
      target_version: a.version,
    },
    admin,
    409,
  );
  await scoped('/api/v2/goals/' + a.id + '/revisions', {
    title: '分析客户端错误处理的新版本',
    constraints: ['只读分析，不修改代码'],
    acceptance: ['列出明确的错误处理差异'],
    reason: '接口版本已更新，需要重新判断',
    expected_version: a.version,
  });
  const revised = await until(
    async () => (await scoped('/api/v2/goals/' + a.id)).data.goal,
    (g) => g.title === '分析客户端错误处理的新版本' && g.state !== 'STOPPING',
  );
  expect(revised.version).toBeGreaterThan(a.version);
  expect((await scoped('/api/v2/goals/' + a.id + '/coordination')).data.revisions[0].state).toBe(
    'applied',
  );
});
test('真实出站 Bridge 在项目路径下并行执行独立步骤，依赖随后推进且不冒充自动集成验收', async () => {
  await scoped('/api/v2/execution/limits', { devices: 3, parallel: 3 });
  const repositoryIds: string[] = [];
  for (let index = 0; index < 2; index++) {
    const repo = resolve(root, 'repo-' + index);
    await mkdir(resolve(repo, 'src'), { recursive: true });
    await writeFile(resolve(repo, 'src/index.ts'), 'export const value=' + index + ';');
    await exec('git', ['init', repo], { windowsHide: true });
    await exec('git', ['-C', repo, 'add', '.'], { windowsHide: true });
    await exec(
      'git',
      [
        '-C',
        repo,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'fixture',
      ],
      { windowsHide: true },
    );
    const code = (await scoped('/api/v1/pairing-codes', {})).data.code;
    const config = await pairBridge({
      dataDir: resolve(root, 'bridge-' + index),
      api: url + '/p/' + project,
      code,
      repo,
      runtime: 'inspection',
      allowedWritePrefixes: [],
    });
    const bridge = new BridgeClient(config, resolve(root, 'bridge-' + index));
    bridges.push(bridge);
    repositoryIds.push(config.repository.id);
    await bridge.start();
  }
  const boot = await until(
    async () => (await scoped('/api/v2/bootstrap')).data,
    (v) => v.devices.filter((d: any) => d.status === 'online').length === 2,
  );
  await scoped('/api/v2/node-policy', {
    enabled: true,
    repository_id: repositoryIds[0],
    allow_edit: false,
    wall_time_seconds: 30,
    max_model_calls: 4,
    expected_version: boot.policy_version,
  });
  const goal = await candidate('联合分析前后端实现');
  const plan = (
    await scoped('/api/v2/goals/' + goal.id + '/plans', {
      expected_version: goal.version,
      steps: [
        {
          name: 'frontend',
          goal: '分析客户端模块结构',
          repository_id: repositoryIds[0],
          dependencies: [],
        },
        {
          name: 'backend',
          goal: '分析服务端模块结构',
          repository_id: repositoryIds[1],
          dependencies: [],
        },
        {
          name: 'integration',
          goal: '对照前后端接口报告整理差异',
          repository_id: repositoryIds[0],
          dependencies: ['frontend', 'backend'],
        },
      ],
    })
  ).data.id;
  const detail = await until(
    async () => (await scoped('/api/v2/goals/' + goal.id + '/coordination')).data,
    (v) => v.plans.find((p: any) => p.id === plan)?.state === 'awaiting_verification',
  );
  expect(detail.steps.every((s: any) => s.state === 'completed')).toBe(true);
  expect((await scoped('/api/v2/goals/' + goal.id)).data.goal.state).toBe('APPROVED');
  const services = await server.services.organization!.open(project);
  const attempts = await services.db.query(
    'SELECT s.name,a.started_at,a.stopped_at FROM execution_steps s JOIN execution_attempts a ON a.task_id=s.task_id WHERE s.plan_id=$1',
    [plan],
  );
  const downstream = (
    await services.db.query(
      "SELECT t.snapshot FROM execution_steps s JOIN tasks t ON t.id=s.task_id WHERE s.plan_id=$1 AND s.name='integration'",
      [plan],
    )
  )[0];
  expect(downstream.snapshot.evidence.filter((e: any) => e.kind === 'artifact')).toHaveLength(2);
  const front = attempts.find((a) => a.name === 'frontend')!,
    back = attempts.find((a) => a.name === 'backend')!,
    integration = attempts.find((a) => a.name === 'integration')!;
  expect(new Date(front.started_at).getTime()).toBeLessThan(new Date(back.stopped_at).getTime());
  expect(new Date(back.started_at).getTime()).toBeLessThan(new Date(front.stopped_at).getTime());
  expect(new Date(integration.started_at).getTime()).toBeGreaterThanOrEqual(
    Math.max(new Date(front.stopped_at).getTime(), new Date(back.stopped_at).getTime()),
  );
  await scoped('/api/v2/plans/' + plan + '/verify', {
    evidence: '已逐项核对三份实际报告，确认协作目标完成；本次没有运行自动测试',
  });
  expect((await scoped('/api/v2/goals/' + goal.id)).data.goal.state).toBe('COMPLETED');
  const duplicate = await candidate('另一份分析计划');
  await scoped(
    '/api/v2/goals/' + duplicate.id + '/plans',
    {
      expected_version: duplicate.version,
      steps: [
        {
          name: 'repeat',
          goal: '分析客户端模块结构',
          repository_id: repositoryIds[0],
          dependencies: [],
        },
      ],
    },
    admin,
    409,
  );
}, 60000);
test('群管理可移交，项目维护者不会绕过当前群管理权限', async () => {
  const id = (await scoped('/api/v2/groups', { title: '管理移交试验', visibility: 'private' })).data
    .id;
  const invite = (await scoped('/api/v2/groups/' + id + '/invites', {})).data.token;
  await scoped('/api/v2/group-invites/join', { token: invite }, member);
  await scoped('/api/v2/groups/' + id + '/lifecycle', {
    action: 'transfer_manager',
    user_id: memberId,
  });
  await scoped('/api/v2/groups/' + id + '/lifecycle', { action: 'archive' }, admin, 403);
  await scoped('/api/v2/groups/' + id + '/lifecycle', { action: 'archive' }, member);
  await scoped('/api/v2/groups/' + id + '/lifecycle', { action: 'restore' }, member);
});
test('上游成果失效后不得作为下游的新执行依据', async () => {
  const services = await server.services.organization!.open(project);
  const artifact = (
    await services.db.query(
      "SELECT a.id FROM artifacts a JOIN execution_steps s ON s.task_id=a.task_id WHERE a.kind='report' AND s.name='frontend' LIMIT 1",
    )
  )[0];
  await scoped('/api/v2/artifacts/' + artifact.id + '/validity', {
    state: 'stale',
    reason: '需求版本已变化，旧报告需要重新核查',
  });
  const user = (
    await services.db.query(
      "SELECT id,email,name,role FROM users WHERE role='OWNER' AND active LIMIT 1",
    )
  )[0] as any;
  const repo = (await services.devices.list()).flatMap((d) => d.repositories)[0];
  await expect(
    services.db.transaction((tx) =>
      services.tasks.queueFromCoordinator(
        user,
        {
          conversation_id: group,
          goal: '分析过期报告的后续步骤',
          constraints: [],
          acceptance: ['不得引用过期报告继续执行'],
          source_refs: [],
          memory_refs: [],
          dependency_artifact_refs: [artifact.id],
          repository_binding_id: repo.id,
          base_commit: repo.base_commit,
          execution_profile: 'code_review',
          budget: { wall_time_seconds: 30, max_model_calls: 3 },
        },
        tx,
      ),
    ),
  ).rejects.toThrow('依赖成果不可用');
});
test('未知执行阻止主节点切换，旧代次许可延迟到达时不会创建工作目录', async () => {
  for (const b of bridges.splice(0)) await b.close();
  const services = await server.services.organization!.open(project);
  const device = (await services.devices.list()).find((d) => d.repositories.length)!;
  const repo = device.repositories[0];
  const user = (
    await services.db.query(
      "SELECT id,email,name,role FROM users WHERE role='OWNER' AND active LIMIT 1",
    )
  )[0] as any;
  await services.db.transaction((tx) =>
    services.tasks.queueFromCoordinator(
      user,
      {
        conversation_id: group,
        goal: '分析旧许可延迟抵达的边界',
        constraints: [],
        acceptance: ['必须在代次不匹配时拒绝执行'],
        repository_binding_id: repo.id,
        base_commit: repo.base_commit,
        execution_profile: 'code_review',
        source_refs: [],
        memory_refs: [],
        budget: { wall_time_seconds: 30, max_model_calls: 3 },
      },
      tx,
    ),
  );
  const dispatch = await services.tasks.claim(device.id);
  expect(dispatch).toBeTruthy();
  await services.tasks.uncertain(
    device.id,
    dispatch!.descriptor.attempt_id,
    '合成调度验证：模拟交接后失去联系，未启动进程',
  );
  await scoped(
    '/api/v2/execution/node-binding',
    { node_id: device.id, expected_epoch: 1 },
    admin,
    409,
  );
  await services.tasks.finish(
    device.id,
    dispatch!.descriptor.attempt_id,
    {
      status: 'failed',
      report: '合成调度场景，确认未创建受管进程',
      diff: '',
      verification: 'not_run',
    },
    '测试执行器核实本场景未启动过受管进程',
  );
  const bound = (
    await scoped('/api/v2/execution/node-binding', { node_id: device.id, expected_epoch: 1 })
  ).data;
  expect(bound.epoch).toBe(2);
  expect(
    (await scoped('/api/v2/execution/node-binding', { node_id: device.id, expected_epoch: 2 })).data
      .epoch,
  ).toBe(2);
  await expect(services.tasks.lease(device.id, dispatch!.descriptor.attempt_id)).rejects.toThrow();
  const dirs = [resolve(root, 'bridge-0'), resolve(root, 'bridge-1')];
  const configs = await Promise.all(dirs.map((d) => readBridgeConfig(d)));
  const index = configs.findIndex((c) => c.deviceId === device.id);
  const replay = new BridgeClient(configs[index], dirs[index]);
  bridges.push(replay);
  await replay.start();
  await until(
    async () => (await services.devices.list()).find((d) => d.id === device.id),
    (d) => d?.status === 'online',
  );
  await new Promise((r) => setTimeout(r, 100));
  (services.gateway as any).send(device.id, dispatch);
  await until(
    async () => replay.ledger.get(dispatch!.descriptor.attempt_id),
    (a) => a?.status === 'stopped',
  );
  expect(replay.ledger.get(dispatch!.descriptor.attempt_id)?.result?.error_code).toBe(
    'DISPATCH_REJECTED',
  );
  const { access } = await import('node:fs/promises');
  await expect(
    access(
      resolve(
        dirs[index],
        'worktrees',
        dispatch!.descriptor.task_id,
        dispatch!.descriptor.attempt_id,
      ),
    ),
  ).rejects.toThrow();
}, 30000);
test('撤销项目成员后所有项目入口立即拒绝，治理记录按实际可见范围投影', async () => {
  await scoped('/api/v2/evaluations/coordination', {
    conversation_id: group,
    kind: 'duplicate',
    synthetic: true,
    expected: 'reject',
    actual: 'reject',
    note: '合成边界案例，不能作为真实语义质量指标',
  });
  const metrics = (await scoped('/api/v2/governance/metrics')).data;
  expect(metrics.scope).toContain('有权查看');
  await request('/api/v3/projects/' + project + '/members/' + memberId + '/remove', {});
  await scoped('/api/v2/bootstrap', undefined, member, 404);
  await scoped('/api/v2/groups/' + group + '/feed', undefined, member, 404);
  expect((await scoped('/api/v2/evaluations/coordination')).data[0].synthetic).toBe(true);
});
