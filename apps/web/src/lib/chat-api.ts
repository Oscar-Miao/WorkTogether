import { projectPrefix } from './project-scope.js';
import { ApiError, csrfToken } from './api.js';
export async function chatApi<T>(path: string, body?: unknown, key?: string): Promise<T> {
  const r = await fetch(projectPrefix() + '/api/v2' + path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers:
      body === undefined
        ? {}
        : {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken(),
            'Idempotency-Key': key || crypto.randomUUID(),
          },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await r
    .json()
    .catch(() => ({ error: { code: 'INVALID_RESPONSE', message: '服务响应无法读取' } }));
  if (!r.ok)
    throw new ApiError(
      value.error?.code || 'HTTP_ERROR',
      value.error?.message || '请求失败',
      r.status,
    );
  return value.data as T;
}
