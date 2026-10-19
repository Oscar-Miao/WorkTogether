import type { Database } from '@team-agent/database';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { canonical, renderContext } from '../../packages/domain/src/index.js';
/** Synthetic browser fixtures only; these rejected tasks never ran and carry no execution claim. */
export async function seedBrowserHistory(db: Database) {
  const owner = (await db.query("SELECT id FROM users WHERE role='OWNER'"))[0].id;
  const key = generateKeyPairSync('ed25519')
    .publicKey.export({ type: 'spki', format: 'pem' })
    .toString();
  await db.query(
    "INSERT INTO devices(id,owner_id,name,public_key,runtime,adapter_version,revoked,repositories,created_at) VALUES('dev_history',$1,'合成历史设备',$2,'inspection','1.0.0',true,$3,'2026-01-01')",
    [
      owner,
      key,
      JSON.stringify([
        {
          id: 'repo_history',
          name: '合成历史仓库',
          base_commit: 'a'.repeat(40),
          branch: 'main',
          capabilities: ['file_read', 'file_search'],
        },
      ]),
    ],
  );
  for (let index = 0; index < 25; index++) {
    const suffix = String(index).padStart(2, '0'),
      date = '2026-01-01T00:00:00.000' + String(index).padStart(3, '0') + 'Z';
    await db.query(
      'INSERT INTO conversations(id,title,created_by,created_at) VALUES($1,$2,$3,$4)',
      ['conv_history_' + suffix, '历史会话 ' + suffix, owner, date],
    );
    const content =
      index === 0
        ? '这是合成的长资料正文。\n'.repeat(800) + '完整资料末尾校验标记'
        : '合成资料 ' + suffix;
    await db.query(
      'INSERT INTO sources(id,name,visibility,created_by,created_at) VALUES($1,$2,$3,$4,$5)',
      ['src_history_' + suffix, '历史资料 ' + suffix, 'shared', owner, date],
    );
    await db.query(
      'INSERT INTO source_versions(source_id,version,content,content_hash) VALUES($1,1,$2,$3)',
      ['src_history_' + suffix, content, createHash('sha256').update(content).digest('hex')],
    );
    await db.query(
      "INSERT INTO memories(id,title,content,source_refs,created_by,created_at) VALUES($1,$2,$3,'[]',$4,$5)",
      ['mem_history_' + suffix, '历史结论 ' + suffix, '合成候选结论，尚未人工确认。', owner, date],
    );
    const goal = '[合成夹具] 历史任务 ' + suffix;
    const input = {
      conversation_id: 'conv_general',
      conversation_cutoff_seq: 0,
      goal,
      constraints: ['仅为分页界面测试，不执行代码'],
      acceptance: [],
      source_refs: [],
      memory_refs: [],
      repository_binding_id: 'repo_history',
      base_commit: 'a'.repeat(40),
      execution_profile: 'code_review',
      budget: { wall_time_seconds: 30, max_model_calls: 1 },
      allowed_write_prefixes: [],
    };
    const base = {
      id: 'ctx_history_' + suffix,
      conversation_id: 'conv_general',
      cutoff_seq: 0,
      goal,
      constraints: input.constraints,
      acceptance: [],
      evidence: [],
      recent_messages: [],
      historical_excerpts: [],
      omitted_message_ids: [],
      compacted: false,
    };
    const body = { ...base, model_input: renderContext(base) };
    const snapshot = { ...body, hash: createHash('sha256').update(canonical(body)).digest('hex') };
    await db.query(
      "INSERT INTO tasks(id,conversation_id,creator_id,state,version,input,snapshot,created_at,updated_at) VALUES($1,'conv_general',$2,'REJECTED',2,$3,$4,$5,$5)",
      ['task_history_' + suffix, owner, JSON.stringify(input), JSON.stringify(snapshot), date],
    );
  }
  await db.query(
    "INSERT INTO messages(id,conversation_id,seq,author_id,body,client_message_id,created_at) SELECT 'msg_history_'||n,'conv_general',n,$1,'历史消息 '||lpad(n::text,3,'0'),'history_message_'||n,'2026-01-01T00:01:00Z'::timestamptz+(n*interval '1 second') FROM generate_series(1,45) AS n",
    [owner],
  );
}
