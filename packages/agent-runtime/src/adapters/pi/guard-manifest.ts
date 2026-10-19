import { readFile } from 'node:fs/promises';

/**
 * Bridge 为单次执行生成的权限清单。
 * 文件路径由父进程通过环境变量传入，不接受模型或群消息修改。
 */
export interface GuardManifest {
  /** 整个执行尝试的模型请求上限，工具结果后的再次推理也计入。 */
  maxModelCalls: number;
  /** 子进程写入此标记，父进程据此区分预算耗尽与普通取消。 */
  budgetExceededFile: string;
  /** 本次任务的独立 Git worktree，不是用户日常开发的工作目录。 */
  worktree: string;
  allowEdit: boolean;
  allowedWritePrefixes: string[];
  /** 短期上下文回读凭据的文件路径；凭据续租时更新，无需重启 Pi。 */
  contextAccessFile?: string;
  /** 获准回读的原文 ID；模型提出新 ID 不会扩大范围。 */
  allowedSources: string[];
}

export async function loadGuardManifest(): Promise<GuardManifest> {
  const manifestPath = process.env.TEAM_AGENT_GUARD_MANIFEST;
  if (!manifestPath) throw new Error('GUARD_MANIFEST_REQUIRED');
  return JSON.parse(await readFile(manifestPath, 'utf8')) as GuardManifest;
}
