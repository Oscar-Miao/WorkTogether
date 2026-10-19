import { beforeAll, afterAll, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApplication } from '../../apps/api/src/application.js';
const origin = 'http://127.0.0.1:5173';
let app: Awaited<ReturnType<typeof createApplication>>, url: string;
async function call(
  path: string,
  body?: unknown,
  status = body === undefined ? 200 : 201,
  cookie = '',
  headers: Record<string, string> = {},
) {
  const response = await fetch(url + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = (await response.json()) as any;
  expect(response.status, JSON.stringify(value)).toBe(status);
  return { ...value, response };
}
const cookie = (r: any) => r.response.headers.get('set-cookie').split(';')[0];
beforeAll(async () => {
  vi.stubEnv('COORDINATOR_ENABLED', 'false');
  await mkdir('.local/reports/password', { recursive: true });
  const root = await mkdtemp(resolve('.local/reports/password/run-'));
  app = await createApplication({
    dataDir: root,
    databaseUrl: undefined,
    production: false,
    ownerEmail: 'owner@password.test',
    ownerPassword: 'Synthetic-' + randomUUID(),
    webOrigin: origin,
    registrationEnabled: true,
  });
  await app.app.listen(0, '127.0.0.1');
  url = 'http://127.0.0.1:' + app.app.getHttpServer().address().port;
});
afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
});
test('内测注册接受六位密码和格式正确的虚构邮箱，仍保存 Argon2id 哈希', async () => {
  expect((await call('/auth/options')).data.password_min_length).toBe(6);
  await call('/auth/register', {
    email: 'six@not-real.invalid',
    name: '内测用户',
    password: '123456',
  });
  const row = (
    await app.services.db.query('SELECT password_hash FROM users WHERE email=$1', [
      'six@not-real.invalid',
    ])
  )[0];
  expect(row.password_hash).toMatch(/^\$argon2id\$/);
  expect(row.password_hash).not.toBe('123456');
  await call(
    '/auth/register',
    { email: 'short@not-real.invalid', name: '短密码', password: '12345' },
    400,
  );
  await call('/auth/register', { email: 'invalid-email', name: '错格式', password: '123456' }, 400);
});
test('登录页凭旧密码改密，撤销所有旧会话，新密码可登录', async () => {
  const first = await call('/auth/login', { email: 'six@not-real.invalid', password: '123456' });
  const second = await call('/auth/login', { email: 'six@not-real.invalid', password: '123456' });
  const result = await call('/auth/change-password', {
    email: 'six@not-real.invalid',
    current_password: '123456',
    new_password: '654321',
  });
  expect(result.data).toEqual({ ok: true, relogin_required: true });
  await call('/me', undefined, 401, cookie(first));
  await call('/me', undefined, 401, cookie(second));
  await call('/auth/login', { email: 'six@not-real.invalid', password: '123456' }, 401);
  expect(
    (await call('/auth/login', { email: 'six@not-real.invalid', password: '654321' })).data.email,
  ).toBe('six@not-real.invalid');
  const audit = JSON.stringify(
    await app.services.db.query(
      "SELECT detail FROM audit_logs WHERE action='account.password_changed'",
    ),
  );
  expect(audit).not.toContain('123456');
  expect(audit).not.toContain('654321');
});
test('错误旧密码、缺少旧密码、过短新密码和外部来源不能修改', async () => {
  const input = {
    email: 'six@not-real.invalid',
    current_password: 'wrong',
    new_password: '555555',
  };
  await call('/auth/change-password', input, 401);
  await call('/auth/change-password', { email: input.email, new_password: '555555' }, 400);
  await call(
    '/auth/change-password',
    { ...input, current_password: '654321', new_password: '12345' },
    400,
  );
  await call('/auth/change-password', { ...input, current_password: '654321' }, 403, '', {
    Origin: 'https://foreign.invalid',
  });
  await call('/auth/login', { email: input.email, password: '654321' });
});
test('并发改密只有一份旧凭据可以成功提交', async () => {
  const email = 'race@not-real.invalid';
  await call('/auth/register', { email, name: '并发改密', password: '123456' });
  const send = (next: string) =>
    fetch(url + '/api/v1/auth/change-password', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, current_password: '123456', new_password: next }),
    });
  const results = await Promise.all([send('first66'), send('second77')]);
  expect(results.filter((r) => r.status === 201)).toHaveLength(1);
  expect([401, 409]).toContain(results.find((r) => r.status !== 201)!.status);
  await call('/auth/login', {
    email,
    password: results[0].status === 201 ? 'first66' : 'second77',
  });
});
test('生产策略恢复十二位门槛，前端 options 和服务端注册、邀请、改密一致', async () => {
  app.services.config.production = true;
  try {
    expect((await call('/auth/options')).data.password_min_length).toBe(12);
    await call(
      '/auth/register',
      { email: 'prod@not-real.invalid', name: '生产策略', password: '123456' },
      400,
    );
    await call(
      '/auth/change-password',
      { email: 'six@not-real.invalid', current_password: '654321', new_password: '123456' },
      400,
    );
    await expect(
      app.services.auth.accept('x'.repeat(43), '受邀者', '123456'),
    ).rejects.toMatchObject({ code: 'PASSWORD_LENGTH_INVALID' });
    await call('/auth/register', {
      email: 'prod@not-real.invalid',
      name: '生产策略',
      password: 'Production-123456',
    });
  } finally {
    app.services.config.production = false;
  }
});
