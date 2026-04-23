import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { LoadedDocumentModel } from '../analysis/types.js';
import { ResolveError } from './errors.js';
import { ensureCloned, isGitUrl, type CloneFn } from './git.js';
import { loadDocumentModelsFromDir } from './load.js';
import { findProjectRoot } from './project-root.js';

export { ResolveError } from './errors.js';
export type { ResolveErrorCode } from './errors.js';
export type { LoadedDocumentModel } from '../analysis/types.js';

export interface ResolveOptions {
  projectRoot?: string;
  clone?: CloneFn;
}

export async function resolveTarget(
  spec: string,
  opts: ResolveOptions = {},
): Promise<LoadedDocumentModel[]> {
  let dir: string;

  if (isGitUrl(spec)) {
    const projectRoot = opts.projectRoot ?? findProjectRoot();
    dir = await ensureCloned(spec, projectRoot, opts.clone);
  } else {
    const abs = path.resolve(spec);
    try {
      const s = await stat(abs);
      if (!s.isDirectory()) {
        throw new ResolveError(
          'local-path-missing',
          `Local path "${spec}" is not a directory.`,
        );
      }
    } catch (err) {
      if (err instanceof ResolveError) throw err;
      throw new ResolveError(
        'local-path-missing',
        `Local path "${spec}" could not be read: ${(err as Error).message}`,
        err,
      );
    }
    dir = abs;
  }

  return loadDocumentModelsFromDir(dir);
}
