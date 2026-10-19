import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import type { ExecutionDescriptor } from '@team-agent/contracts';
const execute = promisify(execFile);
export async function repositoryInfo(path: string) {
  const commit = (
    await execute('git', ['-C', path, 'rev-parse', 'HEAD'], { windowsHide: true })
  ).stdout.trim();
  const branch = (
    await execute('git', ['-C', path, 'branch', '--show-current'], { windowsHide: true })
  ).stdout.trim();
  return { base_commit: commit, branch: branch || 'detached' };
}
export async function prepareWorktree(
  repo: string,
  dataDir: string,
  descriptor: ExecutionDescriptor,
  signal: AbortSignal,
): Promise<string> {
  if (!/^[a-f0-9]{40,64}$/.test(descriptor.base_commit)) throw new Error('INVALID_BASE_COMMIT');
  const root = resolve(dataDir, 'worktrees'),
    path = resolve(root, descriptor.task_id, descriptor.attempt_id);
  const rel = relative(root, path);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('PATH_OUT_OF_SCOPE');
  await mkdir(resolve(path, '..'), { recursive: true });
  const hooks = resolve(dataDir, 'disabled-hooks');
  await mkdir(hooks, { recursive: true });
  await execute('git', ['-C', repo, 'cat-file', '-e', descriptor.base_commit + '^{commit}'], {
    windowsHide: true,
    timeout: 15000,
    signal,
  });
  // 通过参数数组执行 Git，禁用 hooks；不运行 stash/reset/clean，也不改用户原工作目录。
  await execute(
    'git',
    [
      '-c',
      'core.hooksPath=' + hooks,
      '-c',
      'submodule.recurse=false',
      '-C',
      repo,
      'worktree',
      'add',
      '-b',
      'task/' + descriptor.task_id + '/' + descriptor.attempt_id,
      path,
      descriptor.base_commit,
    ],
    { windowsHide: true, timeout: 30000, signal, maxBuffer: 1024 * 1024 },
  );
  return realpath(path);
}
export async function collectDiff(path: string): Promise<string> {
  const names = await execute(
    'git',
    ['-C', path, 'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z'],
    { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
  );
  if (names.stdout.split('\0').filter(Boolean).length > 100) throw new Error('DIFF_FILE_LIMIT');
  const result = await execute(
    'git',
    ['-C', path, 'diff', '--no-ext-diff', '--no-textconv', '--stat'],
    { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 },
  );
  const patch = await execute('git', ['-C', path, 'diff', '--no-ext-diff', '--no-textconv', '--'], {
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const diff = (result.stdout + '\n' + patch.stdout).trim();
  if (Buffer.byteLength(diff) > 2 * 1024 * 1024) throw new Error('DIFF_SIZE_LIMIT');
  return diff;
}
