/**
 * schema-diff
 *
 * Toolchain: `@graphql-inspector/core` for GraphQL SDL, custom JSON Schema
 * diff for JSON-Schema-authored models.
 *
 * Compares the document model's current state + action schemas to a
 * baseline snapshot stored at
 * `<projectRoot>/.ph-lelantos/baseline/<modelId>/`. Flags breaking changes:
 *   - removed fields / removed operations
 *   - required field added to an existing optional field
 *   - type narrowed (enum member removed, string -> number, bound tightened)
 *   - operation input parameter removed or made required
 *
 * Consistency across revisions matters for document models because
 * persisted operations must still replay cleanly.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  buildSchema,
  printSchema,
  type GraphQLSchema,
} from 'graphql';
import { CriticalityLevel, diff } from '@graphql-inspector/core';

import type {
  Analyzer,
  AnalyzerContext,
  Finding,
  LoadedDocumentModel,
  LoadedOperation,
  SourceLocation,
} from '../types.js';

type JsonSchema = Record<string, unknown>;

interface BaselineFile {
  path: string;
  format: 'graphql' | 'json';
  content: string;
}

async function readIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === 'ENOENT'
    ) {
      return undefined;
    }
    throw err;
  }
}

async function loadBaseline(
  baseName: string,
  dir: string,
): Promise<BaselineFile | undefined> {
  const graphqlPath = path.join(dir, `${baseName}.graphql`);
  const graphqlContent = await readIfExists(graphqlPath);
  if (graphqlContent !== undefined) {
    return { path: graphqlPath, format: 'graphql', content: graphqlContent };
  }
  const jsonPath = path.join(dir, `${baseName}.json`);
  const jsonContent = await readIfExists(jsonPath);
  if (jsonContent !== undefined) {
    return { path: jsonPath, format: 'json', content: jsonContent };
  }
  return undefined;
}

function isGraphQLSchema(value: unknown): value is GraphQLSchema {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { getTypeMap?: unknown }).getTypeMap === 'function'
  );
}

interface CurrentSchema {
  format: 'graphql' | 'json';
  sdl?: string;
  json?: JsonSchema;
}

function normalizeCurrent(value: unknown): CurrentSchema | undefined {
  if (value == null) return undefined;
  if (isGraphQLSchema(value)) {
    return { format: 'graphql', sdl: printSchema(value) };
  }
  if (typeof value === 'string') {
    return { format: 'graphql', sdl: value };
  }
  if (typeof value === 'object') {
    return { format: 'json', json: value as JsonSchema };
  }
  return undefined;
}

const BREAKING_RULE_BY_CHANGE_TYPE: Record<string, string> = {
  FIELD_REMOVED: 'graphql/field-removed',
  INPUT_FIELD_REMOVED: 'graphql/input-field-removed',
  TYPE_REMOVED: 'graphql/type-removed',
  ENUM_VALUE_REMOVED: 'graphql/enum-value-removed',
  FIELD_TYPE_CHANGED: 'graphql/type-narrowed',
  INPUT_FIELD_TYPE_CHANGED: 'graphql/type-narrowed',
  FIELD_ARGUMENT_TYPE_CHANGED: 'graphql/type-narrowed',
  TYPE_KIND_CHANGED: 'graphql/type-narrowed',
  FIELD_ARGUMENT_ADDED: 'graphql/field-argument-required-added',
  UNION_MEMBER_REMOVED: 'graphql/type-narrowed',
  DIRECTIVE_REMOVED: 'graphql/directive-removed',
};

function ruleForGraphQLChange(changeType: string): string {
  return BREAKING_RULE_BY_CHANGE_TYPE[changeType] ?? `graphql/${changeType
    .toLowerCase()
    .replace(/_/g, '-')}`;
}

async function diffGraphQL(
  baselineSdl: string,
  currentSdl: string,
  baselineFile: string,
  scope: {
    model: string;
    module?: string;
    operation?: string;
  },
): Promise<Finding[]> {
  const location: SourceLocation = { file: baselineFile };
  let oldSchema: GraphQLSchema;
  let newSchema: GraphQLSchema;
  try {
    oldSchema = buildSchema(baselineSdl, { assumeValid: true });
    newSchema = buildSchema(currentSdl, { assumeValid: true });
  } catch (err) {
    return [
      {
        analyzerId: 'schema-diff',
        ruleId: 'schema-diff/baseline-unreadable',
        severity: 'info',
        message: `Could not parse GraphQL SDL for diff: ${
          err instanceof Error ? err.message : String(err)
        }`,
        model: scope.model,
        module: scope.module,
        operation: scope.operation,
        location,
      },
    ];
  }

  const changes = await diff(oldSchema, newSchema);
  return changes
    .filter((c) => c.criticality.level === CriticalityLevel.Breaking)
    .map<Finding>((change) => ({
      analyzerId: 'schema-diff',
      ruleId: ruleForGraphQLChange(String(change.type)),
      severity: 'error',
      message: change.message,
      model: scope.model,
      module: scope.module,
      operation: scope.operation,
      location,
      evidence: change.path,
    }));
}

function isObject(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getProperties(schema: JsonSchema): Record<string, JsonSchema> {
  const props = schema.properties;
  if (!isObject(props)) return {};
  const out: Record<string, JsonSchema> = {};
  for (const [k, v] of Object.entries(props)) {
    if (isObject(v)) out[k] = v;
  }
  return out;
}

function getRequired(schema: JsonSchema): string[] {
  const req = schema.required;
  if (!Array.isArray(req)) return [];
  return req.filter((r): r is string => typeof r === 'string');
}

function normalizeType(t: unknown): string[] {
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return [];
}

function joinPath(parent: string, child: string): string {
  return parent ? `${parent}.${child}` : child;
}

function diffJsonSchemaAt(
  baseline: JsonSchema,
  current: JsonSchema,
  prefix: string,
  emit: (ruleId: string, message: string, evidence?: string) => void,
): void {
  const baseProps = getProperties(baseline);
  const curProps = getProperties(current);
  const baseRequired = new Set(getRequired(baseline));
  const curRequired = new Set(getRequired(current));

  for (const [key, baseField] of Object.entries(baseProps)) {
    const fullPath = joinPath(prefix, key);
    const curField = curProps[key];

    if (curField === undefined) {
      emit(
        'json/field-removed',
        `Field \`${fullPath}\` was removed from the schema.`,
        fullPath,
      );
      continue;
    }

    const baseTypes = normalizeType(baseField.type);
    const curTypes = normalizeType(curField.type);
    if (baseTypes.length > 0 && curTypes.length > 0) {
      const baseSet = new Set(baseTypes);
      const curSet = new Set(curTypes);
      const droppedTypes = [...baseSet].filter((t) => !curSet.has(t));
      if (droppedTypes.length > 0) {
        emit(
          'json/type-narrowed',
          `Field \`${fullPath}\` type narrowed: removed ${droppedTypes
            .map((t) => `\`${t}\``)
            .join(', ')}.`,
          fullPath,
        );
      }
    }

    if (Array.isArray(baseField.enum) && Array.isArray(curField.enum)) {
      const curEnum = new Set(curField.enum as unknown[]);
      const droppedEnum = (baseField.enum as unknown[]).filter(
        (v) => !curEnum.has(v),
      );
      if (droppedEnum.length > 0) {
        emit(
          'json/type-narrowed',
          `Field \`${fullPath}\` enum narrowed: removed ${droppedEnum
            .map((v) => JSON.stringify(v))
            .join(', ')}.`,
          fullPath,
        );
      }
    }

    const narrowers: Array<{
      key: 'minLength' | 'minimum' | 'minItems';
      label: string;
      cmp: (base: number, cur: number) => boolean;
      direction: 'raised' | 'lowered';
    }> = [
      {
        key: 'minLength',
        label: 'minLength',
        cmp: (b, c) => c > b,
        direction: 'raised',
      },
      {
        key: 'minimum',
        label: 'minimum',
        cmp: (b, c) => c > b,
        direction: 'raised',
      },
      {
        key: 'minItems',
        label: 'minItems',
        cmp: (b, c) => c > b,
        direction: 'raised',
      },
    ];
    const wideners: Array<{
      key: 'maxLength' | 'maximum' | 'maxItems';
      label: string;
    }> = [
      { key: 'maxLength', label: 'maxLength' },
      { key: 'maximum', label: 'maximum' },
      { key: 'maxItems', label: 'maxItems' },
    ];

    for (const n of narrowers) {
      const baseVal = baseField[n.key];
      const curVal = curField[n.key];
      if (typeof curVal !== 'number') continue;
      if (typeof baseVal !== 'number') {
        emit(
          'json/type-narrowed',
          `Field \`${fullPath}\` added \`${n.label}=${curVal}\` (previously unbounded).`,
          fullPath,
        );
      } else if (n.cmp(baseVal, curVal)) {
        emit(
          'json/type-narrowed',
          `Field \`${fullPath}\` \`${n.label}\` ${n.direction} from ${baseVal} to ${curVal}.`,
          fullPath,
        );
      }
    }
    for (const w of wideners) {
      const baseVal = baseField[w.key];
      const curVal = curField[w.key];
      if (typeof curVal !== 'number') continue;
      if (typeof baseVal !== 'number') {
        emit(
          'json/type-narrowed',
          `Field \`${fullPath}\` added \`${w.label}=${curVal}\` (previously unbounded).`,
          fullPath,
        );
      } else if (curVal < baseVal) {
        emit(
          'json/type-narrowed',
          `Field \`${fullPath}\` \`${w.label}\` lowered from ${baseVal} to ${curVal}.`,
          fullPath,
        );
      }
    }

    if (typeof curField.pattern === 'string' && typeof baseField.pattern !== 'string') {
      emit(
        'json/type-narrowed',
        `Field \`${fullPath}\` added \`pattern\` constraint (previously unconstrained).`,
        fullPath,
      );
    } else if (
      typeof baseField.pattern === 'string' &&
      typeof curField.pattern === 'string' &&
      baseField.pattern !== curField.pattern
    ) {
      emit(
        'json/type-narrowed',
        `Field \`${fullPath}\` \`pattern\` changed from \`${baseField.pattern}\` to \`${curField.pattern}\`.`,
        fullPath,
      );
    }

    if (!baseRequired.has(key) && curRequired.has(key)) {
      emit(
        'json/field-newly-required',
        `Field \`${fullPath}\` is newly required.`,
        fullPath,
      );
    }

    diffJsonSchemaAt(baseField, curField, fullPath, emit);
  }
}

function diffJsonSchema(
  baselineRaw: string,
  currentJson: JsonSchema,
  baselineFile: string,
  scope: {
    model: string;
    module?: string;
    operation?: string;
  },
): Finding[] {
  const location: SourceLocation = { file: baselineFile };
  let baseline: JsonSchema;
  try {
    const parsed = JSON.parse(baselineRaw);
    if (!isObject(parsed)) {
      throw new Error('Baseline JSON Schema is not an object.');
    }
    baseline = parsed;
  } catch (err) {
    return [
      {
        analyzerId: 'schema-diff',
        ruleId: 'schema-diff/baseline-unreadable',
        severity: 'info',
        message: `Could not parse JSON Schema baseline: ${
          err instanceof Error ? err.message : String(err)
        }`,
        model: scope.model,
        module: scope.module,
        operation: scope.operation,
        location,
      },
    ];
  }

  const findings: Finding[] = [];
  diffJsonSchemaAt(baseline, currentJson, '', (ruleId, message, evidence) => {
    findings.push({
      analyzerId: 'schema-diff',
      ruleId,
      severity: 'error',
      message,
      model: scope.model,
      module: scope.module,
      operation: scope.operation,
      location,
      evidence,
    });
  });
  return findings;
}

async function diffAgainstBaseline(
  baseline: BaselineFile,
  current: CurrentSchema,
  scope: { model: string; module?: string; operation?: string },
): Promise<Finding[]> {
  if (baseline.format === 'graphql' && current.format === 'graphql' && current.sdl) {
    return diffGraphQL(baseline.content, current.sdl, baseline.path, scope);
  }
  if (baseline.format === 'json' && current.format === 'json' && current.json) {
    return diffJsonSchema(baseline.content, current.json, baseline.path, scope);
  }
  return [
    {
      analyzerId: 'schema-diff',
      ruleId: 'schema-diff/format-mismatch',
      severity: 'info',
      message: `Baseline format (${baseline.format}) does not match current schema format (${current.format}); skipping diff.`,
      model: scope.model,
      module: scope.module,
      operation: scope.operation,
      location: { file: baseline.path },
    },
  ];
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function runForModel(
  model: LoadedDocumentModel,
  baselineRoot: string,
): Promise<Finding[]> {
  const modelDir = path.join(baselineRoot, model.id);
  if (!(await dirExists(modelDir))) return [];

  const findings: Finding[] = [];

  try {
    const stateBaseline = await loadBaseline('state', modelDir);
    const currentState = normalizeCurrent(model.stateSchema);
    if (stateBaseline && currentState) {
      findings.push(
        ...(await diffAgainstBaseline(stateBaseline, currentState, {
          model: model.id,
        })),
      );
    }
  } catch (err) {
    findings.push({
      analyzerId: 'schema-diff',
      ruleId: 'schema-diff/baseline-unreadable',
      severity: 'info',
      message: `Failed to diff state schema for \`${model.id}\`: ${
        err instanceof Error ? err.message : String(err)
      }`,
      model: model.id,
      location: { file: modelDir },
    });
  }

  const opsDir = path.join(modelDir, 'operations');
  if (await dirExists(opsDir)) {
    const baselineOperations = await collectOperationBaselines(opsDir);
    const currentByKey = new Map<string, LoadedOperation>();
    for (const op of model.operations) {
      currentByKey.set(`${op.module}/${op.name}`, op);
    }

    for (const [key, baseline] of baselineOperations) {
      const current = currentByKey.get(key);
      const [moduleName, opName] = key.split('/');
      if (!current) {
        findings.push({
          analyzerId: 'schema-diff',
          ruleId: 'graphql/operation-removed',
          severity: 'error',
          message: `Operation \`${key}\` was removed.`,
          model: model.id,
          module: moduleName,
          operation: opName,
          location: { file: baseline.path },
          evidence: key,
        });
        continue;
      }
      try {
        const currentSchema = normalizeCurrent(current.inputSchema);
        if (!currentSchema) continue;
        findings.push(
          ...(await diffAgainstBaseline(baseline, currentSchema, {
            model: model.id,
            module: current.module,
            operation: current.name,
          })),
        );
      } catch (err) {
        findings.push({
          analyzerId: 'schema-diff',
          ruleId: 'schema-diff/baseline-unreadable',
          severity: 'info',
          message: `Failed to diff operation \`${key}\`: ${
            err instanceof Error ? err.message : String(err)
          }`,
          model: model.id,
          module: moduleName,
          operation: opName,
          location: { file: baseline.path },
        });
      }
    }
  }

  return findings;
}

async function collectOperationBaselines(
  opsDir: string,
): Promise<Map<string, BaselineFile>> {
  const out = new Map<string, BaselineFile>();
  const modules = await fs.readdir(opsDir, { withFileTypes: true });
  for (const modEntry of modules) {
    if (!modEntry.isDirectory()) continue;
    const moduleDir = path.join(opsDir, modEntry.name);
    const files = await fs.readdir(moduleDir, { withFileTypes: true });
    const seen = new Set<string>();
    for (const f of files) {
      if (!f.isFile()) continue;
      const ext = path.extname(f.name);
      if (ext !== '.graphql' && ext !== '.json') continue;
      const base = f.name.slice(0, -ext.length);
      if (seen.has(base)) continue;
      seen.add(base);
      const content = await fs.readFile(path.join(moduleDir, f.name), 'utf8');
      out.set(`${modEntry.name}/${base}`, {
        path: path.join(moduleDir, f.name),
        format: ext === '.graphql' ? 'graphql' : 'json',
        content,
      });
    }
  }
  return out;
}

const analyzer: Analyzer = {
  id: 'schema-diff',
  description: 'Detects breaking schema changes versus a baseline revision.',
  async run(ctx: AnalyzerContext): Promise<Finding[]> {
    const baselineRoot = path.join(ctx.projectRoot, '.ph-lelantos', 'baseline');
    if (!(await dirExists(baselineRoot))) return [];

    const all = await Promise.all(
      ctx.models.map((m) => runForModel(m, baselineRoot)),
    );
    return all.flat();
  },
};

export default analyzer;
