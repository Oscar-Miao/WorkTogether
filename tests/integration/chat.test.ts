import { beforeAll, afterAll, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApplication } from '../../apps/api/src/application.js';
import { pairBridge, authenticate, apiRequest } from '../../apps/bridge/src/config/config.js';
import { BridgeClient } from '../../apps/bridge/src/bridge-client.js';
const exec = promisify(execFile),
  password = 'Chat-test-' + randomUUID(),
  origin = 'http://127.0.0.1:5173';
let server: Awaited<ReturnType<typeof createApplication>>, url: string, root: string;
type Session = { cookie: string; csrf: string };
let maintainer: Session,
  member: Session,
  group: string,
  repoId: string,
  deviceId: string,
  memberId: string,
  bridge: BridgeClient | undefined;
async function req(
  path: string,
  body?: unknown,
  session = maintainer,
  status = body === undefined ? 200 : 201,
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
  const value = (await response.json()) as any;
  expect(response.status, JSON.stringify(value)).toBe(status);
  return { data: value.data, response, error: value.error };
}
async function login(email: string) {
  const r = await req('/api/v1/auth/login', { email, password }, undefined as any);
  return { cookie: r.response.headers.get('set-cookie')!.split(';')[0], csrf: r.data.csrf };
}
async function until(read: () => Promise<any>, accept: (v: any) => boolean) {
  const end = Date.now() + 20000;
  do {
    const v = await read();
    if (accept(v)) return v;
    await new Promise((r) => setTimeout(r, 60));
  } while (Date.now() < end);
  throw new Error('No verified state before timeout');
}
const feed = async (session = member) =>
  (await req('/api/v2/groups/' + group + '/feed', undefined, session)).data;
