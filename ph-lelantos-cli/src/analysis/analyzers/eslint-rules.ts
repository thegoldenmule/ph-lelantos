/**
 * eslint-rules
 *
 * Toolchain: ESLint (programmatic API) with `@typescript-eslint` and
 * `eslint-plugin-security`, plus in-tree custom rules.
 *
 * Covers the lint-style subset of checks that are file-local and don't
 * need whole-program type-graph traversal:
 *   - `no-unused-vars`, `no-implicit-any` on reducer files
 *   - `security/detect-non-literal-regexp`,
 *     `security/detect-object-injection`
 *   - project-custom rules such as "reducer function must not be
 *     `async`" or "a reducer must take exactly two parameters"
 *
 * ESLint findings are merged into the shared `Finding` shape so the
 * LLM reviewer sees one homogeneous stream.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ESLint } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
// @ts-expect-error — eslint-plugin-security ships no type declarations
import securityPlugin from 'eslint-plugin-security';
import type {
  Analyzer,
  AnalyzerContext,
  Finding,
  LoadedDocumentModel,
  Severity,
} from '../types.js';

async function walkTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkTsFiles(full)));
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

async function collectReducerFiles(
  ctx: AnalyzerContext,
): Promise<string[]> {
  const files = new Set<string>();
  for (const model of ctx.models) {
    if (model.reducerDir) {
      for (const file of await walkTsFiles(model.reducerDir)) {
        files.add(path.resolve(file));
      }
    }
    for (const op of model.operations) {
      if (op.reducerFile) {
        files.add(path.resolve(op.reducerFile));
      }
    }
  }
  return [...files];
}

function resolveModel(
  filePath: string,
  models: LoadedDocumentModel[],
): LoadedDocumentModel | undefined {
  const abs = path.resolve(filePath);
  for (const model of models) {
    if (!model.reducerDir) continue;
    const dir = path.resolve(model.reducerDir) + path.sep;
    if ((abs + path.sep).startsWith(dir)) return model;
  }
  return undefined;
}

function toSeverity(level: 0 | 1 | 2): Severity {
  if (level === 2) return 'error';
  if (level === 1) return 'warning';
  return 'info';
}

function extractEvidence(
  source: string | undefined,
  line: number | undefined,
): string | undefined {
  if (!source || !line) return undefined;
  const lines = source.split(/\r?\n/);
  return lines[line - 1];
}

const inTreeCustomPlugin = { rules: {} as Record<string, unknown> };

const overrideConfig = [
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser as unknown as ESLint.Options['baseConfig'],
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: {
      '@typescript-eslint': tsPlugin as unknown as object,
      security: securityPlugin as unknown as object,
      'ph-lelantos': inTreeCustomPlugin,
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      'security/detect-non-literal-regexp': 'warn',
      'security/detect-object-injection': 'warn',
      'security/detect-eval-with-expression': 'error',
      'security/detect-child-process': 'error',
      'security/detect-non-literal-require': 'warn',
      'security/detect-unsafe-regex': 'warn',
    },
  },
];

const analyzer: Analyzer = {
  id: 'eslint-rules',
  description:
    'Runs the reducer-scoped ESLint ruleset and normalizes the output.',
  async run(ctx: AnalyzerContext): Promise<Finding[]> {
    const files = await collectReducerFiles(ctx);
    if (files.length === 0) return [];

    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: overrideConfig as unknown as ESLint.Options['overrideConfig'],
      cwd: ctx.projectRoot,
      errorOnUnmatchedPattern: false,
    });

    const results = await eslint.lintFiles(files);

    const sourceCache = new Map<string, string>();
    const findings: Finding[] = [];

    for (const result of results) {
      const model = resolveModel(result.filePath, ctx.models);
      const moduleName = path.basename(
        result.filePath,
        path.extname(result.filePath),
      );

      for (const message of result.messages) {
        let source = result.source;
        if (!source) {
          let cached = sourceCache.get(result.filePath);
          if (cached === undefined) {
            try {
              cached = await fs.readFile(result.filePath, 'utf8');
            } catch {
              cached = '';
            }
            sourceCache.set(result.filePath, cached);
          }
          source = cached;
        }

        const finding: Finding = {
          analyzerId: 'eslint-rules',
          ruleId: message.ruleId ?? 'eslint/parse-error',
          severity: toSeverity(message.severity as 0 | 1 | 2),
          message: message.message,
          location: {
            file: result.filePath,
            line: message.line,
            column: message.column,
            endLine: message.endLine,
            endColumn: message.endColumn,
          },
          evidence: extractEvidence(source, message.line),
        };
        if (model) {
          finding.model = model.name;
          finding.module = moduleName;
        }
        findings.push(finding);
      }
    }

    return findings;
  },
};

export default analyzer;
