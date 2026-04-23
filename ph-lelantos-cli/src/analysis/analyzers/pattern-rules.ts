/**
 * pattern-rules
 *
 * Toolchain: Semgrep (preferred) or ast-grep as a fallback.
 *
 * Runs a curated ruleset of syntactic patterns against reducer and
 * schema files. Scope is deliberately narrow — anything requiring type
 * info belongs in a ts-morph analyzer, not here. This analyzer is the
 * right home for:
 *   - fast, contributor-authored rules
 *   - upstream security rulesets (`p/security-audit`, `p/typescript`)
 *   - house style rules ("every operation must be registered via
 *     `defineOperation(...)` rather than a bare object literal")
 *
 * Rule files live under `prompts/` or a sibling `rules/` directory —
 * to be decided when the first rule lands.
 */
import type { Analyzer } from '../types.js';

const analyzer: Analyzer = {
  id: 'pattern-rules',
  description:
    'Runs Semgrep / ast-grep rulesets over reducer and schema files.',
  run() {
    // TODO: spawn semgrep with the configured ruleset, parse JSON
    // output into Finding[].
    return [];
  },
};

export default analyzer;
