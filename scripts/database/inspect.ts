import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { openInspectionDatabase } from '@team-agent/database';
import { readConfig } from '../../apps/api/src/config/config.js';

const args = process.argv.slice(2).filter((v) => v !== '--');
function option(name: string) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(name + ' 缺少参数');
  return args[i + 1];
}
const help = [
  '本机 PGlite 只读 SQL 查看器',
  '先在运行 pnpm dev 的终端按 Ctrl+C，等开发服务退出。',
  'pnpm db:inspect                         打开默认根库',
  'pnpm db:inspect -- --project prj_xxx     打开指定项目库',
  'pnpm db:inspect -- --sql "SELECT 1;"     查询后立即退出',
  'pnpm db:inspect -- --data-dir PATH       指定服务数据根目录（不是 postgres 子目录）',
  '',
  '交互命令：\\tables 列表；\\describe users 查看字段；\\projects 查看项目目录；\\help 帮助；\\q 退出。',
  'SQL 每次一行一条；允许 SELECT / WITH / SHOW / EXPLAIN，默认只显示前 100 行。',
].join('\n');
async function main() {
  if (args.includes('--help')) {
    console.log(help);
    return;
  }
  const known = new Set(['--project', '--sql', '--data-dir']);
  for (let i = 0; i < args.length; i += 2)
    if (!known.has(args[i])) throw new Error('未知参数：' + args[i]);
  const config = readConfig();
  if (config.databaseUrl)
    throw new Error('当前配置为 PostgreSQL，请使用 psql 或数据库客户端；此命令只打开本机 PGlite');
  const project = option('--project') || 'project_default';
  if (project !== 'project_default' && !/^prj_[a-zA-Z0-9]+$/.test(project))
    throw new Error('项目 ID 格式不正确');
  const base = resolve(option('--data-dir') || config.dataDir);
  const target = project === 'project_default' ? base : resolve(base, 'projects', project);
  const db = await openInspectionDatabase(target);
  console.log(
    '数据范围：' +
      project +
      '\n服务数据根目录：' +
      target +
      '\n数据库用户名／密码：无（本机嵌入式访问）',
  );
  async function execute(input: string) {
    const text = input.trim();
    if (!text) return;
    if (text === '\\help') {
      console.log(help);
      return;
    }
    let sql = text,
      params: unknown[] = [];
    if (text === '\\tables')
      sql =
        "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' ORDER BY table_name";
    if (text === '\\projects')
      sql =
        'SELECT p.id,p.name,w.name AS workspace FROM org_projects p JOIN org_workspaces w ON w.id=p.workspace_id ORDER BY w.created_at,p.created_at';
    if (text.startsWith('\\describe ')) {
      const table = text.slice(10).trim();
      if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(table)) throw new Error('表名格式不正确');
      sql =
        'SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position';
      params = [table];
    }
    const result = await db.query(sql, params);
    console.table(
      result.rows
        .slice(0, 100)
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              typeof value === 'object' && value !== null ? JSON.stringify(value) : value,
            ]),
          ),
        ),
    );
    console.log(
      '返回 ' +
        result.rows.length +
        ' 行' +
        (result.rows.length > 100 ? '，仅显示前 100 行，请用 LIMIT 缩小查询' : ''),
    );
  }
  try {
    const sql = option('--sql');
    if (sql !== undefined) {
      await execute(sql);
      return;
    }
    console.log(help);
    const terminal = createInterface({ input: stdin, output: stdout });
    try {
      while (true) {
        let line: string;
        try {
          line = await terminal.question('PGlite> ');
        } catch {
          break;
        }
        if (['\\q', '\\quit', 'exit'].includes(line.trim())) break;
        try {
          await execute(line);
        } catch (e: any) {
          console.error('查询未执行：' + (e.message || '未知错误'));
        }
      }
    } finally {
      terminal.close();
    }
  } finally {
    await db.close();
  }
}
main().catch((e: Error) => {
  console.error(
    e.message.includes('LOCAL_DATABASE_IN_USE')
      ? '数据库正在被 API 或另一个查看器使用，请先停止对应进程，再打开查看器。'
      : e.message,
  );
  process.exitCode = 1;
});
