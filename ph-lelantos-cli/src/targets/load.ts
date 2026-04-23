import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type {
  LoadedDocumentModel,
  LoadedOperation,
} from '../analysis/types.js';
import { ResolveError } from './errors.js';

interface RawOperation {
  name?: unknown;
  schema?: unknown;
  scope?: unknown;
}

interface RawModule {
  name?: unknown;
  operations?: unknown;
}

interface RawState {
  global?: { schema?: unknown };
}

interface RawSpec {
  version?: unknown;
  state?: RawState;
  modules?: unknown;
}

interface RawDocModel {
  id?: unknown;
  name?: unknown;
  specifications?: unknown;
}

async function isDir(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

function asString(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined;
}

async function findVersionReducerDirs(
  modelDir: string,
): Promise<{ name: string; reducerDir: string }[]> {
  const out: { name: string; reducerDir: string }[] = [];
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = (await readdir(modelDir, { withFileTypes: true })) as any[];
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const candidate = path.join(modelDir, e.name, 'src', 'reducers');
    if (await isDir(candidate)) {
      out.push({ name: e.name, reducerDir: candidate });
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

async function toOperations(
  modules: RawModule[],
  reducerDir: string | undefined,
): Promise<LoadedOperation[]> {
  const ops: LoadedOperation[] = [];
  for (const m of modules) {
    const moduleName = asString(m.name);
    if (!moduleName) continue;
    const rawOps = Array.isArray(m.operations) ? (m.operations as RawOperation[]) : [];
    let reducerFile: string | undefined;
    if (reducerDir) {
      const candidate = path.join(reducerDir, `${moduleName}.ts`);
      if (await isFile(candidate)) reducerFile = candidate;
    }
    for (const op of rawOps) {
      const opName = asString(op.name);
      if (!opName) continue;
      const loaded: LoadedOperation = {
        name: opName,
        module: moduleName,
        inputSchema: op.schema,
      };
      if (reducerFile) loaded.reducerFile = reducerFile;
      ops.push(loaded);
    }
  }
  return ops;
}

async function loadFromModelDir(
  packageDir: string,
  modelDir: string,
  slug: string,
): Promise<LoadedDocumentModel[]> {
  const jsonPath = path.join(modelDir, `${slug}.json`);
  if (!(await isFile(jsonPath))) return [];

  let raw: RawDocModel;
  try {
    const text = await readFile(jsonPath, 'utf8');
    raw = JSON.parse(text) as RawDocModel;
  } catch {
    return [];
  }

  const id = asString(raw.id);
  const name = asString(raw.name);
  const specifications = Array.isArray(raw.specifications)
    ? (raw.specifications as RawSpec[])
    : undefined;
  if (!id || !name || !specifications || specifications.length === 0) return [];

  const directReducers = path.join(modelDir, 'src', 'reducers');
  const hasDirectReducers = await isDir(directReducers);
  const versionDirs = hasDirectReducers ? [] : await findVersionReducerDirs(modelDir);

  const results: LoadedDocumentModel[] = [];
  for (let i = 0; i < specifications.length; i++) {
    const spec = specifications[i] ?? {};
    const modules = Array.isArray(spec.modules) ? (spec.modules as RawModule[]) : [];

    let reducerDir: string | undefined;
    let subdirLabel: string | undefined;
    if (hasDirectReducers && specifications.length === 1) {
      reducerDir = directReducers;
    } else if (versionDirs.length > 0) {
      const pick = versionDirs[i] ?? versionDirs[versionDirs.length - 1];
      if (pick) {
        reducerDir = pick.reducerDir;
        subdirLabel = pick.name;
      }
    } else if (hasDirectReducers) {
      reducerDir = directReducers;
    }

    const versionLabel =
      asString(spec.version) ?? subdirLabel ?? (specifications.length === 1 ? 'current' : `v${i}`);

    const operations = await toOperations(modules, reducerDir);

    const multi = specifications.length > 1;
    const loaded: LoadedDocumentModel = {
      id: multi ? `${id}@${versionLabel}` : id,
      name: multi ? `${name} (${versionLabel})` : name,
      packageDir,
      stateSchema: spec.state?.global?.schema,
      operations,
    };
    if (reducerDir) loaded.reducerDir = reducerDir;
    results.push(loaded);
  }

  return results;
}

export async function loadDocumentModelsFromDir(
  dir: string,
): Promise<LoadedDocumentModel[]> {
  const docModelsDir = path.join(dir, 'document-models');
  if (!(await isDir(docModelsDir))) {
    throw new ResolveError(
      'no-document-models',
      `No "document-models/" directory found in "${dir}".`,
    );
  }

  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = (await readdir(docModelsDir, { withFileTypes: true })) as any[];
  } catch (err) {
    throw new ResolveError(
      'no-document-models',
      `Failed to read "${docModelsDir}": ${(err as Error).message}`,
      err,
    );
  }

  const modelDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();

  const results: LoadedDocumentModel[] = [];
  for (const slug of modelDirs) {
    const modelDir = path.join(docModelsDir, slug);
    const models = await loadFromModelDir(dir, modelDir, slug);
    results.push(...models);
  }

  if (results.length === 0) {
    throw new ResolveError(
      'no-document-models',
      `No document models found under "${docModelsDir}".`,
    );
  }

  return results;
}
