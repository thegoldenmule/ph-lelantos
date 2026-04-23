/**
 * forbidden-imports
 *
 * Toolchain: dependency-cruiser.
 *
 * Treats reducer files as a hermetic layer. Flags any transitive import
 * that pulls in:
 *   - `node:*` built-ins (fs, http, net, child_process, os, worker_threads, ...)
 *   - HTTP clients (fetch shims, axios, undici, ...)
 *   - database clients
 *   - loggers that touch I/O
 *   - anything outside `document-models/<model>/src/**` (except the tight
 *     allowlist below)
 *
 * Complements reducer-purity: purity checks call sites, this checks the
 * import closure so indirect I/O is caught.
 */
import { access, readdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { cruise } from 'dependency-cruiser';
import type { Analyzer, Finding, LoadedDocumentModel } from '../types.js';

const ALLOWED_PACKAGES = [
  '@powerhousedao/reactor',
  'document-model',
  'mutative',
] as const;

const NODE_BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]);

const HTTP_CLIENT_RE =
  /^(node-fetch|undici|axios|got|ky|cross-fetch|isomorphic-fetch|phin|superagent|request)(\/|$)/;
const DB_CLIENT_RE =
  /^(pg|mysql|mysql2|mongodb|sqlite3|better-sqlite3|@prisma\/client|prisma|typeorm|sequelize|knex|mongoose|drizzle-orm|kysely)(\/|$)/;
const LOGGER_RE = /^(winston|pino|bunyan|log4js|roarr)(\/|$)/;

async function findTsConfig(startDir: string): Promise<string | undefined> {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, 'tsconfig.json');
    try {
      await access(candidate);
      return candidate;
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function collectReducerFiles(reducerDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(reducerDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const { name } = entry;
    if (!name.endsWith('.ts')) continue;
    if (name.endsWith('.test.ts') || name.endsWith('.spec.ts')) continue;
    if (name.endsWith('.d.ts')) continue;
    files.push(join(reducerDir, name));
  }
  return files;
}

function packageNameOf(specifier: string): string {
  if (specifier.startsWith('@')) {
    return specifier.split('/').slice(0, 2).join('/');
  }
  return specifier.split('/')[0] ?? specifier;
}

function classify(
  specifier: string,
  resolvedPath: string | undefined,
  isCore: boolean,
  modelSrcDir: string,
): string | null {
  if (isCore || specifier.startsWith('node:')) {
    return 'no-node-builtins';
  }
  if (NODE_BUILTINS.has(packageNameOf(specifier))) {
    return 'no-node-builtins';
  }
  if (HTTP_CLIENT_RE.test(specifier)) return 'no-http-clients';
  if (DB_CLIENT_RE.test(specifier)) return 'no-db-clients';
  if (LOGGER_RE.test(specifier)) return 'no-loggers';

  const isRelative =
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/');
  if (isRelative) {
    if (!resolvedPath) return null;
    const absolute = resolve(resolvedPath);
    const boundary = modelSrcDir + sep;
    if (absolute === modelSrcDir || absolute.startsWith(boundary)) {
      return null;
    }
    return 'out-of-package';
  }

  const pkg = packageNameOf(specifier);
  if ((ALLOWED_PACKAGES as readonly string[]).includes(pkg)) {
    return null;
  }
  return 'out-of-package';
}

async function analyzeModel(model: LoadedDocumentModel): Promise<Finding[]> {
  if (!model.reducerDir) return [];
  const files = await collectReducerFiles(model.reducerDir);
  if (files.length === 0) return [];

  const modelSrcDir = resolve(model.reducerDir, '..');
  const tsConfigFile = await findTsConfig(model.packageDir);

  let result;
  try {
    result = await cruise(files, {
      validate: false,
      tsPreCompilationDeps: true,
      ...(tsConfigFile ? { tsConfig: { fileName: tsConfigFile } } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [
      {
        analyzerId: 'forbidden-imports',
        ruleId: 'analyzer-failed',
        severity: 'info',
        model: model.name,
        message: `dependency-cruiser failed for model '${model.name}': ${message}`,
      },
    ];
  }

  const output = result.output;
  if (typeof output === 'string') return [];

  const findings: Finding[] = [];
  for (const mod of output.modules) {
    for (const dep of mod.dependencies) {
      const isCore =
        Boolean(dep.coreModule) ||
        (dep.dependencyTypes ?? []).includes('core');
      const ruleId = classify(dep.module, dep.resolved, isCore, modelSrcDir);
      if (!ruleId) continue;
      findings.push({
        analyzerId: 'forbidden-imports',
        ruleId,
        severity: 'error',
        model: model.name,
        message: `Reducer imports forbidden module '${dep.module}' (rule: ${ruleId})`,
        location: { file: mod.source },
        evidence: dep.module,
      });
    }
  }
  return findings;
}

const analyzer: Analyzer = {
  id: 'forbidden-imports',
  description:
    'Asserts reducer files do not transitively import I/O or host modules.',
  async run(ctx) {
    const perModel = await Promise.all(ctx.models.map(analyzeModel));
    return perModel.flat();
  },
};

export default analyzer;
