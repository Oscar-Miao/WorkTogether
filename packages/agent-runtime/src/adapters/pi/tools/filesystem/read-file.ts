import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { readText } from '../../../../safety/file-tools.js';
import { textResult, type ToolRegistrar } from '../shared.js';

/** 将 Pi 的调用参数转交给独立的文件访问边界，不在描述或提示词中实现授权。 */
export const registerReadFileTool: ToolRegistrar = (pi, manifest) => {
  pi.registerTool(
    defineTool({
      name: 'ta_read_file',
      label: '读取获准代码文件',
      description:
        '读取本次任务工作目录内的 UTF-8 文本。禁止敏感文件和符号链接；单文件最大 1 MiB，每次最多返回 16000 个 UTF-16 码元，可用 offset 继续读取。',
      parameters: Type.Object({
        path: Type.String({
          description: '相对于本次任务工作目录的文件路径，不接受绝对路径或越界路径。',
        }),
        offset: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: '读取起点，按 JavaScript 字符串的 UTF-16 码元计数，默认 0。',
          }),
        ),
      }),
      async execute(_id, args) {
        return textResult(await readText(manifest.worktree, args.path, args.offset ?? 0));
      },
    }),
  );
};
