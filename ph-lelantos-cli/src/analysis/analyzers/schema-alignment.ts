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
 *   - schema field declared `required: true` but never written by any
 *     operation (potentially dead / unreachable)
 *
 * This is the core consistency check — everything the reducers touch
 * must exist in the schema and vice versa.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { Analyzer, Finding, LoadedDocumentModel } from '../types.js';

interface FieldInfo {
  required: boolean;
  isPrimitive: boolean;
}

type FieldMap = Map<string, FieldInfo>;

const PRIMITIVE_JSON_TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);

const PRIMITIVE_GRAPHQL_TYPES = new Set([
  'String',
  'Int',
  'Float',
  'Boolean',
  'ID',
  'OID',
  'PHID',
  'OLabel',
  'Amount',
  'Amount_Tokens',
  'Amount_Money',
  'Amount_Fiat',
  'Amount_Currency',
  'Amount_Crypto',
  'Amount_Percentage',
  'EthereumAddress',
  'EmailAddress',
  'Date',
  'DateTime',
  'URL',
  'Currency',
]);

function collectJsonSchemaFields(schema: Record<string, unknown>): FieldMap {
  const fields: FieldMap = new Map();
  const props = (schema.properties ?? null) as
    | Record<string, unknown>
    | null;
  const required = Array.isArray(schema.required)
    ? (schema.required as string[])
    : [];
  if (!props || typeof props !== 'object') return fields;

  for (const [name, def] of Object.entries(props)) {
    const d = (def ?? {}) as Record<string, unknown>;
    const typeVal = d.type;
    const isPrimitive =
      typeof typeVal === 'string' && PRIMITIVE_JSON_TYPES.has(typeVal);
    fields.set(name, { required: required.includes(name), isPrimitive });

    // One level of nested properties for primitive-dereference checks.
    if (!isPrimitive && d.properties && typeof d.properties === 'object') {
      const nestedRequired = Array.isArray(d.required)
        ? (d.required as string[])
        : [];
      for (const [nestedName, nestedDef] of Object.entries(
        d.properties as Record<string, unknown>,
      )) {
        const nd = (nestedDef ?? {}) as Record<string, unknown>;
        const nt = nd.type;
        const nestedIsPrimitive =
          typeof nt === 'string' && PRIMITIVE_JSON_TYPES.has(nt);
        fields.set(`${name}.${nestedName}`, {
          required: nestedRequired.includes(nestedName),
          isPrimitive: nestedIsPrimitive,
        });
      }
    }
  }
  return fields;
}

interface GqlTypeNode {
  kind: string;
  type?: GqlTypeNode;
  name?: { value: string };
}
interface GqlFieldNode {
  name: { value: string };
  type: GqlTypeNode;
}
interface GqlObjectTypeNode {
  kind: 'ObjectTypeDefinition';
  name: { value: string };
  fields?: GqlFieldNode[];
}

