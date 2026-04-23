/**
 * operation-coverage
 *
 * Toolchain: document-model schema loader + ts-morph file discovery.
 *
 * Set-difference between declared operations and implemented reducers.
 * Reports:
 *   - operation declared in the schema but no reducer function found
 *   - reducer function present but no matching operation in the schema
 *   - reducer file naming / module placement doesn't match the
 *     document-model convention (`document-models/<model>/src/reducers/<module>.ts`)
 *
 * Structural consistency only — does not inspect reducer bodies.
 */
import type { Analyzer } from '../types.js';

const analyzer: Analyzer = {
  id: 'operation-coverage',
  description:
    'Verifies every declared operation has a reducer and vice versa.',
  run() {
    // TODO: enumerate schema operations, resolve expected reducer
    // symbol per operation, diff.
    return [];
  },
};

export default analyzer;
