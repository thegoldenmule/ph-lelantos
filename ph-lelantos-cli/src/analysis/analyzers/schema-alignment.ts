/**
 * schema-alignment
 *
 * Toolchain: ts-morph + state-schema introspection (JSON Schema /
 * GraphQL SDL via `@powerhousedao/reactor` loaders).
 *
 * Cross-checks each reducer's property accesses and assignments on
 * `state` against the declared state schema:
 *   - reducer writes to `state.X` but schema has no field `X`
 *   - reducer reads `state.X.Y` where `X` is declared as a primitive
 *   - reducer assigns a value whose inferred TS type is incompatible
 *     with the schema field's declared type
 *   - schema field declared `required: true` but never written by any
 *     operation (potentially dead / unreachable)
 *
 * This is the core consistency check — everything the reducers touch
 * must exist in the schema and vice versa.
 */
import type { Analyzer } from '../types.js';

const analyzer: Analyzer = {
  id: 'schema-alignment',
  description:
    'Cross-checks reducer state mutations against the declared state schema.',
  run() {
    // TODO: build a Project, resolve the State parameter type of every
    // reducer, walk property accesses, diff against schema-derived
    // field set.
    return [];
  },
};

export default analyzer;
