/**
 * Mastra tools the reviewer agent calls.
 *
 * Findings are expected to be injected into the agent's runtime context
 * (Mastra `RequestContext`) under `FINDINGS_KEY`. Whoever invokes the agent
 * (CLI command, `mastra:dev`) is responsible for setting that key before
 * streaming. If the key is absent, the tool falls back to the bundled
 * fixture set so `pnpm mastra:dev` works standalone.
 */
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createTool } from '@mastra/core/tools';
import { findProjectRoot } from '../targets/project-root.js';
import { CLI_ROOT } from '../config.js';
import type { Finding, Severity } from '../analysis/types.js';

export const FINDINGS_KEY = 'findings';
export const PROJECT_ROOT_KEY = 'projectRoot';

export interface ReviewerRequestContext {
  [FINDINGS_KEY]: Finding[];
  [PROJECT_ROOT_KEY]?: string;
}

const SEVERITIES = ['error', 'warning', 'info'] as const satisfies readonly Severity[];

function loadFixtureFindings(): Finding[] {
  const fixturePath = path.join(CLI_ROOT, 'fixtures', 'findings.json');
  try {
    const raw = readFileSync(fixturePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Finding[]) : [];
  } catch {
    return [];
  }
}

function resolveFindings(ctx: { requestContext?: { get?: (key: string) => unknown } }): Finding[] {
  const fromRc = ctx.requestContext?.get?.(FINDINGS_KEY);
  if (Array.isArray(fromRc)) return fromRc as Finding[];
  return loadFixtureFindings();
}

export const getFindingsTool = createTool({
  id: 'getFindings',
  description:
    'Return the current Finding[] set, optionally filtered by severity, analyzerId, model, module, or operation. Always call this before producing recommendations.',
  inputSchema: z.object({
    severity: z.enum(SEVERITIES).optional(),
    analyzerId: z.string().optional(),
    model: z.string().optional(),
    module: z.string().optional(),
    operation: z.string().optional(),
  }),
  outputSchema: z.object({
    count: z.number(),
    findings: z.array(z.any()),
  }),
  execute: async (input, ctx) => {
    const all = resolveFindings(ctx ?? {});
    const filtered = all.filter((f) => {
      if (input.severity && f.severity !== input.severity) return false;
      if (input.analyzerId && f.analyzerId !== input.analyzerId) return false;
      if (input.model && f.model !== input.model) return false;
      if (input.module && f.module !== input.module) return false;
      if (input.operation && f.operation !== input.operation) return false;
      return true;
    });
    return { count: filtered.length, findings: filtered };
  },
});

function formatExcerpt(
  source: string,
  line: number | undefined,
  contextLines: number,
): { startLine: number; endLine: number; excerpt: string } {
  const lines = source.split(/\r?\n/);
  const total = lines.length;
  let start: number;
  let end: number;
  if (line === undefined) {
    start = 1;
    end = total;
  } else {
    start = Math.max(1, line - contextLines);
    end = Math.min(total, line + contextLines);
  }
  const width = String(end).length;
  const body = lines
    .slice(start - 1, end)
    .map((content, idx) => {
      const n = start + idx;
      return `${String(n).padStart(width, ' ')} | ${content}`;
    })
    .join('\n');
  return { startLine: start, endLine: end, excerpt: body };
}

export const readSourceTool = createTool({
  id: 'readSource',
  description:
    'Return a line-numbered excerpt of a source file, centered on a line when provided. Use this to pull context for a specific finding — do not pre-load files.',
  inputSchema: z.object({
    file: z
      .string()
      .describe('Path relative to the repository root (.git root).'),
    line: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('1-based line to center the excerpt on. If omitted, returns the whole file.'),
    contextLines: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .default(20)
      .describe('Lines of context to include on each side of `line`.'),
  }),
  outputSchema: z.object({
    file: z.string(),
    startLine: z.number(),
    endLine: z.number(),
    excerpt: z.string(),
  }),
  execute: async (input, ctx) => {
    const fromRc = (ctx as { requestContext?: { get?: (key: string) => unknown } } | undefined)
      ?.requestContext?.get?.(PROJECT_ROOT_KEY);
    const projectRoot =
      typeof fromRc === 'string' && fromRc.length > 0 ? fromRc : findProjectRoot();
    const resolved = path.resolve(projectRoot, input.file);
    const rel = path.relative(projectRoot, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(
        `readSource: path "${input.file}" escapes the project root "${projectRoot}".`,
      );
    }
    const source = await readFile(resolved, 'utf8');
    const { startLine, endLine, excerpt } = formatExcerpt(
      source,
      input.line,
      input.contextLines ?? 20,
    );
    return { file: rel, startLine, endLine, excerpt };
  },
});
