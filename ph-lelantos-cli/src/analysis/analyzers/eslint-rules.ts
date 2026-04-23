/**
 * eslint-rules
 *
 * Toolchain: ESLint (programmatic API) with `@typescript-eslint` and
 * `eslint-plugin-security`, plus in-tree custom rules.
 *
 * Covers the lint-style subset of checks that are file-local and don't
 * need whole-program type-graph traversal:
 *   - `no-unused-vars`, `no-implicit-any` on reducer files
 *   - `security/detect-non-literal-regexp`,
 *     `security/detect-object-injection`
 *   - project-custom rules such as "reducer function must not be
 *     `async`" or "a reducer must take exactly two parameters"
 *
 * ESLint findings are merged into the shared `Finding` shape so the
 * LLM reviewer sees one homogeneous stream.
 */
import type { Analyzer } from '../types.js';

const analyzer: Analyzer = {
  id: 'eslint-rules',
  description:
    'Runs the reducer-scoped ESLint ruleset and normalizes the output.',
  run() {
    // TODO: instantiate ESLint programmatic API, lint reducer files,
    // map RuleMessage -> Finding.
    return [];
  },
};

export default analyzer;
