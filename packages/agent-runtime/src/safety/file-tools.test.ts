import { beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkedPath, editText, listFiles, readText } from './file-tools.js';
let root: string, outside: string;
beforeAll(async () => {
  await mkdir(resolve('.local/reports/file-guards'), { recursive: true });
  root = await mkdtemp(resolve('.local/reports/file-guards/repo-'));
  outside = await mkdtemp(resolve('.local/reports/file-guards/outside-'));
  await mkdir(resolve(root, 'src'));
  await mkdir(resolve(root, '.git'));
  await writeFile(resolve(root, 'src/app.ts'), 'export const enabled = false;\n');
  await writeFile(resolve(root, '.env.local'), 'SYNTHETIC_SECRET=test-only');
  await writeFile(resolve(root, '.npmrc'), 'SYNTHETIC_AUTH_TOKEN=test-only');
  await writeFile(resolve(root, 'private.pem'), 'synthetic-private-key');
  await writeFile(resolve(outside, 'private.txt'), 'synthetic-private');
  await symlink(
    outside,
    resolve(root, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
});
describe('real filesystem boundary', () => {
  it('rejects traversal, absolute paths, secrets, Git metadata and junctions', async () => {
    for (const path of [
      '../outside.txt',
      resolve(outside, 'private.txt'),
      '.env.local',
      '.npmrc',
      'private.pem',
      '.git/config',
      'linked/private.txt',
    ]) {
      await expect(checkedPath(root, path)).rejects.toThrow();
    }
    expect(await listFiles(root)).toEqual(['src/app.ts']);
  });
  it('edits only an approved exact match and rejects ambiguity or prefix escape', async () => {
    await expect(editText(root, 'src/app.ts', 'false', 'true', ['docs'])).rejects.toThrow(
      'WRITE_PREFIX_DENIED',
    );
    await editText(root, 'src/app.ts', 'false', 'true', ['src']);
    expect((await readText(root, 'src/app.ts')).text).toContain('enabled = true');
    await expect(editText(root, 'src/app.ts', '', 'oops', ['src'])).rejects.toThrow(
      'EMPTY_MATCH_DENIED',
    );
    await writeFile(resolve(root, 'src/ambiguous.ts'), 'same same');
    await expect(editText(root, 'src/ambiguous.ts', 'same', 'new', ['src'])).rejects.toThrow(
      'EDIT_MATCH_NOT_UNIQUE',
    );
    expect(await readFile(resolve(root, 'src/ambiguous.ts'), 'utf8')).toBe('same same');
  });
});
