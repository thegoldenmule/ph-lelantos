import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { ResolveError } from './errors.js';

const GIT_PREFIXES = ['http://', 'https://', 'git@', 'git://', 'ssh://'];

export function isGitUrl(spec: string): boolean {
  return GIT_PREFIXES.some((p) => spec.startsWith(p));
}

export type CloneFn = (spec: string, dest: string) => Promise<void>;

async function defaultClone(spec: string, dest: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['clone', '--depth=1', spec, dest], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git clone exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function isNonEmptyDir(dir: string): Promise<boolean> {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return false;
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

export function cacheDirFor(spec: string, projectRoot: string): string {
  const hash = createHash('sha256').update(spec).digest('hex');
  return path.join(projectRoot, '.ph-lelantos', 'cache', hash);
}

export async function ensureCloned(
  spec: string,
  projectRoot: string,
  clone: CloneFn = defaultClone,
): Promise<string> {
  const dest = cacheDirFor(spec, projectRoot);
  if (await isNonEmptyDir(dest)) return dest;

  await mkdir(path.dirname(dest), { recursive: true });
  try {
    await clone(spec, dest);
  } catch (err) {
    throw new ResolveError(
      'git-clone-failed',
      `Failed to clone "${spec}" into "${dest}": ${(err as Error).message}`,
      err,
    );
  }
  return dest;
}
