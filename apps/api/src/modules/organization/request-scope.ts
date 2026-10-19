import { AsyncLocalStorage } from 'node:async_hooks';
import type { Services } from '../../container.js';

/** 只路由服务实例，不修改 SQL；后台作业始终持有自己的项目实例。 */
export const requestScope = new AsyncLocalStorage<Services>();
export function scopedServices(root: Services): Services {
  return new Proxy(root, {
    get(target, property) {
      return Reflect.get(requestScope.getStore() || target, property);
    },
  });
}