async function collectGraphqlSchemaFields(
  sdl: string,
): Promise<FieldMap> {
  const fields: FieldMap = new Map();
  try {
    // Dynamic import — `graphql` is an optional peer. Build the module
    // specifier at runtime so TypeScript does not try to resolve it at
    // compile time.
    const specifier = 'graphql';
    const gqlMod = (await import(specifier)) as unknown as {
      parse: (sdl: string) => { definitions: unknown[] };
    };
    const doc = gqlMod.parse(sdl);
    const objectTypes = doc.definitions.filter(
      (d): d is GqlObjectTypeNode =>
        typeof d === 'object' &&
        d !== null &&
        (d as { kind?: string }).kind === 'ObjectTypeDefinition',
    );
    const rootType =
      objectTypes.find((t) => t.name.value.endsWith('State')) ??
      objectTypes[0];
    if (!rootType || !rootType.fields) return fields;

    const typeByName = new Map(objectTypes.map((t) => [t.name.value, t]));

    const isNonNull = (t: GqlTypeNode): boolean => t.kind === 'NonNullType';
    const unwrapName = (t: GqlTypeNode): string | null => {
      let cur: GqlTypeNode = t;
      while (
        (cur.kind === 'NonNullType' || cur.kind === 'ListType') &&
        cur.type
      ) {
        cur = cur.type;
      }
      return cur.kind === 'NamedType' && cur.name ? cur.name.value : null;
    };
    const isList = (t: GqlTypeNode): boolean =>
      t.kind === 'ListType' ||
      (t.kind === 'NonNullType' && !!t.type && t.type.kind === 'ListType');

    for (const field of rootType.fields) {
      const name = field.name.value;
      const typeName = unwrapName(field.type);
      const list = isList(field.type);
      const isPrimitive =
        !list && !!typeName && PRIMITIVE_GRAPHQL_TYPES.has(typeName);
      fields.set(name, {
        required: isNonNull(field.type),
        isPrimitive,
      });

      if (!isPrimitive && typeName && typeByName.has(typeName) && !list) {
        const nested = typeByName.get(typeName)!;
        for (const nf of nested.fields ?? []) {
          const nestedTypeName = unwrapName(nf.type);
          const nestedList = isList(nf.type);
          const nestedIsPrimitive =
            !nestedList &&
            !!nestedTypeName &&
            PRIMITIVE_GRAPHQL_TYPES.has(nestedTypeName);
          fields.set(`${name}.${nf.name.value}`, {
            required: isNonNull(nf.type),
            isPrimitive: nestedIsPrimitive,
          });
        }
      }
    }
  } catch {
    // Unparseable SDL or missing graphql dependency — skip.
  }
  return fields;
}

async function collectSchemaFields(
  stateSchema: unknown,
): Promise<FieldMap> {
  if (typeof stateSchema === 'string') {
    return collectGraphqlSchemaFields(stateSchema);
  }
  if (typeof stateSchema === 'object' && stateSchema !== null) {
    return collectJsonSchemaFields(stateSchema as Record<string, unknown>);
  }
  return new Map();
}

interface StateAccess {
  /** Dotted path rooted at `state`, e.g. `foo` or `foo.bar`. Empty for `state` itself. */
  path: string;
  topField: string;
  depth: number;
  isWrite: boolean;
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  evidence: string;
}

interface ReducerScanResult {
  accesses: StateAccess[];
}

// TODO: deeper nested-path validation (beyond one level of
// primitive-dereference) is deferred; it requires full ts-morph type
// resolution against the generated state types. First pass covers
// top-level field existence and one level of nested primitive checks.

