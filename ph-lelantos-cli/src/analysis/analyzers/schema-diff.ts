/**
 * schema-diff
 *
 * Toolchain: `graphql-inspector` for GraphQL SDL, custom JSON Schema
 * diff for JSON-Schema-authored models.
 *
 * Compares the document model's current state + action schemas to a
 * baseline (previous git ref, published version, or user-supplied).
 * Flags breaking changes:
 *   - removed fields / removed operations
 *   - required field added without a migration path
 *   - type narrowed (enum member removed, string -> number)
 *   - operation input parameter removed or made required
 *
 * Consistency across revisions matters for document models because
 * persisted operations must still replay cleanly.
 */
import type { Analyzer } from '../types.js';

const analyzer: Analyzer = {
  id: 'schema-diff',
  description:
    'Detects breaking schema changes versus a baseline revision.',
  run() {
    // TODO: resolve baseline, run graphql-inspector diff / JSON Schema
    // diff, classify breaks vs. additive changes.
    return [];
  },
};

export default analyzer;
