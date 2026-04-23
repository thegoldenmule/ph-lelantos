/**
 * taint-tracking
 *
 * Toolchain: ts-morph, hand-rolled intraprocedural taint propagation.
 *
 * Sources:
 *   - the reducer's `action.input` parameter and any field derived from it
 *
 * Sinks (each a separate rule id):
 *   - string concatenation into URLs / `new URL(...)` / `fetch(...)`
 *   - `path.join` / `path.resolve` / `path.normalize`
 *   - `eval`, `new Function`
 *   - `new RegExp(<tainted>)`
 *   - DOM sinks (`innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`)
 *
 * Reports the source-to-sink path so the LLM reviewer can reason about
 * exploitability.
 */
import path from 'node:path';
import {
  Node,
  Project,
  SyntaxKind,
  type ArrowFunction,
  type BindingElement,
  type FunctionDeclaration,
  type FunctionExpression,
  type Identifier,
  type SourceFile,
  type VariableDeclaration,
} from 'ts-morph';
import type {
  Analyzer,
  AnalyzerContext,
  Finding,
  LoadedDocumentModel,
  LoadedOperation,
  Severity,
  SourceLocation,
} from '../types.js';

type ReducerFn = FunctionDeclaration | FunctionExpression | ArrowFunction;

interface SinkHit {
  ruleId: string;
  severity: Severity;
  message: string;
  node: Node;
}

const analyzer: Analyzer = {
  id: 'taint-tracking',
  description:
    'Traces untrusted action input from reducer parameters to dangerous sinks.',
  async run(ctx: AnalyzerContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const model of ctx.models) {
      const files = resolveReducerFiles(model);
      if (files.length === 0) continue;

      const project = new Project({
        skipAddingFilesFromTsConfig: true,
        skipFileDependencyResolution: true,
        skipLoadingLibFiles: true,
      });
      const sources: SourceFile[] = [];
      for (const file of files) {
        try {
          sources.push(project.addSourceFileAtPath(file));
        } catch {
          // Unreadable reducer file — skip without throwing.
        }
      }

      for (const sourceFile of sources) {
        const operation = findOperationForFile(model, sourceFile.getFilePath());
        for (const fn of collectReducerFunctions(sourceFile)) {
          const tainted = seedTaint(fn);
          if (tainted.size === 0) continue;
          propagate(fn, tainted);
          for (const hit of collectSinks(fn, tainted)) {
            findings.push(toFinding(hit, model, operation));
          }
        }
      }
    }
    return findings;
  },
};

export default analyzer;

function resolveReducerFiles(model: LoadedDocumentModel): string[] {
  const fromOps = model.operations
    .map((op) => op.reducerFile)
    .filter((f): f is string => typeof f === 'string' && f.length > 0);
  if (fromOps.length > 0) {
    return Array.from(new Set(fromOps));
  }
  if (!model.reducerDir) return [];
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
  });
  const dir = model.reducerDir.replace(/\\/g, '/').replace(/\/+$/, '');
  try {
    const added = project.addSourceFilesAtPaths(`${dir}/**/*.ts`);
    return added.map((s) => s.getFilePath());
  } catch {
    return [];
  }
}

function findOperationForFile(
  model: LoadedDocumentModel,
  filePath: string,
): LoadedOperation | undefined {
  const normalized = path.normalize(filePath);
  return model.operations.find(
    (op) => op.reducerFile && path.normalize(op.reducerFile) === normalized,
  );
}

function collectReducerFunctions(sourceFile: SourceFile): ReducerFn[] {
  const fns: ReducerFn[] = [];
  sourceFile.forEachDescendant((node) => {
    if (
      Node.isFunctionDeclaration(node) ||
      Node.isFunctionExpression(node) ||
      Node.isArrowFunction(node)
    ) {
      if (hasActionParam(node)) fns.push(node);
    }
  });
  return fns;
}

function hasActionParam(fn: ReducerFn): boolean {
  // Heuristic: second parameter named `action` (Powerhouse reducer shape
  // `(state, action) => ...`). Fall back to any parameter named `action`.
  const params = fn.getParameters();
  if (params.length >= 2) {
    const name = params[1]?.getName();
    if (name === 'action') return true;
  }
  return params.some((p) => p.getName() === 'action');
}

function seedTaint(fn: ReducerFn): Set<Node> {
  const tainted = new Set<Node>();
  for (const param of fn.getParameters()) {
    if (param.getName() !== 'action') continue;
    const nameNode = param.getNameNode();
    if (Node.isIdentifier(nameNode)) {
      for (const ref of nameNode.findReferencesAsNodes()) {
        if (isInside(ref, fn)) tainted.add(ref);
      }
    } else if (Node.isObjectBindingPattern(nameNode)) {
      for (const el of nameNode.getElements()) {
        taintBindingElement(el, fn, tainted);
      }
    }
  }
  return tainted;
}

