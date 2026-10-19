import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { bridgeMessageSchema } from '@team-agent/contracts';
import type { ServerToBridge } from '@team-agent/contracts';
import { DeviceService } from './device-service.js';
import { TaskService } from '../tasks/task-service.js';

export class BridgeGateway {
  private readonly sockets = new Map<string, WebSocket>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  constructor(
    private readonly devices: DeviceService,
    private readonly tasks: TaskService,
  ) {}
  attach(server: Server, prefix = ''): void {
    server.on('upgrade', (request, socket, head) => {
      if (request.url !== prefix + '/bridge/v1/connect') return;
      if (request.headers.origin) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const token = request.headers.authorization?.replace(/^Bearer /, '');
      void this.devices
        .authenticate(token)
        .then((device) => {
          this.wss.handleUpgrade(request, socket, head, (ws) => {
            const previous = this.sockets.get(device.id);
            if (previous) previous.close(4000, 'device reconnected');
            this.sockets.set(device.id, ws);
            let ready = false;
            let processing = Promise.resolve();
            ws.on('message', (data) => {
              // Serialize device messages: finish must not overtake started or a durable event batch.
              processing = processing
                .then(async () => {
                  const message = bridgeMessageSchema.parse(JSON.parse(data.toString()));
                  await this.devices.authenticate(token);
                  if (message.type === 'hello') {
                    await this.devices.heartbeat(device.id);
                    ready = true;
                    this.send(device.id, { type: 'hello_ack', device_id: device.id });
                    await this.tasks.restore(device.id, message.active_attempts);
                    await this.tick();
                    return;
                  }
                  if (!ready) throw new Error('HELLO_REQUIRED');
                  if (message.type === 'heartbeat') {
                    await this.devices.heartbeat(device.id);
                    return;
                  }
                  if (message.type === 'started') {
                    await this.tasks.started(device.id, message.attempt_id);
                    return;
                  }
                  if (message.type === 'event_batch') {
                    const seq = await this.tasks.ingest(
                      device.id,
                      message.attempt_id,
                      message.events,
                    );
                    this.send(device.id, { type: 'ack', attempt_id: message.attempt_id, seq });
                    return;
                  }
                  if (message.type === 'finished') {
                    await this.tasks.finish(
                      device.id,
                      message.attempt_id,
                      message.result,
                      message.stop_evidence,
                    );
                    return;
                  }
                  if (message.type === 'uncertain') {
                    await this.tasks.uncertain(device.id, message.attempt_id, message.reason);
                  }
                })
                .catch((error) => {
                  this.send(device.id, {
                    type: 'error',
                    code: error.code || 'PROTOCOL_ERROR',
                    message: '设备请求无法处理，请核查本机日志',
                  });
                });
            });
            ws.on('close', () => {
              if (this.sockets.get(device.id) === ws) this.sockets.delete(device.id);
            });
            ws.on('error', () => {});
          });
        })
        .catch(() => socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'));
    });
    this.tasks.onQueued = () => {
      void this.tick();
    };
    this.tasks.onCancel = (id, attemptId, reason) =>
      this.send(id, { type: 'cancel', attempt_id: attemptId, reason });
    this.timer = setInterval(() => {
      void this.tick();
    }, 1000);
    this.timer.unref();
  }
  private send(id: string, message: ServerToBridge): void {
    const socket = this.sockets.get(id);
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tasks.expireQueued();
      const devices = await this.devices.list();
      for (const device of devices) {
        if (device.status !== 'online') {
          await this.tasks.markDeviceOffline(device.id);
          continue;
        }
        if (!this.sockets.has(device.id)) continue;
        const dispatch = await this.tasks.claim(device.id);
        if (dispatch) this.send(device.id, dispatch);
      }
    } catch (error: any) {
      // A transient database/queue error never creates an untracked retry.
      if (error?.code !== '23505')
        console.error('[scheduler]', error?.code || error?.name || 'error');
    } finally {
      this.ticking = false;
    }
  }
  close(): void {
    if (this.timer) clearInterval(this.timer);
    for (const ws of this.sockets.values()) ws.close();
    this.wss.close();
  }
  disconnect(id: string): void {
    this.sockets.get(id)?.close(4001, 'revoked');
  }
}
