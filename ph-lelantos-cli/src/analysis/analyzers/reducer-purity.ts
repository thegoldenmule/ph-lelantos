/**
 * reducer-purity
 *
 * Toolchain: ts-morph (TypeScript Compiler API wrapper).
 *
 * Walks every reducer function and flags constructs that break the
 * Powerhouse "pure synchronous reducer" contract:
 *   - Date.now(), new Date() without args, performance.now()
 *   - Math.random(), crypto.randomUUID(), crypto.getRandomValues()
 *   - async / await / Promise / setTimeout / setInterval
 *   - any import from node:fs, node:net, node:child_process, node:http(s)
 *   - fetch(), XMLHttpRequest, WebSocket
 *   - process.env, process.argv access
 *
 * Non-deterministic values must come from the action input; this
 * analyzer is the primary guard for that invariant.
 */
import path from 'node:path';
import {
  Node,
  Project,
  SyntaxKind,
  type CallExpression,
  type ImportDeclaration,
  type NewExpression,
  type PropertyAccessExpression,
  type SourceFile,
} from 'ts-morph';
import type {
  Analyzer,
  AnalyzerContext,
  Finding,
  LoadedDocumentModel,
  Severity,
  SourceLocation,
} from '../types.js';

const BANNED_PROPERTY_ACCESS: Record<
  string,
  { ruleId: string; severity: Severity; message: string; suggestion?: string }
> = {
  'Date.now': {
    ruleId: 'time-nondeterminism',
    severity: 'error',
    message: '`Date.now()` is non-deterministic inside a reducer.',
    suggestion: 'Pass the timestamp through the action input instead.',
  },
  'performance.now': {
    ruleId: 'time-nondeterminism',
    severity: 'error',
    message: '`performance.now()` is non-deterministic inside a reducer.',
    suggestion: 'Pass the timestamp through the action input instead.',
  },
  'Math.random': {
    ruleId: 'randomness',
    severity: 'error',
    message: '`Math.random()` is non-deterministic inside a reducer.',
    suggestion: 'Generate the random value caller-side and pass it in the action input.',
  },
  'crypto.randomUUID': {
    ruleId: 'randomness',
    severity: 'error',
    message: '`crypto.randomUUID()` is non-deterministic inside a reducer.',
    suggestion: 'Generate the id caller-side and pass it in the action input.',
  },
  'crypto.getRandomValues': {
    ruleId: 'randomness',
    severity: 'error',
    message: '`crypto.getRandomValues()` is non-deterministic inside a reducer.',
    suggestion: 'Generate random bytes caller-side and pass them in the action input.',
  },
  'globalThis.crypto.randomUUID': {
    ruleId: 'randomness',
    severity: 'error',
    message: '`globalThis.crypto.randomUUID()` is non-deterministic inside a reducer.',
    suggestion: 'Generate the id caller-side and pass it in the action input.',
  },
  'globalThis.crypto.getRandomValues': {
    ruleId: 'randomness',
    severity: 'error',
    message: '`globalThis.crypto.getRandomValues()` is non-deterministic inside a reducer.',
    suggestion: 'Generate random bytes caller-side and pass them in the action input.',
  },
};

const PROCESS_ACCESS_PREFIXES = ['process.env', 'process.argv'];

const BARE_CALL_RULES: Record<
  string,
  { ruleId: string; severity: Severity; message: string; suggestion?: string }
> = {
  fetch: {
    ruleId: 'network-io',
    severity: 'error',
    message: '`fetch()` performs network I/O and is forbidden inside a reducer.',
    suggestion: 'Move the request to a command/service; reducers apply already-fetched data.',
  },
  setTimeout: {
    ruleId: 'timers',
    severity: 'warning',
    message: '`setTimeout` is asynchronous and forbidden inside a reducer.',
  },
  setInterval: {
    ruleId: 'timers',
    severity: 'warning',
    message: '`setInterval` is asynchronous and forbidden inside a reducer.',
  },
  setImmediate: {
    ruleId: 'timers',
    severity: 'warning',
    message: '`setImmediate` is asynchronous and forbidden inside a reducer.',
  },
  queueMicrotask: {
    ruleId: 'timers',
    severity: 'warning',
    message: '`queueMicrotask` is asynchronous and forbidden inside a reducer.',
  },
};

const BARE_NEW_RULES: Record<
  string,
  { ruleId: string; severity: Severity; message: string; suggestion?: string }
> = {
  XMLHttpRequest: {
    ruleId: 'network-io',
    severity: 'error',
    message: '`new XMLHttpRequest()` performs network I/O and is forbidden inside a reducer.',
  },
  WebSocket: {
    ruleId: 'network-io',
    severity: 'error',
    message: '`new WebSocket()` performs network I/O and is forbidden inside a reducer.',
  },
  Promise: {
    ruleId: 'async-reducer',
    severity: 'error',
    message: '`new Promise()` introduces async control flow inside a reducer.',
  },
};