function taintBindingElement(
  el: BindingElement,
  fn: ReducerFn,
  tainted: Set<Node>,
): void {
  const nameNode = el.getNameNode();
  if (Node.isIdentifier(nameNode)) {
    for (const ref of nameNode.findReferencesAsNodes()) {
      if (isInside(ref, fn)) tainted.add(ref);
    }
  } else if (Node.isObjectBindingPattern(nameNode)) {
    for (const inner of nameNode.getElements()) {
      taintBindingElement(inner, fn, tainted);
    }
  }
}

function isInside(node: Node, container: Node): boolean {
  let cur: Node | undefined = node;
  while (cur) {
    if (cur === container) return true;
    cur = cur.getParent();
  }
  return false;
}

function propagate(fn: ReducerFn, tainted: Set<Node>): void {
  // Fixed-point: re-scan the function body until no new taints are added.
  let changed = true;
  let guard = 0;
  while (changed && guard < 16) {
    changed = false;
    guard++;
    fn.forEachDescendant((node) => {
      if (Node.isVariableDeclaration(node)) {
        if (propagateVariableDeclaration(node, fn, tainted)) changed = true;
      } else if (Node.isBinaryExpression(node)) {
        const op = node.getOperatorToken().getKind();
        if (
          op === SyntaxKind.EqualsToken ||
          op === SyntaxKind.PlusEqualsToken
        ) {
          if (isTaintedExpression(node.getRight(), tainted)) {
            const left = node.getLeft();
            if (Node.isIdentifier(left)) {
              if (addReferences(left, fn, tainted)) changed = true;
            } else if (left) {
              if (!tainted.has(left)) {
                tainted.add(left);
                changed = true;
              }
            }
          }
        }
      }
    });
  }
}

function propagateVariableDeclaration(
  decl: VariableDeclaration,
  fn: ReducerFn,
  tainted: Set<Node>,
): boolean {
  const init = decl.getInitializer();
  if (!init) return false;
  if (!isTaintedExpression(init, tainted)) return false;
  let changed = false;
  const nameNode = decl.getNameNode();
  if (Node.isIdentifier(nameNode)) {
    if (addReferences(nameNode, fn, tainted)) changed = true;
  } else if (Node.isObjectBindingPattern(nameNode)) {
    for (const el of nameNode.getElements()) {
      const before = tainted.size;
      taintBindingElement(el, fn, tainted);
      if (tainted.size !== before) changed = true;
    }
  } else if (Node.isArrayBindingPattern(nameNode)) {
    for (const el of nameNode.getElements()) {
      if (Node.isBindingElement(el)) {
        const before = tainted.size;
        taintBindingElement(el, fn, tainted);
        if (tainted.size !== before) changed = true;
      }
    }
  }
  return changed;
}

function addReferences(
  id: Identifier,
  fn: ReducerFn,
  tainted: Set<Node>,
): boolean {
  let changed = false;
  for (const ref of id.findReferencesAsNodes()) {
    if (!isInside(ref, fn)) continue;
    if (!tainted.has(ref)) {
      tainted.add(ref);
      changed = true;
    }
  }
  return changed;
}

function isTaintedExpression(expr: Node | undefined, tainted: Set<Node>): boolean {
  if (!expr) return false;
  if (tainted.has(expr)) return true;

  if (
    Node.isPropertyAccessExpression(expr) ||
    Node.isElementAccessExpression(expr)
  ) {
    return isTaintedExpression(expr.getExpression(), tainted);
  }
  if (Node.isParenthesizedExpression(expr) || Node.isAsExpression(expr)) {
    return isTaintedExpression(expr.getExpression(), tainted);
  }
  if (Node.isNonNullExpression(expr)) {
    return isTaintedExpression(expr.getExpression(), tainted);
  }
  if (Node.isTemplateExpression(expr)) {
    return expr
      .getTemplateSpans()
      .some((span) => isTaintedExpression(span.getExpression(), tainted));
  }
  if (Node.isBinaryExpression(expr)) {
    const op = expr.getOperatorToken().getKind();
    if (op === SyntaxKind.PlusToken) {
      return (
        isTaintedExpression(expr.getLeft(), tainted) ||
        isTaintedExpression(expr.getRight(), tainted)
      );
    }
  }
  if (Node.isConditionalExpression(expr)) {
    return (
      isTaintedExpression(expr.getWhenTrue(), tainted) ||
      isTaintedExpression(expr.getWhenFalse(), tainted)
    );
  }
  if (Node.isIdentifier(expr)) {
    // Not yet in the set — unknown.
    return false;
  }
  return false;
}

