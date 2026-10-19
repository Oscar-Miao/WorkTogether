import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { writeFile } from 'node:fs/promises';
import type { GuardManifest } from './guard-manifest.js';

/** 会话级控制集中在此；单个工具只负责自己的参数和业务行为。 */
export function installGuardHooks(
  pi: ExtensionAPI,
  manifest: GuardManifest,
  active: readonly string[],
): void {
  let providerRequests = 0;
  pi.on('before_provider_request', async (_event, ctx) => {
    if (++providerRequests > manifest.maxModelCalls) {
      // 必须在 HTTP 请求发出前终止；父进程看到 turn_start 时可能已经产生模型费用。
      try {
        await writeFile(manifest.budgetExceededFile, 'BUDGET_EXCEEDED', { mode: 0o600 });
      } finally {
        ctx.abort();
      }
    }
  });
  pi.on('session_start', () => {
    // 控制模型可见的工具集合；实际授权还依靠下面的调用拦截和工具内部检查。
    pi.setActiveTools([...active]);
  });
  pi.on('tool_call', (event) => {
    if (!active.includes(event.toolName))
      return { block: true, reason: 'TOOL_DENIED: 本次执行未获准使用该工具' };
  });
  // 同时关闭交互式命令入口，防止绕过受控工具直接进入 Shell。
  pi.on('user_bash', () => ({
    result: {
      output: 'TOOL_DENIED: 本次执行禁止交互式 Shell',
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  }));
}
