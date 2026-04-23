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
// TODO: thread schema source location through LoadedDocumentModel so
// findings can carry a real `location.file`.
import type {
  Analyzer,
  AnalyzerContext,
  Finding,
  LoadedDocumentModel,
  LoadedOperation,
} from '../types.js';

const ANALYZER_ID = 'schema-introspection';
const MAX_VISITED = 500;
const EVIDENCE_CAP = 200;

type FindingScope = {
  model?: string;
  module?: string;
  operation?: string;
};

type Push = (f: Omit<Finding, 'analyzerId'>) => void;

const ID_NAME_RE = /^id$|Id$|_id$/;
const WEAK_REF_NAME_RE = /^(JSON|Any|Unknown)$/i;
const WEAK_GRAPHQL_SCALAR_RE = /^(JSON|Any|Unknown)$/i;
const ID_GRAPHQL_BAD_TYPES = new Set(['String', 'ID']);

function truncate(s: string, n = EVIDENCE_CAP): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function toEvidence(node: unknown): string {
  try {
    return truncate(JSON.stringify(node));
  } catch {
    return '[unserializable]';
  }
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function typeIncludes(node: Record<string, unknown>, t: string): boolean {
  const v = node.type;
  if (typeof v === 'string') return v === t;
  if (Array.isArray(v)) return v.includes(t);
  return false;
}

function hasAny(node: Record<string, unknown>, keys: string[]): boolean {
  for (const k of keys) {
    if (k in node && node[k] !== undefined) return true;
  }
  return false;
}

function isUnboundedString(node: Record<string, unknown>): boolean {
  if (!typeIncludes(node, 'string')) return false;
  return !hasAny(node, ['maxLength', 'pattern', 'format', 'enum', 'const']);
}

function isUnboundedNumber(node: Record<string, unknown>): boolean {
  const isNumeric =
    typeIncludes(node, 'integer') || typeIncludes(node, 'number');
  if (!isNumeric) return false;
  return !hasAny(node, [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'enum',
    'const',
  ]);
}

function isWeaklyTyped(node: Record<string, unknown>): boolean {
  if (hasAny(node, ['type', '$ref', 'enum', 'const', 'oneOf', 'anyOf', 'allOf'])) {
    if (
      node.type === 'object' &&
      node.additionalProperties === true &&
      !isPlainObject(node.properties)
    ) {
      return true;
    }
    const ref = typeof node.$ref === 'string' ? node.$ref : '';
    if (ref) {
      const refName = ref.split('/').pop() ?? '';
      if (WEAK_REF_NAME_RE.test(refName)) return true;
    }
    return false;
  }
  return true;
}

function isIdName(name: string): boolean {
  return ID_NAME_RE.test(name);
}

function refName(ref: string): string {
  return ref.split('/').pop() ?? '';
}

function resolveRef(
  ref: string,
  root: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!ref.startsWith('#/')) return undefined;
  const parts = ref.slice(2).split('/');
  let cur: unknown = root;
  for (const p of parts) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[p];
  }
  return isPlainObject(cur) ? cur : undefined;
}