async function scanReducerFiles(
  files: string[],
): Promise<ReducerScanResult | null> {
  let tsMorph: typeof import('ts-morph');
  try {
    tsMorph = await import('ts-morph');
  } catch {
    return null;
  }

  const project = new tsMorph.Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      allowJs: false,
      noEmit: true,
      target: tsMorph.ScriptTarget.ES2022,
      module: tsMorph.ModuleKind.NodeNext,
      moduleResolution: tsMorph.ModuleResolutionKind.NodeNext,
    },
  });

  const existing = files.filter((f) => fs.existsSync(f));
  for (const f of existing) {
    try {
      project.addSourceFileAtPath(f);
    } catch {
      // Ignore unreadable files.
    }
  }

  const accesses: StateAccess[] = [];
  const { SyntaxKind, Node } = tsMorph;

  for (const sourceFile of project.getSourceFiles()) {
    const stateParams = new Set<string>();

    // Collect identifiers of parameters that refer to document state.
    // Heuristic: parameter literally named `state`, or with a type
    // whose text contains "State".
    const collectParams = (
      node: import('ts-morph').Node,
    ) => {
      if (Node.isFunctionLikeDeclaration(node)) {
        for (const p of node.getParameters()) {
          const name = p.getName();
          const typeText = p.getTypeNode()?.getText() ?? '';
          if (name === 'state' || /State\b/.test(typeText)) {
            stateParams.add(name);
          }
        }
      }
    };
    sourceFile.forEachDescendant(collectParams);

    if (stateParams.size === 0) continue;

    const filePath = sourceFile.getFilePath();

    const rootIdentifierOf = (
      node: import('ts-morph').Node,
    ): string | null => {
      let cur: import('ts-morph').Node = node;
      while (
        Node.isPropertyAccessExpression(cur) ||
        Node.isElementAccessExpression(cur)
      ) {
        cur = cur.getExpression();
      }
      if (Node.isIdentifier(cur)) return cur.getText();
      return null;
    };

    const pathOf = (
      node: import('ts-morph').Node,
    ): string[] | null => {
      const parts: string[] = [];
      let cur: import('ts-morph').Node = node;
      while (
        Node.isPropertyAccessExpression(cur) ||
        Node.isElementAccessExpression(cur)
      ) {
        if (Node.isPropertyAccessExpression(cur)) {
          parts.unshift(cur.getName());
        } else {
          const arg = cur.getArgumentExpression();
          if (arg && Node.isStringLiteral(arg)) {
            parts.unshift(arg.getLiteralText());
          } else {
            // dynamic key — cannot resolve statically
            return null;
          }
        }
        cur = cur.getExpression();
      }
      return parts;
    };

    const isWriteContext = (
      access: import('ts-morph').Node,
    ): boolean => {
      const parent = access.getParent();
      if (!parent) return false;
      if (Node.isBinaryExpression(parent)) {
        const op = parent.getOperatorToken().getKind();
        const writeOps = new Set<number>([
          SyntaxKind.EqualsToken,
          SyntaxKind.PlusEqualsToken,
          SyntaxKind.MinusEqualsToken,
          SyntaxKind.AsteriskEqualsToken,
          SyntaxKind.SlashEqualsToken,
          SyntaxKind.PercentEqualsToken,
          SyntaxKind.AmpersandEqualsToken,
          SyntaxKind.BarEqualsToken,
          SyntaxKind.CaretEqualsToken,
          SyntaxKind.LessThanLessThanEqualsToken,
          SyntaxKind.GreaterThanGreaterThanEqualsToken,
          SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
          SyntaxKind.AsteriskAsteriskEqualsToken,
          SyntaxKind.AmpersandAmpersandEqualsToken,
          SyntaxKind.BarBarEqualsToken,
          SyntaxKind.QuestionQuestionEqualsToken,
        ]);
        return writeOps.has(op) && parent.getLeft() === access;
      }
      if (
        Node.isPostfixUnaryExpression(parent) ||
        Node.isPrefixUnaryExpression(parent)
      ) {
        const op = parent.getOperatorToken();
        return (
          op === SyntaxKind.PlusPlusToken ||
          op === SyntaxKind.MinusMinusToken
        );
      }
      // Method call like state.foo.push(...) treats the receiver as a
      // write-through site.
      if (
        Node.isPropertyAccessExpression(parent) &&
        parent.getExpression() === access
      ) {
        const grand = parent.getParent();
        if (grand && Node.isCallExpression(grand)) {
          const method = parent.getName();
          if (
            method === 'push' ||
            method === 'pop' ||
            method === 'shift' ||
            method === 'unshift' ||
            method === 'splice' ||
            method === 'sort' ||
            method === 'reverse' ||
            method === 'fill' ||
            method === 'copyWithin'
          ) {
            return true;
          }
        }
      }
      return false;
    };

    sourceFile.forEachDescendant((node) => {
      if (
        !Node.isPropertyAccessExpression(node) &&
        !Node.isElementAccessExpression(node)
      ) {
        return;
      }
      // Skip inner accesses — we only want the outermost chain.
      const parent = node.getParent();
      if (
        parent &&
        (Node.isPropertyAccessExpression(parent) ||
          Node.isElementAccessExpression(parent)) &&
        parent.getExpression() === node
      ) {
        return;
      }
      const root = rootIdentifierOf(node);
      if (!root || !stateParams.has(root)) return;

      const parts = pathOf(node);
      if (!parts || parts.length === 0) return;

      const start = sourceFile.getLineAndColumnAtPos(node.getStart());
      const end = sourceFile.getLineAndColumnAtPos(node.getEnd());
      accesses.push({
        path: parts.join('.'),
        topField: parts[0]!,
        depth: parts.length,
        isWrite: isWriteContext(node),
        file: filePath,
        line: start.line,
        column: start.column,
        endLine: end.line,
        endColumn: end.column,
        evidence: node.getText(),
      });
    });
  }

  return { accesses };
}

