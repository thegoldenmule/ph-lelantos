/**
 * pattern-rules
 *
 * Toolchain: Semgrep when discoverable on `PATH` (preferred — richer
 * rule surface and upstream community rulesets), otherwise the bundled
 * `@ast-grep/cli` binary as the fallback runner.
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
 * Runner selection: probe `semgrep` on `PATH` first; fall back to
 * `ast-grep` shipped via the `@ast-grep/cli` dependency. An unknown
 * runner is a hard error, not a silent skip.
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
    // TODO: resolve the runner (semgrep on PATH, else ast-grep from
    // @ast-grep/cli), spawn it with the configured ruleset, parse the
    // JSON output, and map each match to a Finding.
    return [];
  },
};

export default analyzer;
