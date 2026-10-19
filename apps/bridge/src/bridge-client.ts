import { WebSocket } from 'ws';
import { importSPKI, jwtVerify } from 'jose';
import { createHash, sign } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Dispatch, ExecutionResult, ServerToBridge, RuntimeKind } from '@team-agent/contracts';
import { canonical, descriptorFingerprint } from '@team-agent/domain';
import { PiRpcAdapter, InspectionAdapter, type RuntimeAdapter } from '@team-agent/agent-runtime';
import { authenticate, apiRequest, type BridgeConfig } from './config/config.js';
import { Ledger } from './modules/ledger/ledger.js';
import { acquireInstanceLock } from './modules/ledger/instance-lock.js';
import { prepareWorktree, collectDiff, repositoryInfo } from './modules/worktrees/worktrees.js';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** 本机执行代理：验签、去重、续租、准备 worktree，再将任务交给运行时适配器。 */
export class BridgeClient {
  private socket?: WebSocket;
  private token = '';
  private stopped = false;
  private reconnect?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private monitor?: ReturnType<typeof setInterval>;
  private refreshTokenAt = 0;
  private connecting = false;
  private readonly active = new Map<
    string,
    {
      controller: AbortController;
      validUntil: number;
      contextAccessFile: string;
      cancelReason?: string;
    }
  >();
  private readonly releaseLock: () => void;
  readonly ledger: Ledger;
  readonly runtime: RuntimeAdapter;
  constructor(
    private readonly config: BridgeConfig,
    private readonly dataDir: string,
  ) {
    // 同一数据目录只能有一个 Bridge；重启恢复账本前先取得单实例锁。
    this.releaseLock = acquireInstanceLock(dataDir);
    try {
      this.ledger = new Ledger(dataDir);
      this.ledger.recover();
    } catch (error) {
      this.releaseLock();
      throw error;
    }
    this.runtime = config.runtime === 'pi' ? new PiRpcAdapter() : new InspectionAdapter();
  }
  async start(): Promise<void> {
    await this.connect();
    this.heartbeat = setInterval(() => {
      this.send({ type: 'heartbeat' });
      void this.flushAll();
      if (Date.now() > this.refreshTokenAt) {
        this.socket?.close(4000, 'refresh credentials');
      }
    }, 10000);
    // 网络断开不能无限延长授权；即使收不到取消消息，租约到期也要停止。
    this.monitor = setInterval(() => {
      for (const [id, run] of this.active) {
        if (run.validUntil > 0 && Date.now() > run.validUntil && !run.controller.signal.aborted) {
          run.cancelReason = '运行许可到期，已请求停止';
          run.controller.abort();
        }
      }
    }, 1000);
  }
  private async connect(): Promise<void> {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    try {
      const auth = await authenticate(this.config);
      this.token = auth.access_token;
      this.refreshTokenAt = new Date(auth.expires_at).getTime() - 60000;
      const repo = await repositoryInfo(this.config.repository.path);
      await apiRequest(
        this.config.api,
        '/bridge/v1/repositories',
        {
          repositories: [
            {
              id: this.config.repository.id,
              name: this.config.repository.name,
              ...repo,
              write_prefixes: this.config.repository.allowedWritePrefixes,
              capabilities:
                this.config.runtime === 'pi' && this.config.repository.allowedWritePrefixes.length
                  ? ['file_read', 'file_search', 'file_edit']
                  : ['file_read', 'file_search'],
            },
          ],
        },
        this.token,
      );
      const url = new URL(this.config.api + '/bridge/v1/connect');
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      this.socket = new WebSocket(url, {
        headers: { Authorization: 'Bearer ' + this.token },
        maxPayload: 256 * 1024,
      });
      this.socket.on('open', () => {
        console.log('Bridge 已连接 · ' + this.config.runtime + ' · ' + this.config.deviceId);
        this.send({
          type: 'hello',
          protocol_version: '1',
          runtime: this.config.runtime,
          adapter_version: this.runtime.version,
          active_attempts: this.ledger
            .list()
            .filter((a) => !a.finish_ack)
            .map((a) => ({
              attempt_id: a.id,
              status: this.active.has(a.id)
                ? 'running'
                : a.status === 'stopped'
                  ? 'stopped'
                  : 'uncertain',
            })),
        });
      });
      this.socket.on('message', (data) => {
        void this.message(JSON.parse(data.toString())).catch((error) =>
          console.error('[bridge message]', error?.message || 'error'),
        );
      });
      this.socket.on('error', () => {});
      this.socket.on('close', () => {
        if (!this.stopped)
          this.reconnect = setTimeout(() => {
            void this.connect();
          }, 2000);
      });
    } catch (error: any) {
      console.error('[bridge connection]', error?.message || 'unavailable');
      if (!this.stopped)
        this.reconnect = setTimeout(() => {
          void this.connect();
        }, 3000);
    } finally {
      this.connecting = false;
    }
  }
  private send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
  private async message(message: ServerToBridge): Promise<void> {
    if (message.type === 'dispatch') {
      void this.execute(message);
      return;
    }
    if (message.type === 'ack') {
      this.ledger.acknowledge(message.attempt_id, message.seq);
      this.flush(message.attempt_id);
      return;
    }
    if (message.type === 'cancel') {
      const run = this.active.get(message.attempt_id);
      if (run) {
        run.cancelReason = message.reason;
        run.controller.abort();
      } else if (this.ledger.get(message.attempt_id)?.status !== 'stopped')
        this.send({
          type: 'uncertain',
          attempt_id: message.attempt_id,
          reason: '本次 Bridge 无受管进程句柄，不能确认停止',
        });
      return;
    }
    if (message.type === 'hello_ack') {
      await this.flushAll();
      return;
    }
    if (message.type === 'error') console.error('[server]', message.code);
  }
  private async renew(id: string, required = false): Promise<void> {
    const run = this.active.get(id);
    if (!run || run.controller.signal.aborted) return;
    try {
      const lease = await apiRequest<{ valid_until: string; context_permit?: string }>(
        this.config.api,
        '/bridge/v1/attempts/' + id + '/lease',
        {},
        this.token,
      );
      run.validUntil = new Date(lease.valid_until).getTime();
      if (lease.context_permit)
        await writeFile(
          run.contextAccessFile,
          JSON.stringify({
            url: this.config.api + '/bridge/v1/attempts/' + id + '/context',
            permit: lease.context_permit,
          }),
          { mode: 0o600 },
        );
    } catch (error: any) {
      // 续租网络失败时保留最后确认的截止时间，绝不能自行延长授权。
      if (['LEASE_REVOKED', 'TASK_TIMEOUT', 'DEVICE_AUTH_REQUIRED'].includes(error.message)) {
        run.cancelReason = error.message;
        run.controller.abort();
      }
      if (required) throw error;
    }
  }
  private async execute(dispatch: Dispatch): Promise<void> {
    const descriptor = dispatch.descriptor,
      id = descriptor.attempt_id;
    let reserved = false,
      verifiedHash: string | undefined,
      managedOperationStarted = false,
      renewTimer: ReturnType<typeof setInterval> | undefined,
      worktree: string | undefined;
    try {
      // 同时核对签名、目标设备、执行尝试及上下文摘要，防止许可被移用于其他任务。
      const publicKey = await importSPKI(this.config.serverPublicKey, 'EdDSA');
      const claims = (
        await jwtVerify(dispatch.start_permit, publicKey, {
          issuer: 'team-agent-api',
          audience: 'team-agent-bridge',
          algorithms: ['EdDSA'],
        })
      ).payload;
      const hash = digest(descriptorFingerprint(descriptor));
      const { hash: snapshotHash, ...snapshotBody } = descriptor.snapshot;
      if (
        claims.descriptor_hash !== hash ||
        (descriptor.leadership_epoch !== undefined &&
          claims.leadership_epoch !== descriptor.leadership_epoch) ||
        hash !== dispatch.descriptor_hash ||
        claims.device_id !== this.config.deviceId ||
        descriptor.device_id !== this.config.deviceId ||
        claims.attempt_id !== id ||
        claims.task_id !== descriptor.task_id ||
        claims.input_version !== descriptor.input_version ||
        digest(canonical(snapshotBody)) !== snapshotHash
      )
        throw new Error('PERMIT_SCOPE_DENIED');
      verifiedHash = hash;
      // 重传只恢复事件与结果交付；已有账本记录的尝试不能重复启动。
      const previous = this.ledger.get(id);
      if (previous) {
        if (previous.descriptor_hash !== hash) throw new Error('ATTEMPT_DESCRIPTOR_CONFLICT');
        if (previous.status === 'stopped') await this.submitResult(id);
        else if (this.active.has(id)) this.send({ type: 'started', attempt_id: id });
        else
          this.send({
            type: 'uncertain',
            attempt_id: id,
            reason: '执行账本已有此尝试；不重复启动',
          });
        return;
      }
      if (descriptor.repository_binding_id !== this.config.repository.id)
        throw new Error('REPOSITORY_SCOPE_DENIED');
      if (
        descriptor.execution_profile === 'code_edit' &&
        (this.config.runtime !== 'pi' || !this.config.repository.allowedWritePrefixes.length)
      )
        throw new Error('LOCAL_TOOL_POLICY_DENIED');
      if (
        descriptor.execution_profile === 'code_edit' &&
        (!descriptor.allowed_write_prefixes?.length ||
          !descriptor.allowed_write_prefixes.every((path) =>
            this.config.repository.allowedWritePrefixes.some(
              (prefix) => path === prefix || path.startsWith(prefix + '/'),
            ),
          ))
      )
        throw new Error('LOCAL_WRITE_SCOPE_DENIED');
      // 先持久化占用再准备目录或启动进程，崩溃后才能辨认未核清的执行。
      reserved = this.ledger.reserve(descriptor, hash);
      if (!reserved) {
        if (this.ledger.get(id)?.status === 'stopped') await this.submitResult(id);
        else if (this.active.has(id)) this.send({ type: 'started', attempt_id: id });
        else
          this.send({
            type: 'uncertain',
            attempt_id: id,
            reason: '执行账本已有此尝试；不重复启动',
          });
        return;
      }
      const attemptDir = resolve(this.dataDir, 'artifacts', descriptor.task_id, id);
      await mkdir(attemptDir, { recursive: true });
      const run = {
        controller: new AbortController(),
        validUntil: 0,
        contextAccessFile: resolve(attemptDir, 'context-access.json'),
        cancelReason: undefined as string | undefined,
      };
      this.active.set(id, run);
      this.ledger.running(id);
      this.send({ type: 'started', attempt_id: id });
      await this.renew(id, true);
      if (run.controller.signal.aborted) throw new Error('LEASE_REVOKED');
      renewTimer = setInterval(() => {
        void this.renew(id);
      }, 20000);
      const wallTimer = setTimeout(() => {
        run.cancelReason = 'TASK_TIMEOUT';
        run.controller.abort();
      }, descriptor.budget.wall_time_seconds * 1000);
      try {
        this.append(id, {
          type: 'phase.changed',
          visibility: 'shared',
          payload: { phase: '准备独立工作目录' },
        });
        managedOperationStarted = true;
        worktree = await prepareWorktree(
          this.config.repository.path,
          this.dataDir,
          descriptor,
          run.controller.signal,
        );
        if (run.controller.signal.aborted) throw new Error('CANCELLED');
        // Pi 适配器启动真正的 CLI；inspection 只做确定性检查，不调用模型。
        const result = await this.runtime.run({
          descriptor,
          worktree,
          dataDir: attemptDir,
          signal: run.controller.signal,
          allowedWritePrefixes: descriptor.allowed_write_prefixes || [],
          contextAccessFile: run.contextAccessFile,
          provider: process.env.PI_PROVIDER,
          model: process.env.PI_MODEL,
          modelConfigFile: process.env.TEAM_AGENT_MODEL_CONFIG,
          emit: (event) => this.append(id, event),
          onProcess: (pid) => this.ledger.running(id, pid),
        });
        result.diff = await collectDiff(worktree);
        this.ledger.stopped(
          id,
          result,
          'runtime settled; managed process exit confirmed; worktree retained',
        );
      } catch (error: any) {
        if (error?.message === 'STOP_UNCONFIRMED') {
          this.ledger.uncertain(id);
          this.send({ type: 'uncertain', attempt_id: id, reason: '受管进程尚未确认停止' });
          return;
        }
        // 运行时只有在受管操作已返回、进程退出已确认后，才允许写入 stopped。
        const cancelled = run.controller.signal.aborted;
        const code =
          run.cancelReason === 'TASK_TIMEOUT'
            ? 'TASK_TIMEOUT'
            : cancelled
              ? 'CANCELLED'
              : String(error?.message || 'RUNTIME_ERROR').slice(0, 100);
        const result: ExecutionResult = {
          status: code === 'CANCELLED' ? 'cancelled' : 'failed',
          error_code: code,
          report: cancelled
            ? '执行已停止；已发生的文件修改保留，未执行回滚。'
            : '执行未完成：' + code + '\n未运行测试；请检查 Owner 私有日志及模型配置。',
          diff: worktree ? await collectDiff(worktree).catch(() => '') : '',
          verification: 'not_run',
        };
        this.ledger.stopped(
          id,
          result,
          'managed operation returned or process exit confirmed; no automatic rollback',
        );
      } finally {
        clearTimeout(wallTimer);
      }
      await this.submitResult(id);
    } catch (error: any) {
      if (verifiedHash && !managedOperationStarted && (reserved || !this.ledger.get(id))) {
        const result: ExecutionResult = {
          status: 'failed',
          error_code: 'DISPATCH_REJECTED',
          report: '本机校验或首次续租失败，未启动工作目录准备或模型进程。',
          diff: '',
          verification: 'not_run',
        };
        if (reserved)
          this.ledger.stopped(
            id,
            result,
            'initial handoff rejected before managed operation spawn',
          );
        else this.ledger.rejectBeforeSpawn(descriptor, verifiedHash, result);
        // 拒绝结果已经落盘；上传失败只在重连后补传，不重新执行。
        await this.submitResult(id).catch(() => {});
      } else if (reserved && this.ledger.get(id)?.status !== 'stopped') {
        this.ledger.uncertain(id);
        this.send({ type: 'uncertain', attempt_id: id, reason: '执行交接失败，请核查本地账本' });
      }
      // 上传失败不撤销已落盘的停止证据；重连仅重试交付。
      else if (!reserved)
        this.send({
          type: 'uncertain',
          attempt_id: id,
          reason: '本地授权或资源校验失败，未重复启动',
        });
      console.error('[execution]', error?.message || 'error');
    } finally {
      if (renewTimer) clearInterval(renewTimer);
      if (reserved) this.active.delete(id);
    }
  }
  private append(id: string, event: Parameters<Ledger['append']>[1]): void {
    try {
      this.ledger.append(id, event);
      this.flush(id);
    } catch (error) {
      this.active.get(id)?.controller.abort();
      throw error;
    }
  }
  private flush(id: string): void {
    const events = this.ledger.pending(id);
    if (events.length) this.send({ type: 'event_batch', attempt_id: id, events });
  }
  private async flushAll(): Promise<void> {
    for (const attempt of this.ledger.list()) {
      this.flush(attempt.id);
      if (attempt.status === 'stopped' && !attempt.finish_ack)
        await this.submitResult(attempt.id).catch(() => {});
    }
  }
  private async submitResult(id: string): Promise<void> {
    const attempt = this.ledger.get(id);
    if (!attempt?.result || !attempt.stop_evidence) return;
    try {
      await apiRequest(
        this.config.api,
        '/bridge/v1/attempts/' + id + '/finish',
        { result: attempt.result, stop_evidence: attempt.stop_evidence },
        this.token,
      );
    } catch (error: any) {
      if (!['DEVICE_AUTH_REQUIRED', 'DEVICE_REVOKED'].includes(error.message)) throw error;
      // 设备撤销后普通上传会被拒绝，但仍应允许提交可验签的停止回执。
      const challenge = await apiRequest<{ challenge_id: string; nonce: string }>(
        this.config.api,
        '/bridge/v1/stop-challenges',
        { device_id: this.config.deviceId, attempt_id: id },
      );
      const payload = canonical({
        nonce: challenge.nonce,
        attempt_id: id,
        result: attempt.result,
        stop_evidence: attempt.stop_evidence,
      });
      const signature = sign(
        null,
        Buffer.from(payload),
        await readFile(this.config.privateKeyFile, 'utf8'),
      ).toString('base64url');
      await apiRequest(this.config.api, '/bridge/v1/attempts/' + id + '/stop-receipt', {
        device_id: this.config.deviceId,
        challenge_id: challenge.challenge_id,
        signature,
        result: attempt.result,
        stop_evidence: attempt.stop_evidence,
      });
    }
    this.ledger.finishAck(id);
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.monitor) clearInterval(this.monitor);
    for (const run of this.active.values()) {
      run.cancelReason = 'Bridge 正在退出';
      run.controller.abort();
    }
    const deadline = Date.now() + 10000;
    while (this.active.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (this.active.size) console.error('仍有未核清执行，请保留账本并手动核查进程');
    this.socket?.terminate();
    if (!this.active.size) {
      this.ledger.close();
      this.releaseLock();
    }
  }
}
