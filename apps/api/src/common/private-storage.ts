import { mkdir, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
let sid: string | undefined;

/** POSIX modes do not enforce Windows ACLs; restrict inherited access explicitly there. */
export async function protectPrivatePath(path: string, directory = true): Promise<void> {
  if (directory) await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await chmod(path, directory ? 0o700 : 0o600);
    return;
  }
  if (!sid) {
    const identity = await exec('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
    sid = identity.stdout.match(/S-1-[0-9-]+/)?.[0];
    if (!sid) throw new Error('WINDOWS_USER_SID_UNAVAILABLE');
  }
  await exec(
    'icacls',
    [path, '/inheritance:r', '/grant:r', '*' + sid + (directory ? ':(OI)(CI)F' : ':F')],
    { windowsHide: true },
  );
}
