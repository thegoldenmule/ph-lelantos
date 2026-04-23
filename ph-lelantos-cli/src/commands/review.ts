import { z } from 'zod';

import { defineCommand } from '../framework.js';
import { analyzers } from '../analysis/index.js';
import type {
  AnalyzerContext,
  Finding,
  Severity,
  SourceLocation,
} from '../analysis/types.js';
import { findProjectRoot } from '../targets/project-root.js';
import { resolveTarget } from '../targets/resolve.js';

const inputSchema = z.object({
  target: z
    .string()
    .describe('Local path or public git URL of the project to review.'),
  only: z
    .string()
    .optional()
    .describe('Comma-separated analyzer ids to include (exclusive with other analyzers).'),
  skip: z
    .string()
    .optional()
    .describe('Comma-separated analyzer ids to exclude.'),
  json: z
    .boolean()
    .optional()
    .default(false)
    .describe('Emit raw Finding[] as JSON to stdout.'),
});

const SEVERITY_ORDER: Severity[] = ['error', 'warning', 'info'];

function parseIds(csv: string | undefined): string[] {
  if (!csv) return [];
  return csv
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function validateIds(label: string, ids: string[], known: Set<string>): void {
  for (const id of ids) {
    if (!known.has(id)) {
      throw new Error(
        `Unknown analyzer id in --${label}: ${id}. Known: ${[...known].sort().join(', ')}`,
      );
    }
  }
}

function formatLocation(loc: SourceLocation | undefined): string {
  if (!loc) return '';
  const parts: string[] = [loc.file];
  if (loc.line !== undefined) parts.push(String(loc.line));
  if (loc.column !== undefined) parts.push(String(loc.column));
  return parts.join(':');
}

function formatScope(f: Finding): string {
  const bits: string[] = [];
  if (f.model) bits.push(f.model);
  if (f.module) bits.push(f.module);
  if (f.operation) bits.push(f.operation);
  return bits.length > 0 ? `(${bits.join('/')})` : '';
}

function renderHuman(findings: Finding[]): string[] {
  const lines: string[] = [];
  for (const severity of SEVERITY_ORDER) {
    const bucket = findings.filter((f) => f.severity === severity);
    if (bucket.length === 0) continue;
    lines.push(`=== ${severity.toUpperCase()} (${bucket.length}) ===`);
    const byAnalyzer = new Map<string, Finding[]>();
    for (const f of bucket) {
      const list = byAnalyzer.get(f.analyzerId) ?? [];
      list.push(f);
      byAnalyzer.set(f.analyzerId, list);
    }
    const analyzerIds = [...byAnalyzer.keys()].sort();
    for (const analyzerId of analyzerIds) {
      for (const f of byAnalyzer.get(analyzerId)!) {
        const scope = formatScope(f);
        const loc = formatLocation(f.location);
        const head = [
          `[${severity.toUpperCase()}]`,
          `${f.analyzerId}/${f.ruleId}`,
          scope,
          loc,
        ]
          .filter(Boolean)
          .join('  ');
        lines.push(`${head} — ${f.message}`);
        if (f.evidence) {
          for (const evLine of f.evidence.split('\n')) {
            lines.push(`  ${evLine}`);
          }
        }
      }
    }
    lines.push('');
  }
  if (lines.length === 0) {
    lines.push('No findings.');
  }
  return lines;
}

export const reviewCommand = defineCommand({
  id: 'review',
  description:
    'Run static analyzers against a document-model project (local path or public git URL).',
  inputSchema,
  execute: async (input, ctx) => {
    const projectRoot = findProjectRoot();
    const models = await resolveTarget(input.target, { projectRoot });

    const analyzerCtx: AnalyzerContext = {
      models,
      projectRoot: models[0]?.packageDir ?? projectRoot,
    };

    const known = new Set(analyzers.map((a) => a.id));
    const onlyIds = parseIds(input.only);
    const skipIds = parseIds(input.skip);
    validateIds('only', onlyIds, known);
    validateIds('skip', skipIds, known);

    const onlySet = onlyIds.length > 0 ? new Set(onlyIds) : undefined;
    const skipSet = new Set(skipIds);
    const filtered = analyzers.filter(
      (a) => (!onlySet || onlySet.has(a.id)) && !skipSet.has(a.id),
    );

    const findings = (
      await Promise.all(filtered.map((a) => a.run(analyzerCtx)))
    ).flat();

    if (input.json) {
      ctx.stdout(JSON.stringify(findings, null, 2));
    } else {
      ctx.stdout(renderHuman(findings).join('\n'));
    }

    if (findings.some((f) => f.severity === 'error')) {
      process.exit(1);
    }
    return undefined;
  },
});