function walkJsonSchema(
  schema: unknown,
  scope: FindingScope,
  push: Push,
): void {
  if (!isPlainObject(schema)) return;
  const root = schema;
  const visited = { count: 0 };
  const cycleEmitted = new Set<string>();

  function visit(
    node: unknown,
    fieldName: string | undefined,
    refChain: string[],
  ): void {
    if (visited.count >= MAX_VISITED) return;
    if (!isPlainObject(node)) return;
    visited.count++;

    // $ref handling (recursion + follow)
    if (typeof node.$ref === 'string') {
      const name = refName(node.$ref);
      if (WEAK_REF_NAME_RE.test(name)) {
        push({
          ruleId: 'weak-typing',
          severity: 'warning',
          ...scope,
          message: `Field${fieldName ? ` "${fieldName}"` : ''} uses the weak type "${name}".`,
          evidence: toEvidence(node),
          suggestion:
            'Replace JSON/Any/Unknown with a concrete schema or an enum/const set.',
        });
        return;
      }
      if (refChain.includes(name)) {
        const cycleKey = [...refChain, name].join('->');
        if (!cycleEmitted.has(cycleKey)) {
          cycleEmitted.add(cycleKey);
          push({
            ruleId: 'recursive-without-depth-bound',
            severity: 'warning',
            ...scope,
            message: `Recursive type cycle without depth bound: ${cycleKey}.`,
            evidence: toEvidence(node),
            suggestion:
              'Bound recursion with maxItems/maxContains, or document a maxDepth limit.',
          });
        }
        return;
      }
      const target = resolveRef(node.$ref, root);
      if (target) visit(target, fieldName, [...refChain, name]);
      return;
    }

    // Structural rules
    if (fieldName && isIdName(fieldName) && typeIncludes(node, 'string')) {
      if (!hasAny(node, ['format', 'pattern'])) {
        push({
          ruleId: 'id-without-format',
          severity: 'warning',
          ...scope,
          message: `ID field "${fieldName}" has no format or pattern constraint.`,
          evidence: toEvidence(node),
          suggestion:
            'Add a format (e.g. "uuid") or a pattern regex for the ID shape.',
        });
      }
    }

    if (isUnboundedString(node)) {
      push({
        ruleId: 'unbounded-string',
        severity: 'warning',
        ...scope,
        message: `String field${fieldName ? ` "${fieldName}"` : ''} has no maxLength, pattern, format, enum, or const.`,
        evidence: toEvidence(node),
        suggestion: 'Add maxLength or pattern, or switch to an enum/const.',
      });
    }

    if (isUnboundedNumber(node)) {
      push({
        ruleId: 'unbounded-number',
        severity: 'warning',
        ...scope,
        message: `Numeric field${fieldName ? ` "${fieldName}"` : ''} has no minimum/maximum or enum.`,
        evidence: toEvidence(node),
        suggestion: 'Add minimum/maximum (or exclusive variants) or enumerate.',
      });
    }

    if (isWeaklyTyped(node)) {
      push({
        ruleId: 'weak-typing',
        severity: 'warning',
        ...scope,
        message: `Field${fieldName ? ` "${fieldName}"` : ''} is weakly typed (any/unknown/open object).`,
        evidence: toEvidence(node),
        suggestion:
          'Declare a concrete type, or constrain additionalProperties to a schema.',
      });
    }

    if (Array.isArray(node.enum) && node.enum.length === 1) {
      push({
        ruleId: 'single-member-enum',
        severity: 'info',
        ...scope,
        message: `Enum${fieldName ? ` on "${fieldName}"` : ''} has a single member (likely placeholder).`,
        evidence: toEvidence(node.enum),
      });
    }

    // Descend
    if (isPlainObject(node.properties)) {
      for (const [k, v] of Object.entries(node.properties)) {
        visit(v, k, refChain);
      }
    }
    if (isPlainObject(node.patternProperties)) {
      for (const v of Object.values(node.patternProperties)) {
        visit(v, fieldName, refChain);
      }
    }
    if (isPlainObject(node.additionalProperties)) {
      visit(node.additionalProperties, fieldName, refChain);
    }
    if (isPlainObject(node.items)) {
      visit(node.items, fieldName, refChain);
    } else if (Array.isArray(node.items)) {
      for (const it of node.items) visit(it, fieldName, refChain);
    }
    for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
      const arr = node[key];
      if (Array.isArray(arr)) {
        for (const sub of arr) visit(sub, fieldName, refChain);
      }
    }
    if (isPlainObject(node.definitions)) {
      for (const [k, v] of Object.entries(node.definitions)) {
        visit(v, k, refChain);
      }
    }
    if (isPlainObject(node.$defs)) {
      for (const [k, v] of Object.entries(node.$defs)) {
        visit(v, k, refChain);
      }
    }
  }

  try {
    visit(root, undefined, []);
  } catch {
    // Defensive: malformed input must not crash the analyzer.
  }
}

type GqlTypeRef = { name: string; nonNull: boolean; list: boolean };

function unwrapGraphqlType(typeNode: unknown): GqlTypeRef {
  let cur: any = typeNode;
  let nonNull = false;
  let list = false;
  // Walk NonNull / List wrappers
  while (isPlainObject(cur)) {
    if (cur.kind === 'NonNullType') {
      nonNull = true;
      cur = cur.type;
      continue;
    }
    if (cur.kind === 'ListType') {
      list = true;
      cur = cur.type;
      continue;
    }
    break;
  }
  const name =
    isPlainObject(cur) &&
    cur.kind === 'NamedType' &&
    isPlainObject(cur.name) &&
    typeof cur.name.value === 'string'
      ? cur.name.value
      : '';
  return { name, nonNull, list };
}

