import type { RuntimeAdapter, RuntimeOptions } from '../../ports/runtime-adapter.js';
import { listFiles } from '../../safety/file-tools.js';
export class InspectionAdapter implements RuntimeAdapter {
  readonly kind = 'inspection' as const;
  readonly version = '1.0.0';
  async run(options: RuntimeOptions) {
    if (options.descriptor.execution_profile !== 'code_review')
      throw new Error('CAPABILITY_UNSUPPORTED');
    options.emit({
      type: 'phase.changed',
      visibility: 'shared',
      payload: { phase: '只读仓库检查' },
    });
    const files = await listFiles(options.worktree);
    // 无模型账号时用于验证链路，报告必须明确说明未调用 AI，不能冒充语义分析。
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 350);
      const abort = () => {
        clearTimeout(timer);
        reject(new Error('CANCELLED'));
      };
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    });
    options.emit({
      type: 'tool.finished',
      visibility: 'owner',
      payload: { tool: 'list_files', file_count: files.length },
    });
    return {
      status: 'succeeded' as const,
      verification: 'not_run' as const,
      diff: '',
      report: [
        '# 本地仓库检查结果',
        '运行方式：确定性只读检查（未调用 AI 模型）。',
        '任务：' + options.descriptor.snapshot.goal,
        '基线：' + options.descriptor.base_commit,
        '发现 ' + files.length + ' 个可访问文件（最多列出 300 个）。',
        ...files.slice(0, 80).map((file) => '- ' + file),
        '\n本次未修改代码、未运行测试，也不提供语义层面的代码正确性判断。',
        '\n需要 AI 分析或修改时，请以 Pi 运行模式重新连接 Bridge 并配置本机模型。',
      ].join('\n'),
    };
  }
}
