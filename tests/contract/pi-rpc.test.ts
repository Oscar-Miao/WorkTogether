import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PiRpcAdapter } from '../../packages/agent-runtime/src/adapters/pi/pi-rpc-adapter.js';
import type { ExecutionDescriptor, RuntimeEvent } from '@team-agent/contracts';

/** 启动真实 Pi 和真实文件系统，模型由本机合成服务代替；验证协议与权限，不代表真实模型质量。 */
async function runContract(allowEdit = false, maxCalls = 8) {
  await mkdir(resolve('.local/reports/pi-contract'), { recursive: true });
  const root = await mkdtemp(resolve('.local/reports/pi-contract/run-'));
  const worktree = resolve(root, 'repository'),
    dataDir = resolve(root, 'attempt');
  await mkdir(resolve(worktree, 'src'), { recursive: true });
  await mkdir(resolve(dataDir, 'pi-home'), { recursive: true });
  await writeFile(resolve(worktree, 'src/app.ts'), 'export const value = 42;');
  await writeFile(resolve(worktree, 'README.md'), 'unchanged');
  await mkdir(resolve(worktree, '.pi/extensions'), { recursive: true });
  await writeFile(resolve(worktree, 'AGENTS.md'), 'UNTRUSTED_PROJECT_PROMPT_MUST_NOT_LOAD');
  await writeFile(
    resolve(worktree, '.pi/extensions/untrusted.ts'),
    "import { writeFileSync } from 'node:fs'; export default function(){writeFileSync(" +
      JSON.stringify(resolve(worktree, 'untrusted-marker.txt')) +
      ",'bad')}",
  );
  await writeFile(resolve(worktree, '.env.local'), 'SYNTHETIC_SECRET=must-not-appear');
  const plan = [
    { name: 'ta_read_file', args: { path: 'src/app.ts' } },
    { name: 'ta_list_files', args: { directory: 'src' } },
    { name: 'ta_read_context', args: { source_id: 'source_rpc' } },
    { name: 'ta_read_context', args: { source_id: 'unapproved_source' } },
    ...(allowEdit
      ? [
          { name: 'ta_edit_file', args: { path: 'src/app.ts', old_text: '42', new_text: '43' } },
          {
            name: 'ta_edit_file',
            args: { path: 'README.md', old_text: 'unchanged', new_text: 'wrong' },
          },
        ]
      : []),
    { name: 'ta_read_file', args: { path: '.env.local' } },
  ];
  const requests: any[] = [],
    events: RuntimeEvent[] = [],
    contextRequests: string[] = [];
  const model = createServer(async (req, res) => {
    // 回读服务也走真实 HTTP：未获准的来源应在工具内被拒绝，不能到达此端口。
    if (req.method === 'GET') {
      contextRequests.push(req.url || '');
      if (
        req.url !== '/context/source_rpc?offset=0' ||
        req.headers.authorization !== 'Bearer synthetic-context-permit'
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { text: '已授权的协作原文', truncated: false } }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const step = requests.length;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = (delta: unknown, reason: string | null = null) =>
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'synthetic-' + step,
            object: 'chat.completion.chunk',
            created: 1,
            model: 'test-coder',
            choices: [{ index: 0, delta, finish_reason: reason }],
          }) +
          '\n\n',
      );
    send({ role: 'assistant' });
    if (step <= plan.length) {
      const tool = plan[step - 1];
      send({
        tool_calls: [
          {
            index: 0,
            id: 'call_' + step,
            type: 'function',
            function: { name: tool.name, arguments: JSON.stringify(tool.args) },
          },
        ],
      });
      send({}, 'tool_calls');
    } else {
      send({ content: '已读取获准代码，秘密文件访问已被拒绝。中文🧩传输完成。' });
      send({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((done) => model.listen(0, '127.0.0.1', done));
  const port = (model.address() as any).port;
  await writeFile(
    resolve(dataDir, 'context-access.json'),
    JSON.stringify({
      url: 'http://127.0.0.1:' + port + '/context',
      permit: 'synthetic-context-permit',
    }),
  );
  await writeFile(
    resolve(dataDir, 'pi-home/models.json'),
    JSON.stringify({
      providers: {
        'local-test': {
          baseUrl: 'http://127.0.0.1:' + port + '/v1',
          api: 'openai-completions',
          apiKey: 'synthetic-test-only',
          models: [
            {
              id: 'test-coder',
              name: 'Synthetic contract model',
              reasoning: false,
              input: ['text'],
              contextWindow: 32000,
              maxTokens: 1000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  const descriptor = {
    task_id: 'task_rpc',
    attempt_id: 'attempt_rpc',
    device_id: 'dev_rpc',
    input_version: 1,
    repository_binding_id: 'repo_rpc',
    base_commit: 'a'.repeat(40),
    execution_profile: allowEdit ? 'code_edit' : 'code_review',
    allowed_write_prefixes: allowEdit ? ['src'] : [],
    capabilities: ['file_read', 'file_search', ...(allowEdit ? ['file_edit'] : [])],
    result_audience: 'conv_rpc',
    budget: { wall_time_seconds: 45, max_model_calls: maxCalls },
    snapshot: {
      id: 'ctx_rpc',
      conversation_id: 'conv_rpc',
      cutoff_seq: 0,
      goal: 'Synthetic protocol test',
      constraints: ['Do not read secrets'],
      acceptance: [],
      evidence: [],
      recent_messages: [],
      historical_excerpts: [],
      omitted_message_ids: ['source_rpc'],
      compacted: false,
      model_input: 'Inspect src/app.ts using approved tools. Secret reads must be denied.',
      hash: 'b'.repeat(64),
    },
  } as ExecutionDescriptor;
  try {
    const operation = new PiRpcAdapter().run({
      descriptor,
      worktree,
      dataDir,
      signal: new AbortController().signal,
      allowedWritePrefixes: allowEdit ? ['src'] : [],
      provider: 'local-test',
      model: 'test-coder',
      contextAccessFile: resolve(dataDir, 'context-access.json'),
      emit: (event) => events.push(event),
    });
    if (maxCalls < plan.length + 1) {
      await expect(operation).rejects.toThrow('BUDGET_EXCEEDED');
      expect(requests.length).toBeLessThanOrEqual(maxCalls);
      return;
    }
    const result = await operation;
    expect(result.status, JSON.stringify(events)).toBe('succeeded');
    expect(result.report).toContain('中文🧩');
    expect(result.verification).toBe('not_run');
    expect(requests).toHaveLength(plan.length + 1);
    await expect(access(resolve(worktree, 'untrusted-marker.txt'))).rejects.toThrow();
    expect(JSON.stringify(requests[0].messages)).not.toContain(
      'UNTRUSTED_PROJECT_PROMPT_MUST_NOT_LOAD',
    );
    for (const request of requests) {
      expect(request.tools.map((tool: any) => tool.function.name).sort()).toEqual(
        [
          'ta_list_files',
          'ta_read_context',
          'ta_read_file',
          ...(allowEdit ? ['ta_edit_file'] : []),
        ].sort(),
      );
      // 断言真正发给模型的工具说明和参数说明为中文，而不只检查源码字符串。
      for (const tool of request.tools) {
        expect(tool.function.description).toMatch(/\p{Script=Han}/u);
        for (const parameter of Object.values(tool.function.parameters.properties) as any[])
          expect(parameter.description).toMatch(/\p{Script=Han}/u);
      }
    }
    expect(JSON.stringify(requests[1].messages)).toContain('export const value = 42');
    expect(JSON.stringify(requests.at(-1).messages)).toContain('PATH_OUT_OF_SCOPE');
    expect(JSON.stringify(requests)).not.toContain('must-not-appear');
    expect(await readFile(resolve(worktree, 'src/app.ts'), 'utf8')).toBe(
      'export const value = ' + (allowEdit ? '43' : '42') + ';',
    );
    expect(await readFile(resolve(worktree, 'README.md'), 'utf8')).toBe('unchanged');
    const finalMessages = JSON.stringify(requests.at(-1).messages);
    expect(finalMessages).toContain('src/app.ts');
    expect(finalMessages).toContain('已授权的协作原文');
    expect(finalMessages).toContain('CONTEXT_SOURCE_DENIED');
    expect(contextRequests).toEqual(['/context/source_rpc?offset=0']);
    if (allowEdit) expect(finalMessages).toContain('WRITE_PREFIX_DENIED');
  } finally {
    model.closeAllConnections();
    await new Promise<void>((done) => model.close(() => done()));
  }
}
it('runs real read-only Pi RPC and denies secret-file access', () => runContract(), 60000);
it('edits through actual Pi tools only inside the approved prefix', () => runContract(true), 60000);
it(
  'stops at the model request budget before another HTTP call',
  () => runContract(false, 1),
  60000,
);
