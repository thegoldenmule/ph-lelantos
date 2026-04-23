/**
 * schema-introspection
 *
 * Toolchain: `@powerhousedao/reactor` / `document-model` loaders, plus
 * `ajv` for JSON Schema walking and `graphql` for SDL parsing.
 *
 * Operates purely on the state + action schemas (no reducer code).
 * Emits findings about the schemas themselves:
 *   - action input fields typed as unbounded strings / numbers with no
 *     min/max/length/pattern constraint
 *   - fields typed as `any` / `unknown` / `JSON`
 *   - enums with a single member (likely placeholder)
 *   - required fields whose type permits the empty value (empty string,
 *     zero-length array) — flag for manual review
 *   - recursive types with no depth bound
 *   - ID fields without a format/pattern constraint
 *
 * These are structural weaknesses that let bad data reach the reducer
 * regardless of how careful the reducer is.
 */
import type { Analyzer } from '../types.js';

const analyzer: Analyzer = {
  id: 'schema-introspection',
  description:
    'Inspects state and action schemas for missing constraints and weak typing.',
  run() {
    // TODO: walk each schema, enumerate fields, apply rule set.
    return [];
  },
};

export default analyzer;
