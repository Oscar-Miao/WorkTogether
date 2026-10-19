import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { GuardManifest } from '../guard-manifest.js';

/** 注册函数只提供工具定义；Pi 在模型选择工具后才调用定义中的 execute。 */
export type ToolRegistrar = (pi: ExtensionAPI, manifest: GuardManifest) => void;

/** 工具结果统一返回为文本内容块，供 Pi 放入下一轮模型上下文。 */
export const textResult = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  details: undefined,
});
