import { ApiError, csrfToken } from './api.js';
/** 身份和团队目录始终访问根控制面，不随当前项目的请求前缀变化。 */
export async function platform<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch('/api/v3' + path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers:
      body === undefined
        ? {}
        : {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken(),
            'Idempotency-Key': crypto.randomUUID(),
          },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok)
    throw new ApiError(
      value.error?.code || 'HTTP_ERROR',
      value.error?.message || '操作失败',
      response.status,
    );
  return value.data;
}
export function enterProject(id: string) {
  // 丢弃旧邀请、侧栏和在途请求；项目资格已由服务器校验，不能用 URL 获得权限。
  const next = new URL(location.origin + location.pathname);
  next.searchParams.set('project', id);
  location.assign(next);
}
export function teamToken(value: string): string {
  const raw = value.trim();
  if (/^[A-Za-z0-9_-]{43}$/.test(raw)) return raw;
  try {
    return new URL(raw).searchParams.get('join') || '';
  } catch {
    return '';
  }
}
