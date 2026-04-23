/**
 * operation-coverage
 *
 * Toolchain: document-model schema loader + file discovery (node:fs).
 *
 * Set-difference between declared operations and implemented reducers.
 * Reports:
 *   - operation declared in the schema but no reducer function found
 *   - reducer function present but no matching operation in the schema
 *   - reducer file naming / module placement doesn't match the
 *     document-model convention (`document-models/<model>/src/reducers/<module>.ts`)
 *
 * Structural consistency only — does not inspect reducer bodies.
 *
 * Accepted reducer identifier forms (per operation):
 *   - canonical: `<camelCaseOpName>Operation`  (Powerhouse codegen)
 *   - tolerated fallback: bare `<camelCaseOpName>` (in-flight codegen variants)
 * `coverage/missing-reducer` only fires when neither form is present.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type {
  Analyzer,
  AnalyzerContext,
  Finding,
  LoadedDocumentModel,
} from '../types.js';

const ANALYZER_ID = 'operation-coverage';

function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
}

function toCamelCase(name: string): string {
  const words = splitWords(name).map((w) => w.toLowerCase());
  if (words.length === 0) return '';
  return (
    words[0] +
    words
      .slice(1)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join('')
  );
}

function toKebabCase(name: string): string {
  return splitWords(name)
    .map((w) => w.toLowerCase())
    .join('-');
}

interface ExtractedIdentifiers {
  canonical: Set<string>;
  bare: Set<string>;
}

function extractReducerIdentifiers(source: string): ExtractedIdentifiers {
  const canonical = new Set<string>();
  const bare = new Set<string>();

  const exportFn = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  const objectMember = /(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*[:(]/g;

  let m: RegExpExecArray | null;
  while ((m = exportFn.exec(source)) !== null) {
    const id = m[1];
    if (id.endsWith('Operation')) {
      canonical.add(id.slice(0, -'Operation'.length));
    } else {
      bare.add(id);
    }
  }
  while ((m = objectMember.exec(source)) !== null) {
    const id = m[1];
    if (id.endsWith('Operation') && id.length > 'Operation'.length) {
      canonical.add(id.slice(0, -'Operation'.length));
    }
  }

  return { canonical, bare };
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

function resolveReducerDir(model: LoadedDocumentModel): string {
  if (model.reducerDir) return model.reducerDir;
  return path.join(
    model.packageDir,
    'document-models',
    toKebabCase(model.name),
    'src',
    'reducers',
  );
}

async function analyzeModel(model: LoadedDocumentModel): Promise<Finding[]> {
  const findings: Finding[] = [];
  const reducerDir = resolveReducerDir(model);

  const declaredModuleSlugs = new Map<string, string>();
  for (const op of model.operations) {
    const slug = toKebabCase(op.module);
    if (!declaredModuleSlugs.has(slug)) declaredModuleSlugs.set(slug, op.module);
  }

  const opsByModuleSlug = new Map<
    string,
    Array<{ name: string; module: string; camel: string }>
  >();
  for (const op of model.operations) {
    const slug = toKebabCase(op.module);
    const camel = toCamelCase(op.name);
    const entry = opsByModuleSlug.get(slug) ?? [];
    entry.push({ name: op.name, module: op.module, camel });
    opsByModuleSlug.set(slug, entry);
  }

  if (!(await dirExists(reducerDir))) {
    findings.push({
      analyzerId: ANALYZER_ID,
      ruleId: 'coverage/missing-reducer-dir',
      severity: 'error',
      message: `Reducer directory not found for model '${model.name}' (expected at ${reducerDir}).`,
      model: model.name,
      location: { file: reducerDir },
      suggestion:
        'Create the reducers directory following the document-models/<model>/src/reducers convention.',
    });
    return findings;
  }

  let entries: string[] = [];
  try {
    entries = await fs.readdir(reducerDir);
  } catch {
    entries = [];
  }

  interface FileInfo {
    file: string;
    base: string;
    ext: string;
    slug: string;
  }
  const files: FileInfo[] = entries
    .map((name) => {
      const ext = path.extname(name);
      const base = name.slice(0, name.length - ext.length);
      return {
        file: path.join(reducerDir, name),
        base,
        ext,
        slug: base.toLowerCase(),
      };
    })
    .filter((f) => f.ext === '.ts' || f.ext === '.tsx');

  const matchedFilesByModuleSlug = new Map<string, FileInfo>();

  for (const f of files) {
    const declaredSlug = [...declaredModuleSlugs.keys()].find(
      (s) => s === f.base,
    );
    const caseInsensitiveSlug = [...declaredModuleSlugs.keys()].find(
      (s) => s === f.slug,
    );

    if (declaredSlug && f.ext === '.ts') {
      matchedFilesByModuleSlug.set(declaredSlug, f);
      continue;
    }

    if (caseInsensitiveSlug) {
      findings.push({
        analyzerId: ANALYZER_ID,
        ruleId: 'coverage/misnamed-reducer-file',
        severity: 'info',
        message: `Reducer file '${path.basename(f.file)}' should be named '${caseInsensitiveSlug}.ts' to match the module slug.`,
        model: model.name,
        module: declaredModuleSlugs.get(caseInsensitiveSlug),
        location: { file: f.file },
        suggestion: `Rename to '${caseInsensitiveSlug}.ts'.`,
      });
      if (!matchedFilesByModuleSlug.has(caseInsensitiveSlug)) {
        matchedFilesByModuleSlug.set(caseInsensitiveSlug, f);
      }
      continue;
    }

    findings.push({
      analyzerId: ANALYZER_ID,
      ruleId: 'coverage/misplaced-reducer',
      severity: 'warning',
      message: `Reducer file '${path.basename(f.file)}' does not match any declared module for model '${model.name}'.`,
      model: model.name,
      location: { file: f.file },
      suggestion:
        'Move or rename the file to match a declared module, or remove it if obsolete.',
    });
  }

  for (const [slug, ops] of opsByModuleSlug) {
    const fileInfo = matchedFilesByModuleSlug.get(slug);
    const expectedFile =
      fileInfo?.file ?? path.join(reducerDir, `${slug}.ts`);

    let identifiers: ExtractedIdentifiers = {
      canonical: new Set(),
      bare: new Set(),
    };
    if (fileInfo) {
      try {
        const source = await fs.readFile(fileInfo.file, 'utf8');
        identifiers = extractReducerIdentifiers(source);
      } catch {
        // Treat unreadable file as empty; missing-reducer findings will follow.
      }
    }

    for (const op of ops) {
      const hasCanonical = identifiers.canonical.has(op.camel);
      const hasBare = identifiers.bare.has(op.camel);
      if (!hasCanonical && !hasBare) {
        findings.push({
          analyzerId: ANALYZER_ID,
          ruleId: 'coverage/missing-reducer',
          severity: 'error',
          message: `Operation '${op.name}' in module '${op.module}' has no reducer function in ${path.basename(expectedFile)}.`,
          model: model.name,
          module: op.module,
          operation: op.name,
          location: { file: expectedFile },
          suggestion: `Declare a reducer '${op.camel}Operation' (or export function '${op.camel}Operation') in ${path.basename(expectedFile)}.`,
        });
      }
    }

    if (!fileInfo) continue;

    const declaredCamelNames = new Set(ops.map((o) => o.camel));
    for (const id of identifiers.canonical) {
      if (!declaredCamelNames.has(id)) {
        findings.push({
          analyzerId: ANALYZER_ID,
          ruleId: 'coverage/orphan-reducer',
          severity: 'warning',
          message: `Reducer '${id}Operation' in ${path.basename(fileInfo.file)} has no matching declared operation in module '${declaredModuleSlugs.get(slug)}'.`,
          model: model.name,
          module: declaredModuleSlugs.get(slug),
          location: { file: fileInfo.file },
          suggestion:
            'Remove the reducer or add the corresponding operation to the schema.',
        });
      }
    }
    for (const id of identifiers.bare) {
      if (!declaredCamelNames.has(id)) continue;
      // Bare identifier that matches a declared op is handled above; nothing to do.
    }
  }

  return findings;
}

const analyzer: Analyzer = {
  id: ANALYZER_ID,
  description:
    'Verifies every declared operation has a reducer and vice versa.',
  async run(ctx: AnalyzerContext): Promise<Finding[]> {
    const perModel = await Promise.all(ctx.models.map(analyzeModel));
    return perModel.flat();
  },
};

export default analyzer;
