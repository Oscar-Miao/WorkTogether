import { lstat, realpath, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, sep } from 'node:path';

// 不向模型暴露凭据、运行数据、版本库元信息或第三方依赖。
const denied = new Set([
  '.git',
  '.local',
  'node_modules',
  '.ssh',
  '.aws',
  '.codex',
  '.pi',
  '.github',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  '.kube',
  '.docker',
  'credentials',
  'id_rsa',
  'id_ed25519',
]);
function blocked(segment: string): boolean {
  return (
    denied.has(segment.toLowerCase()) ||
    segment.toLowerCase().startsWith('.env') ||
    /\.(pem|key|p12|pfx|jks)$/i.test(segment)
  );
}
/** 按路径分段判断包含关系，避免 src-other 被误认为 src 的子目录。 */
export function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}
/** 逐段拒绝符号链接和 Windows junction；仅过滤文本中的 ../ 无法阻止目录跳转。 */
export async function checkedPath(root: string, input: string, allowNew = false): Promise<string> {
  if (!input || input.includes('\0') || isAbsolute(input) || /^[A-Za-z]:|^\\\\/.test(input))
    throw new Error('PATH_OUT_OF_SCOPE');
  const canonicalRoot = await realpath(root);
  const target = resolve(canonicalRoot, input);
  if (!inside(canonicalRoot, target)) throw new Error('PATH_OUT_OF_SCOPE');
  const parts = relative(canonicalRoot, target).split(sep).filter(Boolean);
  if (parts.some(blocked)) throw new Error('PATH_OUT_OF_SCOPE');
  let current = canonicalRoot;
  for (let i = 0; i < parts.length; i++) {
    current = resolve(current, parts[i]);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error('PATH_OUT_OF_SCOPE');
    } catch (error: any) {
      if (error.code === 'ENOENT' && allowNew && i === parts.length - 1) break;
      throw error;
    }
  }
  const parent = await realpath(dirname(target));
  if (!inside(canonicalRoot, parent)) throw new Error('PATH_OUT_OF_SCOPE');
  return target;
}
/** 单文件最多 1 MiB，按 UTF-16 码元分页返回；不把二进制文件当成文本发送。 */
export async function readText(
  root: string,
  path: string,
  offset = 0,
): Promise<{ text: string; truncated: boolean }> {
  const file = await checkedPath(root, path);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('FILE_TOO_LARGE');
  const content = await readFile(file, 'utf8');
  if (content.includes('\0')) throw new Error('BINARY_FILE_DENIED');
  return {
    text: content.slice(offset, offset + 16000),
    truncated: content.length > offset + 16000,
  };
}
/** 递归遍历时同步跳过敏感条目，并限制返回数量，避免目录枚举撑满上下文。 */
export async function listFiles(root: string, subdir = '.', limit = 300): Promise<string[]> {
  const dir = subdir === '.' ? await realpath(root) : await checkedPath(root, subdir);
  const result: string[] = [];
  async function walk(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (result.length >= limit) return;
      if (blocked(entry.name) || entry.isSymbolicLink()) continue;
      const file = resolve(path, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) result.push(relative(root, file).replaceAll('\\', '/'));
    }
  }
  await walk(dir);
  return result;
}
/** 只修改获准前缀下的既有文件；唯一原文匹配可防止模糊替换误改多处。 */
export async function editText(
  root: string,
  path: string,
  oldText: string,
  newText: string,
  prefixes: string[],
): Promise<void> {
  const normalized = path.replaceAll('\\', '/');
  if (
    !prefixes.some(
      (prefix) => normalized === prefix || normalized.startsWith(prefix.replace(/\/$/, '') + '/'),
    )
  )
    throw new Error('WRITE_PREFIX_DENIED');
  if (!oldText) throw new Error('EMPTY_MATCH_DENIED');
  const file = await checkedPath(root, path);
  const content = await readFile(file, 'utf8');
  if (content.includes('\0') || Buffer.byteLength(content) > 1024 * 1024)
    throw new Error('FILE_TOO_LARGE');
  const first = content.indexOf(oldText);
  if (first < 0 || content.indexOf(oldText, first + oldText.length) >= 0)
    throw new Error('EDIT_MATCH_NOT_UNIQUE');
  const replacement = content.slice(0, first) + newText + content.slice(first + oldText.length);
  if (Buffer.byteLength(replacement) > 1024 * 1024) throw new Error('FILE_TOO_LARGE');
  // 写入前再次检查路径，缩小并发改动的风险窗口；完整文件系统隔离仍需操作系统沙箱。
  await checkedPath(root, path);
  await writeFile(file, replacement, 'utf8');
}
