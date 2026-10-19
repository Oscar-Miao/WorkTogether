import { beforeAll, afterAll, test, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApplication } from '../../apps/api/src/application.js';
import { sha } from '../../apps/api/src/common/security.js';

type Session = { cookie: string; csrf: string; id: string; email: string };
const origin = 'http://127.0.0.1:5173',
  password = 'Onboarding-' + randomUUID();
let app: Awaited<ReturnType<typeof createApplication>>, url: string, dataDir: string;
let operator: Session,
  alice: Session,
  bob: Session,
  charlie: Session,
  project: string,
  workspace: string,
  privateGroup: string;
async function request(
  path: string,
  body?: unknown,
  session?: Session,
  status = body === undefined ? 200 : 201,
  headers: Record<string, string> = {},
) {
  const response = await fetch(url + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: origin,
      ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}),
      ...(body === undefined
        ? {}
        : { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = (await response.json()) as any;
  expect(response.status, JSON.stringify(value)).toBe(status);
  return { ...value, response };
}
function session(result: any): Session {
  return {
    cookie: result.response.headers.get('set-cookie').split(';')[0],
    csrf: result.data.csrf,
    id: result.data.id,
    email: result.data.email,
  };
}
async function register(email: string, name: string) {
  return session(await request('/api/v1/auth/register', { email, name, password }));
}
async function invite(body: unknown = {}) {
  return (await request('/api/v3/projects/' + project + '/invitations', body, alice)).data;
}
beforeAll(async () => {
  vi.stubEnv('COORDINATOR_ENABLED', 'false');
  await mkdir('.local/reports/onboarding', { recursive: true });
  dataDir = await mkdtemp(resolve('.local/reports/onboarding/run-'));
  app = await createApplication({
    dataDir,
    databaseUrl: undefined,
    production: false,
    ownerEmail: 'operator@onboarding.test',
    ownerPassword: password,
    webOrigin: origin,
    registrationEnabled: true,
  });
  await app.app.listen(0, '127.0.0.1');
  url = 'http://127.0.0.1:' + app.app.getHttpServer().address().port;
  operator = session(
    await request('/api/v1/auth/login', { email: 'operator@onboarding.test', password }),
  );
});
afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
});