function truncate(text: string, max = 120): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function locationOf(node: Node): SourceLocation {
  const sourceFile = node.getSourceFile();
  const start = sourceFile.getLineAndColumnAtPos(node.getStart());
  const end = sourceFile.getLineAndColumnAtPos(node.getEnd());
  return {
    file: sourceFile.getFilePath(),
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

function propertyAccessChain(node: PropertyAccessExpression): string {
  return node.getText().replace(/\s+/g, '');
}

function analyzeSourceFile(
  source: SourceFile,
  model: LoadedDocumentModel,
  moduleName: string,
): Finding[] {
  const findings: Finding[] = [];

  const push = (
    rule: { ruleId: string; severity: Severity; message: string; suggestion?: string },
    node: Node,
  ): void => {
    findings.push({
      analyzerId: 'reducer-purity',
      ruleId: rule.ruleId,
      severity: rule.severity,
      message: rule.message,
      model: model.name,
      module: moduleName,
      location: locationOf(node),
      evidence: truncate(node.getText()),
      suggestion: rule.suggestion,
    });
  };

  // Imports: node:* static and dynamic.
  source.forEachDescendant((node) => {
    if (node.getKind() === SyntaxKind.ImportDeclaration) {
      const decl = node as ImportDeclaration;
      const specifier = decl.getModuleSpecifierValue();
      if (specifier && specifier.startsWith('node:')) {
        push(
          {
            ruleId: 'node-builtin-import',
            severity: 'error',
            message: `Reducer imports Node built-in \`${specifier}\`.`,
            suggestion: 'Remove the import; reducers must not touch host modules.',
          },
          decl,
        );
      }
      return;
    }

    if (node.getKind() === SyntaxKind.CallExpression) {
      const call = node as CallExpression;
      const expr = call.getExpression();

      // Dynamic import("node:...").
      if (expr.getKind() === SyntaxKind.ImportKeyword) {
        const [arg] = call.getArguments();
        if (arg && Node.isStringLiteral(arg) && arg.getLiteralValue().startsWith('node:')) {
          push(
            {
              ruleId: 'node-builtin-import',
              severity: 'error',
              message: `Reducer dynamically imports Node built-in \`${arg.getLiteralValue()}\`.`,
              suggestion: 'Remove the dynamic import; reducers must not touch host modules.',
            },
            call,
          );
        }
        return;
      }

      // Banned property-access calls: Date.now(), Math.random(), etc.
      if (Node.isPropertyAccessExpression(expr)) {
        const chain = propertyAccessChain(expr);
        const direct = BANNED_PROPERTY_ACCESS[chain];
        if (direct) {
          push(direct, call);
          return;
        }
      }

      // Bare-identifier calls: fetch(), setTimeout(...), etc.
      if (Node.isIdentifier(expr)) {
        const rule = BARE_CALL_RULES[expr.getText()];
        if (rule) push(rule, call);
      }
      return;
    }

    if (node.getKind() === SyntaxKind.NewExpression) {
      const newExpr = node as NewExpression;
      const expr = newExpr.getExpression();
      if (!Node.isIdentifier(expr)) return;
      const name = expr.getText();

      if (name === 'Date' && newExpr.getArguments().length === 0) {
        push(
          {
            ruleId: 'time-nondeterminism',
            severity: 'error',
            message: '`new Date()` with no arguments is non-deterministic inside a reducer.',
            suggestion: 'Pass the timestamp through the action input.',
          },
          newExpr,
        );
        return;
      }

      const rule = BARE_NEW_RULES[name];
      if (rule) push(rule, newExpr);
      return;
    }

    // process.env / process.argv chains — flag the outermost access.
    if (
      node.getKind() === SyntaxKind.PropertyAccessExpression &&
      !Node.isPropertyAccessExpression(node.getParent())
    ) {
      const access = node as PropertyAccessExpression;
      const chain = propertyAccessChain(access);
      if (PROCESS_ACCESS_PREFIXES.some((p) => chain === p || chain.startsWith(`${p}.`))) {
        push(
          {
            ruleId: 'process-env',
            severity: 'error',
            message: `Reducer reads \`${chain}\`, which is host state.`,
            suggestion: 'Pass configuration through the action input or a bound service.',
          },
          access,
        );
      }
      return;
    }

    // async / await / for-await.
    if (node.getKind() === SyntaxKind.AwaitExpression) {
      push(
        {
          ruleId: 'async-reducer',
          severity: 'error',
          message: '`await` is not allowed inside a synchronous reducer.',
        },
        node,
      );
      return;
    }

    if (Node.isForOfStatement(node) && node.isAwaited()) {
      push(
        {
          ruleId: 'async-reducer',
          severity: 'error',
          message: '`for await` is not allowed inside a synchronous reducer.',
        },
        node,
      );
      return;
    }

    if (
      (Node.isFunctionDeclaration(node) ||
        Node.isFunctionExpression(node) ||
        Node.isArrowFunction(node) ||
        Node.isMethodDeclaration(node)) &&
      node.isAsync()
    ) {
      push(
        {
          ruleId: 'async-reducer',
          severity: 'error',
          message: 'Reducer function is declared `async`; reducers must be synchronous.',
        },
        node,
      );
    }
  });

  return findings;
}

function listReducerFiles(dir: string, project: Project): SourceFile[] {
  const pattern = path.join(dir, '**/*.ts').replace(/\\/g, '/');
  return project
    .addSourceFilesAtPaths(pattern)
    .filter((sf) => !sf.getFilePath().endsWith('.d.ts'));
}

const analyzer: Analyzer = {
  id: 'reducer-purity',
  description:
    'Flags non-deterministic and impure constructs inside reducer bodies.',
  run(ctx: AnalyzerContext) {
    const findings: Finding[] = [];

    for (const model of ctx.models) {
      if (!model.reducerDir) continue;

      const project = new Project({
        skipAddingFilesFromTsConfig: true,
        skipFileDependencyResolution: true,
        skipLoadingLibFiles: true,
        useInMemoryFileSystem: false,
      });

      const sources = listReducerFiles(model.reducerDir, project);
      if (sources.length === 0) continue;

      for (const source of sources) {
        const moduleName = path.basename(source.getFilePath()).replace(/\.ts$/, '');
        findings.push(...analyzeSourceFile(source, model, moduleName));
      }
    }

    return findings;
  },
};

export default analyzer;
