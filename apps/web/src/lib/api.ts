import { projectPrefix } from './project-scope.js';
import type { PageInfo, PageResult } from '@team-agent/contracts';
let csrf = '';
export const csrfToken = () => csrf;
export function setCsrf(value: string): void {
  csrf = value;
}
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function response<T>(
  path: string,
  body?: unknown,
  options: { key?: string; method?: string } = {},
): Promise<{ data: T; pagination?: PageInfo }> {
  const method = options.method || (body === undefined ? 'GET' : 'POST');
  const identityPath = /^\/(auth|invitations)(\/|$)/.test(path);
  const result = await fetch((identityPath ? '' : projectPrefix()) + '/api/v1' + path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(method === 'GET'
        ? {}
        : { 'X-CSRF-Token': csrf, 'Idempotency-Key': options.key || crypto.randomUUID() }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const envelope = await result
    .json()
    .catch(() => ({ error: { code: 'INVALID_RESPONSE', message: '服务响应无法读取' } }));
  if (!result.ok)
    throw new ApiError(
      envelope.error?.code || 'HTTP_ERROR',
      envelope.error?.message || '请求失败',
      result.status,
    );
  return envelope;
}
export async function api<T>(
  path: string,
  body?: unknown,
  options: { key?: string; method?: string } = {},
): Promise<T> {
  return (await response<T>(path, body, options)).data;
}
export async function apiPage<T>(path: string, cursor?: string): Promise<PageResult<T>> {
  const target =
    path +
    (path.includes('?') ? '&' : '?') +
    'limit=20' +
    (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
  const result = await response<T[]>(target);
  if (!result.pagination) throw new ApiError('INVALID_RESPONSE', '列表缺少分页信息', 502);
  return { items: result.data, pagination: result.pagination };
}
export const shortId = (id: string) => id.replace(/^[a-z]+_/, '').slice(0, 7);
export function timeLabel(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}
