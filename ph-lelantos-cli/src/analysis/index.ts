/**
 * Static-analysis registry.
 *
 * Each entry is one deterministic tool. Add new analyzers by creating a
 * file under `./analyzers/` that default-exports an `Analyzer`, then
 * registering it here. The agent invokes `runAll` (or a subset) and
 * hands the resulting findings to the LLM reviewer.
 *
 * See `docs/static-analysis.md` for the rationale behind each analyzer
 * and the underlying toolchain.
 */
import type { Analyzer, AnalyzerContext, Finding } from './types.js';

import reducerPurity from './analyzers/reducer-purity.js';
import schemaAlignment from './analyzers/schema-alignment.js';
import taintTracking from './analyzers/taint-tracking.js';
import forbiddenImports from './analyzers/forbidden-imports.js';
import schemaIntrospection from './analyzers/schema-introspection.js';
import schemaDiff from './analyzers/schema-diff.js';
import patternRules from './analyzers/pattern-rules.js';
import eslintRules from './analyzers/eslint-rules.js';
import operationCoverage from './analyzers/operation-coverage.js';
import reducerReturnShape from './analyzers/reducer-return-shape.js';

export const analyzers: Analyzer[] = [
  reducerPurity,
  schemaAlignment,
  taintTracking,
  forbiddenImports,
  schemaIntrospection,
  schemaDiff,
  patternRules,
  eslintRules,
  operationCoverage,
  reducerReturnShape,
];

export async function runAll(ctx: AnalyzerContext): Promise<Finding[]> {
  const results = await Promise.all(analyzers.map((a) => a.run(ctx)));
  return results.flat();
}

export async function runById(
  ids: string[],
  ctx: AnalyzerContext,
): Promise<Finding[]> {
  const selected = analyzers.filter((a) => ids.includes(a.id));
  const results = await Promise.all(selected.map((a) => a.run(ctx)));
  return results.flat();
}

export type { Analyzer, AnalyzerContext, Finding } from './types.js';