function fileToOperation(
  model: LoadedDocumentModel,
  file: string,
): { operation?: string; module?: string } {
  const match = model.operations.find(
    (op) => op.reducerFile && path.resolve(op.reducerFile) === path.resolve(file),
  );
  if (match) return { operation: match.name, module: match.module };
  return {};
}

function listReducerFiles(model: LoadedDocumentModel): string[] {
  const explicit = model.operations
    .map((op) => op.reducerFile)
    .filter((f): f is string => typeof f === 'string');
  if (explicit.length > 0) {
    return Array.from(new Set(explicit));
  }
  if (!model.reducerDir) return [];
  try {
    const entries = fs.readdirSync(model.reducerDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => path.join(model.reducerDir!, e.name));
  } catch {
    return [];
  }
}

async function analyzeModel(
  model: LoadedDocumentModel,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const fields = await collectSchemaFields(model.stateSchema);
  if (fields.size === 0) return findings;

  const files = listReducerFiles(model);
  if (files.length === 0) return findings;

  const scan = await scanReducerFiles(files);
  if (!scan) return findings;

  const writtenTopFields = new Set<string>();

  for (const access of scan.accesses) {
    const { operation, module } = fileToOperation(model, access.file);
    const location = {
      file: access.file,
      line: access.line,
      column: access.column,
      endLine: access.endLine,
      endColumn: access.endColumn,
    };

    const topInfo = fields.get(access.topField);
    if (!topInfo) {
      findings.push({
        ruleId: 'unknown-state-field',
        analyzerId: 'schema-alignment',
        severity: 'error',
        message: `Reducer accesses \`state.${access.topField}\` but the state schema declares no such field.`,
        model: model.name,
        module,
        operation,
        location,
        evidence: access.evidence,
      });
      continue;
    }

    if (access.isWrite) {
      writtenTopFields.add(access.topField);
    }

    if (access.depth >= 2 && topInfo.isPrimitive) {
      findings.push({
        ruleId: 'primitive-dereference',
        analyzerId: 'schema-alignment',
        severity: 'error',
        message: `Reducer reads/writes \`state.${access.path}\` but \`${access.topField}\` is declared as a primitive.`,
        model: model.name,
        module,
        operation,
        location,
        evidence: access.evidence,
      });
    }
  }

  for (const [name, info] of fields.entries()) {
    if (name.includes('.')) continue; // only check top-level required fields
    if (!info.required) continue;
    if (!writtenTopFields.has(name)) {
      findings.push({
        ruleId: 'required-field-never-written',
        analyzerId: 'schema-alignment',
        severity: 'warning',
        message: `Required state field \`${name}\` is never written by any reducer.`,
        model: model.name,
      });
    }
  }

  return findings;
}

const analyzer: Analyzer = {
  id: 'schema-alignment',
  description:
    'Cross-checks reducer state mutations against the declared state schema.',
  async run(ctx) {
    try {
      const all = await Promise.all(ctx.models.map((m) => analyzeModel(m)));
      return all.flat();
    } catch {
      return [];
    }
  },
};

export default analyzer;
