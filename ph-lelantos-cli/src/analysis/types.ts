/**
 * Shared types for the static-analysis layer.
 *
 * Every analyzer in `src/analysis/analyzers/` implements `Analyzer` and
 * produces `Finding[]`. The LLM/reviewer agent consumes the aggregated
 * findings and turns them into recommendations — it never does static
 * analysis itself.
 */

export type Severity = 'error' | 'warning' | 'info';

export interface SourceLocation {
  file: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface Finding {
  ruleId: string;
  analyzerId: string;
  severity: Severity;
  message: string;
  model?: string;
  module?: string;
  operation?: string;
  location?: SourceLocation;
  evidence?: string;
  suggestion?: string;
}

export interface LoadedOperation {
  name: string;
  module: string;
  inputSchema: unknown;
  reducerFile?: string;
}

export interface LoadedDocumentModel {
  id: string;
  name: string;
  packageDir: string;
  stateSchema: unknown;
  operations: LoadedOperation[];
  reducerDir?: string;
}

export interface AnalyzerContext {
  models: LoadedDocumentModel[];
  projectRoot: string;
}

export interface Analyzer {
  id: string;
  description: string;
  run(ctx: AnalyzerContext): Promise<Finding[]> | Finding[];
}