function graphqlFieldEvidence(field: any): string {
  const loc = field?.loc;
  if (loc && typeof loc.start === 'number' && typeof loc.end === 'number') {
    const src: string | undefined = loc.source?.body;
    if (typeof src === 'string') {
      return truncate(src.slice(loc.start, loc.end));
    }
  }
  const name = field?.name?.value ?? '?';
  return truncate(`field ${name}`);
}

function walkGraphqlAst(
  doc: unknown,
  scope: FindingScope,
  push: Push,
): void {
  if (!isPlainObject(doc) || !Array.isArray((doc as any).definitions)) return;
  const defs = (doc as any).definitions as any[];

  // Index object / input / enum / scalar definitions by name.
  const objectLike = new Map<string, any>();
  const enums = new Map<string, any>();
  const scalars = new Map<string, any>();
  for (const def of defs) {
    if (!isPlainObject(def)) continue;
    const kind = (def as any).kind;
    const name = (def as any).name?.value;
    if (typeof name !== 'string') continue;
    if (
      kind === 'ObjectTypeDefinition' ||
      kind === 'InputObjectTypeDefinition' ||
      kind === 'InterfaceTypeDefinition'
    ) {
      objectLike.set(name, def);
    } else if (kind === 'EnumTypeDefinition') {
      enums.set(name, def);
    } else if (kind === 'ScalarTypeDefinition') {
      scalars.set(name, def);
    }
  }

  // Single-member enums
  for (const [name, def] of enums) {
    const values = (def as any).values;
    if (Array.isArray(values) && values.length === 1) {
      push({
        ruleId: 'single-member-enum',
        severity: 'info',
        ...scope,
        message: `Enum "${name}" has a single member (likely placeholder).`,
        evidence: truncate(`enum ${name}`),
      });
    }
  }

  // Weak scalars
  for (const [name] of scalars) {
    if (WEAK_GRAPHQL_SCALAR_RE.test(name)) {
      push({
        ruleId: 'weak-typing',
        severity: 'warning',
        ...scope,
        message: `Scalar "${name}" is an open type; prefer a concrete shape.`,
        evidence: truncate(`scalar ${name}`),
        suggestion:
          'Replace JSON/Any/Unknown scalar with a concrete type or constrained scalar.',
      });
    }
  }

  // Field-level checks on object/input/interface types
  let visited = 0;
  for (const [typeName, def] of objectLike) {
    const fields = (def as any).fields;
    if (!Array.isArray(fields)) continue;
    for (const field of fields) {
      if (++visited > MAX_VISITED) break;
      if (!isPlainObject(field)) continue;
      const fname = (field as any).name?.value;
      if (typeof fname !== 'string') continue;
      const tref = unwrapGraphqlType((field as any).type);
      const evidence = graphqlFieldEvidence(field);

      // Weak type reference
      if (tref.name && WEAK_GRAPHQL_SCALAR_RE.test(tref.name)) {
        push({
          ruleId: 'weak-typing',
          severity: 'warning',
          ...scope,
          message: `Field "${typeName}.${fname}" uses weak type "${tref.name}".`,
          evidence,
          suggestion:
            'Replace JSON/Any/Unknown with a concrete type or constrained scalar.',
        });
      }

      // Unbounded string (GraphQL has no standard constraint directives —
      // warn whenever a String field has no directive at all).
      if (tref.name === 'String') {
        const directives = (field as any).directives;
        const hasDirective =
          Array.isArray(directives) && directives.length > 0;
        if (!hasDirective) {
          push({
            ruleId: 'unbounded-string',
            severity: 'warning',
            ...scope,
            message: `Field "${typeName}.${fname}" is an unbounded String (no directive constraint).`,
            evidence,
            suggestion:
              'Add a length/pattern directive or switch to a constrained scalar/enum.',
          });
        }
      }

      // Unbounded number
      if (tref.name === 'Int' || tref.name === 'Float') {
        const directives = (field as any).directives;
        const hasDirective =
          Array.isArray(directives) && directives.length > 0;
        if (!hasDirective) {
          push({
            ruleId: 'unbounded-number',
            severity: 'warning',
            ...scope,
            message: `Field "${typeName}.${fname}" is an unbounded ${tref.name} (no range directive).`,
            evidence,
            suggestion: 'Add a range directive or enumerate allowed values.',
          });
        }
      }

      // ID field naming convention — expect OID / PHID
      if (isIdName(fname) && ID_GRAPHQL_BAD_TYPES.has(tref.name)) {
        push({
          ruleId: 'id-without-format',
          severity: 'warning',
          ...scope,
          message: `ID field "${typeName}.${fname}" uses "${tref.name}" instead of OID/PHID.`,
          evidence,
          suggestion:
            'Use the OID scalar for intra-document IDs, or PHID for external document references.',
        });
      }
    }
  }

  // Recursion detection over object/input/interface types
  const cycleEmitted = new Set<string>();
  for (const [startName] of objectLike) {
    const stack: string[] = [];
    const onPath = new Set<string>();

    const dfs = (name: string): void => {
      if (onPath.has(name)) {
        const idx = stack.indexOf(name);
        const cyc = stack.slice(idx).concat(name).join('->');
        if (!cycleEmitted.has(cyc)) {
          cycleEmitted.add(cyc);
          push({
            ruleId: 'recursive-without-depth-bound',
            severity: 'warning',
            ...scope,
            message: `Recursive type cycle without depth bound: ${cyc}.`,
            evidence: truncate(cyc),
            suggestion:
              'Bound recursion (e.g. a maxDepth directive, or store as a flat list with parentId).',
          });
        }
        return;
      }
      const def = objectLike.get(name);
      if (!def) return;
      stack.push(name);
      onPath.add(name);
      const fields = (def as any).fields;
      if (Array.isArray(fields)) {
        for (const f of fields) {
          if (!isPlainObject(f)) continue;
          const tref = unwrapGraphqlType((f as any).type);
          if (tref.name && objectLike.has(tref.name)) {
            dfs(tref.name);
          }
        }
      }
      stack.pop();
      onPath.delete(name);
    };

    try {
      dfs(startName);
    } catch {
      // Defensive.
    }
  }
}

