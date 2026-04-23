import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import schemaDiff from '../../src/analysis/analyzers/schema-diff.js';
import type {
  AnalyzerContext,
  LoadedDocumentModel,
} from '../../src/analysis/types.js';

function makeCtx(
  projectRoot: string,
  models: LoadedDocumentModel[],
): AnalyzerContext {
  return { projectRoot, models };
}

function writeBaseline(
  projectRoot: string,
  modelId: string,
  relPath: string,
  content: string,
): string {
  const full = path.join(
    projectRoot,
    '.ph-lelantos',
    'baseline',
    modelId,
    relPath,
  );
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

describe('schema-diff analyzer', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'schema-diff-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns no findings when no baseline directory exists', async () => {
    const ctx = makeCtx(projectRoot, [
      {
        id: 'foo/bar',
        name: 'Bar',
        packageDir: projectRoot,
        stateSchema: { type: 'object', properties: { name: { type: 'string' } } },
        operations: [],
      },
    ]);
    const findings = await schemaDiff.run(ctx);
    expect(findings).toEqual([]);
  });

  it('detects a removed GraphQL field', async () => {
    const modelId = 'foo/bar';
    writeBaseline(
      projectRoot,
      modelId,
      'state.graphql',
      `type Query { hello: String foo: String }`,
    );
    const ctx = makeCtx(projectRoot, [
      {
        id: modelId,
        name: 'Bar',
        packageDir: projectRoot,
        stateSchema: `type Query { hello: String }`,
        operations: [],
      },
    ]);
    const findings = await schemaDiff.run(ctx);
    const fieldRemoved = findings.filter(
      (f) => f.ruleId === 'graphql/field-removed',
    );
    expect(fieldRemoved).toHaveLength(1);
    expect(fieldRemoved[0].severity).toBe('error');
    expect(fieldRemoved[0].model).toBe(modelId);
  });

  it('detects a newly-required JSON Schema field', async () => {
    const modelId = 'foo/bar';
    writeBaseline(
      projectRoot,
      modelId,
      'state.json',
      JSON.stringify({
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'string' } },
        required: ['a'],
      }),
    );
    const ctx = makeCtx(projectRoot, [
      {
        id: modelId,
        name: 'Bar',
        packageDir: projectRoot,
        stateSchema: {
          type: 'object',
          properties: { a: { type: 'string' }, b: { type: 'string' } },
          required: ['a', 'b'],
        },
        operations: [],
      },
    ]);
    const findings = await schemaDiff.run(ctx);
    const newlyRequired = findings.filter(
      (f) => f.ruleId === 'json/field-newly-required',
    );
    expect(newlyRequired).toHaveLength(1);
    expect(newlyRequired[0].message).toContain('b');
  });

  it('detects a removed JSON Schema field', async () => {
    const modelId = 'foo/bar';
    writeBaseline(
      projectRoot,
      modelId,
      'state.json',
      JSON.stringify({
        type: 'object',
        properties: { a: { type: 'string' }, gone: { type: 'number' } },
      }),
    );
    const ctx = makeCtx(projectRoot, [
      {
        id: modelId,
        name: 'Bar',
        packageDir: projectRoot,
        stateSchema: {
          type: 'object',
          properties: { a: { type: 'string' } },
        },
        operations: [],
      },
    ]);
    const findings = await schemaDiff.run(ctx);
    const removed = findings.filter((f) => f.ruleId === 'json/field-removed');
    expect(removed).toHaveLength(1);
    expect(removed[0].message).toContain('gone');
  });

  it('detects a narrowed JSON Schema type', async () => {
    const modelId = 'foo/bar';
    writeBaseline(
      projectRoot,
      modelId,
      'state.json',
      JSON.stringify({
        type: 'object',
        properties: { a: { type: 'string' } },
      }),
    );
    const ctx = makeCtx(projectRoot, [
      {
        id: modelId,
        name: 'Bar',
        packageDir: projectRoot,
        stateSchema: {
          type: 'object',
          properties: { a: { type: 'number' } },
        },
        operations: [],
      },
    ]);
    const findings = await schemaDiff.run(ctx);
    const narrowed = findings.filter((f) => f.ruleId === 'json/type-narrowed');
    expect(narrowed.length).toBeGreaterThanOrEqual(1);
    expect(narrowed[0].message).toContain('a');
  });

  it('flags a removed operation', async () => {
    const modelId = 'foo/bar';
    writeBaseline(
      projectRoot,
      modelId,
      'operations/core/setName.json',
      JSON.stringify({
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      }),
    );
    const ctx = makeCtx(projectRoot, [
      {
        id: modelId,
        name: 'Bar',
        packageDir: projectRoot,
        stateSchema: { type: 'object', properties: {} },
        operations: [],
      },
    ]);
    const findings = await schemaDiff.run(ctx);
    const removed = findings.filter(
      (f) => f.ruleId === 'graphql/operation-removed',
    );
    expect(removed).toHaveLength(1);
    expect(removed[0].module).toBe('core');
    expect(removed[0].operation).toBe('setName');
  });
});
