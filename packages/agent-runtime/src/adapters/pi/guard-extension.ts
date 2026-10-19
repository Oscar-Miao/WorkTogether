import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadGuardManifest } from './guard-manifest.js';
import { installGuardHooks } from './guard-hooks.js';
import { registerApprovedTools } from './tools/registry.js';

/**
 * Pi 的扩展入口：由 Pi 加载后调用，不是 Bridge 直接调用。
 * 此处只组装权限清单、工具注册和生命周期守卫；工具实现各自维护。
 */
export default async function guardedTools(pi: ExtensionAPI) {
  const manifest = await loadGuardManifest();
  const active = registerApprovedTools(pi, manifest);
  installGuardHooks(pi, manifest, active);
}
