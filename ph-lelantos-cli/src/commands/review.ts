import { z } from 'zod';
import pc from 'picocolors';

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
  by: z
    .enum(['file', 'severity', 'rule'])
    .optional()
    .default('file')
    .describe('Group findings by file (default), severity, or rule.'),
  minSeverity: z
    .enum(['error', 'warning', 'info'])
    .optional()
    .default('warning')
    .describe('Hide findings below this severity. Default "warning" hides info.'),
  json: z
    .boolean()
    .optional()
    .default(false)
    .describe('Emit raw Finding[] as JSON to stdout.'),
  verbose: z
    .boolean()
    .optional()
    .default(false)
    .describe('Disable aggregation — show every finding with evidence.'),
  llm: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Run LLM synthesis on top of static findings. Off by default; pass --llm to enable.',
    ),
  maxTokens: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(4096)
    .describe('Max output tokens for the LLM synthesis pass.'),
});

const SEVERITY_ORDER: Severity[] = ['error', 'warning', 'info'];
const SEVERITY_RANK: Record<Severity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

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

const CACHE_PREFIX_RE = /^.*\.ph-lelantos\/cache\/[0-9a-f]+\//;

export function shortenPath(file: string, projectRoot?: string): string {
  let out = file.replace(CACHE_PREFIX_RE, '');
  if (projectRoot) {
    const root = projectRoot.endsWith('/') ? projectRoot : projectRoot + '/';
    if (out.startsWith(root)) out = out.slice(root.length);
  }
  return out;
}

function formatLocation(
  loc: SourceLocation | undefined,
  projectRoot?: string,
): string {
  if (!loc) return '';
  const parts: string[] = [shortenPath(loc.file, projectRoot)];
  if (loc.line !== undefined) parts.push(String(loc.line));
  if (loc.column !== undefined) parts.push(String(loc.column));
  return parts.join(':');
}

type ColorFn = (s: string) => string;
interface ColorPalette {
  red: ColorFn;
  yellow: ColorFn;
  green: ColorFn;
  dim: ColorFn;
  bold: ColorFn;
  glyph: (sev: Severity) => string;
}

const IDENTITY: ColorFn = (s) => s;
const GLYPHS: Record<Severity, string> = {
  error: '✖',
  warning: '⚠',
  info: 'ℹ',
};

function makeColor(useColor: boolean): ColorPalette {
  if (!useColor) {
    return {
      red: IDENTITY,
      yellow: IDENTITY,
      green: IDENTITY,
      dim: IDENTITY,
      bold: IDENTITY,
      glyph: (sev) => GLYPHS[sev],
    };
  }
  const colors = pc.createColors(true);
  return {
    red: colors.red,
    yellow: colors.yellow,
    green: colors.green,
    dim: colors.dim,
    bold: colors.bold,
    glyph: (sev) => {
      if (sev === 'error') return colors.red(GLYPHS.error);
      if (sev === 'warning') return colors.yellow(GLYPHS.warning);
      return colors.dim(GLYPHS.info);
    },
  };
}

function severityColor(sev: Severity, c: ColorPalette): ColorFn {
  if (sev === 'error') return c.red;
  if (sev === 'warning') return c.yellow;
  return c.dim;
}

export type RenderItem =
  | { kind: 'single'; finding: Finding }
  | {
      kind: 'group';
      analyzerId: string;
      ruleId: string;
      model: string | undefined;
      severity: Severity;
      count: number;
      examples: Finding[];
      message: string;
    };

export interface AggregateOptions {
  maxExamples?: number;
  threshold?: number;
}