test('注册独立身份，不继承默认团队、群聊、名册或项目资料', async () => {
  alice = await register('Alice@onboarding.test', '团队发起人');
  bob = await register('bob@onboarding.test', '协作成员');
  charlie = await register('charlie@onboarding.test', '其他团队成员');
  expect(alice.email).toBe('alice@onboarding.test');
  const account = (await request('/api/v3/account', undefined, alice)).data;
  expect(account.projects).toEqual([]);
  expect(account.workspaces).toEqual([]);
  expect((await request('/api/v1/auth/options')).data.registration_enabled).toBe(true);
  await request('/api/v2/bootstrap', undefined, alice, 404);
  await request('/api/v1/sources', undefined, alice, 404);
  const roster = (await request('/api/v1/members', undefined, operator)).data;
  expect(roster.map((u: any) => u.id)).not.toContain(alice.id);
  const bootstrap = (await request('/api/v2/bootstrap', undefined, operator)).data;
  const feed = (await request('/api/v2/groups/conv_general/feed', undefined, operator)).data;
  expect(feed.members.map((u: any) => u.id)).not.toContain(bob.id);
  expect(bootstrap.groups.find((g: any) => g.id === 'conv_general').member_count).toBe(1);
});
test('注册校验密码、重名邮箱、来源、开关；成功会话有 HttpOnly cookie', async () => {
  await request(
    '/api/v1/auth/register',
    { email: 'alice@onboarding.test', name: '重复', password },
    undefined,
    409,
  );
  await request(
    '/api/v1/auth/register',
    { email: 'short@onboarding.test', name: '短密码', password: '123' },
    undefined,
    400,
  );
  await request(
    '/api/v1/auth/register',
    { email: 'alien@onboarding.test', name: '外部', password },
    undefined,
    403,
    { Origin: 'https://alien.test' },
  );
  app.services.config.registrationEnabled = false;
  await request(
    '/api/v1/auth/register',
    { email: 'disabled@onboarding.test', name: '关闭', password },
    undefined,
    403,
  );
  app.services.config.registrationEnabled = true;
  const logged = await request('/api/v1/auth/login', { email: alice.email, password });
  expect(logged.response.headers.get('set-cookie')).toMatch(/HttpOnly/);
  expect(logged.response.headers.get('set-cookie')).toMatch(/SameSite=Strict/);
});
test('创建团队和首项目原子完成，发起人是本团队维护者且请求重试不重复创建', async () => {
  const body = { name: '产品协作社群', project_name: '全栈研发' },
    key = randomUUID();
  const result = (await request('/api/v3/teams', body, alice, 201, { 'Idempotency-Key': key }))
    .data;
  expect(
    (await request('/api/v3/teams', body, alice, 201, { 'Idempotency-Key': key })).data,
  ).toEqual(result);
  project = result.project_id;
  workspace = result.workspace_id;
  const account = (await request('/api/v3/account', undefined, alice)).data;
  expect(account.projects).toHaveLength(1);
  expect(account.projects[0].role).toBe('admin');
  await request(
    '/p/' + project + '/api/v1/auth/register',
    { email: 'shadow@onboarding.test', name: '项目镜像', password },
    alice,
    404,
  );
  expect(
    await app.services.db.query('SELECT id FROM users WHERE email=$1', ['shadow@onboarding.test']),
  ).toEqual([]);
  const rootAudit = JSON.stringify((await request('/api/v1/audit', undefined, operator)).data);
  expect(rootAudit).not.toContain(project);
  expect(rootAudit).not.toContain('alice@onboarding.test');
  expect((await request('/api/v3/account', undefined, bob)).data.projects).toEqual([]);
  await request('/p/' + project + '/api/v2/bootstrap', undefined, operator, 404);
  const group = (
    await request(
      '/p/' + project + '/api/v2/groups',
      { title: '团队私有讨论', visibility: 'private' },
      alice,
    )
  ).data;
  privateGroup = group.id;
});
test('邀请只存摘要，预览不泄露名册和受邀邮箱；匿名接受与非管理员签发被拒绝', async () => {
  const invitation = await invite({ email: bob.email, max_uses: 1 });
  const stored = (
    await app.services.db.query('SELECT * FROM org_invitations WHERE id=$1', [invitation.id])
  )[0];
  expect(stored.token_hash).toBe(sha(invitation.token));
  expect(JSON.stringify(stored)).not.toContain(invitation.token);
  const preview = (await request('/api/v3/team-invitations/preview', { token: invitation.token }))
    .data;
  expect(preview.workspace).toBe('产品协作社群');
  expect(preview.email_required).toBe(true);
  expect(JSON.stringify(preview)).not.toContain(bob.email);
  await request('/api/v3/team-invitations/accept', { token: invitation.token }, undefined, 401);
  await request('/api/v3/projects/' + project + '/invitations', {}, bob, 403);
  await request('/api/v3/team-invitations/accept', { token: invitation.token }, charlie, 403);
  await request('/api/v3/team-invitations/accept', { token: invitation.token }, bob, 403, {
    'X-CSRF-Token': 'wrong',
  });
  await request('/api/v3/team-invitations/accept', { token: invitation.token }, bob);
  const retry = (await request('/api/v3/team-invitations/accept', { token: invitation.token }, bob))
    .data;
  expect(retry.already_joined).toBe(true);
  expect(
    (
      await app.services.db.query('SELECT used_count FROM org_invitations WHERE id=$1', [
        invitation.id,
      ])
    )[0].used_count,
  ).toBe(1);
});
test('接受邀请同步已打开的项目身份，可发言但不能进入已有私群或其他项目', async () => {
  const account = (await request('/api/v3/account', undefined, bob)).data;
  expect(account.workspaces[0].id).toBe(workspace);
  expect(account.projects[0].role).toBe('member');
  await request('/p/' + project + '/api/v2/groups/' + privateGroup + '/feed', undefined, bob, 404);
  const group = (
    await request(
      '/p/' + project + '/api/v2/groups',
      { title: '一起推进', visibility: 'public' },
      bob,
    )
  ).data.id;
  await request('/p/' + project + '/api/v2/groups/' + group + '/join', {}, alice);
  await request(
    '/p/' + project + '/api/v2/groups/' + group + '/messages',
    { body: '新成员已加入，共同推进目标', client_message_id: randomUUID() },
    bob,
  );
  expect(
    JSON.stringify(
      (await request('/p/' + project + '/api/v2/groups/' + group + '/feed', undefined, alice)).data,
    ),
  ).toContain('新成员已加入');
  await request('/api/v2/bootstrap', undefined, bob, 404);
  await request('/api/v3/projects/' + project + '/invitations', {}, bob, 403);
});
test('不同账号并发接受单名额邀请只成功一个，成员被移出后旧邀请不能恢复权限', async () => {
  const extra = await register('extra@onboarding.test', '另一位成员'),
    invitation = await invite();
  const send = (s: Session) =>
    fetch(url + '/api/v3/team-invitations/accept', {
      method: 'POST',
      headers: {
        Origin: origin,
        Cookie: s.cookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': s.csrf,
      },
      body: JSON.stringify({ token: invitation.token }),
    });
  const outcomes = await Promise.all([send(charlie), send(extra)]);
  expect(outcomes.map((r) => r.status).sort()).toEqual([201, 410]);
  const winner = outcomes[0].status === 201 ? charlie : extra;
  await request('/api/v3/projects/' + project + '/members/' + winner.id + '/remove', {}, alice);
  await request('/api/v3/team-invitations/accept', { token: invitation.token }, winner, 409);
  await request('/p/' + project + '/api/v2/bootstrap', undefined, winner, 404);
});
test('过期、撤销和撤权维护者的邀请均不可加入；邀请列表不返回令牌', async () => {
  const expired = await invite(),
    revoked = await invite();
  await app.services.db.query(
    "UPDATE org_invitations SET expires_at=now()-interval '1 second' WHERE id=$1",
    [expired.id],
  );
  await request('/api/v3/team-invitations/preview', { token: expired.token }, undefined, 410);
  await request(
    '/api/v3/projects/' + project + '/invitations/' + revoked.id + '/revoke',
    {},
    alice,
  );
  await request('/api/v3/team-invitations/preview', { token: revoked.token }, undefined, 410);
  const list = (await request('/api/v3/projects/' + project + '/invitations', undefined, alice))
    .data;
  expect(JSON.stringify(list)).not.toContain(revoked.token);
  expect(JSON.stringify(list)).not.toContain('token_hash');
  const stale = await invite();
  await app.services.db.query(
    "UPDATE org_project_members SET role='member' WHERE project_id=$1 AND user_id=$2",
    [project, alice.id],
  );
  await request('/api/v3/team-invitations/preview', { token: stale.token }, undefined, 410);
  await app.services.db.query(
    "UPDATE org_project_members SET role='admin' WHERE project_id=$1 AND user_id=$2",
    [project, alice.id],
  );
});
test('默认项目也使用显式邀请，移出项目不注销账号或其他团队身份', async () => {
  const inv = (
    await request('/api/v3/projects/project_default/invitations', { email: bob.email }, operator)
  ).data;
  await request('/api/v3/team-invitations/accept', { token: inv.token }, bob);
  expect((await request('/api/v2/bootstrap', undefined, bob)).data.project.id).toBe(
    'project_default',
  );
  await request('/api/v3/projects/project_default/members/' + bob.id + '/remove', {}, operator);
  await request('/api/v2/bootstrap', undefined, bob, 404);
  expect(
    (await request('/api/v3/account', undefined, bob)).data.projects.map((p: any) => p.id),
  ).toEqual([project]);
  expect((await request('/api/v1/auth/login', { email: bob.email, password })).data.id).toBe(
    bob.id,
  );
});
test('重启不会把新账号或被移出成员重新加入默认项目', async () => {
  await app.close();
  app = await createApplication({
    dataDir,
    databaseUrl: undefined,
    production: false,
    ownerEmail: 'operator@onboarding.test',
    ownerPassword: password,
    webOrigin: origin,
    registrationEnabled: true,
  });
  await app.app.listen(0, '127.0.0.1');
  url = 'http://127.0.0.1:' + app.app.getHttpServer().address().port;
  expect(
    (await request('/api/v3/account', undefined, bob)).data.projects.map((p: any) => p.id),
  ).toEqual([project]);
  await request('/api/v2/bootstrap', undefined, bob, 404);
  expect(
    (await request('/api/v3/account', undefined, alice)).data.projects.map((p: any) => p.id),
  ).toEqual([project]);
});
test('注册限流先于密码哈希，超限不创建账号', async () => {
  await app.services.db.query(
    "INSERT INTO identity_rate_limits(bucket,count,reset_at) VALUES($1,10,now()+interval '15 minutes') ON CONFLICT(bucket) DO UPDATE SET count=10",
    ['register:' + sha('127.0.0.1')],
  );
  await request(
    '/api/v1/auth/register',
    { email: 'limited@onboarding.test', name: '限流', password },
    undefined,
    429,
  );
  expect(
    await app.services.db.query('SELECT id FROM users WHERE email=$1', ['limited@onboarding.test']),
  ).toEqual([]);
});
