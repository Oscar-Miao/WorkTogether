import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/** 只复制主设备选定的模型提供商配置到本次执行的独立 Pi 目录。 */
export async function copyModelConfig(source: string, dataDir: string): Promise<void> {
  const config = JSON.parse(await readFile(source, 'utf8'));
  if (!config.providers || typeof config.providers !== 'object' || Array.isArray(config.providers))
    throw new Error('INVALID_MODEL_CONFIG');
  function rejectCommands(value: unknown): void {
    if (typeof value === 'string' && value.trimStart().startsWith('!'))
      throw new Error('MODEL_CONFIG_COMMAND_DENIED');
    if (value && typeof value === 'object')
      for (const item of Object.values(value)) rejectCommands(item);
  }
  rejectCommands(config.providers);
  for (const provider of Object.values(config.providers) as any[]) {
    if (!provider.baseUrl) continue;
    const url = new URL(provider.baseUrl);
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      throw new Error('MODEL_ENDPOINT_REQUIRES_TLS');
  }
  const home = resolve(dataDir, 'pi-home');
  await mkdir(home, { recursive: true });
  // 仅保留 providers，避免同时带入扩展、指令或其他可执行配置。
  await writeFile(resolve(home, 'models.json'), JSON.stringify({ providers: config.providers }), {
    mode: 0o600,
  });
}
