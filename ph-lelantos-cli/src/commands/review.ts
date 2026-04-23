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
import { createCommandReviewerAgent } from '../agents/agent.js';

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
  llm: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Run LLM synthesis on top of static findings. Off by default; pass --llm to enable.',
    ),
  maxTokens: z
    .number()
    .int()
    .positive()
    .optional()
    .default(4096)
    .describe('Max output tokens for the LLM synthesis pass.'),
});

const SEVERITY_ORDER: Severity[] = ['error', 'warning', 'info'];

export interface Recommendation {
  cites: string[];
  text: string;
}

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

function renderFindings(findings: Finding[]): string[] {
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

// Cite atom matches the format the reviewer agent is prompted to emit:
// `<analyzerId>:<ruleId>@<file>:<line>`.
const CITE_RE = /([A-Za-z0-9][\w-]*):([A-Za-z0-9][\w.-]*)@([^\s,]+?):(\d+)/g;

export function parseRecommendations(markdown: string): Recommendation[] {
  const result: Recommendation[] = [];
  const lines = markdown.split('\n');
  let current: Recommendation | null = null;

  const flush = () => {
    if (current) {
      current.text = current.text.trim();
      if (current.cites.length > 0 || current.text.length > 0) {
        result.push(current);
      }
    }
  };

  for (const raw of lines) {
    const citeMatch = raw.match(/^\s*-\s*Cites?\s*:\s*(.+)$/i);
    if (citeMatch) {
      flush();
      const cites: string[] = [];
      for (const m of citeMatch[1].matchAll(CITE_RE)) {
        cites.push(`${m[1]}:${m[2]}@${m[3]}:${m[4]}`);
      }
      current = { cites, text: '' };
      continue;
    }
    if (current) {
      current.text += (current.text ? '\n' : '') + raw.replace(/^\s{0,4}/, '');
    }
  }
  flush();

  if (result.length === 0 && markdown.trim().length > 0) {
    return [{ cites: [], text: markdown.trim() }];
  }
  return result;
}

export function renderCite(cite: string): string {
  const m = cite.match(/^([^:]+):([^@]+)@(.+?):(\d+)$/);
  if (!m) return `[${cite}]`;
  return `[${m[1]}/${m[2]} @ ${m[3]}:${m[4]}]`;
}

function renderRecommendations(recs: Recommendation[]): string[] {
  const lines: string[] = [];
  lines.push('=== RECOMMENDATIONS ===');
  for (const rec of recs) {
    const citeStr =
      rec.cites.length > 0 ? rec.cites.map(renderCite).join(', ') : '(no citations)';
    lines.push(`- ${citeStr}`);
    for (const textLine of rec.text.split('\n')) {
      lines.push(`  ${textLine}`);
    }
  }
  lines.push('');
  return lines;
}

async function runSynthesis(
  ctx: Parameters<typeof createCommandReviewerAgent>[0],
  findings: Finding[],
  projectRoot: string,
  maxTokens: number,
): Promise<Recommendation[]> {
  const { agent, requestContext } = await createCommandReviewerAgent(ctx, {
    findings,
    projectRoot,
  });
  const prompt =
    'Review the attached findings via getFindings and emit recommendations per the citation contract. Do not re-analyze.';
  const streamResult = await agent.stream(prompt, {
    requestContext,
    maxOutputTokens: maxTokens,
  } as never);
  let text = '';
  for await (const chunk of streamResult.fullStream as AsyncIterable<{
    type: string;
    textDelta?: string;
    text?: string;
  }>) {
    if (chunk.type === 'text-delta') {
      text += chunk.textDelta ?? chunk.text ?? '';
    }
  }
  return parseRecommendations(text);
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

    let recommendations: Recommendation[] = [];
    if (input.llm && findings.length > 0) {
      try {
        recommendations = await runSynthesis(
          ctx,
          findings,
          analyzerCtx.projectRoot,
          input.maxTokens,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.stdout(
          `[warn] LLM synthesis failed: ${msg} — falling back to static-only output.\n`,
        );
        recommendations = [];
      }
    }

    if (input.json) {
      ctx.stdout(JSON.stringify({ findings, recommendations }, null, 2));
    } else {
      const lines = renderFindings(findings);
      if (recommendations.length > 0) {
        lines.push(...renderRecommendations(recommendations));
      }
      ctx.stdout(lines.join('\n'));
    }

    if (findings.some((f) => f.severity === 'error')) {
      process.exit(1);
    }
    return undefined;
  },
});