async function post(
  body: string,
  session = member,
  extra: Record<string, unknown> = {},
  status = 201,
) {
  return req(
    '/api/v2/groups/' + group + '/messages',
    { body, client_message_id: randomUUID(), ...extra },
    session,
    status,
  );
}
beforeAll(async () => {
  await mkdir('.local/reports/chat-integration', { recursive: true });
  root = await mkdtemp(resolve('.local/reports/chat-integration/run-'));
  const repository = resolve(root, 'repo');
  await mkdir(resolve(repository, 'src'), { recursive: true });
  await writeFile(resolve(repository, 'src/index.ts'), 'export const value=1;\\n');
  await exec('git', ['init', repository], { windowsHide: true });
  await exec('git', ['-C', repository, 'add', '.'], { windowsHide: true });
  await exec(
    'git',
    [
      '-C',
      repository,
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
  server = await createApplication({
    dataDir: resolve(root, 'server'),
    databaseUrl: undefined,
    ownerEmail: 'maintainer@chat.test',
    ownerPassword: password,
    production: false,
    webOrigin: origin,
  });
  await server.app.listen(0, '127.0.0.1');
  url = 'http://127.0.0.1:' + server.app.getHttpServer().address().port;
  maintainer = await login('maintainer@chat.test');
  const invitation = (await req('/api/v1/invitations', { email: 'member@chat.test' })).data;
  await req(
    '/api/v1/invitations/accept',
    { token: invitation.token, name: '林可', password },
    undefined as any,
  );
  member = await login('member@chat.test');
  memberId = (await req('/api/v2/bootstrap', undefined, member)).data.user.id;
  group = (await req('/api/v2/groups', { title: '私群机密目标', visibility: 'private' }, member))
    .data.id;
  const code = (await req('/api/v1/pairing-codes', {})).data.code;
  const config = await pairBridge({
    dataDir: resolve(root, 'bridge'),
    api: url,
    code,
    repo: repository,
    runtime: 'inspection',
    allowedWritePrefixes: [],
  });
  repoId = config.repository.id;
  deviceId = config.deviceId;
  const token = (await authenticate(config)).access_token;
  const commit = (
    await exec('git', ['-C', repository, 'rev-parse', 'HEAD'], { windowsHide: true })
  ).stdout.trim();
  await apiRequest(
    url,
    '/bridge/v1/repositories',
    {
      repositories: [
        {
          id: repoId,
          name: 'fixture',
          base_commit: commit,
          branch: 'main',
          capabilities: ['file_read', 'file_search'],
          write_prefixes: [],
        },
      ],
    },
    token,
  );
});
afterAll(async () => {
  if (bridge) await bridge.close();
  if (server) await server.close();
});
test('private group membership is enforced by v2 and legacy read paths; invitation joins persist', async () => {
  expect(JSON.stringify((await req('/api/v2/bootstrap')).data)).not.toContain('私群机密目标');
  expect(JSON.stringify((await req('/api/v1/bootstrap')).data)).not.toContain('私群机密目标');
  await req('/api/v2/groups/' + group + '/feed', undefined, maintainer, 404);
  await req('/api/v1/conversations/' + group + '/messages', undefined, maintainer, 404);
  await req('/api/v2/groups/' + group + '/join', {}, maintainer, 404);
  const invite = (await req('/api/v2/groups/' + group + '/invites', {}, member)).data;
  await req('/api/v2/group-invites/join', { token: invite.token }, maintainer);
  expect((await feed(maintainer)).members.some((m: any) => m.id === memberId)).toBe(true);
});
test('member mentions persist stable identities, forged identities fail, quoting and duplicates do not invoke Agent', async () => {
  const m = (await post('@林可 请确认交互稿')).data;
  expect(m.mentions).toMatchObject([{ type: 'member', target_id: memberId }]);
  await until(feed, (f) => f.observed_seq >= m.seq);
  expect((await feed()).goals).toHaveLength(0);
  await post(
    '@陌生成员 请检查',
    member,
    { mentions: [{ type: 'member', target_id: memberId, label: '陌生成员', start: 0, end: 6 }] },
    400,
  );
  const q = (await post('> @AI 不应启动')).data;
  await until(feed, (f) => f.observed_seq >= q.seq);
  expect((await feed()).goals).toHaveLength(0);
  const key = randomUUID(),
    body = { body: '普通幂等消息', client_message_id: key };
  const a = (await req('/api/v2/groups/' + group + '/messages', body, member)).data,
    b = (await req('/api/v2/groups/' + group + '/messages', body, member)).data;
  expect(a.id).toBe(b.id);
  await req('/api/v2/groups/' + group + '/messages', { ...body, body: '不同正文' }, member, 409);
});
test('human work enters the shared index, exact duplicate requests are rejected, review requires differences and policy', async () => {
  const m = (await post('我来做 发布验收文档梳理')).data;
  const f = await until(feed, (f) => f.goals.some((g: any) => g.message_id === m.id));
  const goal = f.goals.find((g: any) => g.message_id === m.id);
  await req('/api/v2/goals/' + goal.id + '/claim', { version: goal.version }, member);
  const duplicate = (await post('@AI 发布验收文档梳理')).data;
  const result = await until(feed, (f) => f.goals.some((g: any) => g.message_id === duplicate.id));
  const rejected = result.goals.find((g: any) => g.message_id === duplicate.id);
  expect(rejected.decision).toBe('REJECT');
  expect(rejected.related_goal_id).toBe(goal.id);
  expect(rejected.task_id).toBeNull();
  await req(
    '/api/v2/goals/' + rejected.id + '/review',
    {
      title: '分析另一个模块的发布风险',
      constraints: [],
      acceptance: ['列出代码来源'],
      reason: '范围不同',
      expected_version: rejected.version,
    },
    member,
  );
  const reviewed = await until(feed, (f) =>
    f.goals.some((g: any) => g.id === rejected.id && g.state === 'CLARIFYING'),
  );
  expect(reviewed.goals.find((g: any) => g.id === rejected.id).reason).toContain('策略');
});
test('node policy permits one exact effect under concurrent requests; member stop cancels queue without human admin approval', async () => {
  const p = (await req('/api/v2/bootstrap')).data;
  await req(
    '/api/v2/node-policy',
    { ...p.policy, enabled: true, repository_id: repoId, expected_version: p.policy_version },
    member,
    403,
  );
  await req('/api/v2/node-policy', {
    ...p.policy,
    enabled: true,
    repository_id: repoId,
    expected_version: p.policy_version,
  });
  const messages = await Promise.all(
    Array.from({ length: 6 }, () => post('@AI 分析代码目录并列出风险')),
  );
  const result = await until(feed, (f) =>
    messages.every((m) => f.goals.some((g: any) => g.message_id === m.data.id)),
  );
  const goals = result.goals.filter((g: any) => messages.some((m) => m.data.id === g.message_id));
  expect(goals.filter((g: any) => g.decision === 'APPROVE')).toHaveLength(1);
  expect(goals.filter((g: any) => g.decision === 'REJECT')).toHaveLength(5);
  const approved = goals.find((g: any) => g.decision === 'APPROVE');
  const detail = (await req('/api/v2/goals/' + approved.id, undefined, member)).data;
  expect(detail.task.approval.approver_id).toBe('node:coordinator');
  await req('/api/v2/goals/' + approved.id + '/stop', { reason: '团队明确取消这项分析' }, member);
  await until(feed, (f) => f.goals.find((g: any) => g.id === approved.id)?.state === 'STOPPED');
});
test('policy versions revoke old permits and do not expire tasks admitted under the new policy', async () => {
  await post('@AI 分析依赖目录中的许可风险');
  let f = await until(feed, (f) =>
    f.goals.some((g: any) => g.title === '分析依赖目录中的许可风险' && g.state === 'APPROVED'),
  );
  const goal = f.goals.find((g: any) => g.title === '分析依赖目录中的许可风险');
  const p = (await req('/api/v2/bootstrap')).data;
  await req('/api/v2/node-policy', {
    ...p.policy,
    enabled: false,
    expected_version: p.policy_version,
  });
  expect((await req('/api/v2/goals/' + goal.id, undefined, member)).data.task.state).toBe(
    'EXPIRED',
  );
  expect(await server.services.tasks.claim(deviceId)).toBeUndefined();
  const next = (await req('/api/v2/bootstrap')).data;
  await req('/api/v2/node-policy', {
    ...next.policy,
    enabled: true,
    expected_version: next.policy_version,
  });
});
test('an explicit group stop command stops the named queued goal', async () => {
  const title = '检查单独的构建目录风险';
  const m = (await post('@AI ' + title)).data;
  const f = await until(feed, (f) =>
    f.goals.some((g: any) => g.message_id === m.id && g.state === 'APPROVED'),
  );
  const goal = f.goals.find((g: any) => g.message_id === m.id);
  await post('@AI 停止 ' + title);
  await until(feed, (f) => f.goals.find((g: any) => g.id === goal.id)?.state === 'STOPPED');
  expect((await req('/api/v2/goals/' + goal.id, undefined, member)).data.task.state).toBe(
    'CANCELLED',
  );
});
test('semantic suggestions are checked against stable work and cannot erase concrete acceptance differences', async () => {
  const m = (await post('我来做 项目目录责任说明')).data;
  const f = await until(feed, (f) => f.goals.some((g: any) => g.message_id === m.id));
  const original = f.goals.find((g: any) => g.message_id === m.id);
  await req('/api/v2/goals/' + original.id + '/claim', { version: original.version }, member);
  Object.defineProperty(server.services.coordinator.model, 'configured', { value: true });
  let acceptance: string[] = [];
  const mock = vi
    .spyOn(server.services.coordinator.model, 'observe')
    .mockImplementation(async () => ({
      title: '汇总代码目录与责任边界',
      intent: 'request',
      constraints: [],
      acceptance,
      question: null,
      match: { goal_id: original.id, relation: 'same', differences: [] },
    }));
  try {
    const same = (await post('@AI 汇总代码目录与责任边界')).data;
    const rejected = await until(feed, (f) =>
      f.goals.some((g: any) => g.message_id === same.id && g.decision === 'REJECT'),
    );
    expect(rejected.goals.find((g: any) => g.message_id === same.id).related_goal_id).toBe(
      original.id,
    );
    acceptance = ['增加另一环境的验收清单'];
    const different = (await post('@AI 汇总另一个环境的责任边界')).data;
    const clarified = await until(feed, (f) =>
      f.goals.some((g: any) => g.message_id === different.id && g.state === 'CLARIFYING'),
    );
    const differentGoal = clarified.goals.find((g: any) => g.message_id === different.id);
    expect(differentGoal.decision).toBeNull();
    await req(
      '/api/v2/goals/' + differentGoal.id + '/review',
      {
        title: differentGoal.title,
        constraints: [],
        acceptance: ['增加另一环境的验收清单'],
        reason: '这次覆盖另一个环境，验收对象不同',
        expected_version: differentGoal.version,
      },
      member,
    );
    const approved = await until(feed, (f) =>
      f.goals.some((g: any) => g.id === differentGoal.id && g.decision === 'APPROVE'),
    );
    expect(approved.goals.find((g: any) => g.id === differentGoal.id).task_id).toBeTruthy();
    await req(
      '/api/v2/goals/' + differentGoal.id + '/stop',
      { reason: '合成用例完成，停止队列' },
      member,
    );
  } finally {
    mock.mockRestore();
    Object.defineProperty(server.services.coordinator.model, 'configured', { value: false });
  }
});
test('a real inspection Bridge executes a coordinated request and returns a visible group report', async () => {
  const configPath = resolve(root, 'bridge');
  const { readBridgeConfig } = await import('../../apps/bridge/src/config/config.js');
  bridge = new BridgeClient(await readBridgeConfig(configPath), configPath);
  await bridge.start();
  const source = (
    await req('/api/v1/sources', {
      name: '群内共享验收来源',
      content: '报告必须列出实际文件，不得假装运行测试。',
      visibility: 'shared',
    })
  ).data;
  const m = (
    await post('@AI 分析仓库中的源码文件清单', member, {
      source_refs: [{ source_id: source.id, version: source.version }],
    })
  ).data;
  const f = await until(feed, (f) =>
    f.goals.some((g: any) => g.message_id === m.id && g.state === 'COMPLETED'),
  );
  const goal = f.goals.find((g: any) => g.message_id === m.id);
  const detail = (await req('/api/v2/goals/' + goal.id, undefined, member)).data;
  expect(
    detail.task.snapshot.evidence.some(
      (e: any) => e.id === source.id && e.version === source.version,
    ),
  ).toBe(true);
  expect(detail.task.state).toBe('SUCCEEDED');
  expect(
    detail.task.artifacts.some((a: any) => a.published && a.content.includes('src/index.ts')),
  ).toBe(true);
  expect(detail.task.artifacts.some((a: any) => a.content.includes('未调用 AI 模型'))).toBe(true);
});

test('private execution and related evidence stay hidden even from a nonmember maintainer using legacy APIs', async () => {
  const previous = group;
  const hidden = (
    await req('/api/v2/groups', { title: '不可见的内部群名', visibility: 'private' }, member)
  ).data.id;
  try {
    group = hidden;
    const m = (await post('@AI 检查 TypeScript 入口清单')).data;
    const completed = await until(feed, (f) =>
      f.goals.some((g: any) => g.message_id === m.id && g.state === 'COMPLETED'),
    );
    const goal = completed.goals.find((g: any) => g.message_id === m.id);
    await req('/api/v2/goals/' + goal.id, undefined, maintainer, 404);
    await req('/api/v1/tasks/' + goal.task_id, undefined, maintainer, 404);
    await req('/api/v1/tasks/' + goal.task_id + '/retention', undefined, maintainer, 404);
    expect(JSON.stringify((await req('/api/v1/tasks')).data)).not.toContain(goal.task_id);
    group = 'conv_general';
    const matching = (await post('@AI 检查 TypeScript 入口清单', maintainer)).data;
    const projected = await until(
      () => feed(maintainer),
      (f) => f.goals.some((g: any) => g.message_id === matching.id),
    );
    const duplicate = projected.goals.find((g: any) => g.message_id === matching.id);
    expect(duplicate.decision).toBe('REJECT');
    expect(duplicate.related_goal_id).toBeNull();
    expect(duplicate.restricted_relation).toBe(true);
    expect(JSON.stringify(projected)).not.toContain(hidden);
    expect(JSON.stringify(projected)).not.toContain(goal.id);
  } finally {
    group = previous;
  }
});