export function aggregateFindings(
  findings: Finding[],
  opts: AggregateOptions = {},
): RenderItem[] {
  const maxExamples = opts.maxExamples ?? 1;
  const threshold = opts.threshold ?? 2;

  const buckets = new Map<string, Finding[]>();
  const order: string[] = [];
  for (const f of findings) {
    const key = `${f.analyzerId} ${f.ruleId} ${f.model ?? ''}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(f);
  }

  const out: RenderItem[] = [];
  for (const key of order) {
    const bucket = buckets.get(key)!;
    if (bucket.length >= threshold) {
      const first = bucket[0];
      out.push({
        kind: 'group',
        analyzerId: first.analyzerId,
        ruleId: first.ruleId,
        model: first.model,
        severity: first.severity,
        count: bucket.length,
        examples: bucket.slice(0, maxExamples),
        message: first.message,
      });
    } else {
      for (const f of bucket) out.push({ kind: 'single', finding: f });
    }
  }
  return out;
}

interface TallyRow {
  error: number;
  warning: number;
  info: number;
}

function emptyTally(): TallyRow {
  return { error: 0, warning: 0, info: 0 };
}

function computeTallies(findings: Finding[]): {
  global: TallyRow;
  perModel: Map<string, TallyRow>;
} {
  const global = emptyTally();
  const perModel = new Map<string, TallyRow>();
  for (const f of findings) {
    global[f.severity] += 1;
    const key = f.model ?? '(unscoped)';
    let row = perModel.get(key);
    if (!row) {
      row = emptyTally();
      perModel.set(key, row);
    }
    row[f.severity] += 1;
  }
  return { global, perModel };
}

function sortModelKeys(keys: string[]): string[] {
  const named = keys.filter((k) => k !== '(unscoped)').sort();
  const hasUnscoped = keys.includes('(unscoped)');
  return hasUnscoped ? [...named, '(unscoped)'] : named;
}

function filterBySeverity(
  findings: Finding[],
  minSeverity: Severity,
): { kept: Finding[]; hidden: TallyRow } {
  const cutoff = SEVERITY_RANK[minSeverity];
  const kept: Finding[] = [];
  const hidden = emptyTally();
  for (const f of findings) {
    if (SEVERITY_RANK[f.severity] <= cutoff) {
      kept.push(f);
    } else {
      hidden[f.severity] += 1;
    }
  }
  return { kept, hidden };
}

export type GroupBy = 'file' | 'severity' | 'rule';

export interface RenderOptions {
  verbose?: boolean;
  useColor?: boolean;
  projectRoot?: string;
  by?: GroupBy;
  minSeverity?: Severity;
}

export function renderFindings(
  findings: Finding[],
  opts: RenderOptions = {},
): string[] {
  const verbose = opts.verbose ?? false;
  const c = makeColor(opts.useColor ?? false);
  const projectRoot = opts.projectRoot;
  const by: GroupBy = opts.by ?? 'file';
  const minSeverity: Severity = opts.minSeverity ?? 'warning';

  if (findings.length === 0) {
    return [c.green(c.bold('✓ PASS — no findings.'))];
  }

  const { kept, hidden } = filterBySeverity(findings, minSeverity);
  const lines: string[] = [];

  if (kept.length > 0) {
    if (by === 'file') {
      lines.push(...renderByFile(kept, { c, projectRoot }));
    } else if (by === 'rule') {
      lines.push(...renderByRule(kept, { c, projectRoot, verbose }));
    } else {
      lines.push(...renderBySeverity(kept, { c, projectRoot, verbose }));
    }
    lines.push('');
  }

  lines.push(...renderSummary(kept, { c, hidden, minSeverity }));
  lines.push('');
  lines.push(renderVerdict(findings, c));

  return lines;
}

export function renderFindingsPlain(
  findings: Finding[],
  opts: Omit<RenderOptions, 'useColor'> = {},
): string[] {
  return renderFindings(findings, { ...opts, useColor: false });
}

interface BodyOpts {
  c: ColorPalette;
  projectRoot?: string;
  verbose?: boolean;
}

export function renderByFile(
  findings: Finding[],
  opts: Omit<BodyOpts, 'verbose'>,
): string[] {
  const { c, projectRoot } = opts;
  const lines: string[] = [];

  const byFile = new Map<string, Finding[]>();
  const NO_LOC = '(no location)';
  for (const f of findings) {
    const key = f.location
      ? shortenPath(f.location.file, projectRoot)
      : NO_LOC;
    const list = byFile.get(key) ?? [];
    list.push(f);
    byFile.set(key, list);
  }

  const fileStats = [...byFile.entries()].map(([file, fs]) => {
    const errors = fs.filter((f) => f.severity === 'error').length;
    const warnings = fs.filter((f) => f.severity === 'warning').length;
    return { file, fs, errors, warnings, total: fs.length };
  });
  fileStats.sort((a, b) => {
    if (a.file === NO_LOC) return 1;
    if (b.file === NO_LOC) return -1;
    if (b.errors !== a.errors) return b.errors - a.errors;
    if (b.warnings !== a.warnings) return b.warnings - a.warnings;
    if (b.total !== a.total) return b.total - a.total;
    return a.file.localeCompare(b.file);
  });

  lines.push(c.bold('=== FINDINGS (by file) ==='));
  for (const { file, fs } of fileStats) {
    fs.sort((a, b) => {
      const la = a.location?.line ?? 0;
      const lb = b.location?.line ?? 0;
      if (la !== lb) return la - lb;
      return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    });

    const errs = fs.filter((f) => f.severity === 'error').length;
    const warns = fs.filter((f) => f.severity === 'warning').length;
    const infos = fs.filter((f) => f.severity === 'info').length;
    const tallyBits: string[] = [];
    if (errs) tallyBits.push(c.red(`${errs}E`));
    if (warns) tallyBits.push(c.yellow(`${warns}W`));
    if (infos) tallyBits.push(c.dim(`${infos}I`));
    const tally = tallyBits.length > 0 ? ` ${c.dim('—')} ${tallyBits.join(' ')}` : '';
    lines.push(`${c.bold(file)}${tally}`);

    for (const f of fs) {
      const glyph = c.glyph(f.severity);
      const line = f.location?.line !== undefined ? String(f.location.line) : '—';
      const col = f.location?.column !== undefined ? `:${f.location.column}` : '';
      const loc = c.dim(`${line}${col}`.padStart(5));
      const rule = c.dim(`${f.analyzerId}/${f.ruleId}`);
      lines.push(`  ${glyph} ${loc}  ${f.message} ${rule}`);
    }
    lines.push('');
  }

  // Trailing empty line is added by renderFindings; drop the last one here.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function renderByRule(
  findings: Finding[],
  opts: BodyOpts,
): string[] {
  const { c, projectRoot, verbose } = opts;
  const lines: string[] = [];

  const byRule = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = `${f.analyzerId}/${f.ruleId}`;
    const list = byRule.get(key) ?? [];
    list.push(f);
    byRule.set(key, list);
  }

  const rules = [...byRule.entries()].map(([rule, fs]) => ({
    rule,
    fs,
    severity: fs[0].severity,
  }));
  rules.sort((a, b) => {
    const sa = SEVERITY_RANK[a.severity];
    const sb = SEVERITY_RANK[b.severity];
    if (sa !== sb) return sa - sb;
    if (b.fs.length !== a.fs.length) return b.fs.length - a.fs.length;
    return a.rule.localeCompare(b.rule);
  });

  lines.push(c.bold('=== FINDINGS (by rule) ==='));
  for (const { rule, fs, severity } of rules) {
    const glyph = c.glyph(severity);
    const sevColor = severityColor(severity, c);
    lines.push(
      `${glyph} ${sevColor(c.bold(rule))} ${c.dim(`(${fs.length}) — ${fs[0].message}`)}`,
    );
    const limit = verbose ? fs.length : Math.min(fs.length, 5);
    for (let i = 0; i < limit; i++) {
      const loc = formatLocation(fs[i].location, projectRoot);
      if (loc) lines.push(`  ${c.dim('- ' + loc)}`);
    }
    const hidden = fs.length - limit;
    if (hidden > 0) {
      lines.push(
        `  ${c.dim(`… and ${hidden} more (pass --verbose to expand)`)}`,
      );
    }
    lines.push('');
  }
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function renderBySeverity(
  findings: Finding[],
  opts: BodyOpts,
): string[] {
  const { c, projectRoot, verbose } = opts;
  const lines: string[] = [];

  for (const severity of SEVERITY_ORDER) {
    const bucket = findings.filter((f) => f.severity === severity);
    if (bucket.length === 0) continue;
    const sevColor = severityColor(severity, c);
    lines.push(
      sevColor(
        c.bold(`${c.glyph(severity)} === ${severity.toUpperCase()} (${bucket.length}) ===`),
      ),
    );

    const byModel = new Map<string, Finding[]>();
    for (const f of bucket) {
      const key = f.model ?? '(unscoped)';
      const list = byModel.get(key) ?? [];
      list.push(f);
      byModel.set(key, list);
    }

    for (const modelKey of sortModelKeys([...byModel.keys()])) {
      const modelFindings = byModel.get(modelKey)!;
      lines.push(`  ${c.bold(modelKey)}`);

      const byModule = new Map<string, Finding[]>();
      for (const f of modelFindings) {
        const key = f.module ?? '';
        const list = byModule.get(key) ?? [];
        list.push(f);
        byModule.set(key, list);
      }
      const moduleKeys = [...byModule.keys()].sort();

      for (const moduleKey of moduleKeys) {
        const moduleFindings = byModule.get(moduleKey)!;
        if (moduleKey) lines.push(`    ${c.dim(moduleKey)}`);

        const byOp = new Map<string, Finding[]>();
        for (const f of moduleFindings) {
          const key = f.operation ?? '';
          const list = byOp.get(key) ?? [];
          list.push(f);
          byOp.set(key, list);
        }
        const opKeys = [...byOp.keys()].sort();

        for (const opKey of opKeys) {
          const opFindings = byOp.get(opKey)!;
          if (opKey) lines.push(`      ${c.dim(opKey)}`);

          const items = verbose
            ? opFindings.map<RenderItem>((f) => ({ kind: 'single', finding: f }))
            : aggregateFindings(opFindings);

          for (const item of items) {
            if (item.kind === 'single') {
              const f = item.finding;
              const rule = c.bold(`${f.analyzerId}/${f.ruleId}`);
              const loc = c.dim(formatLocation(f.location, projectRoot));
              const head = [rule, loc].filter(Boolean).join(' ');
              lines.push(`        ${c.glyph(f.severity)} ${head} — ${f.message}`);
              if (f.evidence) {
                for (const evLine of f.evidence.split('\n')) {
                  lines.push(`          ${c.dim(evLine)}`);
                }
              }
            } else {
              const rule = c.bold(`${item.analyzerId}/${item.ruleId}`);
              const suffix = c.dim(`(x${item.count} occurrences)`);
              lines.push(`        ${c.glyph(item.severity)} ${rule} ${suffix} — ${item.message}`);
              for (const ex of item.examples) {
                const loc = formatLocation(ex.location, projectRoot);
                if (loc) lines.push(`          ${c.dim('- ' + loc)}`);
              }
              const hidden = item.count - item.examples.length;
              if (hidden > 0) {
                lines.push(
                  `          ${c.dim(`… and ${hidden} more (pass --verbose to expand)`)}`,
                );
              }
            }
          }
        }
      }
    }
    lines.push('');
  }
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

interface SummaryOpts {
  c: ColorPalette;
  hidden: TallyRow;
  minSeverity: Severity;
}

export function renderSummary(
  findings: Finding[],
  opts: SummaryOpts,
): string[] {
  const { c, hidden, minSeverity } = opts;
  const lines: string[] = [];
  const { global, perModel } = computeTallies(findings);

  lines.push(c.bold('=== SUMMARY ==='));

  const tallyRows: { label: string; row: TallyRow; bold: boolean }[] = [
    { label: 'Total', row: global, bold: true },
  ];
  for (const key of sortModelKeys([...perModel.keys()])) {
    tallyRows.push({ label: key, row: perModel.get(key)!, bold: false });
  }
  const labelWidth = Math.max(...tallyRows.map((r) => r.label.length));
  const errWidth = Math.max(...tallyRows.map((r) => String(r.row.error).length));
  const warnWidth = Math.max(...tallyRows.map((r) => String(r.row.warning).length));
  const infoWidth = Math.max(...tallyRows.map((r) => String(r.row.info).length));
  for (const { label, row, bold } of tallyRows) {
    const pad = label.padEnd(labelWidth);
    const labelOut = bold ? c.bold(pad) : c.bold(pad);
    const cols = [
      `${c.glyph('error')} ${c.red(`${String(row.error).padStart(errWidth)} errors`)}`,
      `${c.glyph('warning')} ${c.yellow(`${String(row.warning).padStart(warnWidth)} warnings`)}`,
      `${c.glyph('info')} ${c.dim(`${String(row.info).padStart(infoWidth)} info`)}`,
    ].join('   ');
    lines.push(`${labelOut}   ${cols}`);
  }

  const hiddenTotal = hidden.error + hidden.warning + hidden.info;
  if (hiddenTotal > 0) {
    const parts: string[] = [];
    if (hidden.error) parts.push(`${hidden.error} error`);
    if (hidden.warning) parts.push(`${hidden.warning} warning`);
    if (hidden.info) parts.push(`${hidden.info} info`);
    lines.push(
      c.dim(
        `(${parts.join(', ')} hidden below --min-severity=${minSeverity}; pass --min-severity info to show)`,
      ),
    );
  }

  // Top offenders: files
  const fileCounts = new Map<string, { errors: number; warnings: number; total: number }>();
  for (const f of findings) {
    if (!f.location) continue;
    const key = shortenPath(f.location.file);
    const row = fileCounts.get(key) ?? { errors: 0, warnings: 0, total: 0 };
    if (f.severity === 'error') row.errors += 1;
    if (f.severity === 'warning') row.warnings += 1;
    row.total += 1;
    fileCounts.set(key, row);
  }
  const topFiles = [...fileCounts.entries()]
    .sort((a, b) => {
      const ae = a[1].errors;
      const be = b[1].errors;
      if (be !== ae) return be - ae;
      const aw = a[1].warnings;
      const bw = b[1].warnings;
      if (bw !== aw) return bw - aw;
      return b[1].total - a[1].total;
    })
    .slice(0, 5);
  if (topFiles.length > 0) {
    lines.push('');
    lines.push(c.bold('Top files:'));
    const widest = Math.max(...topFiles.map(([file]) => file.length));
    for (const [file, row] of topFiles) {
      const bits: string[] = [];
      if (row.errors) bits.push(c.red(`${row.errors}E`));
      if (row.warnings) bits.push(c.yellow(`${row.warnings}W`));
      const info = row.total - row.errors - row.warnings;
      if (info) bits.push(c.dim(`${info}I`));
      lines.push(`  ${file.padEnd(widest)}  ${bits.join(' ')}`);
    }
  }

  // Top rules
  const ruleCounts = new Map<string, { errors: number; warnings: number; total: number; severity: Severity }>();
  for (const f of findings) {
    const key = `${f.analyzerId}/${f.ruleId}`;
    const row = ruleCounts.get(key) ?? { errors: 0, warnings: 0, total: 0, severity: f.severity };
    if (f.severity === 'error') row.errors += 1;
    if (f.severity === 'warning') row.warnings += 1;
    row.total += 1;
    if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[row.severity]) {
      row.severity = f.severity;
    }
    ruleCounts.set(key, row);
  }
  const topRules = [...ruleCounts.entries()]
    .sort((a, b) => {
      const sa = SEVERITY_RANK[a[1].severity];
      const sb = SEVERITY_RANK[b[1].severity];
      if (sa !== sb) return sa - sb;
      if (b[1].total !== a[1].total) return b[1].total - a[1].total;
      return a[0].localeCompare(b[0]);
    })
    .slice(0, 5);
  if (topRules.length > 0) {
    lines.push('');
    lines.push(c.bold('Top rules:'));
    const widest = Math.max(...topRules.map(([r]) => r.length));
    for (const [rule, row] of topRules) {
      const bits: string[] = [];
      if (row.errors) bits.push(c.red(`${row.errors}E`));
      if (row.warnings) bits.push(c.yellow(`${row.warnings}W`));
      const info = row.total - row.errors - row.warnings;
      if (info) bits.push(c.dim(`${info}I`));
      lines.push(`  ${c.glyph(row.severity)} ${rule.padEnd(widest)}  ${bits.join(' ')}`);
    }
  }

  return lines;
}

export function renderVerdict(
  findings: Finding[],
  c: ColorPalette,
): string {
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  if (errors > 0) {
    return c.red(
      c.bold(`✖ FAIL — ${errors} error${errors === 1 ? '' : 's'} must be fixed before shipping.`),
    );
  }
  if (warnings > 0) {
    return c.yellow(`⚠ PASS with ${warnings} warning${warnings === 1 ? '' : 's'}.`);
  }
  return c.green(c.bold('✓ PASS — no findings.'));
}

// Cite atom accepts three forms emitted by the reviewer agent:
//   1. analyzerId:ruleId@file:line   (location-pinned)
//   2. analyzerId:ruleId@ScopeName   (model/module/operation scope)
//   3. analyzerId:ruleId             (rule-wide, no scope)
// Lookbehind prevents mid-token matches like `ts:277` inside `wallet.ts:277`.
// ruleId char class includes `/` to match paths like `security/detect-object-injection`.
const CITE_RE =
  /(?<![A-Za-z0-9./])([A-Za-z0-9][\w-]*):([A-Za-z0-9][\w./-]*)(?:@([^\s,]+))?/g;

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
        const analyzerId = m[1];
        const ruleId = m[2];
        const scope = m[3];
        cites.push(scope ? `${analyzerId}:${ruleId}@${scope}` : `${analyzerId}:${ruleId}`);
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
  // Form 1: analyzerId:ruleId@file:line
  const locM = cite.match(/^([^:]+):([^@]+)@(.+):(\d+)$/);
  if (locM) return `[${locM[1]}/${locM[2]} @ ${locM[3]}:${locM[4]}]`;
  // Form 2: analyzerId:ruleId@ScopeName
  const scopeM = cite.match(/^([^:]+):([^@]+)@([^:]+)$/);
  if (scopeM) return `[${scopeM[1]}/${scopeM[2]} ~ ${scopeM[3]}]`;
  // Form 3: analyzerId:ruleId
  const ruleM = cite.match(/^([^:]+):([^:]+)$/);
  if (ruleM) return `[${ruleM[1]}/${ruleM[2]}]`;
  return `[${cite}]`;
}

function renderRecommendations(
  recs: Recommendation[],
  opts: { useColor?: boolean } = {},
): string[] {
  const c = makeColor(opts.useColor ?? false);
  const lines: string[] = [];
  lines.push(c.bold('=== RECOMMENDATIONS ==='));
  lines.push('');
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    const num = c.bold(`${i + 1}.`);
    const citeStr =
      rec.cites.length > 0
        ? rec.cites.map(renderCite).join(', ')
        : c.dim('(no citations)');
    lines.push(`${num} ${c.dim('Cites:')} ${citeStr}`);
    for (const textLine of rec.text.split('\n')) {
      if (textLine.trim() === '') continue;
      lines.push(`   ${textLine}`);
    }
    if (i < recs.length - 1) lines.push('');
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
    error?: unknown;
    payload?: { text?: string };
  }>) {
    if (chunk.type === 'text-delta') {
      text += chunk.textDelta ?? chunk.text ?? chunk.payload?.text ?? '';
    } else if (chunk.type === 'error') {
      const err = chunk.error;
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`LLM stream error: ${msg}`);
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
      recommendations = await runSynthesis(
        ctx,
        findings,
        analyzerCtx.projectRoot,
        input.maxTokens,
      );
    }

    if (input.json) {
      ctx.stdout(JSON.stringify({ findings, recommendations }, null, 2));
    } else {
      const lines = renderFindings(findings, {
        verbose: input.verbose,
        useColor: true,
        projectRoot: analyzerCtx.projectRoot,
        by: input.by,
        minSeverity: input.minSeverity,
      });
      if (recommendations.length > 0) {
        // renderFindings ends with [..., '', verdict]. Splice recs in before
        // the trailing blank + verdict so the verdict stays the final line.
        const verdict = lines.pop();
        const trailingBlank = lines.pop();
        lines.push(...renderRecommendations(recommendations, { useColor: true }));
        if (trailingBlank !== undefined) lines.push(trailingBlank);
        if (verdict !== undefined) lines.push(verdict);
      }
      ctx.stdout(lines.join('\n'));
    }

    if (findings.some((f) => f.severity === 'error')) {
      process.exit(1);
    }
    return undefined;
  },
});
