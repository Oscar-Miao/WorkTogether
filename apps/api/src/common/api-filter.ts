import { Catch, type ArgumentsHost, type ExceptionFilter, HttpException } from '@nestjs/common';
import { z } from '@team-agent/contracts';
import type { Database } from '@team-agent/database';
import { DomainError } from '@team-agent/domain';
import { audit, ids, sha } from './security.js';

@Catch()
export class ApiFilter implements ExceptionFilter {
  constructor(private readonly db: Database) {}
  async catch(error: any, host: ArgumentsHost): Promise<void> {
    const response = host.switchToHttp().getResponse();
    const request = host.switchToHttp().getRequest();
    if (response.headersSent) return;
    const requestId = response.getHeader('X-Request-ID') || ids('req');
    response.setHeader('X-Request-ID', requestId);
    let status = 500,
      code = 'INTERNAL_ERROR',
      message = '服务暂时不可用，请稍后重试';
    if (error instanceof DomainError) {
      status = error.status;
      code = error.code;
      message = error.message;
    } else if (error instanceof z.ZodError) {
      status = 400;
      code = 'INVALID_INPUT';
      message = error.issues[0]?.message || '输入格式不正确';
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      code = 'HTTP_ERROR';
      message = status === 404 ? '接口不存在' : '请求无法处理';
    } else if (error?.code === '23505') {
      status = 409;
      code = 'CONFLICT';
      message = '记录已存在或正在被其他请求处理';
    } else console.error('[api]', requestId, error?.code || error?.name || 'unknown');
    if (status === 403) {
      try {
        const token = request.cookies?.ta_session;
        const session =
          typeof token === 'string'
            ? (
                await this.db.query(
                  'SELECT user_id FROM sessions WHERE id=$1 AND expires_at>now()',
                  [sha(token)],
                )
              )[0]
            : undefined;
        // Only trusted session identity and route templates enter the denial audit; never headers/body.
        await audit(this.db, session?.user_id || 'anonymous', 'request.denied', String(requestId), {
          method: request.method,
          route: request.route?.path || 'unmatched',
          code,
        });
      } catch {
        console.error('[audit]', requestId, 'denial audit unavailable');
      }
    }
    response
      .status(status)
      .json({ error: { code, message, retryable: status >= 500 }, request_id: requestId });
  }
}
