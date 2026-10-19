import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../../apps/api/src/application.js';
import { RetentionService } from '../../apps/api/src/modules/maintenance/retention-service.js';
import type { User } from '@team-agent/contracts';

let server: Awaited<ReturnType<typeof createApplication>>,
  url: string,
  user: User,
  conversation: string;
let owner: { cookie: string; csrf: string }, member: typeof owner;
const origin = 'http://127.0.0.1:5173',
  password = 'Synthetic-retention-' + randomUUID();
async function call(
  path: string,
  body?: unknown,
  status = body === undefined ? 200 : 201,
  session = owner,
  key = randomUUID(),
) {
  const response = await fetch(url + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: origin,
      Cookie: session?.cookie || '',
      'X-CSRF-Token': session?.csrf || '',
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = (await response.json()) as any;
  expect(response.status, JSON.stringify(value.error)).toBe(status);
  return { value: value.data, error: value.error, response };
}
async function login(email: string) {
  const result = await call('/auth/login', { email, password });
  return {
    cookie: result.response.headers.get('set-cookie')!.split(';')[0],
    csrf: result.value.csrf,
  };
}
async function seed(state = 'SUCCEEDED', age = 40) {
  const id = 'task_' + randomUUID(),
    attempt = 'attempt_' + randomUUID();
  const input = {
    source_refs: [],
    memory_refs: [],
    repository_binding_id: 'repo_retention',
    goal: 'synthetic retention',
  };
  await server.services.db.query(
    "INSERT INTO tasks(id,conversation_id,creator_id,state,input,snapshot,approval,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()-($8::int * interval '1 day'),now()-($8::int * interval '1 day'))",
    [
      id,
      conversation,
      user.id,
      state,
      JSON.stringify(input),
      JSON.stringify({ hash: 'a'.repeat(64) }),
      JSON.stringify({ expires_at: new Date(Date.now() + 1800000).toISOString() }),
      age,
    ],
  );
  await server.services.db.query(
    "INSERT INTO execution_attempts(id,task_id,device_id,status,descriptor,stopped_at,stop_evidence) VALUES($1,$2,'device_retention','stopped','{}',now(),'synthetic stopped')",
    [attempt, id],
  );
  await server.services.db.query('UPDATE tasks SET attempt_id=$1 WHERE id=$2', [attempt, id]);
  await server.services.db.query(
    "INSERT INTO execution_events(task_id,attempt_id,seq,type,visibility,payload,occurred_at) VALUES($1,$2,1,'output.delta','owner',$3,now()-($4::int * interval '1 day'))",
    [id, attempt, JSON.stringify({ text: 'synthetic private raw output' }), age],
  );
  await server.services.db.query(
    "INSERT INTO artifacts(id,task_id,attempt_id,kind,title,content,published,created_at) VALUES($1,$2,$3,'report','private','synthetic private body',false,now()-($4::int * interval '1 day')),($5,$2,$3,'report','shared','published evidence',true,now()-($4::int * interval '1 day'))",
    [id + '_private', id, attempt, age, id + '_shared'],
  );
  return id;
}
beforeAll(async () => {
  await mkdir(resolve('.local/reports/retention'), { recursive: true });
  const dir = await mkdtemp(resolve('.local/reports/retention/run-'));
  // Every cleanup below is confined to this newly created synthetic database; never .local/server.
  server = await createApplication({
    dataDir: resolve(dir, 'server'),
    databaseUrl: undefined,
    production: false,
    ownerEmail: 'owner@retention.test',
    ownerPassword: password,
    webOrigin: origin,
    retentionEnabled: false,
  });
  await server.app.listen(0, '127.0.0.1');
  url = 'http://127.0.0.1:' + server.app.getHttpServer().address().port;
  owner = await login('owner@retention.test');
  user = (await server.services.db.query("SELECT * FROM users WHERE role='OWNER'"))[0] as User;
  const invitation = (await call('/invitations', { email: 'member@retention.test' })).value;
  await call('/invitations/accept', { token: invitation.token, name: '合成成员', password });
  member = await login('member@retention.test');
  conversation = (await call('/conversations', { title: '保留测试' })).value.id;
  await server.services.db.query(
    "INSERT INTO devices(id,owner_id,name,public_key,runtime,adapter_version,repositories) VALUES('device_retention',$1,'synthetic','synthetic','inspection','1.0.0',$2)",
    [user.id, JSON.stringify([{ id: 'repo_retention' }])],
  );
});
afterAll(async () => {
  await server?.close();
});
it('defaults to preview only, enforces Owner and refuses cleanup when disabled', async () => {
  const id = await seed();
  const preview = (await call('/tasks/' + id + '/retention')).value;
  expect(preview.enabled).toBe(false);
  expect(preview.raw_events).toBe(1);
  expect(preview.private_artifacts).toHaveLength(1);
  expect(
    (
      await call(
        '/tasks/' + id + '/cleanup',
        { version: preview.version, reason: 'synthetic' },
        409,
      )
    ).error.code,
  ).toBe('RETENTION_NOT_ENABLED');
  await call('/tasks/' + id + '/retention', undefined, 403, member);
  await call(
    '/tasks/' + id + '/retention-hold',
    { version: preview.version, hold: true, reason: 'synthetic' },
    403,
    member,
  );
  expect(
    (
      await server.services.db.query('SELECT content FROM artifacts WHERE id=$1', [id + '_private'])
    )[0].content,
  ).toBe('synthetic private body');
});
it('requires a fresh version, protects held/active/uncertain tasks, and allows explicit release', async () => {
  // Enable only this isolated service, with no background timer.
  server.services.maintenance = new RetentionService(server.services.db, () => {}, true);
  const id = await seed();
  await call('/tasks/' + id + '/retention-hold', { version: 1, hold: true, reason: '争议证据' });
  expect(
    (await call('/tasks/' + id + '/cleanup', { version: 1, reason: 'stale' }, 409)).error.code,
  ).toBe('VERSION_CONFLICT');
  expect(
    (await call('/tasks/' + id + '/cleanup', { version: 2, reason: 'held' }, 409)).error.code,
  ).toBe('RETENTION_PROTECTED');
  await call('/tasks/' + id + '/retention-hold', { version: 2, hold: false, reason: '已核实' });
  const active = await seed('RUNNING');
  expect(
    (await call('/tasks/' + active + '/cleanup', { version: 1, reason: 'active' }, 409)).error.code,
  ).toBe('RETENTION_PROTECTED');
  const uncertain = await seed();
  await server.services.db.query(
    "UPDATE execution_attempts SET status='uncertain' WHERE task_id=$1",
    [uncertain],
  );
  expect(
    (await call('/tasks/' + uncertain + '/cleanup', { version: 1, reason: 'unknown' }, 409)).error
      .code,
  ).toBe('STOP_UNCONFIRMED');
});
it('clears only private bodies, keeps hashes and shared evidence, and replays idempotently', async () => {
  const id = await seed('SUCCEEDED', 1),
    key = randomUUID();
  const first = await call(
    '/tasks/' + id + '/cleanup',
    { version: 1, reason: 'synthetic explicit preview' },
    201,
    owner,
    key,
  );
  const replay = await call(
    '/tasks/' + id + '/cleanup',
    { version: 1, reason: 'synthetic explicit preview' },
    201,
    owner,
    key,
  );
  expect(replay.value).toEqual(first.value);
  const task = (await call('/tasks/' + id)).value;
  expect(task.content_revision).toBe(1);
  expect(task.artifacts.find((item: any) => item.published).content).toBe('published evidence');
  const purged = task.artifacts.find((item: any) => !item.published);
  expect(purged.content).toBe('');
  expect(purged.content_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(purged.purged_at).toBeTruthy();
  await call('/tasks/' + id + '/artifacts/' + purged.id + '/publish', {}, 404);
  const events = await server.services.db.query(
    "SELECT payload,purged_at FROM execution_events WHERE task_id=$1 AND visibility='owner'",
    [id],
  );
  expect(events[0].payload.purged).toBe(true);
  expect(events[0].payload.text).toBeUndefined();
  expect(task.snapshot.hash).toBe('a'.repeat(64));
});
it('applies 30/180 day ages without cleaning fresh, held or unresolved evidence', async () => {
  const old = await seed('SUCCEEDED', 190),
    fresh = await seed('FAILED', 2),
    held = await seed('FAILED', 190);
  await call('/tasks/' + held + '/retention-hold', { version: 1, hold: true, reason: 'dispute' });
  const counts = await server.services.maintenance.run();
  expect(counts.approvals).toBeGreaterThanOrEqual(1);
  const task = (await call('/tasks/' + old)).value;
  expect(task.approval).toBeNull();
  expect(task.approval_purged_at).toBeTruthy();
  expect(task.artifacts.find((item: any) => !item.published).purged_at).toBeTruthy();
  for (const id of [fresh, held]) {
    const artifact = (
      await server.services.db.query('SELECT * FROM artifacts WHERE id=$1', [id + '_private'])
    )[0];
    expect(artifact.purged_at).toBeNull();
    expect(artifact.content).toBe('synthetic private body');
  }
  expect(
    await server.services.db.query(
      "SELECT status FROM execution_attempts WHERE status='uncertain'",
    ),
  ).toHaveLength(1);
});
it('expires an offline queued approval without retention and serializes queue admissions at 20', async () => {
  const expired = await seed('QUEUED', 1);
  await server.services.db.query('UPDATE tasks SET approval=$1 WHERE id=$2', [
    JSON.stringify({ expires_at: new Date(0).toISOString() }),
    expired,
  ]);
  await server.services.tasks.expireQueued();
  expect((await call('/tasks/' + expired)).value.state).toBe('EXPIRED');
  for (let i = 0; i < 19; i++) await seed('QUEUED', 0);
  const first = await seed('PENDING_APPROVAL', 0),
    second = await seed('PENDING_APPROVAL', 0);
  const responses = await Promise.all(
    [first, second].map((id) =>
      fetch(url + '/api/v1/tasks/' + id + '/approve', {
        method: 'POST',
        headers: {
          Origin: origin,
          Cookie: owner.cookie,
          'X-CSRF-Token': owner.csrf,
          'Content-Type': 'application/json',
          'Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({ version: 1, input_version: 1, snapshot_hash: 'a'.repeat(64) }),
      }),
    ),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([201, 429]);
  expect(
    (await server.services.db.query("SELECT count(*)::int AS n FROM tasks WHERE state='QUEUED'"))[0]
      .n,
  ).toBe(20);
});
