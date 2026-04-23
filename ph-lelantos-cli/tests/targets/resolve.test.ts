import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ResolveError } from '../../src/targets/errors.js';
import { isGitUrl, cacheDirFor } from '../../src/targets/git.js';
import { findProjectRoot } from '../../src/targets/project-root.js';
import { resolveTarget } from '../../src/targets/resolve.js';

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

function writeText(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function makeSpec(opts: {
  stateSchema: string;
  moduleName: string;
  opName: string;
  opSchema: string;
  version?: string;
}) {
  const spec: Record<string, unknown> = {
    state: {
      global: { schema: opts.stateSchema, initialValue: '{}' },
      local: { schema: '', initialValue: '{}' },
    },
    modules: [
      {
        id: `${opts.moduleName}-module`,
        name: opts.moduleName,
        description: '',
        operations: [
          {
            id: `${opts.opName}-op`,
            name: opts.opName,
            schema: opts.opSchema,
            reducer: '',
            scope: 'global',
            errors: [],
            examples: [],
            template: '',
            description: '',
          },
        ],
      },
    ],
    changeLog: [],
  };
  if (opts.version) spec.version = opts.version;
  return spec;
}

function writeSingleVersionModel(
  projectDir: string,
  slug: string,
  id: string,
  name: string,
): void {
  const modelDir = path.join(projectDir, 'document-models', slug);
  writeJson(path.join(modelDir, `${slug}.json`), {
    id,
    name,
    description: '',
    extension: slug,
    author: { name: 'test', website: '' },
    specifications: [
      makeSpec({
        stateSchema: `type ${name}State { id: OID! }`,
        moduleName: 'main',
        opName: 'DO_THING',
        opSchema: 'input DoThingInput { v: String! }',
      }),
    ],
  });
  writeText(
    path.join(modelDir, 'src', 'reducers', 'main.ts'),
    '// reducer',
  );
}

function writeMultiVersionModel(
  projectDir: string,
  slug: string,
  id: string,
  name: string,
  versions: string[],
): void {
  const modelDir = path.join(projectDir, 'document-models', slug);
  writeJson(path.join(modelDir, `${slug}.json`), {
    id,
    name,
    description: '',
    extension: slug,
    author: { name: 'test', website: '' },
    specifications: versions.map((v) =>
      makeSpec({
        stateSchema: `type ${name}State_${v} { id: OID! }`,
        moduleName: 'main',
        opName: 'DO_THING',
        opSchema: `input DoThingInput_${v} { v: String! }`,
      }),
    ),
  });
  for (const v of versions) {
    writeText(
      path.join(modelDir, v, 'src', 'reducers', 'main.ts'),
      `// reducer ${v}`,
    );
  }
}

describe('isGitUrl', () => {
  it.each([
    'http://github.com/foo/bar.git',
    'https://github.com/foo/bar.git',
    'git@github.com:foo/bar.git',
    'git://github.com/foo/bar.git',
    'ssh://git@github.com/foo/bar.git',
  ])('matches %s', (spec) => {
    expect(isGitUrl(spec)).toBe(true);
  });

  it.each(['./foo', '/abs/path', 'my-folder', 'foo.com/bar', ''])(
    'rejects %s',
    (spec) => {
      expect(isGitUrl(spec)).toBe(false);
    },
  );
});

describe('findProjectRoot', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'proj-root-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns the nearest ancestor containing a .git directory', () => {
    mkdirSync(path.join(tmp, '.git'), { recursive: true });
    const child = path.join(tmp, 'a', 'b', 'c');
    mkdirSync(child, { recursive: true });
    expect(findProjectRoot(child)).toBe(tmp);
  });

  it('returns the ancestor when .git is a file (worktree/submodule)', () => {
    writeText(path.join(tmp, '.git'), 'gitdir: /elsewhere\n');
    const child = path.join(tmp, 'nested');
    mkdirSync(child, { recursive: true });
    expect(findProjectRoot(child)).toBe(tmp);
  });

  it('throws project-root-not-found when no .git exists up to root', () => {
    const child = path.join(tmp, 'deep');
    mkdirSync(child, { recursive: true });
    try {
      findProjectRoot(child);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ResolveError);
      expect((err as ResolveError).code).toBe('project-root-not-found');
    }
  });
});

