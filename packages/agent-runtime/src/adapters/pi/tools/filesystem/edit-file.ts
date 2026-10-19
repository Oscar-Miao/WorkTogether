import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { editText } from '../../../../safety/file-tools.js';
import { textResult, type ToolRegistrar } from '../shared.js';

/** 编辑工具仅在本次任务获准写入时注册；每次调用还会校验具体文件的写入前缀。 */
export const registerEditFileTool: ToolRegistrar = (pi, manifest) => {
  pi.registerTool(
    defineTool({
      name: 'ta_edit_file',
      label: '精确修改获准文件',
      description:
        '在主设备已授权目录内，对既有文本文件执行一次精确替换。old_text 必须非空且只匹配一处；禁止新建、删除、执行命令或提交代码。',
      parameters: Type.Object({
        path: Type.String({
          description: '相对于任务工作目录的既有文件路径，必须位于本次获准写入的目录内。',
        }),
        old_text: Type.String({
          minLength: 1,
          description: '需要替换的完整原文，必须在文件中恰好出现一次。',
        }),
        new_text: Type.String({
          description: '替换后的文本；允许空字符串，用于删除已精确定位的文本片段。',
        }),
      }),
      async execute(_id, args) {
        await editText(
          manifest.worktree,
          args.path,
          args.old_text,
          args.new_text,
          manifest.allowedWritePrefixes,
        );
        return textResult({ updated: true });
      },
    }),
  );
};
