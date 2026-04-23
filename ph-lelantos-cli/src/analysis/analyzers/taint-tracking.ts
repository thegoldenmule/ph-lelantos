/**
 * taint-tracking
 *
 * Toolchain: ts-morph, hand-rolled intraprocedural taint propagation.
 *
 * Sources:
 *   - the reducer's `action.input` parameter and any field derived from it
 *
 * Sinks (each a separate rule id):
 *   - string concatenation into URLs / `new URL(...)`
 *   - `path.join` / `path.resolve` with user-controlled segments
 *   - `fs.*` calls (caught earlier by reducer-purity, re-reported here
 *     with taint context if the purity rule is disabled)
 *   - tagged SQL templates, raw query builders
 *   - `eval`, `Function` constructor, `new RegExp(<tainted>)`
 *   - DOM sinks if reducers ever touch them (`innerHTML`, etc.)
 *
 * Reports the source-to-sink path so the LLM reviewer can reason about
 * exploitability.
 */
import type { Analyzer } from '../types.js';

const analyzer: Analyzer = {
  id: 'taint-tracking',
  description:
    'Traces untrusted action input from reducer parameters to dangerous sinks.',
  run() {
    // TODO: seed tainted identifiers from the reducer's action
    // parameter, propagate through assignments / returns / property
    // reads, record sink hits.
    return [];
  },
};

export default analyzer;
