import type { PageInfo } from '@team-agent/contracts';
type PageWire = { data: { id: string; visibility?: string }[]; pagination: PageInfo };
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createApplication } from '../../apps/api/src/application.js';
let server: Awaited<ReturnType<typeof createApplication>>,
  url: string,
  owner: { cookie: string; csrf: string },
  member: { cookie: string; csrf: string };
const password = 'Synthetic-pagination-' + randomUUID(),
  origin = 'http://127.0.0.1:5173';
let conversation: string, source: string, firstTask: string;
async function call(
  path: string,
  body?: unknown,
  session = owner,
  status = body === undefined ? 200 : 201,
): Promise<{ value: any; response: Response }> {
  const response = await fetch(url + '/api/v1' + path, {
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
  expect(response.status, JSON.stringify(value.error)).toBe(status);
  return { value, response };
}
async function login(email: string) {
  const result = await call('/auth/login', { email, password });
  return {
    cookie: result.response.headers.get('set-cookie')!.split(';')[0],
    csrf: result.value.data.csrf,
  };
}
beforeAll(async () => {
  await mkdir(resolve('.local/reports/pagination'), { recursive: true });
  const dir = await mkdtemp(resolve('.local/reports/pagination/run-'));
  server = await createApplication({
    dataDir: resolve(dir, 'server'),
    databaseUrl: undefined,
    production: false,
    webOrigin: origin,
    ownerEmail: 'owner@pagination.test',
    ownerPassword: password,
  });
  await server.app.listen(0, '127.0.0.1');
  url = 'http://127.0.0.1:' + server.app.getHttpServer().address().port;
  owner = await login('owner@pagination.test');
  const invitation = (await call('/invitations', { email: 'member@pagination.test' })).value.data;
  await call('/invitations/accept', { token: invitation.token, name: '分页成员', password });
  member = await login('member@pagination.test');
  conversation = (await call('/conversations', { title: '历史分页测试' })).value.data.id;
  source = (
    await call('/sources', {
      name: '长原文',
      content: '中文资料'.repeat(2000) + '完整正文标记',
      visibility: 'shared',
    })
  ).value.data.id;
  for (let index = 0; index < 25; index++) {
    await call('/sources', {
      name: '权限资料 ' + index,
      content: 'synthetic-' + index,
      visibility: index % 3 === 0 ? 'owner' : 'shared',
    });
    await call('/conversations', { title: '历史会话 ' + index });
  }
  const pair = (await call('/pairing-codes', {})).value.data;
  const keys = generateKeyPairSync('ed25519');
  const device = (
    await call('/devices/pair', {
      code: pair.code,
      name: '仅供分页测试的离线设备',
      public_key: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      runtime: 'inspection',
      adapter_version: '1.0.0',
    })
  ).value.data;
  await server.services.devices.setRepositories(device.device_id, [
    {
      id: 'repo_pagination',
      name: 'synthetic-nonexecuting',
      base_commit: 'a'.repeat(40),
      branch: 'main',
      capabilities: ['file_read', 'file_search'],
    },
  ]);
  for (let index = 0; index < 61; index++) {
    const result = (
      await call('/tasks', {
        conversation_id: conversation,
        goal: '仅用于分页测试 ' + index,
        constraints: ['不得执行此测试夹具'],
        acceptance: [],
        source_refs: [],
        memory_refs: [],
        repository_binding_id: 'repo_pagination',
        base_commit: 'a'.repeat(40),
        execution_profile: 'code_review',
        budget: { wall_time_seconds: 30, max_model_calls: 1 },
      })
    ).value.data;
    if (index === 0) firstTask = result.id;
    await server.services.db.query(
      "UPDATE tasks SET created_at='2026-01-01T00:00:00Z'::timestamptz+($1::int*interval '1 microsecond') WHERE id=$2",
      [index, result.id],
    );
  }
}, 60000);
afterAll(async () => {
  if (server) await server.close();
});

it('uses default 20 and preserves all task positions within one database millisecond', async () => {
  const initial = (await call('/tasks')).value;
  expect(initial.data).toHaveLength(20);
  expect(initial.pagination.limit).toBe(20);
  expect(initial.data[0]).not.toHaveProperty('snapshot');
  expect(initial.data[0]).not.toHaveProperty('artifacts');
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page: PageWire = (
      await call('/tasks?limit=7' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))
    ).value;
    ids.push(...page.data.map((row: any) => row.id));
    cursor = page.pagination.next_cursor;
  } while (cursor);
  expect(ids).toHaveLength(61);
  expect(new Set(ids).size).toBe(61);
  expect(ids.at(-1)).toBe(firstTask);
  const bootstrap = (await call('/bootstrap')).value.data;
  expect(bootstrap.tasks).toHaveLength(20);
  expect(bootstrap.task_stats.total).toBe(61);
  expect(bootstrap.task_stats.pending).toBe(61);
  const detailed = (await call('/tasks/' + firstTask)).value.data;
  expect(detailed.snapshot.hash).toHaveLength(64);
});
for (const limit of ['0', '101', '-1', 'no', '1.5']) {
  it('rejects invalid page size ' + limit, async () => {
    await call('/tasks?limit=' + limit, undefined, owner, 400);
  });
}
it('rejects cursor corruption and reuse with a different filter or resource', async () => {
  const page = (await call('/tasks?limit=3')).value;
  await call('/tasks?cursor=not-json', undefined, owner, 400);
  await call('/tasks?state=done&cursor=' + page.pagination.next_cursor, undefined, owner, 400);
  await call('/sources?cursor=' + page.pagination.next_cursor, undefined, owner, 400);
  await call(
    '/tasks?cursor=' +
      encodeURIComponent(
        Buffer.from(
          JSON.stringify({
            v: 1,
            scope: 'tasks:all:all',
            id: 'task_bad',
            at: '2026-13-01T00:00:00.000000Z',
          }),
        ).toString('base64url'),
      ),
    undefined,
    owner,
    400,
  );
});
it('keeps source lists lightweight and independently checks full-text permissions', async () => {
  const page = (await call('/sources?limit=100')).value;
  const long = page.data.find((row: any) => row.id === source);
  expect(long.preview).toHaveLength(400);
  expect(long.character_count).toBeGreaterThan(4000);
  expect(long).not.toHaveProperty('content');
  const full = (await call('/sources/' + source + '?version=1')).value.data;
  expect(full.content).toContain('完整正文标记');
  const privateItem = page.data.find((row: any) => row.visibility === 'owner');
  await call('/sources/' + privateItem.id + '?version=1', undefined, member, 404);
  await call('/sources?visibility=owner', undefined, member, 403);
  let next: string | null = null;
  const members: any[] = [];
  do {
    const result: PageWire = (
      await call('/sources?limit=4' + (next ? '&cursor=' + next : ''), undefined, member)
    ).value;
    members.push(...result.data);
    next = result.pagination.next_cursor;
  } while (next);
  expect(members.length).toBe(17);
  expect(members.every((row) => row.visibility === 'shared')).toBe(true);
  const ownerCursor = (await call('/sources?limit=2')).value.pagination.next_cursor;
  await call('/sources?cursor=' + ownerCursor, undefined, member, 400);
});
it('does not overwrite a changed source with an old editing version', async () => {
  await call('/sources/' + source + '/versions', { content: 'version two', version: 1 });
  await call(
    '/sources/' + source + '/versions',
    { content: 'stale overwrite', version: 1 },
    owner,
    409,
  );
  expect((await call('/sources/' + source + '?version=2')).value.data.content).toBe('version two');
  expect((await call('/sources/' + source + '?version=1')).value.data.content).toContain(
    '完整正文标记',
  );
});
it('pages conversations and audit without exposing Owner audit to Member', async () => {
  const all: string[] = [];
  let cursor: string | null = null;
  do {
    const result: PageWire = (
      await call('/conversations?limit=5' + (cursor ? '&cursor=' + cursor : ''))
    ).value;
    all.push(...result.data.map((row: any) => row.id));
    cursor = result.pagination.next_cursor;
  } while (cursor);
  expect(all).toHaveLength(27);
  expect(new Set(all).size).toBe(27);
  const logs = (await call('/audit?limit=2')).value;
  expect(logs.data).toHaveLength(2);
  expect(logs.pagination.has_more).toBe(true);
  await call('/audit', undefined, member, 403);
});
it('loads latest message pages while context captures the actual conversation cutoff after message 1000', async () => {
  await server.services.db.query(
    "INSERT INTO messages(id,conversation_id,seq,author_id,body,client_message_id) SELECT 'msg_history_'||n,$1,n,$2,'记录 '||n,'client_history_'||n FROM generate_series(1,1005) AS n",
    [
      conversation,
      (await server.services.db.query("SELECT id FROM users WHERE role='OWNER'"))[0].id,
    ],
  );
  const recent = (await call('/conversations/' + conversation + '/messages')).value;
  expect(recent.data[0].seq).toBe(986);
  expect(recent.data.at(-1).seq).toBe(1005);
  const older = (
    await call(
      '/conversations/' + conversation + '/messages?cursor=' + recent.pagination.next_cursor,
    )
  ).value;
  expect(older.data[0].seq).toBe(966);
  expect(older.data.at(-1).seq).toBe(985);
  const created = (
    await call('/tasks', {
      conversation_id: conversation,
      conversation_cutoff_seq: 1005,
      goal: '确认真实截止消息',
      constraints: ['不得遗漏明确限制'],
      acceptance: [],
      source_refs: [],
      memory_refs: [],
      repository_binding_id: 'repo_pagination',
      base_commit: 'a'.repeat(40),
      execution_profile: 'code_review',
      budget: { wall_time_seconds: 30, max_model_calls: 1 },
    })
  ).value.data;
  const snapshot = (await call('/tasks/' + created.id)).value.data.snapshot;
  expect(snapshot.cutoff_seq).toBe(1005);
  expect(snapshot.recent_messages.at(-1).seq).toBe(1005);
  expect(snapshot.constraints).toEqual(['不得遗漏明确限制']);
});
