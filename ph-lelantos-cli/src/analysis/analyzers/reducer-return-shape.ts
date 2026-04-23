/**
 * reducer-return-shape
 *
 * Toolchain: ts-morph.
 *
 * Powerhouse reducers are Mutative-wrapped: the body mutates the
 * `state` draft in place and should not return a new value. This
 * analyzer flags:
 *   - `return someState` statements inside reducer bodies
 *   - reassignment of the `state` parameter (`state = ...`)
 *   - destructured rebind of state that loses the proxy
 *   - reducers whose inferred return type is not `void` / `undefined`
 *
 * Small rule, but catches a common porting mistake and is a clear
 * signal that a reducer was authored against Redux semantics rather
 * than Mutative.
 */
import type { Analyzer } from '../types.js';

const analyzer: Analyzer = {
  id: 'reducer-return-shape',
  description:
    'Enforces Mutative-style reducers — mutate state, do not return it.',
  run() {
    // TODO: inspect reducer function nodes, flag explicit returns and
    // state reassignments.
    return [];
  },
};

export default analyzer;
