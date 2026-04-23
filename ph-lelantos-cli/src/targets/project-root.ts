import { statSync } from 'node:fs';
import path from 'node:path';

import { ResolveError } from './errors.js';

export function findProjectRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start);
  while (true) {
    const gitPath = path.join(dir, '.git');
    try {
      statSync(gitPath);
      return dir;
    } catch {
      // .git not present here — walk up
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new ResolveError(
        'project-root-not-found',
        `No .git directory found from "${start}" up to filesystem root.`,
      );
    }
    dir = parent;
  }
}
