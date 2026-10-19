import { existsSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { RuntimeAdapter, RuntimeOptions } from '../../ports/runtime-adapter.js';

import { copyModelConfig } from '../../config/model-config.js';
import { getApprovedToolNames } from './tool-policy.js';
const execFileAsync = promisify(execFile);
/** 每次执行使用独立 Pi 配置目录，只继承模型连接和进程启动必需的环境。 */
function isolatedEnvironment(dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PI_CODING_AGENT_DIR: resolve(dataDir, 'pi-home'),
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
  };
  for (const key of [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'DEEPSEEK_API_KEY',
    'PI_PROVIDER_API_KEY',
    'GEMINI_API_KEY',
    'OPENROUTER_API_KEY',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}
/** 管理 Pi 子进程的生命周期与 JSON RPC；文件操作由子进程中的受控工具完成。 */
export class PiRpcAdapter implements RuntimeAdapter {
  readonly kind = 'pi' as const;
  readonly version = '1.3.0';
  async run(options: RuntimeOptions) {
    if (!options.model) throw new Error('MODEL_NOT_CONFIGURED');
    // 从工程锁定的依赖解析 CLI，避免 PATH 中个人安装的 Pi 版本影响执行。
    const root = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
    const cli = resolve(root, 'cli.js');
    // 这是项目源码里的扩展入口；Pi 负责加载它，不需要安装到个人 extensions 目录。
    const extension = resolve(dirname(fileURLToPath(import.meta.url)), 'guard-extension.ts');
    await mkdir(options.dataDir, { recursive: true });
    if (options.modelConfigFile) await copyModelConfig(options.modelConfigFile, options.dataDir);
    const manifestPath = resolve(options.dataDir, 'guard-manifest.json');
    const budgetExceededFile = resolve(options.dataDir, 'budget-exceeded');
    const sources = [
      ...options.descriptor.snapshot.evidence.map((x) => x.id),
      ...options.descriptor.snapshot.recent_messages.map((x) => x.id),
      ...options.descriptor.snapshot.historical_excerpts.map((x) => x.message_id),
      ...options.descriptor.snapshot.omitted_message_ids,
    ];
    // 只把本次已授权范围写入清单；模型不能通过工具参数修改这份授权。
    await writeFile(
      manifestPath,
      JSON.stringify({
        maxModelCalls: options.descriptor.budget.max_model_calls,
        budgetExceededFile,
        worktree: options.worktree,
        allowEdit: options.descriptor.execution_profile === 'code_edit',
        allowedWritePrefixes: options.allowedWritePrefixes,
        contextAccessFile: options.contextAccessFile,
        allowedSources: sources,
      }),
      { mode: 0o600 },
    );
    const env = isolatedEnvironment(options.dataDir);
    env.TEAM_AGENT_GUARD_MANIFEST = manifestPath;
    const tools = getApprovedToolNames(options.descriptor.execution_profile === 'code_edit');
    // 关闭自动发现与内置工具，只通过 --extension 显式加载受控扩展。
    // --mode rpc 使用标准输入/输出交换逐行 JSON，不模拟终端键盘输入。
    const args = [
      cli,
      '--mode',
      'rpc',
      '--no-session',
      '--no-extensions',
      '--no-mcp',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--no-approve',
      '--offline',
      '--no-builtin-tools',
      '--extension',
      extension,
      '--tools',
      tools.join(','),
      '--model',
      options.model,
      '--thinking',
      'off',
    ];
    if (options.provider) args.push('--provider', options.provider);
    options.emit({
      type: 'phase.changed',
      visibility: 'shared',
      payload: { phase: 'Pi 正在分析任务' },
    });
    // 子进程在独立 worktree 启动；管道分别承载请求、RPC 事件和诊断输出。
    const child = spawn(process.execPath, args, {
      cwd: options.worktree,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (child.pid) options.onProcess?.(child.pid);
    let buffer = '',
      report = '',
      stderr = '',
      calls = 0,
      outputBytes = 0,
      settled = false,
      finished = false;
    const decoder = new StringDecoder('utf8');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopping: Promise<void> | undefined;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    let abortListener: (() => void) | undefined;
    const redact = (value: string) =>
      Object.entries(env)
        .filter(([key, secret]) => /KEY|TOKEN/.test(key) && secret && secret.length >= 6)
        .reduce((text, [, secret]) => text.split(secret!).join('[REDACTED]'), value);
    // 多条失败路径可能同时请求停止，共用一个 Promise，避免重复杀进程。
    const stop = () => {
      if (stopping) return stopping;
      stopping = (async () => {
        try {
          if (settled) child.stdin.end();
          else child.stdin.write(JSON.stringify({ id: 'abort', type: 'abort' }) + '\n');
        } catch {}
        if (exited()) return;
        await new Promise<void>((r) => {
          const t = setTimeout(r, 1500);
          child.once('exit', () => {
            clearTimeout(t);
            r();
          });
        });
        if (exited()) return;
        // 先发 RPC abort 并等待退出；Windows 超时后按进程树终止，不能只杀父进程。
        if (process.platform === 'win32' && child.pid)
          await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
          }).catch(() => {});
        else child.kill('SIGKILL');
        await new Promise<void>((resolve, reject) => {
          if (exited()) {
            resolve();
            return;
          }
          const t = setTimeout(() => reject(new Error('STOP_UNCONFIRMED')), 5000);
          child.once('exit', () => {
            clearTimeout(t);
            resolve();
          });
        });
      })();
      return stopping;
    };
    const operation = new Promise<void>((resolveRun, rejectRun) => {
      const fail = (error: Error) => {
        if (finished) return;
        finished = true;
        rejectRun(error);
      };
      child.once('error', fail);
      child.once('exit', (code) => {
        if (!finished) {
          if (settled) {
            finished = true;
            resolveRun();
          } else fail(new Error('PI_EXITED_' + code));
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-8000);
      });
      child.stdout.on('data', (chunk) => {
        try {
          buffer += decoder.write(chunk);
          if (buffer.length > 256 * 1024) {
            fail(new Error('OUTPUT_LIMIT'));
            return;
          }
          let index: number;
          // RPC 只按 LF 分帧；JSON 字符串中的 Unicode 行分隔符不是事件边界。
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).replace(/\r$/, '');
            buffer = buffer.slice(index + 1);
            if (!line) continue;
            let event: any;
            try {
              event = JSON.parse(line);
            } catch {
              fail(new Error('PI_PROTOCOL_ERROR'));
              return;
            }
            if (event.type === 'response' && event.success === false) {
              fail(new Error('PI_REQUEST_REJECTED'));
              return;
            }
            if (
              event.type === 'message_update' &&
              event.assistantMessageEvent?.type === 'text_delta'
            ) {
              const text = String(event.assistantMessageEvent.delta || '');
              report += text;
              // 累计整个执行的输出量；更新最终报告时不能重置任务总配额。
              outputBytes += Buffer.byteLength(text);
              if (outputBytes > 10 * 1024 * 1024 || Buffer.byteLength(report) > 200000) {
                fail(new Error('OUTPUT_LIMIT'));
                return;
              }
              options.emit({ type: 'output.delta', visibility: 'owner', payload: { text } });
            }
            if (event.type === 'message_end' && event.message?.role === 'assistant') {
              const message = event.message;
              if (message.usage)
                options.emit({
                  type: 'model.usage',
                  visibility: 'owner',
                  payload: {
                    model: options.model,
                    input_tokens: message.usage.input > 0 ? message.usage.input : null,
                    output_tokens: message.usage.output > 0 ? message.usage.output : null,
                    cost_usd: message.usage.cost?.total > 0 ? message.usage.cost.total : null,
                  },
                });
              if (message.stopReason === 'error' || message.stopReason === 'aborted') {
                fail(
                  new Error(
                    existsSync(budgetExceededFile)
                      ? 'BUDGET_EXCEEDED'
                      : message.stopReason === 'aborted'
                        ? 'CANCELLED'
                        : 'MODEL_ERROR',
                  ),
                );
                return;
              }
              const text = (message.content || [])
                .filter((x: any) => x.type === 'text')
                .map((x: any) => x.text)
                .join('\n');
              if (Buffer.byteLength(text) > 200000) {
                fail(new Error('OUTPUT_LIMIT'));
                return;
              }
              if (text) report = text;
            }
            if (
              event.type === 'turn_start' &&
              ++calls > options.descriptor.budget.max_model_calls
            ) {
              fail(new Error('BUDGET_EXCEEDED'));
              return;
            }
            // 工具在 Pi 内部执行，Bridge 接收事件后写入账本并转发；这里不再次执行工具。
            if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end')
              options.emit({
                type: event.type === 'tool_execution_start' ? 'tool.started' : 'tool.finished',
                visibility: 'owner',
                payload: { tool: event.toolName, tool_call_id: event.toolCallId },
              });
            if (event.type === 'auto_compaction_start' || event.type === 'auto_compaction_end')
              options.emit({
                type: 'context.compacted',
                visibility: 'owner',
                payload: { phase: event.type },
              });
            if (event.type === 'agent_settled' && !finished) {
              settled = true;
              finished = true;
              resolveRun();
            }
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error('OUTPUT_DELIVERY_FAILED'));
        }
      });
      timer = setTimeout(
        () => fail(new Error('TASK_TIMEOUT')),
        options.descriptor.budget.wall_time_seconds * 1000,
      );
      const abort = () => fail(new Error('CANCELLED'));
      abortListener = abort;
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
      // 模型收到冻结的任务输入后，自行选择工具；Bridge 不逐条命令操控模型。
      child.stdin.write(
        JSON.stringify({
          id: 'prompt',
          type: 'prompt',
          message: options.descriptor.snapshot.model_input,
        }) + '\n',
      );
    });
    try {
      await operation;
      if (existsSync(budgetExceededFile)) throw new Error('BUDGET_EXCEEDED');
      if (!settled) throw new Error('PI_RESULT_UNCERTAIN');
      return {
        status: 'succeeded' as const,
        report: report + '\n\n验证状态：未运行测试。',
        diff: '',
        verification: 'not_run' as const,
      };
    } catch (error) {
      if (stderr)
        options.emit({
          type: 'runtime.diagnostic',
          visibility: 'owner',
          payload: { message: redact(stderr) },
        });
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (abortListener) options.signal.removeEventListener('abort', abortListener);
      // 即使 Pi 已返回最终回答，也需确认进程退出，才能向上层交付可靠的停止状态。
      await stop();
    }
  }
}
