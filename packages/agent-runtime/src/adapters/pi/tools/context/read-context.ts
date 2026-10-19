import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import { textResult, type ToolRegistrar } from '../shared.js';

export const registerReadContextTool: ToolRegistrar = (pi, manifest) => {
  pi.registerTool(
    defineTool({
      name: 'ta_read_context',
      label: '回读授权原文',
      description:
        '按原文 ID 回读本次任务已获准访问的资料、消息或上游成果。仅允许权限清单内的 ID，不能借回读访问其他群聊或额外资料。',
      parameters: Type.Object({
        source_id: Type.String({
          description: '本次任务上下文中提供的资料或消息 ID，不接受自行推测的其他来源。',
        }),
        offset: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: '原文读取起点，按服务端文本的 UTF-16 码元计数，默认 0。',
          }),
        ),
      }),
      async execute(_id, args) {
        // 先做本地范围检查，再请求服务端；来源存在也不代表本次任务有权读取。
        if (!manifest.allowedSources.includes(args.source_id) || !manifest.contextAccessFile)
          throw new Error('CONTEXT_SOURCE_DENIED');
        // 每次调用重新读取短期凭据，让 Bridge 续租后的许可及时生效。
        const access = JSON.parse(await readFile(manifest.contextAccessFile, 'utf8'));
        const url =
          access.url + '/' + encodeURIComponent(args.source_id) + '?offset=' + (args.offset ?? 0);
        const response = await fetch(url, {
          headers: { Authorization: 'Bearer ' + access.permit },
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error('CONTEXT_READBACK_DENIED');
        return textResult(((await response.json()) as { data: unknown }).data);
      },
    }),
  );
};