describe('resolveTarget — local', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'resolve-local-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('throws local-path-missing when the path does not exist', async () => {
    const missing = path.join(tmp, 'does-not-exist');
    await expect(resolveTarget(missing)).rejects.toMatchObject({
      name: 'ResolveError',
      code: 'local-path-missing',
    });
  });

  it('throws local-path-missing when the path is a file, not a directory', async () => {
    const file = path.join(tmp, 'file.txt');
    writeText(file, 'x');
    await expect(resolveTarget(file)).rejects.toMatchObject({
      code: 'local-path-missing',
    });
  });

  it('throws no-document-models when document-models/ is absent', async () => {
    const project = path.join(tmp, 'project');
    mkdirSync(project, { recursive: true });
    await expect(resolveTarget(project)).rejects.toMatchObject({
      code: 'no-document-models',
    });
  });

  it('throws no-document-models when document-models/ has no valid models', async () => {
    const project = path.join(tmp, 'project');
    mkdirSync(path.join(project, 'document-models', 'not-a-model'), {
      recursive: true,
    });
    await expect(resolveTarget(project)).rejects.toMatchObject({
      code: 'no-document-models',
    });
  });

  it('loads a single-version model', async () => {
    const project = path.join(tmp, 'project');
    writeSingleVersionModel(project, 'clicker', 'powerhouse/clicker', 'Clicker');

    const models = await resolveTarget(project);
    expect(models).toHaveLength(1);
    const [m] = models;
    expect(m.id).toBe('powerhouse/clicker');
    expect(m.name).toBe('Clicker');
    expect(m.packageDir).toBe(path.resolve(project));
    expect(m.stateSchema).toBe('type ClickerState { id: OID! }');
    expect(m.operations).toHaveLength(1);
    expect(m.operations[0]).toMatchObject({
      name: 'DO_THING',
      module: 'main',
      inputSchema: 'input DoThingInput { v: String! }',
    });
    expect(m.reducerDir).toBe(
      path.join(project, 'document-models', 'clicker', 'src', 'reducers'),
    );
    expect(m.operations[0].reducerFile).toBe(
      path.join(
        project,
        'document-models',
        'clicker',
        'src',
        'reducers',
        'main.ts',
      ),
    );
  });

  it('expands multi-version models into one LoadedDocumentModel per spec', async () => {
    const project = path.join(tmp, 'project');
    writeMultiVersionModel(project, 'chat-room', 'powerhouse/chat-room', 'ChatRoom', [
      'legacy',
      'v1',
    ]);

    const models = await resolveTarget(project);
    expect(models).toHaveLength(2);

    const [first, second] = models;
    expect(first.id).toBe('powerhouse/chat-room@legacy');
    expect(first.name).toBe('ChatRoom (legacy)');
    expect(first.stateSchema).toBe('type ChatRoomState_legacy { id: OID! }');
    expect(first.reducerDir).toBe(
      path.join(project, 'document-models', 'chat-room', 'legacy', 'src', 'reducers'),
    );

    expect(second.id).toBe('powerhouse/chat-room@v1');
    expect(second.name).toBe('ChatRoom (v1)');
    expect(second.stateSchema).toBe('type ChatRoomState_v1 { id: OID! }');
    expect(second.reducerDir).toBe(
      path.join(project, 'document-models', 'chat-room', 'v1', 'src', 'reducers'),
    );
  });

  it('returns a stable ordering across multiple models and versions', async () => {
    const project = path.join(tmp, 'project');
    writeSingleVersionModel(project, 'alpha', 'p/alpha', 'Alpha');
    writeMultiVersionModel(project, 'bravo', 'p/bravo', 'Bravo', ['legacy', 'v1']);

    const models = await resolveTarget(project);
    expect(models.map((m) => m.id)).toEqual([
      'p/alpha',
      'p/bravo@legacy',
      'p/bravo@v1',
    ]);
  });

  it('skips malformed JSON but still loads valid siblings', async () => {
    const project = path.join(tmp, 'project');
    writeSingleVersionModel(project, 'alpha', 'p/alpha', 'Alpha');
    const bogusDir = path.join(project, 'document-models', 'bogus');
    writeText(path.join(bogusDir, 'bogus.json'), '{not json');

    const models = await resolveTarget(project);
    expect(models.map((m) => m.id)).toEqual(['p/alpha']);
  });
});

describe('resolveTarget — git', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'resolve-git-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reuses the cache when the target dir is already populated', async () => {
    const spec = 'https://example.com/foo/bar.git';
    const expectedDir = cacheDirFor(spec, tmp);
    writeSingleVersionModel(expectedDir, 'alpha', 'p/alpha', 'Alpha');

    const clone = async (): Promise<void> => {
      throw new Error('clone should not be invoked on cache hit');
    };

    const models = await resolveTarget(spec, { projectRoot: tmp, clone });
    expect(models.map((m) => m.id)).toEqual(['p/alpha']);
  });

  it('invokes the injected clone once on a cache miss', async () => {
    const spec = 'https://example.com/foo/bar.git';
    let cloneCalls = 0;
    const clone = async (_spec: string, dest: string): Promise<void> => {
      cloneCalls++;
      writeSingleVersionModel(dest, 'beta', 'p/beta', 'Beta');
    };

    const models = await resolveTarget(spec, { projectRoot: tmp, clone });
    expect(cloneCalls).toBe(1);
    expect(models.map((m) => m.id)).toEqual(['p/beta']);

    const expectedDir = path.join(
      tmp,
      '.ph-lelantos',
      'cache',
      createHash('sha256').update(spec).digest('hex'),
    );
    expect(existsSync(expectedDir)).toBe(true);
  });

  it('wraps clone failures in ResolveError(git-clone-failed)', async () => {
    const spec = 'https://example.com/foo/bar.git';
    const clone = async (): Promise<void> => {
      throw new Error('network down');
    };

    await expect(
      resolveTarget(spec, { projectRoot: tmp, clone }),
    ).rejects.toMatchObject({
      name: 'ResolveError',
      code: 'git-clone-failed',
    });
  });
});
