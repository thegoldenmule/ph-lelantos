/**
 * forbidden-imports
 *
 * Toolchain: dependency-cruiser (or madge + a manual allowlist).
 *
 * Treats reducer files as a hermetic layer. Flags any transitive import
 * that pulls in:
 *   - `node:*` built-ins (fs, http, net, child_process, os, worker_threads)
 *   - `fetch` / `undici` / HTTP client libs
 *   - database clients
 *   - loggers that touch I/O
 *   - anything outside `document-models/<model>/src/**`
 *
 * Cheap and catches a lot. Complements reducer-purity: purity checks
 * call sites, this checks the import graph so indirect I/O is caught.
 */
import type { Analyzer } from '../types.js';

const analyzer: Analyzer = {
  id: 'forbidden-imports',
  description:
    'Asserts reducer files do not transitively import I/O or host modules.',
  run() {
    // TODO: run dependency-cruiser programmatically against reducer
    // entry files, map violations to Finding[].
    return [];
  },
};

export default analyzer;
