import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { hostname } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RuntimeKind } from '@team-agent/contracts';
import { protectPrivatePath } from './private-storage.js';
const execFileAsync = promisify(execFile);
export interface BridgeConfig {
  deviceId: string;
  api: string;
  publicKey: string;
  privateKeyFile: string;
  serverPublicKey: string;
  runtime: RuntimeKind;
  repository: { id: string; name: string; path: string; allowedWritePrefixes: string[] };
}
export async function readBridgeConfig(dataDir: string): Promise<BridgeConfig> {
  await protectPrivatePath(dataDir);
  const config = JSON.parse(await readFile(resolve(dataDir, 'config.json'), 'utf8'));
  config.api = assertApi(config.api);
  return config;
}
export async function apiRequest<T>(
  api: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const response = await fetch(api + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const result = (await response.json()) as { data: T; error?: { code: string; message: string } };
  if (!response.ok) throw new Error(result.error?.code || 'HTTP_' + response.status);
  return result.data;
}
export function assertApi(api: string): string {
  const url = new URL(api);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  )
    throw new Error('Bridge requires HTTPS except for loopback development');
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/(?:p\/prj_[a-zA-Z0-9]+\/?)?$/.test(url.pathname)
  )
    throw new Error('请使用服务地址或明确的 /p/项目ID 路径，不允许凭据或任意路径');
  return url.origin + url.pathname.replace(/\/$/, '');
}
export async function pairBridge(options: {
  dataDir: string;
  api: string;
  code: string;
  repo: string;
  runtime: RuntimeKind;
  name?: string;
  allowedWritePrefixes: string[];
}): Promise<BridgeConfig> {
  const api = assertApi(options.api);
  if (existsSync(resolve(options.dataDir, 'config.json')))
    throw new Error(
      '此数据目录已有设备配置；请先在网页撤销旧设备并使用新的 --data-dir，不覆盖旧账本',
    );
  const repo = await realpath(options.repo);
  const root = (
    await execFileAsync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { windowsHide: true })
  ).stdout.trim();
  if ((await realpath(root)).toLowerCase() !== repo.toLowerCase())
    throw new Error('--repo 必须指向 Git 仓库根目录');
  for (const prefix of options.allowedWritePrefixes)
    if (!/^[a-zA-Z0-9_/-]+$/.test(prefix) || prefix.includes('..') || prefix.startsWith('/'))
      throw new Error('Invalid allowed write prefix');
  await protectPrivatePath(options.dataDir);
  await mkdir(resolve(options.dataDir, 'state'), { recursive: true });
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyFile = resolve(options.dataDir, 'state', 'device-key.pem');
  await writeFile(privateKeyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
    flag: 'wx',
  });
  const result = await apiRequest<{ device_id: string; server_public_key: string }>(
    api,
    '/api/v1/devices/pair',
    {
      code: options.code,
      name: options.name || hostname(),
      public_key: publicKey,
      runtime: options.runtime,
      adapter_version: options.runtime === 'pi' ? '1.3.0' : '1.0.0',
    },
  );
  const config: BridgeConfig = {
    deviceId: result.device_id,
    api,
    publicKey,
    privateKeyFile,
    serverPublicKey: result.server_public_key,
    runtime: options.runtime,
    repository: {
      id: 'repo_' + result.device_id.slice(4),
      name: repo.replaceAll('\\', '/').split('/').at(-1) || '项目仓库',
      path: repo,
      allowedWritePrefixes: options.allowedWritePrefixes,
    },
  };
  await writeFile(resolve(options.dataDir, 'config.json'), JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
  return config;
}
export async function authenticate(
  config: BridgeConfig,
): Promise<{ access_token: string; expires_at: string }> {
  const challenge = await apiRequest<{ challenge_id: string; nonce: string }>(
    config.api,
    '/bridge/v1/challenges',
    { device_id: config.deviceId },
  );
  const privateKey = await readFile(config.privateKeyFile, 'utf8');
  const signature = sign(null, Buffer.from(challenge.nonce), privateKey).toString('base64url');
  return apiRequest(config.api, '/bridge/v1/tokens', {
    device_id: config.deviceId,
    challenge_id: challenge.challenge_id,
    signature,
  });
}
