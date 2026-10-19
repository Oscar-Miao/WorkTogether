import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { listFiles } from '../../../../safety/file-tools.js';
import { textResult, type ToolRegistrar } from '../shared.js';

export const registerListFilesTool: ToolRegistrar = (pi, manifest) => {
  pi.registerTool(
    defineTool({
      name: 'ta_list_files',
      label: '列出代码文件',
      description:
        '递归列出本次任务工作目录内最多 300 个文件，跳过敏感目录、敏感文件和符号链接。结果路径相对于任务工作目录。',
      parameters: Type.Object({
        directory: Type.Optional(
          Type.String({ description: '需要列出的相对目录，默认点号，表示任务工作目录。' }),
        ),
      }),
      async execute(_id, args) {
        return textResult(await listFiles(manifest.worktree, args.directory || '.'));
      },
    }),
  );
};
