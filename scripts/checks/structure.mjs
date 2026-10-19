import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(process.cwd());
const allowed = new Set([
  'README.md',
  'AGENTS.md',
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  '.npmrc',
  '.gitignore',
  '.dockerignore',
  '.prettierignore',
  '.prettierrc.json',
  '.env.example',
  '.env.local',
  'tsconfig.json',
  'tsconfig.build.json',
  'tsup.config.ts',
  'vitest.config.ts',
  'playwright.config.ts',
  'apps',
  'packages',
  'scripts',
  'tests',
  'docs',
  'infra',
  'experiments',
  '.local',
  'node_modules',
  '.git',
]);
const errors = [];
const inside = (parent, path) => path === parent || path.startsWith(parent + sep);
async function walk(path) {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (['node_modules', '.local', 'dist', '.git'].includes(entry.name) || entry.isSymbolicLink())
      continue;
    const target = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(target)));
    else files.push(target);
  }
  return files;
}
for (const entry of await readdir(root))
  if (!allowed.has(entry)) errors.push('Unregistered root entry: ' + entry);
const files = await walk(root);
for (const file of files) {
  const local = relative(root, file).replaceAll('\\', '/');
  if (/(package-lock|yarn\.lock|npm-shrinkwrap)/.test(local))
    errors.push('Duplicate package lock: ' + local);
  if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
  const text = await readFile(file, 'utf8');
  for (const match of text.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)) {
    const imported = match[1];
    const target = imported.startsWith('.') ? resolve(dirname(file), imported) : '';
    if (
      local.startsWith('apps/web/src/') &&
      (/^(node:|@team-agent\/(database|agent-runtime))/.test(imported) ||
        (target &&
          (inside(resolve(root, 'apps/api'), target) ||
            inside(resolve(root, 'apps/bridge'), target))))
    )
      errors.push('Browser imports server code: ' + local);
    if (local.startsWith('packages/') && target && inside(resolve(root, 'apps'), target))
      errors.push('Package depends on app: ' + local);
    if (
      !local.includes('.test.') &&
      (imported.includes('test-utils') || (target && inside(resolve(root, 'experiments'), target)))
    )
      errors.push('Production imports test/experiment code: ' + local);
    if (
      /^packages\/(domain|contracts)\/src\//.test(local) &&
      !local.includes('.test.') &&
      /^(node:|@team-agent\/(database|agent-runtime))/.test(imported)
    )
      errors.push('Pure package imports I/O code: ' + local);
  }
}
const ignored = await readFile(resolve(root, '.gitignore'), 'utf8');
for (const required of ['node_modules', '.local', '.env.local'])
  if (!ignored.includes(required)) errors.push('Missing ignore rule: ' + required);
try {
  // Only inspect files tracked in this checkout. No credential contents are printed.
  const tracked = execFileSync('git', ['ls-files', '--cached'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).split(/\r?\n/);
  for (const file of tracked)
    if (
      /(^|\/)(\.local|node_modules)\/|(^|\/)\.env(\.local)?$|device-key\.pem|permit-key\.pem/.test(
        file,
      )
    )
      errors.push('Sensitive/generated file is tracked: ' + file);
} catch {
  /* The initial source handoff may not have a Git repository yet. */
}
if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else
  console.log(
    'Structure verified: registered roots, one lockfile, dependency boundaries and generated-data exclusions.',
  );