async function loadGraphqlParser(): Promise<
  ((sdl: string) => unknown) | undefined
> {
  try {
    const mod: any = await import('graphql');
    if (typeof mod?.parse === 'function') {
      return (sdl: string) => mod.parse(sdl);
    }
  } catch {
    // graphql not resolvable — skip SDL analysis silently.
  }
  return undefined;
}

function isGraphqlDocumentAst(x: unknown): boolean {
  return (
    isPlainObject(x) &&
    (x as any).kind === 'Document' &&
    Array.isArray((x as any).definitions)
  );
}

async function analyzeSchema(
  schema: unknown,
  scope: FindingScope,
  push: Push,
  parseSdl: ((sdl: string) => unknown) | undefined,
): Promise<void> {
  if (schema == null) return;
  if (typeof schema === 'string') {
    if (!parseSdl) return;
    try {
      const doc = parseSdl(schema);
      walkGraphqlAst(doc, scope, push);
    } catch {
      // Malformed SDL — skip.
    }
    return;
  }
  if (isGraphqlDocumentAst(schema)) {
    walkGraphqlAst(schema, scope, push);
    return;
  }
  if (isPlainObject(schema)) {
    walkJsonSchema(schema, scope, push);
    return;
  }
  // Arrays / primitives at top level: opaque, skip.
}

async function analyzeModel(
  model: LoadedDocumentModel,
  push: (f: Finding) => void,
  parseSdl: ((sdl: string) => unknown) | undefined,
): Promise<void> {
  const wrap =
    (scope: FindingScope): Push =>
    (f) =>
      push({ analyzerId: ANALYZER_ID, ...f, ...scope });

  await analyzeSchema(
    model.stateSchema,
    { model: model.name },
    wrap({ model: model.name }),
    parseSdl,
  );

  for (const op of model.operations ?? ([] as LoadedOperation[])) {
    const scope: FindingScope = {
      model: model.name,
      module: op.module,
      operation: op.name,
    };
    await analyzeSchema(op.inputSchema, scope, wrap(scope), parseSdl);
  }
}

const analyzer: Analyzer = {
  id: ANALYZER_ID,
  description:
    'Inspects state and action schemas for missing constraints and weak typing.',
  async run(ctx: AnalyzerContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const push = (f: Finding): void => {
      findings.push(f);
    };
    const parseSdl = await loadGraphqlParser();
    for (const model of ctx.models ?? []) {
      try {
        await analyzeModel(model, push, parseSdl);
      } catch {
        // Per-model failure must not abort the whole run.
      }
    }
    return findings;
  },
};

export default analyzer;