function collectSinks(fn: ReducerFn, tainted: Set<Node>): SinkHit[] {
  const hits: SinkHit[] = [];
  fn.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      const target = node.getExpression();
      const callee = target.getText();
      const args = node.getArguments();

      if (callee === 'eval') {
        if (args.some((a) => isTaintedExpression(a, tainted))) {
          hits.push({
            ruleId: 'sink-eval',
            severity: 'error',
            message: 'Tainted action input reaches `eval(...)`.',
            node,
          });
        }
      } else if (callee === 'fetch') {
        if (args.some((a) => isTaintedExpression(a, tainted))) {
          hits.push({
            ruleId: 'sink-url',
            severity: 'warning',
            message: 'Tainted action input reaches `fetch(...)`.',
            node,
          });
        }
      } else if (
        callee === 'path.join' ||
        callee === 'path.resolve' ||
        callee === 'path.normalize'
      ) {
        if (args.some((a) => isTaintedExpression(a, tainted))) {
          hits.push({
            ruleId: 'sink-path',
            severity: 'warning',
            message: `Tainted action input reaches \`${callee}(...)\`.`,
            node,
          });
        }
      } else if (callee === 'document.write') {
        if (args.some((a) => isTaintedExpression(a, tainted))) {
          hits.push({
            ruleId: 'sink-dom',
            severity: 'warning',
            message: 'Tainted action input reaches `document.write(...)`.',
            node,
          });
        }
      } else if (
        Node.isPropertyAccessExpression(target) &&
        target.getName() === 'insertAdjacentHTML'
      ) {
        if (args.some((a) => isTaintedExpression(a, tainted))) {
          hits.push({
            ruleId: 'sink-dom',
            severity: 'warning',
            message: 'Tainted action input reaches `insertAdjacentHTML(...)`.',
            node,
          });
        }
      }
    } else if (Node.isNewExpression(node)) {
      const callee = node.getExpression().getText();
      const args = node.getArguments();
      if (callee === 'URL') {
        if (args.some((a) => isTaintedExpression(a, tainted))) {
          hits.push({
            ruleId: 'sink-url',
            severity: 'warning',
            message: 'Tainted action input reaches `new URL(...)`.',
            node,
          });
        }
      } else if (callee === 'RegExp') {
        if (args.some((a) => isTaintedExpression(a, tainted))) {
          hits.push({
            ruleId: 'sink-regexp',
            severity: 'warning',
            message: 'Tainted action input reaches `new RegExp(...)`.',
            node,
          });
        }
      } else if (callee === 'Function') {
        if (args.some((a) => isTaintedExpression(a, tainted))) {
          hits.push({
            ruleId: 'sink-eval',
            severity: 'error',
            message: 'Tainted action input reaches `new Function(...)`.',
            node,
          });
        }
      }
    } else if (Node.isBinaryExpression(node)) {
      const op = node.getOperatorToken().getKind();
      if (op !== SyntaxKind.EqualsToken) return;
      const left = node.getLeft();
      const right = node.getRight();
      if (!isTaintedExpression(right, tainted)) return;
      if (!Node.isPropertyAccessExpression(left)) return;
      const name = left.getName();
      if (
        name === 'innerHTML' ||
        name === 'outerHTML'
      ) {
        hits.push({
          ruleId: 'sink-dom',
          severity: 'warning',
          message: `Tainted action input assigned to \`.${name}\`.`,
          node,
        });
      } else if (name === 'href') {
        hits.push({
          ruleId: 'sink-url',
          severity: 'warning',
          message: 'Tainted action input assigned to `.href`.',
          node,
        });
      } else if (left.getText() === 'window.location') {
        hits.push({
          ruleId: 'sink-url',
          severity: 'warning',
          message: 'Tainted action input assigned to `window.location`.',
          node,
        });
      }
    }
  });
  return hits;
}

function toFinding(
  hit: SinkHit,
  model: LoadedDocumentModel,
  operation: LoadedOperation | undefined,
): Finding {
  const node = hit.node;
  const sourceFile = node.getSourceFile();
  const start = sourceFile.getLineAndColumnAtPos(node.getStart());
  const end = sourceFile.getLineAndColumnAtPos(node.getEnd());
  const location: SourceLocation = {
    file: sourceFile.getFilePath(),
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
  return {
    analyzerId: 'taint-tracking',
    ruleId: hit.ruleId,
    severity: hit.severity,
    message: hit.message,
    model: model.name,
    module: operation?.module,
    operation: operation?.name,
    location,
    evidence: node.getText().slice(0, 400),
  };
}
