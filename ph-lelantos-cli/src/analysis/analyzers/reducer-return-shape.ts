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
import path from 'node:path';
import {
  Node,
  Project,
  SyntaxKind,
  ts,
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  type ParameterDeclaration,
  type SourceFile,
  type Symbol as TsMorphSymbol,
} from 'ts-morph';
import type {
  Analyzer,
  AnalyzerContext,
  Finding,
  LoadedDocumentModel,
  LoadedOperation,
  SourceLocation,
} from '../types.js';

type ReducerFn =
  | FunctionDeclaration
  | FunctionExpression
  | ArrowFunction
  | MethodDeclaration;

interface FileAttribution {
  model: string;
  module?: string;
  operation?: string;
}

const ASSIGN_TOKENS = new Set<SyntaxKind>([
  SyntaxKind.EqualsToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.SlashEqualsToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
  SyntaxKind.LessThanLessThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  SyntaxKind.BarEqualsToken,
  SyntaxKind.AmpersandEqualsToken,
  SyntaxKind.CaretEqualsToken,
  SyntaxKind.AsteriskAsteriskEqualsToken,
]);

const ALLOWED_RETURN_TYPES = new Set(['void', 'undefined', 'never', 'any']);

function truncate(text: string, max = 160): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function nodeLocation(sf: SourceFile, node: Node): SourceLocation {
  const start = sf.getLineAndColumnAtPos(node.getStart());
  const end = sf.getLineAndColumnAtPos(node.getEnd());
  return {
    file: sf.getFilePath(),
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

function unwrap(expr: Node): Node {
  let current: Node = expr;
  while (
    Node.isParenthesizedExpression(current) ||
    Node.isAsExpression(current) ||
    Node.isTypeAssertion(current) ||
    Node.isNonNullExpression(current) ||
    Node.isSatisfiesExpression(current)
  ) {
    const inner = (current as { getExpression: () => Node }).getExpression();
    current = inner;
  }
  return current;
}

function rootOfAccessChain(expr: Node): Node {
  let current: Node = expr;
  while (
    Node.isPropertyAccessExpression(current) ||
    Node.isElementAccessExpression(current)
  ) {
    current = current.getExpression();
  }
  return current;
}

function identifierResolvesTo(node: Node, target: TsMorphSymbol): boolean {
  if (!Node.isIdentifier(node)) return false;
  const sym = node.getSymbol();
  if (!sym) return false;
  if (sym === target) return true;
  const aliased = sym.getAliasedSymbol?.();
  return aliased === target;
}

function collectReducerFunctions(sf: SourceFile): ReducerFn[] {
  const out: ReducerFn[] = [];
  const kinds: SyntaxKind[] = [
    SyntaxKind.FunctionDeclaration,
    SyntaxKind.FunctionExpression,
    SyntaxKind.ArrowFunction,
    SyntaxKind.MethodDeclaration,
  ];
  for (const kind of kinds) {
    for (const node of sf.getDescendantsOfKind(kind)) {
      const fn = node as ReducerFn;
      const params = fn.getParameters();
      if (params.length === 0) continue;
      const first = params[0];
      const nameNode = first.getNameNode();
      if (!Node.isIdentifier(nameNode)) continue;
      if (nameNode.getText() !== 'state') continue;
      out.push(fn);
    }
  }
  return out;
}

function describeFunction(fn: ReducerFn): string {
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) {
    const name = fn.getName();
    if (name) return name;
  }
  if (Node.isFunctionExpression(fn)) {
    const name = fn.getName();
    if (name) return name;
  }
  const parent = fn.getParent();
  if (parent && Node.isVariableDeclaration(parent)) {
    return parent.getName();
  }
  return '<anonymous>';
}

function attributionForFile(
  filePath: string,
  byFile: Map<string, FileAttribution>,
): FileAttribution | undefined {
  const direct = byFile.get(filePath);
  if (direct) return direct;
  const normalized = path.resolve(filePath);
  return byFile.get(normalized);
}

function buildAttribution(
  models: LoadedDocumentModel[],
): { files: string[]; byFile: Map<string, FileAttribution> } {
  const files = new Set<string>();
  const byFile = new Map<string, FileAttribution>();

  for (const model of models) {
    const opsByFile = new Map<string, LoadedOperation[]>();
    for (const op of model.operations) {
      if (!op.reducerFile) continue;
      const key = path.resolve(op.reducerFile);
      const list = opsByFile.get(key) ?? [];
      list.push(op);
      opsByFile.set(key, list);
    }

    if (opsByFile.size > 0) {
      for (const [file, ops] of opsByFile) {
        files.add(file);
        const modules = new Set(ops.map((o) => o.module));
        const attribution: FileAttribution = {
          model: model.name,
          module: modules.size === 1 ? [...modules][0] : undefined,
          operation: ops.length === 1 ? ops[0].name : undefined,
        };
        byFile.set(file, attribution);
      }
      continue;
    }

    if (model.reducerDir) {
      // Glob fallback handled by the caller via ts-morph addSourceFilesAtPaths.
      // Mark the directory — individual files get attributed after loading.
      byFile.set(`dir:${path.resolve(model.reducerDir)}`, {
        model: model.name,
      });
    }
  }

  return { files: [...files], byFile };
}

function attributeDirFile(
  filePath: string,
  byFile: Map<string, FileAttribution>,
): FileAttribution | undefined {
  for (const [key, attribution] of byFile) {
    if (!key.startsWith('dir:')) continue;
    const dir = key.slice('dir:'.length);
    if (filePath === dir || filePath.startsWith(`${dir}${path.sep}`)) {
      const base = path.basename(filePath, path.extname(filePath));
      return { model: attribution.model, module: base };
    }
  }
  return undefined;
}

function findStateParam(fn: ReducerFn): ParameterDeclaration | undefined {
  const params = fn.getParameters();
  if (params.length === 0) return undefined;
  const first = params[0];
  const nameNode = first.getNameNode();
  if (!Node.isIdentifier(nameNode)) return undefined;
  if (nameNode.getText() !== 'state') return undefined;
  return first;
}

const analyzer: Analyzer = {
  id: 'reducer-return-shape',
  description:
    'Enforces Mutative-style reducers — mutate state, do not return it.',
  run(ctx: AnalyzerContext): Finding[] {
    const findings: Finding[] = [];
    const project = new Project({
      skipAddingFilesFromTsConfig: true,
      useInMemoryFileSystem: false,
    });

    const { files, byFile } = buildAttribution(ctx.models);
    const loadedFiles = new Set<string>();

    for (const file of files) {
      try {
        project.addSourceFileAtPathIfExists(file);
        loadedFiles.add(file);
      } catch (err) {
        findings.push({
          analyzerId: 'reducer-return-shape',
          ruleId: 'analysis-skipped',
          severity: 'info',
          message: `Could not load reducer file: ${(err as Error).message}`,
          location: { file },
        });
      }
    }

    for (const model of ctx.models) {
      if (!model.reducerDir) continue;
      const hasFileLevel = model.operations.some((o) => o.reducerFile);
      if (hasFileLevel) continue;
      const pattern = path
        .join(path.resolve(model.reducerDir), '**/*.ts')
        .replace(/\\/g, '/');
      try {
        const added = project.addSourceFilesAtPaths([
          pattern,
          `!${pattern.replace(/\*\*\/\*\.ts$/, '**/*.d.ts')}`,
          `!${pattern.replace(/\*\*\/\*\.ts$/, '**/*.test.ts')}`,
        ]);
        for (const sf of added) {
          loadedFiles.add(sf.getFilePath());
        }
      } catch (err) {
        findings.push({
          analyzerId: 'reducer-return-shape',
          ruleId: 'analysis-skipped',
          severity: 'info',
          message: `Could not scan reducer dir ${model.reducerDir}: ${(err as Error).message}`,
          location: { file: model.reducerDir },
          model: model.name,
        });
      }
    }

    for (const sf of project.getSourceFiles()) {
      const filePath = sf.getFilePath();
      if (!loadedFiles.has(filePath)) continue;
      const attribution =
        attributionForFile(filePath, byFile) ??
        attributeDirFile(filePath, byFile);

      try {
        const reducers = collectReducerFunctions(sf);
        for (const fn of reducers) {
          inspectReducer(fn, sf, attribution, findings);
        }
      } catch (err) {
        findings.push({
          analyzerId: 'reducer-return-shape',
          ruleId: 'analysis-skipped',
          severity: 'info',
          message: `Failed to inspect ${path.basename(filePath)}: ${(err as Error).message}`,
          location: { file: filePath },
          model: attribution?.model,
        });
      }
    }

    return findings;
  },
};

function inspectReducer(
  fn: ReducerFn,
  sf: SourceFile,
  attribution: FileAttribution | undefined,
  findings: Finding[],
): void {
  const stateParam = findStateParam(fn);
  if (!stateParam) return;
  const stateSymbol = stateParam.getSymbol();
  const body = fn.getBody();
  if (!body) return;

  const scope = attribution
    ? {
        model: attribution.model,
        module: attribution.operation ? attribution.module : attribution.module,
        operation: attribution.operation,
      }
    : {};

  // Rule: explicit-return-of-state
  for (const ret of body.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
    // Skip returns inside nested functions (not this reducer).
    const enclosing = ret.getFirstAncestor(
      (a) =>
        Node.isFunctionDeclaration(a) ||
        Node.isFunctionExpression(a) ||
        Node.isArrowFunction(a) ||
        Node.isMethodDeclaration(a),
    );
    if (enclosing && enclosing !== fn) continue;

    const expr = ret.getExpression();
    if (!expr) continue;
    const unwrapped = unwrap(expr);
    const root = rootOfAccessChain(unwrapped);
    if (stateSymbol && identifierResolvesTo(root, stateSymbol)) {
      findings.push({
        analyzerId: 'reducer-return-shape',
        ruleId: 'explicit-return-of-state',
        severity: 'error',
        message:
          'Reducer returns `state` (or a projection of it). Mutative reducers must mutate in place.',
        ...scope,
        location: nodeLocation(sf, ret),
        evidence: truncate(ret.getText()),
        suggestion: 'Mutate `state` in place; remove the `return`.',
      });
    }
  }

  // Rule: state-reassignment
  if (stateSymbol) {
    for (const bin of body.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      const opKind = bin.getOperatorToken().getKind();
      if (!ASSIGN_TOKENS.has(opKind)) continue;
      const lhs = bin.getLeft();
      if (!identifierResolvesTo(lhs, stateSymbol)) continue;
      findings.push({
        analyzerId: 'reducer-return-shape',
        ruleId: 'state-reassignment',
        severity: 'error',
        message:
          'Reassigning the `state` parameter breaks the Mutative proxy; mutate its properties instead.',
        ...scope,
        location: nodeLocation(sf, bin),
        evidence: truncate(bin.getText()),
        suggestion:
          'Replace `state = ...` with per-field mutations (e.g., `state.foo = ...`).',
      });
    }
  }

  // Rule: state-rebind
  for (const varDecl of body.getDescendantsOfKind(
    SyntaxKind.VariableDeclaration,
  )) {
    const nameNode = varDecl.getNameNode();
    if (!Node.isIdentifier(nameNode)) continue;
    if (nameNode.getText() !== 'state') continue;
    findings.push({
      analyzerId: 'reducer-return-shape',
      ruleId: 'state-rebind',
      severity: 'warning',
      message:
        'Local binding named `state` shadows the reducer parameter and loses the Mutative proxy.',
      ...scope,
      location: nodeLocation(sf, varDecl),
      evidence: truncate(varDecl.getText()),
      suggestion: 'Rename the local variable to avoid shadowing `state`.',
    });
  }

  // Rule: non-void-return-type
  try {
    const returnType = fn.getReturnType();
    const text = returnType.getText();
    if (!ALLOWED_RETURN_TYPES.has(text.trim())) {
      const anchor =
        (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)
          ? fn.getNameNode()
          : undefined) ?? stateParam;
      findings.push({
        analyzerId: 'reducer-return-shape',
        ruleId: 'non-void-return-type',
        severity: 'warning',
        message: `Reducer \`${describeFunction(fn)}\` has return type \`${truncate(text, 80)}\`; expected \`void\`/\`undefined\`.`,
        ...scope,
        location: nodeLocation(sf, anchor),
        evidence: truncate(fn.getText(), 160),
        suggestion:
          'Annotate the reducer as returning `void` and remove explicit returns.',
      });
    }
  } catch {
    // Type checking can fail for files outside a tsconfig; silently skip.
  }
}

// Silence unused-import warnings from narrow type imports above.
void ts;

export default analyzer;
