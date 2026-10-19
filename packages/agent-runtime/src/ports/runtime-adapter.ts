import type { ExecutionDescriptor, ExecutionResult, RuntimeEvent } from '@team-agent/contracts';

/** Bridge 传给一次执行的冻结输入与本机资源；适配器不能自行扩大权限。 */
export interface RuntimeOptions {
  descriptor: ExecutionDescriptor;
  /** 已按基线创建的独立任务工作目录。 */
  worktree: string;
  /** 本次尝试的私有配置、权限清单和结果目录。 */
  dataDir: string;
  /** 用户停止、租约失效或超时均通过同一取消信号传递。 */
  signal: AbortSignal;
  allowedWritePrefixes: string[];
  contextAccessFile?: string;
  provider?: string;
  model?: string;
  modelConfigFile?: string;
  /** 回调给 Bridge，由其持久化并上传；运行时不直接写业务数据库。 */
  emit(event: RuntimeEvent): void;
  /** 子进程启动后立即登记 PID，支持崩溃恢复时人工核查。 */
  onProcess?(pid: number): void;
}

/** 统一真实 Pi 和确定性检查的生命周期，返回前须完成受管操作的退出确认。 */
export interface RuntimeAdapter {
  readonly kind: 'pi' | 'inspection';
  readonly version: string;
  run(options: RuntimeOptions): Promise<ExecutionResult>;
}
