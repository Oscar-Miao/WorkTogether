import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readBridgeConfig, pairBridge } from './config/config.js';
import { BridgeClient } from './bridge-client.js';
import { Ledger } from './modules/ledger/ledger.js';
import { acquireInstanceLock } from './modules/ledger/instance-lock.js';

const envFile = resolve('.env.local');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === '--')),
  options: {
    pair: { type: 'string' },
    repo: { type: 'string' },
    api: { type: 'string' },
    runtime: { type: 'string' },
    name: { type: 'string' },
    'data-dir': { type: 'string' },
    'allow-edit': { type: 'string' },
    inspect: { type: 'boolean' },
    help: { type: 'boolean' },
    reconcile: { type: 'string' },
    'stop-evidence': { type: 'string' },
  },
});
const dataDir = resolve(
  values['data-dir'] || process.env.TEAM_AGENT_BRIDGE_DATA_DIR || '.local/bridge/default',
);

if (values.help) {
  console.log(
    'pnpm bridge -- --pair <code> --repo <absolute-git-root> --runtime inspection|pi [--allow-edit src,tests]\n后续 pnpm bridge 重连。--inspect 只读查看账本。\n--reconcile <attempt-id> --stop-evidence "<人工核查证据>"：仅在 Bridge 停止且原进程树已由 Owner 核清后使用。',
  );
} else if (values.inspect) {
  const ledger = new Ledger(dataDir, { readOnly: true });
  try {
    console.log(
      JSON.stringify(
        ledger.list().map(({ id, status, pid, finish_ack }) => ({ id, status, pid, finish_ack })),
        null,
        2,
      ),
    );
  } finally {
    ledger.close();
  }
} else if (values.reconcile) {
  const evidence = values['stop-evidence']?.trim();
  if (!evidence || evidence.length < 20)
    throw new Error(
      '必须提供至少 20 字的人工核查证据，说明如何确认原进程树已停止；该命令不负责杀进程。',
    );
  const release = acquireInstanceLock(dataDir);
  const ledger = new Ledger(dataDir);
  try {
    ledger.recover();
    const attempt = ledger.get(values.reconcile);
    if (!attempt || attempt.status !== 'uncertain') throw new Error('只能核查 uncertain 尝试');
    if (attempt.pid) {
      try {
        process.kill(attempt.pid, 0);
        throw new Error('记录的 PID 仍存在，请先人工核查，不能释放槽位');
      } catch (error: any) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    // 这是操作者的人工核查声明；本命令无法自动证明遗留子进程都已退出。
    ledger.stopped(
      attempt.id,
      {
        status: 'failed',
        error_code: 'MANUALLY_RECONCILED',
        diff: '',
        report: 'Owner 已人工确认原执行停止。原执行结果未确认，未自动重跑。\n核查记录：' + evidence,
        verification: 'not_run',
      },
      'operator_attestation: ' + evidence,
    );
    console.log('核查记录已持久保存；重新启动 Bridge 后回传云端。');
  } finally {
    ledger.close();
    release();
  }
} else {
  let config;
  if (values.pair) {
    if (!values.repo) throw new Error('首次配对需要 --repo 指向 Owner 明确允许的 Git 仓库根目录');
    const runtime = values.runtime || 'pi';
    if (runtime !== 'pi' && runtime !== 'inspection') throw new Error('Invalid runtime');
    config = await pairBridge({
      dataDir,
      api: values.api || 'http://127.0.0.1:3001',
      code: values.pair,
      repo: values.repo,
      runtime,
      name: values.name,
      allowedWritePrefixes: (values['allow-edit'] || '').split(',').filter(Boolean),
    });
  } else config = await readBridgeConfig(dataDir);
  const bridge = new BridgeClient(config, dataDir);
  await bridge.start();
  let stopping = false;
  const stop = async () => {
    if (!stopping) {
      stopping = true;
      await bridge.close();
    }
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}
